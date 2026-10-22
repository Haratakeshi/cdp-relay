// E2E-11: Browser.setDownloadBehavior を chrome.downloads で実現する(以前は黙って {} を返す no-op だった)
//  - Playwright(connectOverCDP は既定で allowAndName + eventsEnabled): download イベント / download.path()(downloadPath/<guid>)/ saveAs
//  - puppeteer: setDownloadBehavior({policy:'allow', downloadPath}) で downloadPath/<元の名前> / 'deny' で保存されない
//  - Playwright クライアント 2 つ: どちらにも download が届き、それぞれの downloadPath に置かれる。片方が切断しても残った方は使える
//  - 同名のファイルがあっても上書きしない("name (1).ext")。downloadPath は絶対パスのみ
//  - クライアントの切断で既定に戻る(以後のダウンロードには中継が触らない)
//  - Security.setIgnoreCertificateErrors {ignore:true} はエラー(黙って成功にしない)、{ignore:false} は {}
import puppeteer from 'puppeteer-core';
import { chromium } from 'playwright-core';
import http from 'node:http';
import { WebSocket } from 'ws';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { startRelay, launchChromeWithExtension, waitForBrowser, RELAY, sleep, assert, artifactsDir, relayEvents } from './harness.mjs';

const NAME = 'dl';
const srv = http.createServer((req, res) => {
  const m = req.url.match(/^\/f\/([\w.-]+)$/);
  if (m) { res.setHeader('content-disposition', `attachment; filename="${m[1]}"`); return res.end(`content of ${m[1]}`); }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<title>dl</title>${['pw.txt', 'two.txt', 'two-b.txt', 'pptr.txt', 'deny.txt', 'after.txt'].map(f => `<a id="${f.split('.')[0]}" href="/f/${f}">${f}</a> `).join('')}`);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${srv.address().port}`;

const out = artifactsDir('e2e-downloads');
const chromeDir = join(out, 'chrome-download-dir'); // ブラウザ自身のダウンロード先(実運用の ~/Downloads に相当)
const waitFile = async (p, ms = 5000) => { for (let t = 0; t < ms && !existsSync(p); t += 100) await sleep(100); return existsSync(p); };
const relay = await startRelay();
const { browser: chrome, worker } = await launchChromeWithExtension({ name: NAME, prefs: { download: { default_directory: chromeDir, prompt_for_download: false } } });
try {
  await waitForBrowser(NAME);

  // --- Playwright ---
  const pw = await chromium.connectOverCDP(`${RELAY}/b/${NAME}`, { timeout: 30_000 });
  const pp = await pw.contexts()[0].newPage();
  await pp.goto(site);
  const [download] = await Promise.all([pp.waitForEvent('download', { timeout: 10_000 }), pp.click('#pw')]);
  assert(download.suggestedFilename() === 'pw.txt' && download.url() === `${site}/f/pw.txt`, `Playwright: download イベント(Browser.downloadWillBegin)suggestedFilename=${download.suggestedFilename()}`);
  const path = await download.path();
  assert(readFileSync(path, 'utf8') === 'content of pw.txt' && /^[0-9a-f-]{36}$/.test(basename(path)), `download.path() = downloadPath/<guid>(${basename(path)})`);
  await download.saveAs(join(out, 'playwright-saved-pw.txt'));
  assert(readFileSync(join(out, 'playwright-saved-pw.txt'), 'utf8') === 'content of pw.txt', 'download.saveAs でアーティファクトに保存');
  assert(!existsSync(join(chromeDir, 'pw.txt')), 'ブラウザのダウンロードフォルダには残さない(downloadPath へ移動)');
  // Playwright は全タブに attach しているが、ユーザーのタブ(中継経由でないタブ)のダウンロードには触らない
  let since = (await relayEvents(NAME)).at(-1).seq;
  const userTabId = await worker.evaluate(url => chrome.tabs.create({ url, active: false }).then(t => t.id), `${site}/user-page`);
  for (let i = 0; i < 40 && !(await fetch(`${RELAY}/browsers`).then(r => r.json()))[0].attachedTabs.includes(userTabId); i++) await sleep(100);
  assert((await fetch(`${RELAY}/browsers`).then(r => r.json()))[0].attachedTabs.includes(userTabId), 'ユーザーのタブにも Playwright が attach している(前提)');
  await worker.evaluate(([id, url]) => chrome.tabs.update(id, { url }), [userTabId, `${site}/f/user.txt`]);
  assert(await waitFile(join(chromeDir, 'user.txt')) && (await relayEvents(NAME, since)).filter(e => e.type.startsWith('download')).length === 0, 'Playwright 接続中でも、ユーザーのタブのダウンロードはブラウザ既定のフォルダのまま(記録もしない)');
  await pp.close(); await pw.close(); await sleep(300);

  // --- Playwright クライアント 2 つ ---
  const [pa, pbw] = [await chromium.connectOverCDP(`${RELAY}/b/${NAME}`, { timeout: 30_000 }), await chromium.connectOverCDP(`${RELAY}/b/${NAME}`, { timeout: 30_000 })];
  const pageA = await pa.contexts()[0].newPage(); await pageA.goto(site);
  const pageB = pbw.contexts()[0].pages().find(p => p.url() === site + '/') ?? await pbw.contexts()[0].waitForEvent('page');
  const [dA, dB] = await Promise.all([pageA.waitForEvent('download', { timeout: 10_000 }), pageB.waitForEvent('download', { timeout: 10_000 }), pageA.click('#two')]);
  const [pathA, pathB] = [await dA.path(), await dB.path()];
  assert(pathA !== pathB && readFileSync(pathA, 'utf8') === 'content of two.txt' && readFileSync(pathB, 'utf8') === 'content of two.txt', 'Playwright 2 クライアント: 両方に download が届き、それぞれの downloadPath に置かれる');
  await pa.close(); await sleep(300); // 片方が切断しても、残った方の設定は外れない
  const [dB2] = await Promise.all([pageB.waitForEvent('download', { timeout: 10_000 }), pageB.click('#two-b')]);
  const pathB2 = await dB2.path();
  assert(readFileSync(pathB2, 'utf8') === 'content of two-b.txt', `片方が切断した後も残った方で download.path() が返る(${basename(pathB2)})`);
  await dB2.saveAs(join(out, 'playwright-second-client-two-b.txt'));
  await pbw.close(); await sleep(300);

  // --- puppeteer: allow / deny ---
  const pb = await puppeteer.connect({ browserURL: `${RELAY}/b/${NAME}`, defaultViewport: null, protocolTimeout: 30_000 });
  const ctx = pb.defaultBrowserContext();
  const pptrDir = join(out, 'puppeteer-download-path');
  let relErr; try { await ctx.setDownloadBehavior({ policy: 'allow', downloadPath: 'relative/dir' }); } catch (e) { relErr = e; }
  assert(/must be absolute/.test(relErr?.message), 'downloadPath は絶対パスのみ');
  mkdirSync(pptrDir, { recursive: true }); writeFileSync(join(pptrDir, 'pptr.txt'), 'USER ORIGINAL');
  await ctx.setDownloadBehavior({ policy: 'allow', downloadPath: pptrDir });
  const page = await pb.newPage(); await page.goto(site);
  await page.click('#pptr');
  assert(await waitFile(join(pptrDir, 'pptr (1).txt')) && readFileSync(join(pptrDir, 'pptr (1).txt'), 'utf8') === 'content of pptr.txt' && readFileSync(join(pptrDir, 'pptr.txt'), 'utf8') === 'USER ORIGINAL', 'puppeteer allow: downloadPath に保存。同名の既存ファイルは上書きせず "pptr (1).txt"');
  await ctx.setDownloadBehavior({ policy: 'deny' });
  since = (await relayEvents(NAME)).at(-1).seq;
  await page.click('#deny'); await sleep(1500);
  const denied = (await relayEvents(NAME, since)).filter(e => e.type === 'download');
  assert(!existsSync(join(chromeDir, 'deny.txt')) && !existsSync(join(pptrDir, 'deny.txt')) && denied[0]?.action === 'canceled', `puppeteer deny: 保存されない(events: ${denied.map(e => e.action).join()})`);
  const state = await page.evaluate(() => 1);
  assert(state === 1, 'deny 後もページは操作可能');

  // --- Security.setIgnoreCertificateErrors ---
  let certErr; try { await puppeteer.connect({ browserURL: `${RELAY}/b/${NAME}`, acceptInsecureCerts: true }); } catch (e) { certErr = e; }
  assert(certErr && /not supported via the extension relay/.test(certErr.message), `acceptInsecureCerts(ignore:true)は接続時にエラー: ${certErr?.message.slice(0, 90)}`);
  const fws = new WebSocket(`${RELAY.replace('http', 'ws')}/b/${NAME}/devtools/browser`); await new Promise(r => fws.once('open', r));
  const ign = await new Promise(r => { fws.once('message', m => r(JSON.parse(m))); fws.send(JSON.stringify({ id: 1, method: 'Security.setIgnoreCertificateErrors', params: { ignore: false } })); });
  assert(ign.result && !ign.error, 'Security.setIgnoreCertificateErrors {ignore:false} は {}');
  fws.close();

  // --- 切断で既定に戻る: 以後のダウンロードはブラウザ既定のフォルダに入り、中継は触らない ---
  await page.close(); pb.disconnect(); await sleep(500);
  since = (await relayEvents(NAME)).at(-1).seq;
  const tab = (await fetch(`${RELAY}/b/${NAME}/json/list`).then(r => r.json()))[0];
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.once('open', r));
  let id = 0; const send = (method, params) => new Promise(r => { const my = ++id; ws.on('message', m => { m = JSON.parse(m); if (m.id === my) r(m); }); ws.send(JSON.stringify({ id: my, method, params })); });
  await send('Page.navigate', { url: site }); await sleep(500);
  await send('Runtime.evaluate', { expression: 'document.getElementById("after").click()', userGesture: true });
  assert(await waitFile(join(chromeDir, 'after.txt')) && !existsSync(join(pptrDir, 'after.txt')), 'クライアント切断後はブラウザ既定のダウンロード先に保存(中継は移動しない)');
  assert((await relayEvents(NAME, since)).filter(e => e.type.startsWith('download')).length === 0, '既定に戻った後のダウンロードは記録しない(ユーザーのダウンロードに触らない)');
  ws.close();
  console.log('E2E-11 PASS');
} finally {
  writeFileSync(join(out, 'events.json'), JSON.stringify(await relayEvents(NAME).catch(e => ({ error: e.message })), null, 1));
  writeFileSync(join(out, 'files.json'), JSON.stringify(Object.fromEntries(['chrome-download-dir', 'puppeteer-download-path'].map(d => [d, existsSync(join(out, d)) ? readdirSync(join(out, d)) : []])), null, 1));
  await chrome.close().catch(() => {}); relay.stop(); srv.close();
}
