// E2E-9: Chrome と Edge を 1 つの中継サーバーに同時登録して、それぞれ独立に操作する
import puppeteer from 'puppeteer-core';
import { startRelay, launchChromeWithExtension, waitForBrowser, startLocalSite, RELAY, sleep, assert } from './harness.mjs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const site = await startLocalSite();
const relay = await startRelay();
const chrome = await launchChromeWithExtension({ name: 'chrome-x', port: 9403 });
const edge = await launchChromeWithExtension({ name: 'edge-x', port: 9404, executablePath: EDGE });
try {
  await waitForBrowser('chrome-x'); await waitForBrowser('edge-x');
  const list = await fetch(`${RELAY}/browsers`).then(r => r.json());
  assert(list.length === 2 && list.every(b => !b.portError), `1 つの中継に 2 ブラウザ: ${list.map(b => `${b.name}:${b.port}`).join(', ')}`);

  const [vc, ve] = await Promise.all([9403, 9404].map(p => fetch(`http://127.0.0.1:${p}/json/version`).then(r => r.json())));
  assert(vc.Browser.startsWith('Chrome/') && ve.Browser.startsWith('Edg/'), `専用ポートが別ブラウザを指す: 9403=${vc.Browser} / 9404=${ve.Browser}`);

  const [bc, be] = await Promise.all([9403, 9404].map(p => puppeteer.connect({ browserURL: `http://127.0.0.1:${p}`, defaultViewport: null })));
  const [pc, pe] = await Promise.all([bc.newPage(), be.newPage()]);
  await Promise.all([pc.goto(site.url + 'from-chrome'), pe.goto(site.url + 'from-edge')]);
  assert(await pc.title() === 'from-chrome' && await pe.title() === 'from-edge', '2 ブラウザを同時に別ページへ遷移');

  const tabsC = await fetch(`${RELAY}/b/chrome-x/json/list`).then(r => r.json());
  assert(tabsC.some(t => t.url.endsWith('from-chrome')) && !tabsC.some(t => t.url.endsWith('from-edge')), 'タブ一覧はブラウザごとに分離');

  await Promise.all([pc.close(), pe.close()]);
  bc.disconnect(); be.disconnect();
  console.log('E2E-9 PASS');
} finally {
  await chrome.browser.close().catch(() => {}); await edge.browser.close().catch(() => {});
  relay.stop(); site.stop();
}
