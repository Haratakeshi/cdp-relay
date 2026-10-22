// E2E-1: 拡張 → 中継 → ページ WS 素通しの疎通(Page.navigate / イベント / Runtime.evaluate / screenshot)
import { startRelay, launchChromeWithExtension, waitForBrowser, startLocalSite, RELAY, sleep, assert } from './harness.mjs';
import { WebSocket } from 'ws';

const site = await startLocalSite();
const relay = await startRelay();
const { browser } = await launchChromeWithExtension({ name: 'test-a' });
try {
  await waitForBrowser('test-a');
  assert(true, 'extension registered at relay as test-a');
  const version = await fetch(`${RELAY}/b/test-a/json/version`).then(r => r.json());
  assert(version.webSocketDebuggerUrl?.endsWith('/b/test-a/devtools/browser'), `json/version -> ${version.Browser}`);
  const tabs = await fetch(`${RELAY}/b/test-a/json/list`).then(r => r.json());
  assert(tabs.length >= 1, `json/list has ${tabs.length} tab(s)`);
  const tab = tabs.find(t => t.url === 'about:blank') ?? tabs[0];

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let seq = 0; const pending = new Map(); const events = [];
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else events.push(m); });
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });

  const { targetInfo } = await send('Target.getTargetInfo');
  assert(targetInfo.targetId === tab.id, `json/list の id == CDP targetId (${tab.id.slice(0, 8)}…)`);
  await send('Page.enable');
  const t0 = Date.now();
  await send('Page.navigate', { url: site.url + 'relay-test' });
  for (let i = 0; i < 40 && !events.some(e => e.method === 'Page.loadEventFired'); i++) await sleep(100);
  assert(events.some(e => e.method === 'Page.loadEventFired'), `Page.loadEventFired received (${Date.now() - t0}ms)`);
  const ev = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  assert(ev.result.value === 'relay-test', `Runtime.evaluate -> ${ev.result.value}`);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  assert(shot.data.length > 1000, `Page.captureScreenshot ${shot.data.length} base64 chars`);
  let err; try { await send('Page.noSuchMethod'); } catch (e) { err = e; }
  assert(err && /wasn't found|not found/i.test(err.message), `error propagated: ${err?.message}`);
  let notAllowed; try { await send('Target.getTargets'); } catch (e) { notAllowed = e; }
  assert(notAllowed && /not allowed/i.test(notAllowed.message), `Target.getTargets via chrome.debugger -> "${notAllowed?.message}" (facade must synthesize)`);
  const browsers = await fetch(`${RELAY}/browsers`).then(r => r.json());
  assert(browsers[0].attachedTabs.length === 1, 'relay tracks 1 attached tab');
  await send('Runtime.enable'); // 次のクライアントへ持ち越してはいけない状態(付け直さないと次の Runtime.enable が実行コンテキストを通知しない)
  ws.close(); await sleep(300);
  // ページ WS で繋いだタブはエージェントのタブ。クライアントが離れても中継が attach し続ける(合間に開くダイアログを自動処理するため)。
  // 付け直しているので、次のクライアントの Runtime.enable にも実行コンテキストが通知される(前のクライアントの状態を持ち越さない)
  const after = await fetch(`${RELAY}/browsers`).then(r => r.json());
  assert(after[0].attachedTabs.length === 1 && after[0].agentTabs.includes(after[0].attachedTabs[0]), 'client close 後もエージェントのタブは中継が attach したまま');
  const ws2 = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws2.once('open', r));
  const ctx = new Promise(r => ws2.on('message', raw => { if (JSON.parse(raw).method === 'Runtime.executionContextCreated') r(true); }));
  ws2.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
  assert(await Promise.race([ctx, sleep(3000).then(() => false)]), '次のクライアントの Runtime.enable に executionContextCreated が届く');
  ws2.close(); await sleep(300);
  await fetch(`${RELAY}/b/test-a/tabs/${after[0].attachedTabs[0]}/adopt`, { method: 'DELETE' }); await sleep(300);
  assert((await fetch(`${RELAY}/browsers`).then(r => r.json()))[0].attachedTabs.length === 0, 'エージェントのタブから外すと detach する');
  console.log('E2E-1 PASS');
} finally {
  await browser.close().catch(() => {});
  relay.stop(); site.stop();
}
