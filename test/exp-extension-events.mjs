// 実験: 拡張 0.2.0 が流す事実の順序を、中継の代わりのスタブ WS サーバーで観察する(中継ロジックの設計前提の確認用)
//  (1) ダウンロード: chrome.debugger の Page.downloadWillBegin/Progress と chrome.downloads の onCreated/onChanged の到着順と対応付け
//  (2) Basic 認証: webRequest.onAuthRequired と、クライアントの Fetch.enable(handleAuthRequests) による Fetch.authRequired のどちらが先か
//  (3) contentSettings: ポート付きオリジンのパターンで navigator.permissions.query が変わるか
import http from 'node:http';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { launchChromeWithExtension, RELAY_PORT, sleep } from './harness.mjs';

const dlDir = resolve('tmp/exp-downloads'); mkdirSync(dlDir, { recursive: true });
const srv = http.createServer((req, res) => {
  if (req.url === '/file.txt') { res.setHeader('content-disposition', 'attachment; filename="file.txt"'); return res.end('hello download'); }
  if (req.url.startsWith('/auth')) { if (req.headers.authorization === 'Basic ' + Buffer.from('u:p').toString('base64')) return res.end('<title>authed</title>'); res.writeHead(401, { 'www-authenticate': 'Basic realm="exp"', 'content-type': 'text/html' }); return res.end('<title>401</title>'); }
  res.setHeader('content-type', 'text/html'); res.end('<title>dl</title><a id=a href="/file.txt">dl</a>');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${srv.address().port}`;

const wss = new WebSocketServer({ port: RELAY_PORT, host: '127.0.0.1' });
const t0 = Date.now(); const log = (...a) => console.log(String(Date.now() - t0).padStart(6), ...a);
let ext, seq = 0; const pending = new Map(); const onEvent = [];
const connected = new Promise(r => wss.on('connection', ws => { ext = ws; ws.on('message', raw => { const m = JSON.parse(raw); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else { if (!/tabUpdated|tabCreated/.test(m.event)) log('EVENT', m.event, m.method ?? '', JSON.stringify(m.params ?? m.item ?? { requestId: m.requestId, url: m.url }).slice(0, 160)); onEvent.forEach(f => f(m)); } }); r(); }));
const call = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ext.send(JSON.stringify({ id, method, params })); });

const userDataDir = mkdtempSync(join(resolve('tmp'), 'profile-exp-ev-'));
mkdirSync(join(userDataDir, 'Default'), { recursive: true });
writeFileSync(join(userDataDir, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: dlDir, prompt_for_download: false } }));
const { browser } = await launchChromeWithExtension({ name: 'exp-ev', userDataDir });
try {
  await connected;
  const info = await call('ext.info'); log('ext.info', info.version, info.features, info.contentSettingTypes);
  const [tab] = await call('ext.listTabs');
  await call('ext.attach', { tabId: tab.tabId });
  const cdp = (method, params) => call('cdp', { tabId: tab.tabId, method, params });
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: site + '/' }); await sleep(800);
  log('--- download (click)');
  await cdp('Runtime.evaluate', { expression: 'document.getElementById("a").click()' }); await sleep(2000);

  log('--- auth without Fetch: respond cancel');
  onEvent.splice(0); onEvent.push(m => { if (m.event === 'ext.authRequired') call('ext.authRespond', { requestId: m.requestId, response: { cancel: true } }); });
  await cdp('Page.navigate', { url: site + '/auth' }); await sleep(1000);
  log('title', (await cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value);

  log('--- auth with Fetch.enable handleAuthRequests: ext responds {} , client continueWithAuth');
  onEvent.splice(0); onEvent.push(m => {
    if (m.event === 'ext.authRequired') call('ext.authRespond', { requestId: m.requestId, response: {} });
    if (m.method === 'Fetch.authRequired') cdp('Fetch.continueWithAuth', { requestId: m.params.requestId, authChallengeResponse: { response: 'ProvideCredentials', username: 'u', password: 'p' } });
    if (m.method === 'Fetch.requestPaused') cdp('Fetch.continueRequest', { requestId: m.params.requestId });
  });
  await cdp('Fetch.enable', { handleAuthRequests: true });
  await cdp('Page.navigate', { url: site + '/auth?2' }); await sleep(1500);
  log('title', (await cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value);
  await cdp('Fetch.disable');

  log('--- contentSettings');
  const q = name => cdp('Runtime.evaluate', { expression: `navigator.permissions.query({name:'${name}'}).then(s => s.state)`, awaitPromise: true, returnByValue: true }).then(r => r.result.value);
  log('before', await q('geolocation'), await q('camera'));
  await call('ext.setContentSettings', { set: [{ type: 'location', pattern: `${site}/*`, setting: 'allow' }, { type: 'camera', pattern: `${site}/*`, setting: 'allow' }] });
  log('after set (port pattern)', await q('geolocation'), await q('camera'));
  await call('ext.setContentSettings', { clear: ['location', 'camera'] });
  log('after clear', await q('geolocation'), await q('camera'));
  await call('ext.setContentSettings', { set: [{ type: 'location', pattern: '<all_urls>', setting: 'block' }] });
  log('after <all_urls> block', await q('geolocation'));
  await call('ext.setContentSettings', { clear: ['location'] });
} catch (e) { log('ERROR', e.message); } finally { await browser.close().catch(() => {}); wss.close(); srv.close(); }
