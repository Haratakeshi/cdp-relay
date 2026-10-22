// 実験: 背面に開いたタブの Page.captureScreenshot が Windows のヘッドレスでタイムアウトする原因と対策(CI の windows-latest で実行)。
// 1 回目(2026-10-22): 開いた直後の背面タブは約 3 秒で撮れる(前面は約 30ms)。occlusion のフラグは無関係
// 2 回目: 背面タブは「直前の撮影・遷移の直後」に撮ると 20 秒で止まり、4 秒置くと撮れる。前面タブは常に撮れる
// 3 回目: タイムアウトはタブではなくブラウザ全体で交互に起き、タイムアウトの直後の撮影はどの方法でも約 1 秒で成功した
// 4 回目: 続けて 5 回撮ると、やり直し方式は毎回約 3 秒(1 回目が 3 秒で切れ、やり直しは約 30ms)。スクリーンキャストだけなら毎回 10ms 前後
// 5 回目(これ): スクリーンキャストを一瞬始めて最初のフレームを待ってから captureScreenshot(viewport / clip / 全体)
import http from 'node:http';
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { startRelay, launchChromeWithExtension, waitForBrowser, RELAY, RELAY_PORT } from './harness.mjs';

const SOCKET = resolve(`tmp/agent-${RELAY_PORT}.sock`);
const LIMIT_MS = 8000;
const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>x</title><h1>hello</h1>'); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${srv.address().port}/`;
function mcp() {
  const child = spawn(process.execPath, [resolve('plugin/cdp-relay/mcp/server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, CDP_RELAY_PORT: String(RELAY_PORT), CDP_RELAY_SOCKET: SOCKET } });
  let buf = '', id = 0; const pend = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pend.get(m.id)?.(m); pend.delete(m.id); } });
  const rpc = (method, params) => new Promise(r => { pend.set(++id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { child, tool: (name, args) => rpc('tools/call', { name, arguments: args }) };
}
/** タブ単位の生 CDP(中継のページ WS)。send は上限つき */
async function page(tabId) {
  const ws = new WebSocket(`${RELAY.replace('http', 'ws')}/b/shot/devtools/page/${tabId}`);
  await new Promise(r => ws.once('open', r));
  let id = 0; const pend = new Map(); const listeners = [];
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id) { pend.get(m.id)?.(m); pend.delete(m.id); } else listeners.forEach(f => f(m)); });
  const send = (method, params = {}, ms = LIMIT_MS) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => rej(new Error(`${method} timeout ${ms}ms`)), ms); pend.set(i, m => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, on: f => listeners.push(f), close: () => ws.close() };
}
const timed = async fn => { const t0 = Date.now(); try { const v = await fn(); return { ok: true, ms: Date.now() - t0, ...(v ?? {}) }; } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message }; } };
const capture = (p, ms) => p.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }, ms).then(r => ({ bytes: r.data.length }));

const VARIANTS = { // 3 回目の比較(screencast は 4 回目でも使う)
  baseline: p => capture(p),
  retryShort: async p => { try { return await capture(p, 2500); } catch { return { retried: true, ...(await capture(p)) }; } },
  domDamage: async p => { await p.send('Runtime.evaluate', { expression: 'document.documentElement.style.setProperty("--cdp-relay-tick", String(Date.now()))' }); return capture(p); },
  focusToggle: async p => { await p.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await p.send('Emulation.setFocusEmulationEnabled', { enabled: true }); return capture(p); },
  screencast: p => new Promise((res, rej) => {
    let done = false; const t = setTimeout(() => rej(new Error(`screencast timeout ${LIMIT_MS}ms`)), LIMIT_MS);
    const off = p.on(m => { if (m.method === 'Page.screencastFrame' && !done) { done = true; clearTimeout(t); p.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {}); p.send('Page.stopScreencast').catch(() => {}); res({ bytes: m.params.data.length }); } });
    p.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 }).catch(rej);
  }),
};

const relay = await startRelay({ CDP_RELAY_SOCKET: SOCKET });
const { browser } = await launchChromeWithExtension({ name: 'shot' });
await waitForBrowser('shot');
const a = mcp();
const results = [];
const retrying = async (p, params = {}) => { try { return await p.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, ...params }, 3000).then(r => ({ bytes: r.data.length })); } catch { return { retried: true, ...(await p.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, ...params }).then(r => ({ bytes: r.data.length }))) }; } };
const kick = async (p, params = {}) => {
  await new Promise((res, rej) => {
    let done = false; const t = setTimeout(() => rej(new Error('kick timeout')), LIMIT_MS);
    p.on(m => { if (m.method === 'Page.screencastFrame' && !done) { done = true; clearTimeout(t); p.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {}); res(); } });
    p.send('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 }).catch(rej);
  });
  try { return await p.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, ...params }).then(r => ({ bytes: r.data.length })); }
  finally { await p.send('Page.stopScreencast').catch(() => {}); }
};
const SERIES = {
  kick: p => kick(p),
  kickClip: p => kick(p, { clip: { x: 0, y: 0, width: 200, height: 100, scale: 1 } }),
  kickFull: p => kick(p, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: 800, height: 2000, scale: 1 } }),
  plainAfterKicks: p => capture(p),
};
for (const [name, fn] of Object.entries(SERIES)) {
  const opened = JSON.parse((await a.tool('tab_open', { browser: 'shot', url: SITE, active: false, snapshot: false })).result.content.find(c => c.type === 'text').text.split('\n\n')[0]);
  const p = await page(opened.tab_id);
  const runs = [];
  for (let i = 0; i < 5; i++) { const r = await timed(() => fn(p)); runs.push(`${r.ok ? 'ok' : 'NG'} ${r.ms}ms${r.retried ? 'R' : ''}`); }
  results.push({ series: name, runs: runs.join(' | ') });
  p.close(); await a.tool('tab_close', { tab: opened.tab });
}
await a.tool('session_end', { close_tabs: true }); a.child.kill();
await browser.close();
console.log(JSON.stringify({ platform: process.platform, results }));
relay.stop(); srv.close(); process.exit(0);
