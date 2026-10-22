// E2E-2: puppeteer-core が中継サーバーを「普通の Chrome」として connect できるか(ブラウザ facade 経由)
import puppeteer from 'puppeteer-core';
import { startRelay, launchChromeWithExtension, waitForBrowser, startLocalSite, RELAY, sleep, assert } from './harness.mjs';

const site = await startLocalSite();
const relay = await startRelay();
const { browser: chrome } = await launchChromeWithExtension({ name: 'test-a' });
try {
  await waitForBrowser('test-a');
  const t0 = Date.now();
  const browser = await puppeteer.connect({ browserURL: `${RELAY}/b/test-a`, defaultViewport: null, protocolTimeout: 30_000 });
  assert(browser.connected, `puppeteer.connect via facade (${Date.now() - t0}ms)`);
  assert(/^(Chrome|Edg)\/\d+/.test(await browser.version()), `browser.version() = ${await browser.version()}`);
  const pages = await browser.pages();
  assert(pages.length >= 1, `browser.pages() -> ${pages.length}`);
  const page = await browser.newPage();
  assert(page, 'browser.newPage() (Target.createTarget -> chrome.tabs.create)');
  await page.goto(site.url + 'facade-test', { waitUntil: 'load' });
  assert(await page.title() === 'facade-test', `page.title() = ${await page.title()}`);
  assert(await page.$eval('h1', e => e.textContent) === 'page facade-test', 'page.$eval');
  const png = await page.screenshot({ type: 'png' });
  assert(png.length > 1000, `page.screenshot ${png.length} bytes`);
  await page.type('#i', 'typed text'); await page.click('#b');
  assert(await page.title() === 'typed text', 'keyboard/mouse input via Input domain');
  const before = (await browser.pages()).length;
  await page.close();
  await sleep(500);
  assert((await browser.pages()).length === before - 1, 'page.close() (Target.closeTarget -> chrome.tabs.remove)');
  browser.disconnect();
  await sleep(300);
  const after = await fetch(`${RELAY}/browsers`).then(r => r.json());
  assert(after[0].attachedTabs.length === 0, 'all tabs detached after disconnect');
  console.log('E2E-2 PASS');
} finally {
  await chrome.close().catch(() => {});
  relay.stop(); site.stop();
}
