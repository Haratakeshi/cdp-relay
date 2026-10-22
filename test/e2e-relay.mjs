// E2E-8: 中継サーバー単体の設定まわり(ブラウザ起動なし)。拡張はスタブの WebSocket クライアントで代用する
import { startRelay, RELAY, RELAY_PORT, sleep, assert } from './harness.mjs';
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';

const stub = (query, handlers = {}) => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/extension?${query}`, { headers: { Origin: 'chrome-extension://stub' } }); // 中継は拡張の Origin だけを受ける
  const closed = new Promise(r => ws.once('close', (code, reason) => r({ code, reason: String(reason) })));
  ws.on('message', raw => { const m = JSON.parse(raw); const fn = handlers[m.method]; ws.send(JSON.stringify(fn ? { id: m.id, result: fn(m.params ?? {}) } : { id: m.id, error: { message: `no stub: ${m.method}` } })); });
  ws.once('open', () => res({ ws, closed }));
  ws.once('error', rej);
  ws.once('unexpected-response', (_, r) => rej(new Error(`HTTP ${r.statusCode}`)));
});
const browsers = () => fetch(`${RELAY}/browsers`).then(r => r.json());
const INFO = { 'ext.info': () => ({ name: 'stub', userAgent: 'Mozilla/5.0 Chrome/152.0.0.0', version: '0.1.0', attached: [] }), 'ext.listTabs': () => [] };

let relay = await startRelay();
try {
  // 専用ポートが中継ポートと同じ: 接続は維持し、理由を報告する(切ると再接続ループになる)
  const a = await stub(`name=same-port&port=${RELAY_PORT}`, INFO);
  await sleep(400);
  const [la] = await browsers();
  assert(la?.name === 'same-port' && la.portError?.includes('same as the relay port'), `same port -> connected with portError "${la?.portError}"`);
  assert((await fetch(`${RELAY}/b/same-port/json/version`).then(r => r.json())).Browser === 'Chrome/152.0.0.0', 'browser still usable via /b/<name>');
  a.ws.close(); await sleep(300);

  // 使用中のポートを要求した場合も同じ扱い
  const busy = await stub('name=holder&port=9405', INFO); await sleep(400);
  const b = await stub('name=loser&port=9405', INFO); await sleep(400);
  const loser = (await browsers()).find(x => x.name === 'loser');
  assert(loser && loser.portError === 'EADDRINUSE', `port in use -> portError ${loser?.portError}`);
  busy.ws.close(); b.ws.close(); await sleep(300);

  // 旧バージョンの拡張(features なし・新メソッドなし)に新しい中継が繋がっても落ちず、未対応機能はログ 1 回 + エラー応答
  const logAt = readFileSync(`tmp/relay-${RELAY_PORT}.log`, 'utf8').length;
  const old = await stub('name=old', INFO); await sleep(400);
  assert((await browsers()).find(x => x.name === 'old')?.extVersion === '0.1.0', '/browsers に extVersion');
  const f = new WebSocket(`${RELAY.replace('http', 'ws')}/b/old/devtools/browser`); await new Promise(r => f.once('open', r));
  let fid = 0; const fsend = (method, params) => new Promise(r => { const id = ++fid; f.on('message', m => { m = JSON.parse(m); if (m.id === id) r(m); }); f.send(JSON.stringify({ id, method, params })); });
  const dl = await fsend('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: '/tmp/x', eventsEnabled: true });
  assert(/does not support downloads/.test(dl.error?.message), `旧拡張: setDownloadBehavior はエラー応答(${dl.error?.message})`);
  const gp = await fsend('Browser.grantPermissions', { permissions: ['geolocation'] });
  assert(/does not support contentSettings/.test(gp.error?.message), '旧拡張: grantPermissions はエラー応答');
  assert((await fsend('Browser.setDownloadBehavior', { behavior: 'default' })).result, "旧拡張でも behavior 'default' は成功(何も変えない)");
  const rl = await fetch(`${RELAY}/b/old/reload-extension`, { method: 'POST' });
  assert(rl.status === 501, `旧拡張: reload-extension は 501(${(await rl.json()).error})`);
  const oldLog = readFileSync(`tmp/relay-${RELAY_PORT}.log`, 'utf8').slice(logAt).split('\n').filter(l => l.includes('unsupported:'));
  assert(oldLog.length === 1 && /auth, downloads, contentSettings, reload/.test(oldLog[0]), `未対応機能は接続時に 1 回だけログ: ${oldLog[0]?.slice(25)}`);
  assert((await fetch(`${RELAY}/b/old/json/version`).then(r => r.json())).Browser === 'Chrome/152.0.0.0', '中継は落ちずに従来機能を提供し続ける');
  f.close(); old.ws.close(); await sleep(300);
  relay.stop(); await sleep(300);

  // トークン設定時は拡張の接続を検証する
  relay = await startRelay({ CDP_RELAY_TOKEN: 'secret' });
  let denied; try { await stub('name=nope', INFO); } catch (e) { denied = e; }
  assert(denied && /403/.test(denied.message), `wrong token rejected (${denied?.message})`);
  const ok = await stub('name=yes&token=secret', INFO); await sleep(400);
  assert((await browsers()).some(x => x.name === 'yes'), 'correct token accepted');
  ok.ws.close();
  console.log('E2E-8 PASS');
} finally { relay.stop(); }
