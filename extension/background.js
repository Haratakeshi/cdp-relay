// CDP Relay Bridge - Service Worker
// 中継サーバーへ WebSocket で接続し、chrome.debugger を介した CDP コマンド/イベントを双方向転送する。
// 中継サーバー → 拡張: {id, method, params}   拡張 → 中継: {id, result} | {id, error:{message}} | {event, ...}
// name は必須(既定値を持たせない)。未設定のまま繋ぐと、別プロファイルに入れたときに同じ名前で互いを蹴り合う
const DEFAULTS = { relayUrl: 'ws://127.0.0.1:9333/extension', name: '', token: '', port: '' };
const KEEPALIVE_ALARM = 'cdp-relay-keepalive';
const AUTH_TIMEOUT_MS = 10_000; // 中継が応答しない(切断中・旧中継)ときに Basic 認証を cancel するまでの時間。認証ダイアログで固まらせない
// 中継が機能の有無を判定する(旧拡張には無い。中継は無ければ未対応としてエラーを返す)
const FEATURES = ['auth', 'downloads', 'contentSettings', 'reload', 'navigateTab'];

let ws = null;
let cfg = null;
let backoffMs = 1000;
let lastClose = null; // 直近の切断理由(オプション画面の診断用)
const attached = new Set(); // 現在 chrome.debugger で attach 中の tabId
const pendingAuth = new Map(); // webRequest requestId -> { callback, timer }

// ツールバーのバッジ: 未設定は「!」、未接続は「OFF」、接続中は操作中のタブ数(0 なら表示なし)
const BADGE = { unconfigured: ['!', '#b45309', 'ブラウザ名が未設定です(クリックして設定)'], offline: ['OFF', '#c2410c', '中継サーバーに未接続(再接続を試行中)'] };
function updateBadge() {
  const state = !cfg?.name ? 'unconfigured' : ws?.readyState !== WebSocket.OPEN ? 'offline' : null;
  const [text, color, title] = BADGE[state] ?? [attached.size ? String(attached.size) : '', '#0f9d8f', `CDP Relay Bridge: ${cfg.name} に接続中${attached.size ? `(操作中のタブ ${attached.size})` : ''}`];
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title });
}

const send = obj => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
const emit = (event, data) => send({ event, ...data });

async function loadConfig() {
  const v = await chrome.storage.local.get(Object.keys(DEFAULTS));
  cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x)) };
  updateBadge();
  return cfg;
}

// --- 中継サーバーから呼ばれるメソッド ---
const methods = {
  'ext.info': async () => ({
    name: cfg.name, userAgent: navigator.userAgent, version: chrome.runtime.getManifest().version, attached: [...attached], features: FEATURES,
    contentSettingTypes: Object.keys(chrome.contentSettings).filter(k => typeof chrome.contentSettings[k]?.set === 'function'),
  }),
  'ext.reload': async () => { setTimeout(() => chrome.runtime.reload(), 100); return {}; }, // 応答を返してから再読み込み(未パックはディスクから読み直す)
  'ext.authRespond': async ({ requestId, response }) => ({ handled: respondAuth(requestId, response) }),
  'ext.downloadCancel': async ({ id }) => { await chrome.downloads.cancel(id); return {}; },
  // clear は「この拡張が設定した」規則だけを型ごとに消す(ユーザー自身の設定は残る)。set は後勝ち。1 件の失敗で残りを止めず、失敗を返す
  'ext.setContentSettings': ({ clear = [], set = [] }) => csSerial(async () => { // 切断時・起動時の後始末とも入れ違わないよう 1 本に並べる
    const errors = [];
    for (const type of clear) await csClear(chrome.contentSettings[type]).catch(e => errors.push(`${type}: ${e.message}`));
    for (const { type, pattern, setting } of set) await chrome.contentSettings[type].set({ primaryPattern: pattern, setting, scope: 'regular' }).catch(e => errors.push(`${type} ${pattern} ${setting}: ${e.message}`));
    return { errors };
  }),
  'ext.listTabs': async () => { const ids = await targetIds(); return (await chrome.tabs.query({})).map(t => tabInfo(t, ids)); },
  'ext.createTab': async ({ url, active = true }) => {
    const t = await chrome.tabs.create({ url, active });
    for (let i = 0; i < 20; i++) { const ids = await targetIds(); if (ids.has(t.id)) return tabInfo(t, ids); await new Promise(r => setTimeout(r, 50)); } // DevTools ターゲット生成待ち
    return tabInfo(t);
  },
  'ext.closeTab': async ({ tabId }) => { await chrome.tabs.remove(tabId); return {}; },
  'ext.navigateTab': async ({ tabId, url }) => { await chrome.tabs.update(tabId, { url }); return {}; },
  'ext.activateTab': async ({ tabId }) => { const t = await chrome.tabs.update(tabId, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); return {}; },
  'ext.attach': async ({ tabId }) => {
    if (!attached.has(tabId)) { await chrome.debugger.attach({ tabId }, '1.3'); attached.add(tabId); updateBadge(); }
    return {};
  },
  'ext.detach': async ({ tabId }) => {
    if (attached.has(tabId)) { attached.delete(tabId); updateBadge(); await chrome.debugger.detach({ tabId }).catch(() => {}); }
    return {};
  },
  // 生の CDP コマンド。sessionId があれば flatten された子セッション(iframe/worker)宛て
  'cdp': async ({ tabId, sessionId, method, params }) => {
    const target = sessionId ? { tabId, sessionId } : { tabId };
    return (await chrome.debugger.sendCommand(target, method, params ?? {})) ?? {};
  },
};

// CDP クライアントには Chrome 本来の targetId(= メインフレーム id。Playwright が同一性を前提にする)を見せるため、getTargets() の id を添える
async function targetIds() {
  const m = new Map();
  for (const t of await chrome.debugger.getTargets()) if (t.type === 'page' && t.tabId !== undefined) m.set(t.tabId, t.id);
  return m;
}
function tabInfo(t, ids) {
  return { tabId: t.id, targetId: ids?.get(t.id), openerTabId: t.openerTabId, pendingUrl: t.pendingUrl, windowId: t.windowId, url: t.url ?? t.pendingUrl ?? '', title: t.title ?? '', active: !!t.active, status: t.status, attached: attached.has(t.id) };
}

async function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.method === 'ping') return send({ id: msg.id, result: { pong: Date.now() } });
  const fn = methods[msg.method];
  if (!fn) return send({ id: msg.id, error: { message: `unknown method: ${msg.method}` } });
  try { send({ id: msg.id, result: await fn(msg.params ?? {}) }); }
  catch (e) { send({ id: msg.id, error: { message: e?.message ?? String(e) } }); }
}

// --- chrome.debugger / tabs のイベントを中継へ流す ---
chrome.debugger.onEvent.addListener((source, method, params) => emit('cdp.event', { tabId: source.tabId, sessionId: source.sessionId, method, params }));
chrome.debugger.onDetach.addListener((source, reason) => { attached.delete(source.tabId); updateBadge(); emit('ext.detached', { tabId: source.tabId, reason }); });
chrome.tabs.onCreated.addListener(async t => emit('ext.tabCreated', { tab: tabInfo(t, await targetIds()) }));
chrome.tabs.onRemoved.addListener(tabId => { if (attached.delete(tabId)) updateBadge(); emit('ext.tabRemoved', { tabId }); });
chrome.tabs.onUpdated.addListener(async (tabId, change, t) => { if (change.url || change.title || change.status) emit('ext.tabUpdated', { tab: tabInfo(t, await targetIds()) }); });

// Basic 認証: 判断は中継(ポリシー・クライアントの Fetch 処理)が持つ。中継が操作中(attach 中)のタブだけ扱い、
// ユーザーが手で使っているタブと proxy 認証はブラウザ既定の認証ダイアログのまま
function respondAuth(requestId, response) {
  const p = pendingAuth.get(requestId);
  if (!p) return false;
  pendingAuth.delete(requestId); clearTimeout(p.timer); p.callback(response);
  return true;
}
chrome.webRequest.onAuthRequired.addListener((d, callback) => {
  if (d.isProxy || !attached.has(d.tabId)) return callback({});
  if (ws?.readyState !== WebSocket.OPEN) return callback({ cancel: true });
  pendingAuth.set(d.requestId, { callback, timer: setTimeout(() => respondAuth(d.requestId, { cancel: true }), AUTH_TIMEOUT_MS) });
  emit('ext.authRequired', { requestId: d.requestId, tabId: d.tabId, url: d.url, realm: d.realm, scheme: d.scheme, type: d.type, initiator: d.initiator });
}, { urls: ['<all_urls>'] }, ['asyncBlocking']);

// ダウンロード: 振り分け(CDP のダウンロードとの対応付け・deny・移動)は中継が行う。拡張は事実を流すだけ
const downloadInfo = d => ({ id: d.id, url: d.url, finalUrl: d.finalUrl, filename: d.filename, state: d.state, danger: d.danger, totalBytes: d.totalBytes, bytesReceived: d.bytesReceived, error: d.error });
chrome.downloads.onCreated.addListener(d => emit('ext.downloadCreated', { item: downloadInfo(d) }));
chrome.downloads.onChanged.addListener(async delta => { const [d] = await chrome.downloads.search({ id: delta.id }); if (d) emit('ext.downloadChanged', { item: downloadInfo(d) }); });

// contentSettings は実プロファイルに永続化される。中継との接続が切れたとき(中継停止・クラッシュ含む)と SW 起動時に、
// この拡張が設定した規則を全部消す(clear は拡張自身の規則だけが対象。ユーザーのサイト設定は残る)。中継は接続時にポリシーを適用し直す
// clear は Promise を返さない(Chrome 152 実測: undefined)ので callback で待つ
const csClear = cs => new Promise((resolve, reject) => cs.clear({ scope: 'regular' }, () => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));
// contentSettings の操作(中継からの set / clear、切断時・起動時の clear)はすべてこの 1 本の Promise チェーンで順に実行する
let csChain = Promise.resolve();
const csSerial = fn => { const p = csChain.then(fn); csChain = p.catch(() => {}); return p; };
const clearContentSettings = () => csSerial(() => Promise.all(Object.values(chrome.contentSettings)
  .filter(cs => typeof cs?.clear === 'function').map(cs => csClear(cs).catch(() => {}))));

// --- 接続管理 ---
function connect() {
  if (!cfg.name) return; // オプション画面でブラウザ名を設定するまで接続しない
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = new URL(cfg.relayUrl);
  url.searchParams.set('name', cfg.name);
  if (cfg.token) url.searchParams.set('token', cfg.token);
  if (cfg.port) url.searchParams.set('port', cfg.port);
  const sock = ws = new WebSocket(url.href);
  sock.onopen = () => { backoffMs = 1000; updateBadge(); console.log('[cdp-relay] connected', cfg.relayUrl); };
  sock.onmessage = e => handleMessage(e.data);
  sock.onclose = e => { if (ws !== sock) return; clearContentSettings(); lastClose = { code: e.code, reason: e.reason, at: new Date().toISOString() }; console.log('[cdp-relay] closed', e.code, e.reason); ws = null; updateBadge(); scheduleReconnect(); }; // 置き換え済みの古いソケットは無視
  sock.onerror = () => {};
}
function scheduleReconnect() {
  setTimeout(() => loadConfig().then(connect), backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30_000);
}
// SW が停止しても alarms で起こして再接続する(WebSocket の送受信がある間は Chrome 116+ が SW を延命する)
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === KEEPALIVE_ALARM) loadConfig().then(connect); });

// 設定変更で繋ぎ直すときも後始末する(古いソケットの onclose は置き換え済みとして無視されるので、ここで消す。新しい接続での適用はこの後に並ぶ)
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') { const old = ws; ws = null; if (old) { old.close(4001, 'config changed'); clearContentSettings(); } loadConfig().then(connect); } });
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'status') reply({ configured: !!cfg?.name, connected: ws?.readyState === WebSocket.OPEN, config: { ...cfg, token: cfg?.token ? '(set)' : '' }, attached: [...attached], lastClose });
  return true;
});

// SW 起動時: 前回の SW が残した attach(孤児)を掃除して状態を揃える
chrome.debugger.getTargets().then(ts => ts.filter(t => t.attached && t.tabId).forEach(t => chrome.debugger.detach({ tabId: t.tabId }).catch(() => {})));
clearContentSettings();
loadConfig().then(connect);
