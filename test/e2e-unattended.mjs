// E2E-14: 見ていない・操作していない間に開いた JS ダイアログでエージェントが止まらないこと(docs/EXPERIMENT_LOG.md §27)。
//  - 背面タブ / 作成後にユーザーが別のタブへ切り替えたタブ / 最小化したウィンドウのタブ: alert 直前の visibilityState が hidden であることを
//    確かめたうえで、中継がダイアログを検知して閉じる(puppeteer の既定引数のうち非表示化を止めるものは外して起動する。付けたままだと
//    どの条件でも visible のままで、この検証にならない)
//  - CLI のコマンドの合間(クライアント未接続)に開いた alert も中継が閉じ、次のコマンドでページの状態(入力値)が残っている
//    (以前は detach していたので検知できず、次の attach で遷移し直して状態を失っていた)
//  - 拡張を再読み込みしても(SW 起動時に attach が外れる)エージェントのタブを attach し直して監視を続ける / adopt を外すと detach する
// CLI は必ず非同期(execFile)で呼ぶ。execFileSync だとテストページを返すこのプロセスのサーバーが止まり、ページが読み込まれない
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRelay, launchChromeWithExtension, waitForBrowser, RELAY, RELAY_PORT, sleep, assert, artifactsDir, relayEvents } from './harness.mjs';

const NAME = 'unatt';
const TIMEOUT = 1500; // テスト用ポリシーの dialogTimeoutMs / unresponsiveTimeoutMs
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  // alert 直前の可視状態を window.__pre に残す(alert で止まっている間も、閉じた後に読める)
  if (u.pathname === '/alert') return res.end(`<title>loaded</title><script>setTimeout(() => { window.__pre = document.visibilityState; alert('hidden?'); document.title = 'after-alert'; }, 300)</script>`);
  // 読み込みの 2 秒後に入力してから alert(CLI の goto が終わった後に開く)
  if (u.pathname === '/idle') return res.end(`<title>idle</title><input id="i"><script>setTimeout(() => { document.getElementById('i').value = 'typed-before-alert'; alert('session expiring'); document.title = 'after-alert'; }, 2000)</script>`);
  res.end(`<title>${u.pathname.slice(1)}</title>`);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${srv.address().port}`;

const out = artifactsDir('e2e-unattended');
const policyPath = join(out, 'policy.json');
writeFileSync(policyPath, JSON.stringify({ dialogTimeoutMs: TIMEOUT, unresponsiveTimeoutMs: TIMEOUT }), { mode: 0o600 });
const relayLog = `tmp/relay-${RELAY_PORT}.log`;
const logStart = readFileSync(relayLog, { flag: 'a+' }).length;
const relay = await startRelay({ CDP_RELAY_POLICY: policyPath });
const ignoreDefaultArgs = ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-ipc-flooding-protection', '--disable-hang-monitor', '--enable-automation'];
const { browser: chrome, worker } = await launchChromeWithExtension({ name: NAME, ignoreDefaultArgs });
const env = { ...process.env, CDP_RELAY_PORT: String(RELAY_PORT) };
const cli = (...a) => promisify(execFile)(process.execPath, ['cli.mjs', ...a, '--browser', NAME], { env }).then(r => r.stdout.trim());
const browsers = () => fetch(`${RELAY}/browsers`).then(r => r.json()).then(l => l.find(b => b.name === NAME));
const summary = {};
try {
  await waitForBrowser(NAME);

  // --- 前面にない・見えていないタブ(facade の browser WS = cli / puppeteer と同じ経路で作る) ---
  const ws = new WebSocket(`${RELAY.replace('http', 'ws')}/b/${NAME}/devtools/browser`); await new Promise(r => ws.once('open', r));
  let id = 0; const pend = new Map(), attachedQ = [];
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id) return pend.get(m.id)?.(m); if (m.method === 'Target.attachedToTarget') attachedQ.shift()?.(m.params); });
  const send = (method, params = {}, sessionId, ms = 10_000) => new Promise(r => { const i = ++id; pend.set(i, r); setTimeout(() => r({ timeout: ms }), ms); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const win = await worker.evaluate(() => chrome.windows.getLastFocused().then(w => w.id));
  const cases = {
    background: { background: true },
    switchedAway: { setup: () => worker.evaluate(url => chrome.tabs.create({ url, active: true }).then(t => t.id), `${site}/user`), teardown: tab => worker.evaluate(t => chrome.tabs.remove(t), tab) },
    minimized: { setup: () => worker.evaluate(w => chrome.windows.update(w, { state: 'minimized' }), win), teardown: () => worker.evaluate(w => chrome.windows.update(w, { state: 'normal' }), win) },
  };
  for (const [name, c] of Object.entries(cases)) {
    const since = (await relayEvents(NAME)).at(-1)?.seq ?? 0;
    const attached = new Promise(r => attachedQ.push(r));
    await send('Target.createTarget', { url: 'about:blank', background: !!c.background });
    const { sessionId, targetInfo } = await attached;
    const tabId = Number(sessionId.replace('session-', ''));
    const extra = await c.setup?.();
    await send('Page.navigate', { url: `${site}/alert?${name}` }, sessionId);
    await sleep(300 + TIMEOUT + 1500);
    const ev = await send('Runtime.evaluate', { expression: '({ pre: window.__pre, title: document.title })', returnByValue: true }, sessionId, 3000);
    const v = ev.result?.result?.value;
    const handled = (await relayEvents(NAME, since)).filter(e => e.type === 'dialog' && e.tabId === tabId);
    summary[name] = { ...v, handled: handled.map(e => e.action), responseTimedOut: !!ev.timeout };
    assert(v?.pre === 'hidden', `${name}: alert の時点でページは hidden(visibilityState=${v?.pre})`);
    assert(v.title === 'after-alert' && handled.length === 1 && handled[0].action === 'accept', `${name}: 中継が alert を検知して accept し、ページは先へ進む`);
    await c.teardown?.(extra);
    await send('Target.closeTarget', { targetId: targetInfo.targetId });
  }
  ws.close(); await sleep(300);

  // --- CLI のコマンドの合間(クライアント未接続)に開いた alert ---
  const read = join(out, 'read.mjs');
  writeFileSync(read, `export default async (b, page) => JSON.stringify(await page.evaluate(() => ({ title: document.title, input: document.getElementById('i').value })));\n`);
  let since = (await relayEvents(NAME)).at(-1)?.seq ?? 0;
  const url = await cli('goto', `${site}/idle`);
  const agentTab = (await browsers()).agentTabs.at(-1);
  for (let i = 0; i < 20 && !(await browsers()).attachedTabs.includes(agentTab); i++) await sleep(50); // 最後のクライアントが離れた直後は付け直しの往復中
  assert(url.endsWith('/idle') && (await browsers()).attachedTabs.includes(agentTab), `cli 終了後もエージェントのタブ(${agentTab})は中継が attach したまま`);
  await sleep(2000 + TIMEOUT + 1500); // alert → dialogTimeoutMs → 閉じる。この間クライアントは繋いでいない
  let evs = await relayEvents(NAME, since);
  assert(evs.some(e => e.type === 'dialog' && e.tabId === agentTab && e.action === 'accept'), 'クライアント未接続の間に開いた alert を中継が閉じる');
  const t0 = Date.now();
  const state = JSON.parse(await cli('run', read));
  summary.idle = { ...state, nextCommandMs: Date.now() - t0 };
  assert(state.input === 'typed-before-alert' && state.title === 'after-alert', `次のコマンドでページの状態が残っている(input="${state.input}")`);
  assert(!(await relayEvents(NAME, since)).some(e => e.type === 'tab.unresponsive'), '遷移し直し(tab.unresponsive)は起きない');

  // --- クライアントがダイアログを開いたまま離れた: 待たずに閉じてから付け直す(開いたまま付け直すと Page.enable が返らない) ---
  const leave = join(out, 'leave.mjs');
  writeFileSync(leave, `export default async (b, page) => { const d = new Promise(r => page.once('dialog', r)); await page.evaluate(() => { setTimeout(() => { alert('left behind'); document.title = 'after-left-behind'; }, 0); }); await d; return 'left'; };\n`);
  since = (await relayEvents(NAME)).at(-1).seq;
  assert(await cli('run', leave) === 'left', 'ダイアログを処理しないまま CLI が終了する(前提)');
  await sleep(500);
  evs = await relayEvents(NAME, since);
  const flushed = evs.find(e => e.type === 'dialog' && e.message === 'left behind');
  summary.leftBehind = flushed;
  assert(flushed?.reason === 'all clients left' && flushed.afterMs < TIMEOUT, `クライアントが離れた時点で dialogTimeoutMs を待たずに閉じる(${flushed?.afterMs}ms)`);
  const state2 = JSON.parse(await cli('run', read));
  assert(state2.title === 'after-left-behind' && state2.input === 'typed-before-alert' && !(await relayEvents(NAME, since)).some(e => e.type === 'tab.unresponsive'), '付け直した後も次のコマンドが普通に動く');

  // --- 拡張を再読み込みしても監視を続ける(開発者モードが OFF だと再読み込みした未パック拡張は無効化される: e2e-reconnect.mjs) ---
  const ext = await chrome.newPage(); await ext.goto('chrome://extensions');
  await ext.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })); await ext.close();
  const { connectedAt } = await browsers();
  await fetch(`${RELAY}/b/${NAME}/reload-extension`, { method: 'POST' });
  let b; for (let i = 0; i < 60; i++) { await sleep(250); b = await browsers(); if (b?.connectedAt !== connectedAt && b?.attachedTabs.includes(agentTab)) break; }
  assert(b?.connectedAt !== connectedAt && b.attachedTabs.includes(agentTab), '拡張の再接続後、エージェントのタブを attach し直す');
  since = (await relayEvents(NAME)).at(-1).seq;
  await chrome.targets().find(t => t.url().endsWith('/idle')).createCDPSession().then(s => s.send('Runtime.evaluate', { expression: `setTimeout(() => { alert('after reload'); document.title = 'after-reload-alert'; }, 500)` }).then(() => s.detach()));
  await sleep(500 + TIMEOUT + 1500);
  evs = await relayEvents(NAME, since);
  const closed = evs.find(e => e.type === 'dialog' && e.tabId === agentTab && e.message === 'after reload');
  const afterReload = JSON.parse(await cli('run', read));
  assert(closed && !closed.error && afterReload.title === 'after-reload-alert' && afterReload.input === 'typed-before-alert', `再接続後にクライアント未接続のまま開いた alert も閉じ、ページは先へ進む(title=${afterReload.title})`);

  // --- adopt を外すと中継の attach も外れる ---
  await fetch(`${RELAY}/b/${NAME}/tabs/${agentTab}/adopt`, { method: 'DELETE' });
  await sleep(300);
  assert(!(await browsers()).attachedTabs.includes(agentTab), 'エージェントのタブから外すと detach する');
  console.log('E2E-14 PASS');
} finally {
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  writeFileSync(join(out, 'events.json'), JSON.stringify(await relayEvents(NAME).catch(e => ({ error: e.message })), null, 1));
  writeFileSync(join(out, 'relay.log'), readFileSync(relayLog, 'utf8').slice(logStart));
  await chrome.close().catch(() => {}); relay.stop(); srv.close();
}
