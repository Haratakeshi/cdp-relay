// E2E-10: ダイアログ・オートパイロット。クライアントが処理しない JS ダイアログ / ファイル選択 / Basic 認証でエージェントが止まらないこと。
//  - puppeteer: page.on('dialog') なしの confirm/prompt/alert がポリシーどおり閉じられる / 自分で処理すれば中継は何もしない
//  - Playwright: リスナーなしは Playwright 自身が即 dismiss(中継は何もしない)/ 何もしないリスナーだけなら中継が閉じる
//  - 未 attach 中に出たダイアログで固まったタブに attach し直しても止まらない(同じ URL へ遷移し直す)
//  - Basic 認証: ポリシーに資格情報あり → 通る / なし → cancel で 401 / 資格情報が拒否 → 再送せず cancel / クライアントの Fetch 処理が優先
//  - ポリシーファイルの読み直し(削除で既定値に戻る)と 600 以外の警告
//  - scope: agentTabs(既定)ではユーザーのタブ(中継経由で作っていない・明示的に選んでいないタブ)に触らない。ダイアログで固まったユーザーのタブが
//    あっても Playwright / puppeteer は止まらずエージェントのタブを操作できる。scope: allTabs ではそのタブも遷移し直して片付ける
//  - 固まったユーザーのタブが複数あっても、接続の遅れは unresponsiveTimeoutMs 1 回分(probe は並列)
//  - CLI で既存タブを --tab で選ぶと、コマンドの実行中だけ adopt される
//  - Target.createTarget(url 付き)の読み込み直後のダイアログと 401 も処理する(about:blank で作って adopt してから遷移する)
//  - opener の継承: エージェントのタブからの window.open は引き継ぎ、Ctrl+T 相当(新規タブページ)は引き継がない
import puppeteer from 'puppeteer-core';
import { chromium } from 'playwright-core';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRelay, launchChromeWithExtension, waitForBrowser, RELAY, RELAY_PORT, sleep, assert, artifactsDir, relayEvents } from './harness.mjs';
import { DEFAULT_POLICY } from '../relay/policy.mjs';

const NAME = 'dlg';
const PORT = 9406; // 専用ポート(/events が /b/<name> なしで引けることを見る)
const TIMEOUT = 1500; // テスト用ポリシーの dialogTimeoutMs
const UNRESP = 1500; // テスト用ポリシーの unresponsiveTimeoutMs
const TOKEN = randomBytes(8).toString('hex'); // policy.auth は CDP_RELAY_TOKEN を設定した中継でだけ使われる
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const handler = (req, res) => {
  const page = html => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); };
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/alert-now') return page(`<title>alert-now</title><script>alert('right after creation'); document.title = 'after-alert'</script>`);
  if (path === '/late') return page(`<title>late</title><script>if (!sessionStorage.alerted) setTimeout(() => { sessionStorage.alerted = 1; alert('late alert'); }, 1000)</script>`);
  if (path === '/file') return page('<title>file</title><input type="file" id="f">');
  if (path === '/bu') return page(`<title>bu</title><button id="b">x</button><script>addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = ''; })</script>`);
  const need = { '/auth': basic('u', 'p'), '/auth-strict': basic('u2', 'p2') }[path];
  if (need && req.headers.authorization !== need) { res.writeHead(401, { 'www-authenticate': 'Basic realm="e2e"', 'content-type': 'text/html' }); return res.end('<title>401</title>'); }
  page(`<title>${need ? 'authed' : path.slice(1) || 'index'}</title><h1>${path}</h1>`);
};
const srv = http.createServer(handler), fresh = http.createServer(handler); // fresh: 一度も認証していないオリジン(Chrome の HTTP 認証キャッシュが効かない)
await new Promise(r => srv.listen(0, '127.0.0.1', r)); await new Promise(r => fresh.listen(0, '127.0.0.1', r));
const freshSite = `http://127.0.0.1:${fresh.address().port}`;
const site = `http://127.0.0.1:${srv.address().port}`;
const other = `http://localhost:${srv.address().port}`; // 同じサーバーだが別オリジン(ポリシーに資格情報なし)

const out = artifactsDir('e2e-dialogs');
const policyPath = join(out, 'policy.json');
const writePolicy = (mode = 0o600, extra = {}) => { writeFileSync(policyPath, JSON.stringify({ ...extra, dialogTimeoutMs: TIMEOUT, unresponsiveTimeoutMs: UNRESP, dialogs: { alert: 'accept', confirm: 'accept', prompt: 'accept', beforeunload: 'accept' }, fileChooser: 'intercept', auth: { [site]: { username: 'u', password: 'p' }, [freshSite]: { username: 'u', password: 'p' } } }, null, 1)); chmodSync(policyPath, mode); };
writePolicy(0o644); // まず 644 で警告が出ることを見る
const relayLog = `tmp/relay-${RELAY_PORT}.log`;
const logStart = readFileSync(relayLog, { flag: 'a+' }).length;
const relay = await startRelay({ CDP_RELAY_POLICY: policyPath, CDP_RELAY_TOKEN: TOKEN });
const { browser: chrome, worker } = await launchChromeWithExtension({ name: NAME, port: PORT, token: TOKEN });
const browsers = () => fetch(`${RELAY}/browsers`).then(r => r.json()).then(l => l.find(b => b.name === NAME));
const userTab = async path => { await worker.evaluate(url => chrome.tabs.create({ url, active: false }), site + path); await sleep(500); return (await fetch(`${RELAY}/b/${NAME}/json/list`).then(r => r.json())).find(t => t.url.endsWith(path)); };
// ユーザーのタブでダイアログが開いたままか: 中継を通さず、テスト用の直結(pipe)セッションで評価が返らないことを見る
const blockedByDialog = async path => { const t = chrome.targets().find(x => x.url().endsWith(path)); const s = await t.createCDPSession(); const r = await Promise.race([s.send('Runtime.evaluate', { expression: '1' }).then(() => false), sleep(1000).then(() => true)]); await s.detach().catch(() => {}); return r; };
const timed = async p => { const t0 = Date.now(); const v = await p; return [v, Date.now() - t0]; };
const summary = {};
try {
  await waitForBrowser(NAME);
  await sleep(300);
  assert(readFileSync(relayLog, 'utf8').slice(logStart).includes('is mode 644'), 'policy.json が 600 でなければ中継ログに警告');
  writePolicy();

  // --- puppeteer: dialog リスナーなし → 中継がポリシーどおり閉じる(ポリシーは既定と逆の confirm/prompt=accept にしてファイルが効いていることを見る) ---
  const pb = await puppeteer.connect({ browserURL: `${RELAY}/b/${NAME}`, defaultViewport: null, protocolTimeout: 30_000 });
  const page = await pb.newPage();
  await page.goto(site + '/p');
  let since = (await relayEvents(NAME)).at(-1)?.seq ?? 0;
  const [c, tc] = await timed(page.evaluate(() => confirm('continue?')));
  assert(c === true && tc >= TIMEOUT - 100, `puppeteer: 放置した confirm を ${tc}ms 後に accept(policy)→ ${c}`);
  const [p, tp] = await timed(page.evaluate(() => prompt('name?', 'dflt')));
  assert(p === 'dflt' && tp >= TIMEOUT - 100, `puppeteer: 放置した prompt を accept → 既定値 "${p}"`);
  const [a] = await timed(page.evaluate(() => alert('hello') ?? 'returned'));
  assert(a === 'returned', 'puppeteer: 放置した alert も閉じられて evaluate が返る');
  let ev = (await relayEvents(NAME, since)).filter(e => e.type === 'dialog');
  assert(ev.length === 3 && ev.map(e => `${e.dialogType}:${e.action}`).join() === 'confirm:accept,prompt:accept,alert:accept', `events: ${ev.map(e => `${e.dialogType}:${e.action}`).join(', ')}`);

  // --- puppeteer: クライアントが自分で処理 → 中継は何もしない ---
  since = ev.at(-1).seq;
  const own = d => d.accept('mine');
  page.on('dialog', own);
  const [mine, tm] = await timed(page.evaluate(() => prompt('name?', 'dflt')));
  await sleep(TIMEOUT + 500);
  assert(mine === 'mine' && tm < TIMEOUT && (await relayEvents(NAME, since)).filter(e => e.type === 'dialog').length === 0, `puppeteer: 自分で処理した prompt(${tm}ms)には中継が手を出さない`);
  page.off('dialog', own);

  // --- beforeunload: 放置すると遷移が止まる → 中継が accept して遷移が進む ---
  await page.goto(site + '/bu'); await page.click('#b'); // beforeunload はユーザー操作の後だけ出る
  const [, tb] = await timed(page.goto(site + '/after-bu'));
  ev = (await relayEvents(NAME, since)).filter(e => e.type === 'dialog');
  assert(await page.title() === 'after-bu' && ev.some(e => e.dialogType === 'beforeunload' && e.action === 'accept'), `beforeunload を accept して遷移が完了(${tb}ms)`);

  // --- ファイル選択: 待たずにクリック → ネイティブの選択画面を出さずイベント化 / waitForFileChooser なら従来どおり使える ---
  await page.goto(site + '/file');
  since = (await relayEvents(NAME)).at(-1).seq;
  await page.click('#f');
  assert(await page.evaluate(() => 1 + 1) === 2, 'ファイル選択を誰も待っていなくてもページは操作可能');
  await sleep(200);
  ev = (await relayEvents(NAME, since)).filter(e => e.type === 'fileChooser');
  assert(ev.length === 1 && ev[0].mode === 'selectSingle' && ev[0].backendNodeId, `fileChooser を記録(mode=${ev[0]?.mode})`);
  const upload = join(out, 'upload.txt'); writeFileSync(upload, 'upload me');
  const [fc] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click('#f')]);
  await fc.accept([upload]);
  assert(await page.$eval('#f', e => e.files[0]?.name) === 'upload.txt', 'waitForFileChooser + accept でファイルを設定できる(中継の intercept と共存)');

  // --- Basic 認証 ---
  const r1 = await page.goto(site + '/auth');
  assert(r1.status() === 200 && await page.title() === 'authed', `ポリシーの資格情報で認証が通る(${site})`);
  await page.screenshot({ path: join(out, 'auth-policy.png') });
  const [r2, t2] = await timed(page.goto(other + '/auth'));
  assert(r2.status() === 401, `資格情報のないオリジン(${other})は cancel → 401 で止まらない(${t2}ms)`);
  const [r3, t3] = await timed(page.goto(site + '/auth-strict'));
  assert(r3.status() === 401 && t3 < 5000, `資格情報が拒否されたら同じ資格情報を再送せず cancel(${t3}ms)`);
  await page.authenticate({ username: 'u', password: 'p' }); // puppeteer は Fetch.enable({handleAuthRequests:true}) で自分で応答する
  const r4 = await page.goto(other + '/auth');
  assert(r4.status() === 200, 'クライアントが Fetch で認証を処理する場合はクライアントが優先(ポリシーに無いオリジンでも通る)');
  await page.authenticate(null);
  const auth = (await relayEvents(NAME)).filter(e => e.type === 'auth');
  assert(auth.map(e => e.decision.split(' ')[0]).join() === 'policy,cancel,policy,cancel', `auth events: ${auth.map(e => `${e.origin} ${e.decision}`).join(' | ')}`);
  assert(!JSON.stringify(auth).includes('"p"') && !readFileSync(relayLog, 'utf8').slice(logStart).includes('"password"'), '記録とログに資格情報が出ない');
  await page.close();
  pb.disconnect();

  // --- 未 attach 中に出たダイアログ: attach し直すと Page.enable すら返らない(実測)→ dialogTimeoutMs 後に同じ URL へ遷移し直して止まらない。
  // エージェントのタブはクライアントが離れても中継が attach し続けるので、未 attach のまま alert が出るのは中継がまだ触っていないタブ ---
  const tab = await userTab('/late?reattach'); await sleep(1500); // /late は 1 秒後に alert(誰も attach していない)
  const raw = () => { const ws = new WebSocket(tab.webSocketDebuggerUrl); let id = 0; const pend = new Map(); ws.on('message', m => { m = JSON.parse(m); pend.get(m.id)?.(m); }); return { ws, open: new Promise(r => ws.once('open', r)), send: (method, params) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => r({ error: { message: 'no response in 15s' } }), 15_000); }) }; };
  since = (await relayEvents(NAME)).at(-1).seq;
  const w2 = raw(); await w2.open;
  const [r5, t5] = await timed(w2.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }));
  await sleep(300);
  const un = (await relayEvents(NAME, since)).filter(e => e.type === 'tab.unresponsive');
  assert(un.length === 1 && un[0].action === 'renavigate' && t5 < UNRESP + 3000, `attach 前からのダイアログで固まったタブ: ${t5}ms 後に復帰(${JSON.stringify(r5.result ?? r5.error).slice(0, 80)})`);
  const r6 = await w2.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  assert(r6.result?.result?.value === 'late', '遷移し直した後は通常どおり操作できる');
  // chrome.debugger のセッションは全クライアント共有。1 クライアントの Page.disable で中継のダイアログ検知を止めない
  since = (await relayEvents(NAME)).at(-1).seq;
  await w2.send('Page.disable');
  const r7 = await w2.send('Runtime.evaluate', { expression: 'confirm("after disable")', returnByValue: true });
  assert(r7.result?.result?.value === true && (await relayEvents(NAME, since)).some(e => e.type === 'dialog'), 'クライアントが Page.disable してもダイアログは中継が閉じる');
  w2.ws.close(); await sleep(300);

  // --- Playwright ---
  const pw = await chromium.connectOverCDP(`${RELAY}/b/${NAME}`, { timeout: 30_000 });
  const pp = await pw.contexts()[0].newPage();
  await pp.goto(site + '/pw');
  since = (await relayEvents(NAME)).at(-1).seq;
  const [pc, tpc] = await timed(pp.evaluate(() => confirm('pw?')));
  await sleep(TIMEOUT + 500);
  assert(pc === false && tpc < TIMEOUT && (await relayEvents(NAME, since)).filter(e => e.type === 'dialog').length === 0, `Playwright: リスナーなしは Playwright 自身が即 dismiss(${tpc}ms)、中継は何もしない`);
  pp.on('dialog', () => {}); // リスナーがあると Playwright は閉じない。放置されたので中継が閉じる
  const [pc2, tpc2] = await timed(pp.evaluate(() => confirm('pw2?')));
  assert(pc2 === true && tpc2 >= TIMEOUT - 100, `Playwright: 何もしないリスナーだけなら中継が ${tpc2}ms 後に accept`);
  const pr = await pp.goto(site + '/auth');
  assert(pr.status() === 200, 'Playwright でもポリシーの資格情報で Basic 認証が通る');
  await pp.screenshot({ path: join(out, 'playwright-auth.png') });
  await pp.close(); await pw.close();

  // --- scope: agentTabs(既定)。ユーザーのタブ(拡張から直接開いた = 中継経由でないタブ)で alert が開いたまま、クライアントが接続する ---
  const ut = await userTab('/late?user'), utb = await userTab('/late?userb'); await sleep(1500); // /late は 1 秒後に alert
  since = (await relayEvents(NAME)).at(-1).seq;
  const [pw2, tconn] = await timed(chromium.connectOverCDP(`${RELAY}/b/${NAME}`, { timeout: 30_000 }));
  const pp2 = await pw2.contexts()[0].newPage(); await pp2.goto(site + '/agent-pw');
  assert(await pp2.title() === 'agent-pw' && !pw2.contexts()[0].pages().some(p => /\/late\?user/.test(p.url())), `Playwright: 固まったユーザーのタブがあっても止まらず(接続 ${tconn}ms)、そのタブは見せずにエージェントのタブを操作できる`);
  assert(tconn < 2 * UNRESP, `固まったタブ 2 つの probe は並列: 接続の遅れは unresponsiveTimeoutMs 1 回分(${tconn}ms < ${2 * UNRESP}ms)`);
  const pb3 = await puppeteer.connect({ browserURL: `${RELAY}/b/${NAME}`, defaultViewport: null, protocolTimeout: 30_000 });
  const [pages3, tpages] = await timed(pb3.pages());
  const page3 = await pb3.newPage(); await page3.goto(site + '/agent-pptr');
  assert(await page3.title() === 'agent-pptr' && !pages3.some(p => p.url().endsWith('/late?user')), `puppeteer: pages()(${tpages}ms)も newPage も止まらない`);
  let evs = await relayEvents(NAME, since);
  assert(evs.some(e => e.type === 'tab.unresponsive' && e.tabId === ut.tabId && /hidden/.test(e.action)) && !evs.some(e => e.tabId === ut.tabId && (e.type === 'dialog' || e.action === 'renavigate')), 'ユーザーのタブは記録だけして隠す(自動応答も遷移し直しもしない)');
  assert((await fetch(`${RELAY}/b/${NAME}/json/list`).then(r => r.json())).find(t => t.tabId === ut.tabId)?.url.endsWith('/late?user') && await blockedByDialog('/late?user'), 'ユーザーのタブは URL もダイアログもそのまま');
  assert(!(await browsers()).agentTabs.includes(ut.tabId), 'ユーザーのタブはエージェントのタブに入っていない');
  await page3.close(); pb3.disconnect(); await pp2.close(); await pw2.close(); await sleep(300);

  // --- CLI で既存タブを --tab で選ぶと、コマンドの実行中だけ adopt される ---
  const ct = await userTab('/cli-target');
  const probeScript = join(out, 'cli-agent-tabs.mjs');
  writeFileSync(probeScript, `export default async (browser, page, puppeteer, args) => ({ url: page.url(), agentTabs: (await (await fetch(args.url)).json()).find(b => b.name === args.name).agentTabs });\n`);
  const cliOut = await promisify(execFile)(process.execPath, ['cli.mjs', 'run', probeScript, '--browser', NAME, '--tab', '/cli-target', '--args', JSON.stringify({ url: `${RELAY}/browsers`, name: NAME })], { env: { ...process.env, CDP_RELAY_PORT: String(RELAY_PORT) } });
  const during = JSON.parse(cliOut.stdout);
  assert(during.url.endsWith('/cli-target') && during.agentTabs.includes(ct.tabId) && !(await browsers()).agentTabs.includes(ct.tabId), `CLI の --tab: 実行中だけエージェントのタブ、終了後は外れる(tab ${ct.tabId})`);

  // --- Target.createTarget(url 付き)の読み込み直後のダイアログと 401 / opener の継承 ---
  const raw2 = new WebSocket(`${RELAY.replace('http', 'ws')}/b/${NAME}/devtools/browser`); await new Promise(r => raw2.once('open', r));
  let fid = 0; const fsend = (method, params, sessionId) => new Promise(r => { const id = ++fid; raw2.on('message', m => { m = JSON.parse(m); if (m.id === id) r(m); }); raw2.send(JSON.stringify({ id, method, params, sessionId })); });
  await fsend('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  since = (await relayEvents(NAME)).at(-1).seq;
  const tabOf = async targetId => (await fetch(`${RELAY}/b/${NAME}/json/list`).then(r => r.json())).find(t => t.id === targetId);
  const nowTab = await tabOf((await fsend('Target.createTarget', { url: site + '/alert-now' })).result.targetId);
  const authTab = await tabOf((await fsend('Target.createTarget', { url: freshSite + '/auth' })).result.targetId);
  await sleep(TIMEOUT + 800);
  evs = await relayEvents(NAME, since);
  assert(evs.some(e => e.type === 'dialog' && e.tabId === nowTab.tabId && e.url.endsWith('/alert-now')), 'createTarget の読み込み直後のダイアログも中継が閉じる');
  assert(evs.some(e => e.type === 'auth' && e.tabId === authTab.tabId && e.decision === 'policy credentials') && (await tabOf(authTab.id)).title === 'authed', 'createTarget の読み込み直後の 401 もポリシーの資格情報で通る');
  const ntp = await worker.evaluate(opener => chrome.tabs.create({ openerTabId: opener, active: false }).then(t => t.id), nowTab.tabId); // Ctrl+T 相当(新規タブページ)
  await fsend('Runtime.evaluate', { expression: `window.open('/popup-target')`, userGesture: true }, `session-${nowTab.tabId}`);
  await sleep(800);
  const popup = (await fetch(`${RELAY}/b/${NAME}/json/list`).then(r => r.json())).find(t => t.url.endsWith('/popup-target'));
  const at = (await browsers()).agentTabs;
  assert(popup && at.includes(popup.tabId) && !at.includes(ntp), `エージェントのタブからの window.open は引き継ぎ(tab ${popup?.tabId})、新規タブページ(tab ${ntp})は引き継がない`);
  raw2.close(); await sleep(300);

  // --- scope: allTabs(外出中モード)。ユーザーのタブも自動処理の対象で、固まっていれば遷移し直す ---
  writePolicy(0o600, { scope: 'allTabs' });
  const ut2 = await userTab('/late?user2'); await sleep(1500);
  since = (await relayEvents(NAME)).at(-1).seq;
  const [pw3, tconn3] = await timed(chromium.connectOverCDP(`${RELAY}/b/${NAME}`, { timeout: 30_000 }));
  await sleep(UNRESP + 1000);
  evs = (await relayEvents(NAME, since)).filter(e => e.type === 'tab.unresponsive' && e.action === 'renavigate');
  assert([ut.tabId, utb.tabId, ut2.tabId].every(id => evs.some(e => e.tabId === id)), `allTabs: 固まったユーザーのタブ 3 つを遷移し直す(接続 ${tconn3}ms)`);
  assert(!(await blockedByDialog('/late?user')) && !(await blockedByDialog('/late?userb')) && !(await blockedByDialog('/late?user2')), 'allTabs: 遷移し直したタブはダイアログが閉じて操作できる');
  await pw3.close(); await sleep(300);
  writePolicy();

  // --- ポリシーファイルを消すと既定値(confirm=dismiss, 8 秒)に戻る(常駐中継を再起動せず反映) ---
  rmSync(policyPath);
  const pb2 = await puppeteer.connect({ browserURL: `${RELAY}/b/${NAME}`, defaultViewport: null, protocolTimeout: 30_000 });
  const page2 = await pb2.newPage(); await page2.goto(site + '/defaults');
  const [d, td] = await timed(page2.evaluate(() => confirm('default?')));
  assert(d === false && td >= DEFAULT_POLICY.dialogTimeoutMs - 100, `ポリシーなし: 既定値で ${td}ms 後に dismiss`);
  summary.timings = { confirm: tc, prompt: tp, beforeunload: tb, reattach: t5, playwrightAuto: tpc, playwrightRelay: tpc2, defaults: td, connectWithStuckUserTab: tconn, puppeteerPages: tpages, connectAllTabs: tconn3 };
  await page2.close(); pb2.disconnect();
  const dedicated = await fetch(`http://127.0.0.1:${PORT}/events`).then(r => r.json());
  assert(Array.isArray(dedicated) && dedicated.length > 0 && dedicated.at(-1).seq === (await relayEvents(NAME)).at(-1).seq, `専用ポートの /events で同じ記録が取れる(${dedicated.length} 件)`);
  console.log('E2E-10 PASS');
} finally {
  writeFileSync(join(out, 'events.json'), JSON.stringify(await relayEvents(NAME).catch(e => ({ error: e.message })), null, 1));
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  writeFileSync(join(out, 'relay.log'), readFileSync(relayLog, 'utf8').slice(logStart));
  await chrome.close().catch(() => {}); relay.stop(); srv.close(); fresh.close();
}
