// E2E-13: 中継の防御(ブラウザ起動なし。拡張はスタブの WebSocket クライアントで代用する)
//  - Origin / Host の検査: /extension は chrome-extension:// の Origin のみ。クライアント用の WS / HTTP は Origin 付き(= ブラウザのページから)を拒否。
//    Host は 127.0.0.1 / localhost / [::1] と CDP_RELAY_ALLOWED_HOSTS のみ(DNS rebinding 対策)。reload-extension は /b/<name> 必須
//  - Basic 認証の資格情報: CDP_RELAY_TOKEN 未設定なら渡さない。設定時もエージェントのタブ・attach 中・同一オリジン(または遷移)だけ
//  - 不正なポリシー / 不正なイベントで中継が落ちない
//  - 危険なダウンロードは承認せず、dialogTimeoutMs 後に cancel して canceled を送る(判定待ちの asyncScanning は待つ)
//  - ダウンロード: onCreated が downloadWillBegin より先でも対応付ける / 対応付かないまま完了したら保存先を期待するクライアントに canceled /
//    配置の結果はクライアントごと(置けたら completed、失敗したら canceled)
//  - adopt の解除(DELETE)、opener の継承は新規タブページでないときだけ
//  - ポリシー: 不正な origin キーは捨てて残りを使い、後始末の clear は必ず送る / タイムアウトの上限 2^31-1 / ポリシーから消した型も clear する
//  - エージェントのタブの watch(中継自身の attach 参照): attach の往復中に unadopt → 再 adopt しても参照が漏れない / ブラウザ側から detach された
//    古いページ WS の遅れた close が、後から繋いだクライアントの参照を減らさない(ダイアログを奪わない)/ 次のクライアントの接続で監視が戻る
//  - クライアント認証(CDP_RELAY_CLIENT_AUTH=1): TCP 側の HTTP / WS / 近道 API / 専用ポートはヘッダのトークンなしで 401。/extension は対象外。
//    トークンは 0600 のファイルに自動生成して再起動後も同じ値、ログに出さない、CLI は自動で読む
//  - MCP シムが中継を起こし直すときは前回の CDP_RELAY_* を引き継ぐ(認証が外れない)。一度も起動していなければ clone の中継を起動する
import http from 'node:http';
import { WebSocket } from 'ws';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startRelay, RELAY, RELAY_PORT, sleep, assert, artifactsDir } from './harness.mjs';

const out = artifactsDir('e2e-hardening');
const policyPath = join(out, 'policy.json');
const writePolicy = p => { writeFileSync(policyPath, typeof p === 'string' ? p : JSON.stringify(p, null, 1)); chmodSync(policyPath, 0o600); };
const relayLog = `tmp/relay-${RELAY_PORT}.log`;
const logStart = readFileSync(relayLog, { flag: 'a+' }).length;
const logSince = () => readFileSync(relayLog, 'utf8').slice(logStart);
const TAB = 7; // スタブのタブ
const INFO = { name: 'v', userAgent: 'Mozilla/5.0 Chrome/152.0.0.0', version: '0.2.0', attached: [], features: ['auth', 'downloads', 'contentSettings', 'reload'], contentSettingTypes: ['location', 'notifications', 'camera', 'microphone', 'clipboard', 'popups'] };

/** 拡張のスタブ。受けた呼び出しを calls に残す。gate(m) が Promise を返したら、それが解決するまで応答を保留する(到着順の制御) */
function stubExtension(name, { origin = 'chrome-extension://stub', token, port } = {}) {
  const calls = [];
  const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/extension?name=${name}${token ? `&token=${token}` : ''}${port ? `&port=${port}` : ''}`, origin ? { headers: { Origin: origin } } : {});
  const stub = { ws, calls, gate: undefined };
  ws.on('message', async raw => {
    const m = JSON.parse(raw); calls.push(m);
    const result = { 'ext.info': INFO, 'ext.listTabs': [{ tabId: TAB, targetId: 'T7', url: 'https://intra.example.com/', title: '' }], 'ext.setContentSettings': { errors: [] } }[m.method] ?? {};
    const hold = stub.gate?.(m);
    if (hold) await hold;
    ws.send(JSON.stringify({ id: m.id, result }));
  });
  stub.opened = new Promise((res, rej) => { ws.once('open', res); ws.once('unexpected-response', (_, r) => rej(new Error(`HTTP ${r.statusCode}`))); ws.once('error', rej); });
  stub.emit = (event, data) => ws.send(JSON.stringify({ event, ...data }));
  return stub;
}
const status = p => p.then(() => 'open', e => e.message);
const wsStatus = (url, headers) => status(new Promise((res, rej) => { const w = new WebSocket(url, { headers }); w.once('open', () => { w.close(); res(); }); w.once('unexpected-response', (_, r) => rej(new Error(`HTTP ${r.statusCode}`))); w.once('error', rej); }));
const httpStatus = (path, headers = {}, method = 'GET') => new Promise(res => http.request({ host: '127.0.0.1', port: RELAY_PORT, path, method, headers }, r => { r.resume(); res(r.statusCode); }).end());
const facade = name => { const w = new WebSocket(`${RELAY.replace('http', 'ws')}/b/${name}/devtools/browser`); const evs = []; let id = 0; const pend = new Map(); w.on('message', raw => { const m = JSON.parse(raw); if (m.id) pend.get(m.id)?.(m); else evs.push(m); }); return { w, evs, open: new Promise(r => w.once('open', r)), send: (method, params) => new Promise(r => { pend.set(++id, r); w.send(JSON.stringify({ id, method, params })); }) }; };
const alive = () => fetch(`${RELAY}/browsers`).then(r => r.ok, () => false);
const summary = {};
const POLICY_RELOAD_MS = 1500; // 中継は policy.json を 1 秒間隔で見ている(と参照のたびに読み直す)

writePolicy({ dialogTimeoutMs: 500, auth: { 'https://intra.example.com': { username: 'alice', password: 'S3cret-e2e' } } });
let relay = await startRelay({ CDP_RELAY_POLICY: policyPath, CDP_RELAY_ALLOWED_HOSTS: 'tunnel.example' });
try {
  // --- Origin / Host ---
  summary.extensionNoOrigin = await status(stubExtension('x1', { origin: null }).opened);
  summary.extensionWebOrigin = await status(stubExtension('x2', { origin: 'https://evil.example' }).opened);
  assert(summary.extensionNoOrigin === 'HTTP 403' && summary.extensionWebOrigin === 'HTTP 403', `/extension は Origin が chrome-extension:// 以外なら 403(なし: ${summary.extensionNoOrigin} / web: ${summary.extensionWebOrigin})`);
  const ext = stubExtension('v'); await ext.opened; await sleep(300);
  summary.clientWsWithOrigin = await wsStatus(`${RELAY.replace('http', 'ws')}/b/v/devtools/browser`, { Origin: 'https://evil.example' });
  summary.clientWsNoOrigin = await wsStatus(`${RELAY.replace('http', 'ws')}/b/v/devtools/browser`);
  assert(summary.clientWsWithOrigin === 'HTTP 403' && summary.clientWsNoOrigin === 'open', `クライアント用 WS: Origin 付きは 403、Node のクライアント(Origin なし)は通る`);
  summary.httpWithOrigin = await httpStatus('/browsers', { Origin: 'https://evil.example' });
  summary.httpBadHost = await httpStatus('/browsers', { Host: 'evil.example:9400' });
  summary.wsBadHost = await wsStatus(`${RELAY.replace('http', 'ws')}/b/v/devtools/browser`, { Host: 'rebind.evil.example' });
  summary.httpTunnelHost = await httpStatus('/browsers', { Host: `tunnel.example:${RELAY_PORT}` });
  assert(summary.httpWithOrigin === 403 && summary.httpBadHost === 403 && summary.wsBadHost === 'HTTP 403' && summary.httpTunnelHost === 200, `Origin 付き HTTP と偽の Host(HTTP / WS)は 403、CDP_RELAY_ALLOWED_HOSTS のホストは通る`);
  summary.reloadNoName = await httpStatus('/reload-extension', {}, 'POST');
  summary.reloadWithOrigin = await httpStatus('/b/v/reload-extension', { Origin: 'https://evil.example' }, 'POST');
  assert(summary.reloadNoName === 400 && summary.reloadWithOrigin === 403 && !ext.calls.some(c => c.method === 'ext.reload'), `reload-extension は /b/<name> 必須(${summary.reloadNoName})、Origin 付きは 403(拡張には届かない)`);

  // --- Basic 認証: トークン未設定では資格情報を渡さない ---
  const page = new WebSocket(`${RELAY.replace('http', 'ws')}/b/v/devtools/page/${TAB}`); await new Promise(r => page.once('open', r)); await sleep(200); // 明示接続 = エージェントのタブ
  ext.emit('ext.authRequired', { requestId: 'r1', tabId: TAB, url: 'https://intra.example.com/', realm: 'x', scheme: 'basic', type: 'main_frame' });
  ext.emit('ext.authRequired', { requestId: 'r2', tabId: 99, url: 'https://intra.example.com/', realm: 'x', scheme: 'basic', type: 'main_frame' });
  await sleep(300);
  const resp = id => ext.calls.find(c => c.method === 'ext.authRespond' && c.params.requestId === id)?.params.response;
  assert(resp('r1')?.cancel === true && logSince().includes('policy.auth is ignored because CDP_RELAY_TOKEN is not set'), 'CDP_RELAY_TOKEN 未設定: ポリシーに資格情報があっても cancel し、警告を出す');
  assert(JSON.stringify(resp('r2')) === '{}', 'エージェントのタブでないタブの認証には介入しない({} = ブラウザ既定)');
  page.close(); ext.ws.close(); await sleep(200);
  relay.stop(); await sleep(300);

  const TOKEN = 'hardening-token';
  relay = await startRelay({ CDP_RELAY_POLICY: policyPath, CDP_RELAY_TOKEN: TOKEN });
  const ext2 = stubExtension('v', { token: TOKEN }); await ext2.opened; await sleep(300);
  const page2 = new WebSocket(`${RELAY.replace('http', 'ws')}/b/v/devtools/page/${TAB}`); await new Promise(r => page2.once('open', r)); await sleep(200);
  const auth = (requestId, extra) => ext2.emit('ext.authRequired', { requestId, tabId: TAB, url: 'https://intra.example.com/api', realm: 'x', scheme: 'basic', ...extra });
  auth('a1', { type: 'main_frame' });
  auth('a2', { type: 'xmlhttprequest', initiator: 'https://evil.example' });
  auth('a3', { type: 'xmlhttprequest', initiator: 'https://intra.example.com' });
  auth('a5', { type: 'sub_frame', initiator: 'https://evil.example' }); // 他サイトが埋め込んだ iframe
  auth('a6', { type: 'sub_frame', initiator: 'https://intra.example.com' });
  await sleep(300);
  const resp2 = id => ext2.calls.find(c => c.method === 'ext.authRespond' && c.params.requestId === id)?.params.response;
  assert(resp2('a1')?.authCredentials?.username === 'alice' && resp2('a2')?.cancel === true && resp2('a3')?.authCredentials, 'トークン設定時: 遷移と同一オリジンのリクエストには資格情報、他オリジンが始めたリクエストには cancel');
  assert(resp2('a5')?.cancel === true && resp2('a6')?.authCredentials, 'sub_frame も initiator が同一オリジンのときだけ資格情報(他サイトの iframe には cancel)');
  assert(!logSince().includes('S3cret-e2e') && !JSON.stringify(await fetch(`${RELAY}/b/v/events`).then(r => r.json())).includes('S3cret-e2e'), '中継ログと記録にパスワードが出ない');

  // --- 危険なダウンロード: 承認せず dialogTimeoutMs(500ms)後に cancel し、canceled を送る ---
  const f = facade('v'); await f.open;
  assert(!(await f.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: join(out, 'dl'), eventsEnabled: true })).error, 'facade: allowAndName');
  const dl = (guid, id, danger) => { ext2.emit('cdp.event', { tabId: TAB, method: 'Page.downloadWillBegin', params: { guid, url: `https://intra.example.com/${guid}.bin`, frameId: 'F', suggestedFilename: `${guid}.bin` } }); ext2.emit('ext.downloadCreated', { item: { id, url: `https://intra.example.com/${guid}.bin`, finalUrl: `https://intra.example.com/${guid}.bin`, filename: '', state: 'in_progress', danger } }); };
  dl('dangerous', 1, 'file'); dl('scanning', 2, 'asyncScanning');
  await sleep(1200);
  const canceled = ext2.calls.filter(c => c.method === 'ext.downloadCancel').map(c => c.params.id);
  assert(canceled.join() === '1' && f.evs.some(e => e.method === 'Browser.downloadProgress' && e.params.guid === 'dangerous' && e.params.state === 'canceled'), `危険なファイルは cancel して canceled を送る。判定待ち(asyncScanning)は待つ(cancel: ${canceled})`);

  // --- ダウンロードの到着順と、クライアントごとの配置結果 ---
  const g = facade('v'); await g.open;
  const okDir = join(out, 'dl-ok'), badDir = join(out, 'not-a-dir', 'x'); writeFileSync(join(out, 'not-a-dir'), 'a file, so mkdir under it fails');
  await f.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: okDir, eventsEnabled: true });
  await g.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: badDir, eventsEnabled: true });
  const src = join(out, 'early.bin'); writeFileSync(src, 'early');
  const u = 'https://intra.example.com/early.bin';
  ext2.emit('ext.downloadCreated', { item: { id: 11, url: u, finalUrl: u, filename: src, state: 'in_progress', danger: 'safe' } }); // onCreated が先
  ext2.emit('cdp.event', { tabId: TAB, method: 'Page.downloadWillBegin', params: { guid: 'early', url: u, frameId: 'F', suggestedFilename: 'early.bin' } });
  ext2.emit('ext.downloadChanged', { item: { id: 11, url: u, finalUrl: u, filename: src, state: 'complete', danger: 'safe' } });
  await sleep(400);
  const done = w => w.evs.find(e => e.method === 'Browser.downloadProgress' && e.params.guid === 'early' && e.params.state !== 'inProgress')?.params;
  assert(done(f)?.state === 'completed' && readFileSync(done(f).filePath, 'utf8') === 'early', `onCreated が downloadWillBegin より先に届いても対応付けて移す(${done(f)?.filePath?.split('/').pop()})`);
  assert(done(g)?.state === 'canceled' && !done(g).filePath, '配置に失敗したクライアントにだけ canceled(置けたクライアントには completed)');
  const u2 = 'https://intra.example.com/orphan.bin'; // chrome.downloads の item が来ないまま CDP では完了
  ext2.emit('cdp.event', { tabId: TAB, method: 'Page.downloadWillBegin', params: { guid: 'orphan', url: u2, frameId: 'F', suggestedFilename: 'orphan.bin' } });
  ext2.emit('cdp.event', { tabId: TAB, method: 'Page.downloadProgress', params: { guid: 'orphan', totalBytes: 1, receivedBytes: 1, state: 'completed' } });
  await sleep(300);
  const orphan = f.evs.filter(e => e.params?.guid === 'orphan' && e.method === 'Browser.downloadProgress').map(e => e.params);
  assert(orphan.length === 1 && orphan[0].state === 'canceled' && !orphan[0].filePath, '対応付かないまま完了したものは、保存先を期待するクライアントに filePath の無い completed ではなく canceled');
  g.w.close();

  // --- adopt の解除と、opener からの継承 ---
  const adoptUrl = `${RELAY}/b/v/tabs/${TAB}/adopt`;
  const agentTabs = async () => (await fetch(`${RELAY}/browsers`).then(r => r.json()))[0].agentTabs;
  assert((await fetch(adoptUrl, { method: 'POST' }).then(r => r.json())).wasAgent === true, 'adopt の応答に wasAgent(既にエージェントのタブなら true)');
  ext2.emit('ext.tabCreated', { tab: { tabId: 30, openerTabId: TAB, url: '', pendingUrl: 'chrome://newtab/' } }); // Ctrl+T 相当
  ext2.emit('ext.tabCreated', { tab: { tabId: 31, openerTabId: TAB, url: '' } });
  ext2.emit('ext.tabCreated', { tab: { tabId: 32, openerTabId: TAB, url: '', pendingUrl: 'https://intra.example.com/popup' } }); // window.open
  ext2.emit('ext.tabCreated', { tab: { tabId: 33, openerTabId: 30, url: 'https://intra.example.com/x' } }); // エージェントでないタブから
  await sleep(200);
  const at = await agentTabs();
  assert(at.includes(32) && ![30, 31, 33].some(id => at.includes(id)), `opener の継承は新規タブページ・空でないときだけ(agentTabs: ${at})`);
  const del = await fetch(adoptUrl, { method: 'DELETE' }).then(r => r.json());
  assert(del.wasAgent === true && !(await agentTabs()).includes(TAB) && (await fetch(adoptUrl, { method: 'DELETE' }).then(r => r.json())).wasAgent === false, 'DELETE …/adopt でエージェントのタブから外れる');
  assert(ext2.calls.some(c => c.method === 'cdp' && c.params.tabId === TAB && c.params.method === 'Page.setInterceptFileChooserDialog' && c.params.params?.enabled === false), '外したタブはファイル選択の intercept を戻す');

  // --- 不正なイベント・不正なポリシーで落ちない ---
  for (const bad of [null, 1, { event: 'cdp.event', tabId: TAB, method: 'Page.javascriptDialogOpening', params: null }, { event: 'cdp.event', tabId: TAB, method: 'Page.downloadWillBegin' },
    { event: 'ext.authRequired', requestId: 'z', tabId: TAB, url: 'not a url' }, { event: 'ext.downloadCreated', item: null }, { event: 'ext.downloadChanged', item: { id: 'x' } }, { event: 'ext.tabCreated' }, { id: 12345, error: null }])
    ext2.ws.send(JSON.stringify(bad));
  await sleep(500);
  assert(await alive() && (await fetch(`${RELAY}/browsers`).then(r => r.json()))[0]?.name === 'v', '不正なイベントを受けても中継は落ちず、拡張の接続も維持');
  writePolicy({ scope: 3, dialogTimeoutMs: -5, dialogs: { alert: 'yes' }, auth: null, permissions: [], typo: 1 }); await sleep(POLICY_RELOAD_MS);
  assert((await f.send('Browser.getVersion')).result && await alive(), '不正な値のポリシーでも落ちない');
  const warn = logSince().split('\n').filter(l => /policy: WARNING (invalid|unknown key)/.test(l));
  assert(['scope', 'dialogTimeoutMs', 'dialogs', 'auth', 'permissions', 'typo'].every(k => warn.some(l => l.includes(`"${k}"`))), `不正な項目ごとに警告して直前の値のまま(${warn.length} 件)`);
  await fetch(adoptUrl, { method: 'POST' }); // 上で外したタブを戻す(以下の認証の確認に使う)
  writePolicy('{ not json'); await sleep(POLICY_RELOAD_MS); ext2.emit('ext.authRequired', { requestId: 'a4', tabId: TAB, url: 'https://intra.example.com/', realm: 'x', scheme: 'basic', type: 'main_frame' }); await sleep(300);
  assert(await alive() && resp2('a4')?.authCredentials, '壊れた JSON でも落ちず、直前の正しい設定(資格情報)のまま動く');
  writePolicy('null'); await sleep(POLICY_RELOAD_MS); await f.send('Browser.getVersion');
  assert(await alive(), 'null のポリシーでも落ちない');
  f.w.close(); page2.close(); ext2.ws.close(); await sleep(200);
  relay.stop(); await sleep(300);

  // --- ポリシー: 不正な origin キー / タイムアウトの上限 / ポリシーから消した型 ---
  writePolicy({ dialogTimeoutMs: 3_000_000_000, unresponsiveTimeoutMs: 2 ** 31, permissions: { 'about:blank': { camera: 'allow' }, 'https://ok.example': { camera: 'allow', popups: 'allow' } } });
  relay = await startRelay({ CDP_RELAY_POLICY: policyPath });
  const ext3 = stubExtension('p'); await ext3.opened; await sleep(400);
  const cs = () => ext3.calls.filter(c => c.method === 'ext.setContentSettings').map(c => c.params);
  const first = cs()[0];
  assert(first?.set.some(x => x.type === 'popups') && first?.set.some(x => x.pattern === 'https://ok.example/*') && !first.set.some(x => /about/.test(x.pattern)) && first.clear.includes('camera') && /invalid origin key\(s\) in "permissions": about:blank/.test(logSince()), '不正な origin キー(about:blank)は警告して捨て、残りは適用する');
  const fp = facade('p'); await fp.open;
  await fp.send('Browser.grantPermissions', { permissions: ['videoCapture'], origin: 'https://a.example' }); fp.w.close(); await sleep(300);
  assert(cs().at(-1)?.clear?.includes('camera') && !cs().at(-1).set.some(x => x.pattern === 'https://a.example/*'), 'クライアント切断の後始末(clear)はポリシーに不正なキーがあっても送る');
  assert(['dialogTimeoutMs', 'unresponsiveTimeoutMs'].every(k => logSince().includes(`invalid "${k}"`)), 'タイムアウトは 2^31-1 まで(超える値は不正として警告し、既定値のまま)');
  const pageP = new WebSocket(`${RELAY.replace('http', 'ws')}/b/p/devtools/page/${TAB}`); await new Promise(r => pageP.once('open', r)); await sleep(100);
  ext3.emit('cdp.event', { tabId: TAB, method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: 'x', url: 'https://a.example/' } });
  await sleep(500);
  assert(!ext3.calls.some(c => c.params?.method === 'Page.handleJavaScriptDialog' || c.params?.method === 'Page.navigate'), '巨大なタイムアウト値でも即時に自動処理しない(setTimeout の 1ms 扱いにならない)');
  pageP.close();
  writePolicy({ permissions: {} }); await sleep(POLICY_RELOAD_MS);
  assert(cs().at(-1)?.clear?.includes('popups') && cs().at(-1).set.length === 0, `ポリシーから消した型(popups)も clear する(clear: ${cs().at(-1)?.clear})`);
  ext3.ws.close();

  // --- watch の参照 ---
  const ext4 = stubExtension('w'); await ext4.opened; await sleep(300);
  const adoptW = `${RELAY}/b/w/tabs/${TAB}/adopt`;
  const attachedW = async () => (await fetch(`${RELAY}/browsers`).then(r => r.json())).find(b => b.name === 'w').attachedTabs;
  const callsSince = (i, method) => ext4.calls.slice(i).filter(c => c.method === method || c.params?.method === method);
  let release; ext4.gate = m => m.method === 'ext.attach' && new Promise(r => { release = r; });
  await fetch(adoptW, { method: 'POST' }); await sleep(100); // watch の ext.attach が往復中
  await fetch(adoptW, { method: 'DELETE' }); await fetch(adoptW, { method: 'POST' }); await sleep(100);
  ext4.gate = undefined; release(); await sleep(300);
  await fetch(adoptW, { method: 'DELETE' }); await sleep(300);
  assert((await attachedW()).length === 0, `attach の往復中に unadopt → 再 adopt しても、最後に外せば detach する(attachedTabs: ${await attachedW()})`);
  await fetch(adoptW, { method: 'POST' }); await sleep(300);
  const B = new WebSocket(`${RELAY.replace('http', 'ws')}/b/w/devtools/page/${TAB}`); await new Promise(r => B.once('open', r)); await sleep(100);
  B._socket.pause(); // close の応答を返さない遅いクライアント(中継の close は最大 30 秒待つ)
  ext4.emit('ext.detached', { tabId: TAB, reason: 'canceled_by_user' }); await sleep(200);
  const C = new WebSocket(`${RELAY.replace('http', 'ws')}/b/w/devtools/page/${TAB}`); await new Promise(r => C.once('open', r)); await sleep(200);
  ext4.emit('cdp.event', { tabId: TAB, method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: 'C handles this', url: 'https://intra.example.com/' } }); await sleep(100);
  const mark = ext4.calls.length;
  B.terminate(); await sleep(300);
  assert(!callsSince(mark, 'ext.detach').length && !callsSince(mark, 'Page.handleJavaScriptDialog').length, 'ブラウザ側から detach された古いページ WS の遅れた close は、接続中のクライアント C の参照を減らさない(ダイアログを閉じない・付け直さない)');
  C.close(); await sleep(300);
  assert(callsSince(mark, 'Page.handleJavaScriptDialog').length === 1 && (await attachedW()).includes(TAB), 'C が離れたら閉じて付け直し、監視を続ける(ブラウザ側の detach の後も、次のクライアントの接続で監視が戻る)');
  await fetch(adoptW, { method: 'DELETE' }); await sleep(300);
  assert((await attachedW()).length === 0, 'エージェントのタブから外すと detach する');
  ext4.ws.close();
  relay.stop(); await sleep(300);

  // --- クライアント認証(CDP_RELAY_CLIENT_AUTH=1): TCP 側のクライアントは Authorization: Bearer <トークン> が必要 ---
  const tokenFile = `tmp/agent-${RELAY_PORT}.client-token`; // harness の CDP_RELAY_SOCKET(tmp/agent-<port>.sock)の隣
  rmSync(tokenFile, { force: true });
  relay = await startRelay({ CDP_RELAY_POLICY: policyPath, CDP_RELAY_CLIENT_AUTH: '1' });
  const DED = RELAY_PORT + 7; // 専用ポート
  const ext5 = stubExtension('ca', { port: DED }); await ext5.opened; await sleep(400);
  summary.extensionWithoutClientToken = 'open';
  const token = readFileSync(tokenFile, 'utf8').trim();
  assert(/^[0-9a-f]{64}$/.test(token) && (process.platform === 'win32' || (statSync(tokenFile).mode & 0o777) === 0o600), 'トークンを 0600 のファイルに自動生成する(Windows は mode が無く、ユーザーフォルダの ACL で守る。拡張の接続口 /extension はクライアント用トークンなしで繋がる)');
  const bearer = { authorization: `Bearer ${token}` };
  const wsBase = RELAY.replace('http', 'ws');
  const denied = {
    browsers: await httpStatus('/browsers'),
    version: await httpStatus('/b/ca/json/version'),
    list: await httpStatus('/b/ca/json/list'),
    eval: await httpStatus(`/b/ca/tabs/${TAB}/eval`, { 'content-type': 'application/json' }, 'POST'),
    cdp: await httpStatus(`/b/ca/tabs/${TAB}/cdp`, { 'content-type': 'application/json' }, 'POST'),
    wrongToken: await httpStatus('/browsers', { authorization: `Bearer ${'0'.repeat(64)}` }),
    queryToken: await httpStatus(`/browsers?token=${token}`),
    wsBrowser: await wsStatus(`${wsBase}/b/ca/devtools/browser`),
    wsPage: await wsStatus(`${wsBase}/b/ca/devtools/page/${TAB}`),
    dedicatedHttp: await new Promise(res => http.get({ host: '127.0.0.1', port: DED, path: '/json/version' }, r => { r.resume(); res(r.statusCode); })),
    dedicatedWs: await wsStatus(`ws://127.0.0.1:${DED}/devtools/browser`),
  };
  summary.clientAuthDenied = denied;
  assert(Object.values(denied).every(s => s === 401 || s === 'HTTP 401'), `トークンなし・違うトークン・クエリ文字列のトークンは、HTTP / WS / 近道 API / 専用ポートのすべてで 401(${JSON.stringify(denied)})`);
  assert(await httpStatus('/browsers', { ...bearer, Origin: 'https://evil.example' }) === 403, 'Origin 付きの要求は正しいトークンがあっても 403(既存の防御が先)');
  const allowed = {
    browsers: await httpStatus('/browsers', bearer),
    version: await httpStatus('/b/ca/json/version', { authorization: `bearer ${token}` }),
    wsBrowser: await wsStatus(`${wsBase}/b/ca/devtools/browser`, bearer),
    dedicatedWs: await wsStatus(`ws://127.0.0.1:${DED}/devtools/browser`, bearer),
  };
  summary.clientAuthAllowed = allowed;
  assert(Object.values(allowed).every(s => s === 200 || s === 'open'), `正しいトークンなら HTTP 200 / WS が開く(scheme の大文字小文字は問わない)(${JSON.stringify(allowed)})`);
  const cli = await new Promise(res => execFile(process.execPath, ['cli.mjs', 'browsers'], { env: { ...process.env, CDP_RELAY_PORT: String(RELAY_PORT), CDP_RELAY_SOCKET: `tmp/agent-${RELAY_PORT}.sock` } }, (e, stdout) => res({ code: e?.code ?? 0, stdout })));
  assert(cli.code === 0 && cli.stdout.includes('ca'), `CLI はトークンのファイルを読んで、そのまま使える(exit ${cli.code})`);
  relay.stop(); await sleep(300);
  relay = await startRelay({ CDP_RELAY_POLICY: policyPath, CDP_RELAY_CLIENT_AUTH: '1' });
  assert(readFileSync(tokenFile, 'utf8').trim() === token && await httpStatus('/browsers', bearer) === 200, '中継を再起動しても同じトークンを使う(クライアントの設定を変えなくてよい)');
  assert(!logSince().includes(token), '中継ログにトークンを出さない');
  ext5.ws.close();
  relay.stop(); await sleep(300);

  // --- MCP シムが中継を起こし直す: 前回の CDP_RELAY_* を引き継ぐ / 一度も起動していなければ clone の relay/server.mjs を起動する ---
  const infoFile = `tmp/agent-${RELAY_PORT}.json`;
  const shimCall = () => new Promise((res, rej) => { // シム自身はクライアント認証の設定を持たない
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CDP_RELAY_')));
    const child = spawn(process.execPath, ['plugin/cdp-relay/mcp/server.mjs'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...env, CDP_RELAY_PORT: String(RELAY_PORT), CDP_RELAY_SOCKET: resolve(`tmp/agent-${RELAY_PORT}.sock`) } });
    const timer = setTimeout(() => { child.kill(); rej(new Error('shim timed out')); }, 30_000);
    child.stdout.on('data', d => { if (String(d).includes('"id":2')) { clearTimeout(timer); child.stdin.end(); res(); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_list', arguments: {} } })}\n`);
  });
  const killStarted = async () => { const pid = JSON.parse(readFileSync(infoFile, 'utf8')).pid; process.kill(pid); for (let i = 0; i < 50 && await alive(); i++) await sleep(100); };
  await shimCall();
  summary.restartedWithoutToken = await httpStatus('/browsers');
  assert(summary.restartedWithoutToken === 401 && await httpStatus('/browsers', bearer) === 200, `シムが起こし直した中継は、前回のクライアント認証の設定を引き継ぐ(トークンなし ${summary.restartedWithoutToken})`);
  await killStarted();
  rmSync(infoFile, { force: true });
  await shimCall();
  assert(await httpStatus('/browsers') === 200 && existsSync(infoFile), '一度も起動していなくても(状態ファイルなし)、シムは clone の relay/server.mjs を起動する');
  await killStarted();
  console.log('E2E-13 PASS');
} finally {
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  writeFileSync(join(out, 'relay.log'), logSince());
  // シムが切り離して起動した中継を残さない(途中で失敗したとき)。状態ファイルは最後に起動した中継のもの。ポートが応答しているときだけ止める(古い pid で無関係なプロセスを止めない)
  try { const { pid } = JSON.parse(readFileSync(`tmp/agent-${RELAY_PORT}.json`, 'utf8')); if (pid !== relay.child.pid && await alive()) process.kill(pid); } catch {}
  relay.stop();
}
