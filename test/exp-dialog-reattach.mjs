// 実験: ダイアログが開いた「後」に attach したとき、Chrome は Page.javascriptDialogOpening を通知するか。
// CLI はコマンドごとに attach し直すので、attach していない間に出た alert を拾えるかが「止まらない」ために重要。
// 手順: タブ WS で /late(1.5 秒後に alert)へ遷移 → すぐ切断(detach)→ alert が出るまで待つ → 別の WS で attach し直して観察
import http from 'node:http';
import { WebSocket } from 'ws';
import { startRelay, launchChromeWithExtension, waitForBrowser, RELAY, sleep } from './harness.mjs';

const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/late' ? `<title>late</title><script>window.marker = 'kept'; setTimeout(() => { alert('late alert'); document.title = 'after-alert'; }, 1500)</script>` : '<title>other</title>'); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${srv.address().port}`;

function client(url) {
  const ws = new WebSocket(url); let seq = 0; const pending = new Map(); const events = [];
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else events.push(m); });
  const send = (method, params, timeout = 3000) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => rej(new Error(`timeout ${timeout}ms`)), timeout); });
  return { ws, events, send, open: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }) };
}
const tryIt = async (label, p) => { const t0 = Date.now(); try { console.log(label, '->', JSON.stringify(await p).slice(0, 120), `${Date.now() - t0}ms`); } catch (e) { console.log(label, '-> ERROR', e.message, `${Date.now() - t0}ms`); } };

const relay = await startRelay();
const { browser } = await launchChromeWithExtension({ name: 'exp' });
try {
  await waitForBrowser('exp');
  const tab = (await fetch(`${RELAY}/b/exp/json/list`).then(r => r.json()))[0];
  const a = client(tab.webSocketDebuggerUrl); await a.open;
  await a.send('Page.navigate', { url: `${site}/late` }); await sleep(300);
  a.ws.close(); await sleep(3000); // この間に alert が出る(誰も Page を enable していない)
  console.log('attached after alert:', (await fetch(`${RELAY}/browsers`).then(r => r.json()))[0].attachedTabs);

  const b = client(tab.webSocketDebuggerUrl); await b.open;
  await tryIt('Page.enable', b.send('Page.enable')); await sleep(1000);
  console.log('events after Page.enable:', b.events.map(e => e.method).join(', ') || '(none)');
  await tryIt('Runtime.evaluate 1+1', b.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }));
  await tryIt('Page.handleJavaScriptDialog accept', b.send('Page.handleJavaScriptDialog', { accept: true }));
  await tryIt('Runtime.evaluate after handle', b.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }));
  // 別タブをアクティブにして戻す(Chrome はタブ切り替えでダイアログを閉じるか)
  const ws2 = new WebSocket(`${RELAY.replace('http', 'ws')}/b/exp/devtools/browser`); await new Promise(r => ws2.once('open', r));
  let s2 = 0; const call2 = (method, params) => new Promise(res => { const id = ++s2; ws2.on('message', raw => { const m = JSON.parse(raw); if (m.id === id) res(m); }); ws2.send(JSON.stringify({ id, method, params })); });
  const created = await call2('Target.createTarget', { url: 'about:blank' }); await sleep(1000);
  console.log('events after other tab active:', b.events.map(e => e.method).join(', '));
  await call2('Target.activateTarget', { targetId: tab.id }); await sleep(500);
  await tryIt('Runtime.evaluate after tab switch', b.send('Runtime.evaluate', { expression: 'document.title + "/" + window.marker', returnByValue: true }));
  await call2('Target.closeTarget', { targetId: created.result.targetId }); ws2.close();
  await tryIt('Page.navigate other', b.send('Page.navigate', { url: `${site}/other` }, 5000)); await sleep(1000);
  console.log('events:', b.events.map(e => e.method).join(', '));
  await tryIt('Runtime.evaluate after navigate', b.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }));
  b.ws.close();
} finally { await browser.close().catch(() => {}); relay.stop(); srv.close(); }
