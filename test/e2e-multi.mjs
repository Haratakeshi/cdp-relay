// E2E-4: 2つの独立した Chrome(別プロファイル)を1つの中継サーバー経由で同時に操作する
import puppeteer from 'puppeteer-core';
import { startRelay, launchChromeWithExtension, waitForBrowser, startLocalSite, RELAY, sleep, assert } from './harness.mjs';

const site = await startLocalSite();
const relay = await startRelay();
const a = await launchChromeWithExtension({ name: 'company-a', port: 9401 });
const b = await launchChromeWithExtension({ name: 'company-b', port: 9402 });
try {
  await waitForBrowser('company-a'); await waitForBrowser('company-b');
  const list = await fetch(`${RELAY}/browsers`).then(r => r.json());
  assert(list.map(x => x.name).sort().join() === 'company-a,company-b', `GET /browsers -> ${list.map(x => x.name).join(', ')}`);
  let err; try { await puppeteer.connect({ browserURL: RELAY }); } catch (e) { err = e; }
  assert(err, 'root /json/version is refused when 2 browsers are connected (must specify /b/<name>)');
  assert(list.every(x => x.port), `dedicated ports announced: ${list.map(x => `${x.name}=${x.port}`).join(', ')}`);
  const [ba, bb] = await Promise.all([9401, 9402].map(p => puppeteer.connect({ browserURL: `http://127.0.0.1:${p}`, defaultViewport: null })));
  assert(ba.connected && bb.connected, 'puppeteer.connect via dedicated ports (browserURL resolves /json/version at root)');
  const [pa, pb] = await Promise.all([ba.newPage(), bb.newPage()]);
  await Promise.all([pa.goto(site.url + 'A'), pb.goto(site.url + 'B')]);
  assert(await pa.title() === 'A' && await pb.title() === 'B', 'both browsers navigated independently');
  const tabsA = await fetch(`${RELAY}/b/company-a/json/list`).then(r => r.json());
  assert(tabsA.some(t => t.url.endsWith('/A')) && !tabsA.some(t => t.url.endsWith('/B')), 'tab lists are isolated per browser');
  await Promise.all([pa.close(), pb.close()]);
  ba.disconnect(); bb.disconnect();
  console.log('E2E-4 PASS');
} finally {
  await a.browser.close().catch(() => {}); await b.browser.close().catch(() => {});
  relay.stop(); site.stop();
}
