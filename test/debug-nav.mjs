import http from 'node:http';
import { startRelay, launchChromeWithExtension, waitForBrowser, RELAY, sleep } from './harness.mjs';
import { WebSocket } from 'ws';
const srv = http.createServer((_, res) => res.end('<title>local</title><h1>local http</h1>'));
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const localUrl = `http://127.0.0.1:${srv.address().port}/`;
const relay = await startRelay();
const { browser } = await launchChromeWithExtension({ name: 'dbg' });
try {
  await waitForBrowser('dbg');
  const tabs = await fetch(`${RELAY}/b/dbg/json/list`).then(r => r.json());
  const ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let seq = 0; const pending = new Map(); const events = [];
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else events.push(m.method); });
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  console.log('Page.enable', JSON.stringify(await send('Page.enable')));
  for (const url of ['data:text/html,<title>d</title><h1>data</h1>', localUrl, 'about:blank']) {
    events.length = 0;
    const r = await send('Page.navigate', { url }).catch(e => ({ error: e.message }));
    await sleep(1500);
    const href = await send('Runtime.evaluate', { expression: 'location.href + " | " + document.title', returnByValue: true }).then(r => r.result.value).catch(e => 'ERR ' + e.message);
    console.log(`navigate ${url.slice(0, 30)} ->`, JSON.stringify(r), '| events:', [...new Set(events)].join(','), '| now:', href);
  }
  // 比較: puppeteer の直結セッション(pipe)で同じタブへ data: URL 遷移
  const page = (await browser.pages())[0];
  const r2 = await page.goto('data:text/html,<title>direct</title>').then(() => 'ok ' + page.url().slice(0, 30)).catch(e => 'ERR ' + e.message.slice(0, 60));
  console.log('direct puppeteer goto data: ->', r2);
  ws.close();
} finally { await browser.close().catch(() => {}); relay.stop(); srv.close(); }
