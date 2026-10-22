// SW 強制停止後の復帰を観察する
import { startRelay, launchChromeWithExtension, waitForBrowser, RELAY, sleep } from './harness.mjs';
const relay = await startRelay();
const { browser, extId } = await launchChromeWithExtension({ name: 'life' });
try {
  await waitForBrowser('life');
  browser.on('targetcreated', t => t.type() === 'service_worker' && console.log(`${ts()} target created: ${t.url().slice(0, 60)}`));
  browser.on('targetdestroyed', t => t.type() === 'service_worker' && console.log(`${ts()} target destroyed: ${t.url().slice(0, 60)}`));
  const t00 = Date.now(); const ts = () => `+${((Date.now() - t00) / 1000).toFixed(1)}s`;
  const cdp = await (await browser.pages())[0].createCDPSession();
  let status = ''; const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', e => e.versions.filter(v => v.scriptURL.startsWith(`chrome-extension://${extId}/`)).forEach(v => { versions.set(v.versionId, v); if (v.runningStatus !== status) { status = v.runningStatus; console.log(`${ts()} SW ${v.versionId} status=${v.runningStatus}`); } }));
  cdp.on('ServiceWorker.workerErrorReported', e => console.log(`${ts()} SW error`, JSON.stringify(e).slice(0, 200)));
  await cdp.send('ServiceWorker.enable'); await sleep(800);
  const v = [...versions.values()][0];
  console.log(`${ts()} stopping SW version ${v?.versionId}`);
  await cdp.send('ServiceWorker.stopWorker', { versionId: v.versionId });
  await sleep(45_000);
  console.log(`${ts()} 45s passed; creating a tab to fire tabs.onCreated (does an event wake the SW?)`);
  const p = await browser.newPage(); await sleep(5000);
  console.log(`${ts()} browsers:`, JSON.stringify(await fetch(`${RELAY}/browsers`).then(r => r.json())));
  await p.close();
} finally { await browser.close().catch(() => {}); relay.stop(); }
