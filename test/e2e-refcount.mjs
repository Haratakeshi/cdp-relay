// 回帰: (a) attach 不可のタブ(chrome://)で参照カウントが漏れない (b) 2 クライアントで共有中に片方が二重 detach しても他方は使える
import { startRelay, launchChromeWithExtension, waitForBrowser, startLocalSite, RELAY, sleep, assert } from './harness.mjs';
import { WebSocket } from 'ws';

const site = await startLocalSite();
const relay = await startRelay();
const { browser } = await launchChromeWithExtension({ name: 'rc' });
const attachedTabs = () => fetch(`${RELAY}/browsers`).then(r => r.json()).then(l => l[0].attachedTabs);
function client(url) {
  const ws = new WebSocket(url); let seq = 0; const pending = new Map();
  const open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', (_, r) => rej(new Error(`HTTP ${r.statusCode}`))); });
  const closed = new Promise(res => ws.once('close', (code, reason) => res({ code, reason: String(reason) })));
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
  const send = (method, params, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  return { ws, open, closed, send };
}
try {
  await waitForBrowser('rc');
  // WebUI ページ(chrome:// / edge://)は chrome.debugger が attach を拒否する。失敗経路の題材に使う
  const scheme = /Edg\//.test(await browser.version()) ? 'edge' : 'chrome';
  const p = await browser.newPage(); await p.goto(`${scheme}://version`);
  const tabs = await fetch(`${RELAY}/b/rc/json/list`).then(r => r.json());
  const chromeTab = tabs.find(t => t.url.startsWith(`${scheme}://`));
  assert(chromeTab, `${scheme}://version tab is listed`);
  for (let i = 1; i <= 2; i++) {
    const c = client(chromeTab.webSocketDebuggerUrl); await c.open;
    const r = await c.closed;
    assert(r.code === 1011 && /:\/\/|Cannot access/i.test(r.reason), `attempt ${i}: page WS on ${scheme}:// closed with attach error (${r.reason.slice(0, 50)})`);
    assert((await attachedTabs()).length === 0, `attempt ${i}: no leaked refcount`);
  }
  await p.close();

  const page = tabs.find(t => t.url === 'about:blank') ?? tabs[0];
  const a = client(page.webSocketDebuggerUrl), b = client(page.webSocketDebuggerUrl);
  await Promise.all([a.open, b.open]);
  await a.send('Page.navigate', { url: site.url + 'shared' }); await sleep(500);
  assert((await attachedTabs()).length === 1, 'two page clients share one attach');
  a.ws.close(); await sleep(300);
  assert((await b.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value === 'shared', 'B still works after A closed');
  assert((await attachedTabs()).length === 1, 'refcount decremented to 1, not 0');

  const f = client(`${RELAY.replace('http', 'ws')}/b/rc/devtools/browser`); await f.open;
  const { sessionId } = await f.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  assert((await f.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, sessionId)).result.value === 2, 'facade client attached to the shared tab');
  await f.send('Target.detachFromTarget', { sessionId }); await f.send('Target.detachFromTarget', { sessionId });
  assert((await b.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value === 'shared', 'B still works after facade client detached twice');
  f.ws.close(); b.ws.close(); await sleep(300);
  // ページ WS で繋いだタブはエージェントのタブで、クライアントが全員離れても中継自身の参照(watch)が残る。adopt を外すと 0 になる
  assert((await attachedTabs()).join() === String(page.tabId), 'clients all released; only the relay watch remains');
  await fetch(`${RELAY}/b/rc/tabs/${page.tabId}/adopt`, { method: 'DELETE' }); await sleep(300);
  assert((await attachedTabs()).length === 0, 'all released');
  console.log('E2E-6 PASS');
} finally { await browser.close().catch(() => {}); relay.stop(); site.stop(); }
