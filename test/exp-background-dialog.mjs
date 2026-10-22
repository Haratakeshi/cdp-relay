// 実験: 前面にない・見えていないタブで開いた JS ダイアログを、中継が検知して閉じられるか(背面タブのダイアログ検知の検証)。
// 条件ごとに 3 層で観測する: 拡張(chrome.debugger.onEvent)/ 中継のクライアント(facade 経由の CDP イベント)/ レンダラー(Runtime.evaluate が返るか)。
// ページは alert の直前の visibilityState / hasFocus を window.__pre に残す(本当に見えていない状態で alert したかを確かめる)。
// 既定はヘッドレス。HEADED=1 で画面つき(前面・背面・最小化・被覆の違いは画面つきでしか出ない可能性がある)。
// puppeteer の既定引数のうち、見えないタブ・ウィンドウの扱いを実ブラウザと変えるものは外す(--disable-backgrounding-occluded-windows 等が
// あると最小化・被覆・タブ切替でも visibilityState が visible のままになる。実測)。PPTR_ARGS=1 で puppeteer の既定のまま起動する
import http from 'node:http';
import { WebSocket } from 'ws';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRelay, launchChromeWithExtension, waitForBrowser, RELAY, RELAY_PORT, HEADED, sleep, artifactsDir, relayEvents } from './harness.mjs';

const NAME = 'bgdlg';
const TIMEOUT = 1500; // テスト用ポリシーの dialogTimeoutMs / unresponsiveTimeoutMs
const ALERT_DELAY = 300; // 実ブラウザで失敗したときと同じ(読み込みから 300ms 後に alert)

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const d = Number(u.searchParams.get('d') ?? ALERT_DELAY);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (u.pathname !== '/alert') return res.end(`<title>${u.pathname.slice(1)}</title>`);
  res.end(`<title>loaded</title><script>setTimeout(() => { window.__pre = { visibility: document.visibilityState, focus: document.hasFocus(), at: Date.now() }; alert('bg?'); document.title = 'after-alert'; }, ${d})</script>`);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${srv.address().port}`;

const out = artifactsDir(`exp-background-dialog-${HEADED ? 'headed' : 'headless'}${process.env.PPTR_ARGS === '1' ? '-pptrargs' : ''}`);
const policyPath = join(out, 'policy.json');
writeFileSync(policyPath, JSON.stringify({ dialogTimeoutMs: TIMEOUT, unresponsiveTimeoutMs: TIMEOUT }), { mode: 0o600 });
const relayLog = `tmp/relay-${RELAY_PORT}.log`;
const logStart = readFileSync(relayLog, { flag: 'a+' }).length;
const relay = await startRelay({ CDP_RELAY_POLICY: policyPath });
const REAL_LIKE = process.env.PPTR_ARGS !== '1';
const ignoreDefaultArgs = REAL_LIKE ? ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-ipc-flooding-protection', '--disable-hang-monitor', '--enable-automation', '--allow-pre-commit-input'] : undefined;
const launched = await launchChromeWithExtension({ name: NAME, ignoreDefaultArgs });
const chrome = launched.browser;
let worker = launched.worker;

// 拡張の層: chrome.debugger.onEvent をそのまま記録する(中継へ送る前の事実)
const instrument = () => worker.evaluate(() => {
  globalThis.__dbg = [];
  chrome.debugger.onEvent.addListener((s, method) => { if (/^Page\.(javascriptDialog|loadEventFired|lifecycleEvent)/.test(method)) globalThis.__dbg.push({ t: Date.now(), tabId: s.tabId, method }); });
});
const extEvents = tabId => worker.evaluate(id => globalThis.__dbg.filter(e => e.tabId === id), tabId);
const tabState = tabId => worker.evaluate(async id => {
  const t = await chrome.tabs.get(id); const w = await chrome.windows.get(t.windowId);
  return { active: t.active, discarded: t.discarded, frozen: t.frozen, status: t.status, title: t.title, windowState: w.state, windowFocused: w.focused };
}, tabId);

// 中継のクライアントの層: facade の browser WS(cli.mjs / puppeteer と同じ経路)
let client;
function openClient() {
  const ws = new WebSocket(`${RELAY.replace('http', 'ws')}/b/${NAME}/devtools/browser`);
  const pend = new Map(), stream = [], waiters = [];
  let id = 0;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id) return pend.get(m.id)?.(m);
    stream.push({ t: Date.now(), sessionId: m.sessionId, method: m.method, params: m.params });
    for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const send = (method, params = {}, sessionId, timeoutMs = 10_000) => new Promise(r => {
    const i = ++id; const t = setTimeout(() => { pend.delete(i); r({ timeout: timeoutMs }); }, timeoutMs);
    pend.set(i, m => { clearTimeout(t); pend.delete(i); r(m); });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const waitFor = (test, ms = 10_000) => new Promise((resolve, reject) => { waiters.push({ test, resolve }); setTimeout(() => reject(new Error('waitFor timeout')), ms); });
  return { ws, send, stream, waitFor, open: new Promise(r => ws.once('open', r)) };
}
async function connectClient() {
  client = openClient(); await client.open;
  await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
}

const results = {};
const since = async () => (await relayEvents(NAME)).at(-1)?.seq ?? 0;
async function scenario(name, { background = false, setup, afterNavigate, delay = ALERT_DELAY, observeMs = delay + TIMEOUT + 2500 } = {}) {
  console.log(`--- ${name}`);
  const t0 = Date.now(), seq0 = await since();
  const attached = client.waitFor(m => m.method === 'Target.attachedToTarget');
  const created = await client.send('Target.createTarget', { url: 'about:blank', background });
  const { sessionId, targetInfo } = (await attached).params;
  const tabId = Number(sessionId.replace('session-', ''));
  const r = { background, tabId, targetId: created.result?.targetId ?? targetInfo.targetId };
  await client.send('Page.enable', {}, sessionId);
  r.setup = setup ? await setup(tabId) : undefined;
  r.stateBeforeNavigate = await tabState(tabId);
  const nav = await client.send('Page.navigate', { url: `${site}/alert?d=${delay}&s=${name}` }, sessionId, 10_000);
  r.navigate = nav.timeout ? `timeout ${nav.timeout}ms` : nav.error ? `error ${nav.error.message}` : 'ok';
  r.afterNavigate = afterNavigate ? await afterNavigate(tabId, sessionId) : undefined;
  await sleep(observeMs);
  r.stateAfter = await tabState(tabId);
  const ev = await client.send('Runtime.evaluate', { expression: '({ title: document.title, preAlert: window.__pre, now: document.visibilityState })', returnByValue: true }, sessionId, 3000);
  r.rendererResponsive = !ev.timeout;
  r.evaluate = ev.timeout ? 'blocked (no response in 3000ms)' : ev.result?.result?.value ?? ev.error?.message;
  const summarize = () => ({
    ext: [], // 下で埋める
    client: client.stream.filter(e => e.sessionId === sessionId && e.method.startsWith('Page.javascriptDialog')).map(e => ({ ms: e.t - t0, method: e.method })),
  });
  const layers = summarize();
  layers.ext = (await extEvents(tabId)).map(e => ({ ms: e.t - t0, method: e.method }));
  layers.relayAutopilot = (await relayEvents(NAME, seq0)).filter(e => e.tabId === tabId).map(e => ({ type: e.type, action: e.action, error: e.error }));
  r.observed = layers;
  // 止まっていたら: タブを前面に出して(ウィンドウも通常状態へ)、イベントが出て中継が片付けるかを見る
  if (!r.rendererResponsive) {
    const t1 = Date.now();
    await worker.evaluate(async id => { const t = await chrome.tabs.update(id, { active: true }); await chrome.windows.update(t.windowId, { state: 'normal', focused: true }); }, tabId);
    await sleep(TIMEOUT + 2000);
    const ev2 = await client.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId, 3000);
    r.recoveryByActivate = {
      rendererResponsive: !ev2.timeout, evaluate: ev2.timeout ? 'blocked' : ev2.result?.result?.value,
      ext: (await extEvents(tabId)).filter(e => e.t >= t1).map(e => ({ ms: e.t - t1, method: e.method })),
      client: client.stream.filter(e => e.sessionId === sessionId && e.t >= t1 && e.method.startsWith('Page.javascriptDialog')).map(e => ({ ms: e.t - t1, method: e.method })),
      relayAutopilot: (await relayEvents(NAME, seq0)).filter(e => e.tabId === tabId).map(e => ({ type: e.type, action: e.action, error: e.error })),
    };
  }
  await client.send('Target.closeTarget', { targetId: r.targetId }, undefined, 5000);
  results[name] = r;
  console.log(JSON.stringify(r));
}

try {
  await waitForBrowser(NAME);
  await instrument();
  await connectClient();
  const win = await worker.evaluate(() => chrome.windows.getLastFocused().then(w => ({ id: w.id, left: w.left, top: w.top, width: w.width, height: w.height })));
  let extra;

  await scenario('foreground');
  await scenario('background', { background: true });
  // 実ブラウザでの失敗の形: 前面で作られた後、ユーザーが同じウィンドウの別のタブ(chrome://extensions)へ戻った
  await scenario('switchedAway', {
    setup: async () => { extra = await worker.evaluate(url => chrome.tabs.create({ url, active: true }).then(t => t.id), `${site}/user`); return { userTab: extra }; },
  });
  await worker.evaluate(id => chrome.tabs.remove(id), extra);
  await scenario('minimized', { setup: async tabId => worker.evaluate(async id => { const t = await chrome.tabs.get(id); await chrome.windows.update(t.windowId, { state: 'minimized' }); return (await chrome.windows.get(t.windowId)).state; }, tabId) });
  await worker.evaluate(id => chrome.windows.update(id, { state: 'normal' }), win.id);
  // 別のウィンドウに完全に覆われる(ディスプレイ消灯・画面ロック時の「全ウィンドウが見えない」に近い)
  await scenario('occluded', {
    setup: async () => { extra = await worker.evaluate(w => chrome.windows.create({ url: 'about:blank', focused: true, left: w.left, top: w.top, width: w.width, height: w.height }).then(x => x.id), win); return { coverWindow: extra }; },
  });
  await worker.evaluate(id => chrome.windows.remove(id), extra);
  // 長く背面にあったタブの凍結(Chrome の省エネ機能)の模擬: タイマーが動かないので alert 自体が出ない
  await scenario('frozen', { delay: 1500, afterNavigate: async (_tabId, sid) => { await sleep(500); const f = await client.send('Page.setWebLifecycleState', { state: 'frozen' }, sid, 5000); return { freeze: f.timeout ? 'timeout' : f.error?.message ?? 'ok' }; } });
  // 拡張を再読み込みした直後(実ブラウザでの失敗は拡張の再読み込みから約 100 秒後)。
  // 開発者モードが OFF だと再読み込みした未パック拡張は無効化される(e2e-reconnect.mjs と同じく ON にする)
  const ext = await chrome.newPage(); await ext.goto('chrome://extensions');
  await ext.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })); await ext.close();
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  client.ws.close();
  await sleep(1000);
  await waitForBrowser(NAME); await sleep(500);
  for (let i = 0; i < 20; i++) { // 古い SW のターゲットが残っている間は evaluate が失敗する。新しい SW で評価できるまで取り直す
    const sw = chrome.targets().filter(t => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${launched.extId}/`)).at(-1);
    worker = await sw?.worker().catch(() => null);
    if (worker && await worker.evaluate(() => 1).catch(() => 0)) break;
    await sleep(250);
  }
  await instrument(); await connectClient();
  await scenario('afterExtensionReload');
} finally {
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));
  writeFileSync(join(out, 'relay.log'), readFileSync(relayLog, 'utf8').slice(logStart));
  console.log('artifacts:', out);
  await chrome.close().catch(() => {}); relay.stop(); srv.close();
}
