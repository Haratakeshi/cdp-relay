// 回帰: 接続中(OPEN)にオプション保存(chrome.storage.local.set)しても再接続ループにならず、1 本の接続に落ち着く
import { startRelay, launchChromeWithExtension, waitForBrowser, RELAY, sleep, assert } from './harness.mjs';
import { readFileSync } from 'node:fs';

const relay = await startRelay();
const { browser, extId, config } = await launchChromeWithExtension({ name: 'rc1', configure: false });
try {
  // 名前が未設定の拡張は接続しない(既定名で他プロファイルと衝突しないように)
  await sleep(5000);
  assert((await fetch(`${RELAY}/browsers`).then(r => r.json())).length === 0, '未設定の拡張は中継に接続しない');
  await config();
  await waitForBrowser('rc1');
  assert(true, '名前を設定すると接続する');
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`));
  const worker = await sw.worker();
  const logLines = () => readFileSync(`tmp/relay-${new URL(RELAY).port}.log`, 'utf8').split('\n').filter(l => /extension (dis)?connected: rc/.test(l)).length;
  const before = logLines();
  await worker.evaluate(() => chrome.storage.local.set({ name: 'rc2' })); // 接続中に名前を変更
  await sleep(6000);
  const list = await fetch(`${RELAY}/browsers`).then(r => r.json());
  assert(list.length === 1 && list[0].name === 'rc2', `exactly one browser registered under the new name (${list.map(b => b.name)})`);
  const churn = logLines() - before;
  assert(churn <= 3, `connect/disconnect log lines after save: ${churn} (loop would produce dozens)`);
  const v = await fetch(`${RELAY}/b/rc2/json/version`).then(r => r.json());
  assert(v.webSocketDebuggerUrl, 'json/version works after reconnect');

  // POST /b/<name>/reload-extension: 人手なしで拡張を読み直し(chrome.runtime.reload)、再接続する。
  // 開発者モードが OFF だと Chrome 152 は再読み込みした未パック拡張を unsupportedDeveloperExtension で無効化する(実測)。
  // 実運用では未パック拡張の読み込みに開発者モードが必要なので ON になっている。テストのプロファイルでも ON にする
  const ext = await browser.newPage(); await ext.goto('chrome://extensions');
  await ext.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  const [{ connectedAt, extVersion }] = await fetch(`${RELAY}/browsers`).then(r => r.json());
  const version = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;
  assert(extVersion === version, `/browsers の extVersion = manifest の version(${extVersion})`);
  const res = await fetch(`${RELAY}/b/rc2/reload-extension`, { method: 'POST' });
  assert(res.status === 200, `reload-extension -> ${res.status} ${JSON.stringify(await res.json())}`);
  let after; for (let i = 0; i < 60; i++) { await sleep(250); after = (await fetch(`${RELAY}/browsers`).then(r => r.json()))[0]; if (after && after.connectedAt !== connectedAt && after.extVersion) break; }
  assert(after?.name === 'rc2' && after.connectedAt !== connectedAt && after.extVersion === version, `拡張が再読み込みされて再接続(connectedAt ${connectedAt.slice(11, 23)} -> ${after?.connectedAt.slice(11, 23)})`);
  console.log('E2E-7 PASS');
} finally { await browser.close().catch(() => {}); relay.stop(); }
