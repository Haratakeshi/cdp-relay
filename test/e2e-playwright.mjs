// E2E-3: Playwright の connectOverCDP が中継サーバー経由で動くか
import { chromium } from 'playwright-core';
import { startRelay, launchChromeWithExtension, waitForBrowser, startLocalSite, RELAY, sleep, assert } from './harness.mjs';

const site = await startLocalSite();
const relay = await startRelay();
const { browser: chrome } = await launchChromeWithExtension({ name: 'test-a' });
try {
  await waitForBrowser('test-a');
  const t0 = Date.now();
  const browser = await chromium.connectOverCDP(`${RELAY}/b/test-a`, { timeout: 30_000 });
  assert(browser.isConnected(), `chromium.connectOverCDP via facade (${Date.now() - t0}ms), version ${browser.version()}`);
  const ctx = browser.contexts()[0];
  assert(ctx && ctx.pages().length >= 1, `default context has ${ctx?.pages().length} page(s)`);
  const page = await ctx.newPage();
  await page.goto(site.url + 'pw-test');
  assert(await page.title() === 'pw-test', `page.title() = ${await page.title()}`);
  await page.fill('#i', 'from playwright'); await page.click('#b');
  assert(await page.title() === 'from playwright', 'fill/click via Playwright');
  const png = await page.screenshot();
  assert(png.length > 1000, `page.screenshot ${png.length} bytes`);
  await page.close();
  await browser.close();
  await sleep(300);
  const after = await fetch(`${RELAY}/browsers`).then(r => r.json());
  assert(after[0].attachedTabs.length === 0, 'all tabs detached after browser.close()');
  console.log('E2E-3 PASS');
} finally {
  await chrome.close().catch(() => {});
  relay.stop(); site.stop();
}
