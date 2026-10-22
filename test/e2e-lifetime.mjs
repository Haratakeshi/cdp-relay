// E2E-5: Service Worker の寿命。
//  (a) 未 attach のアイドル状態で 75 秒経っても同じ WS 接続が維持される(中継の 20 秒 ping で MV3 の 30 秒アイドル終了を回避)
//  (b) ping を止めた中継に繋ぎ直しても 100 秒間 SW が終了しない(拡張側の 30 秒周期 alarms がイベント発火でアイドルタイマーをリセットする)
//      観測メモ: 中継停止中は再接続試行が同様にタイマーをリセットする。ServiceWorker.stopWorker による強制停止は "starting" のまま
//      復帰しない事象を観測した(DevTools 経由の停止固有かは未確認。test/debug-sw.mjs)
import { startRelay, launchChromeWithExtension, waitForBrowser, RELAY, sleep, assert } from './harness.mjs';

let relay = await startRelay();
const { browser, extId } = await launchChromeWithExtension({ name: 'life' });
try {
  await waitForBrowser('life');
  const connectedAt = () => fetch(`${RELAY}/browsers`).then(r => r.json()).then(l => l.find(b => b.name === 'life')?.connectedAt).catch(() => undefined);
  const first = await connectedAt();
  // SW の状態は puppeteer 直結(pipe)のページセッションから ServiceWorker ドメインで観察する
  const cdp = await (await browser.pages())[0].createCDPSession();
  let status = ''; const transitions = [];
  cdp.on('ServiceWorker.workerVersionUpdated', e => e.versions.filter(v => v.scriptURL.startsWith(`chrome-extension://${extId}/`)).forEach(v => { if (v.runningStatus !== status) { status = v.runningStatus; transitions.push(status); } }));
  await cdp.send('ServiceWorker.enable');

  await sleep(75_000);
  assert(await connectedAt() === first, `idle 75s: same extension connection kept (SW status=${status})`);

  relay.stop(); await sleep(1000);
  relay = await startRelay({ CDP_RELAY_PING_INTERVAL: '0' });
  let second; for (let i = 0; i < 120; i++) { second = await connectedAt(); if (second) break; await sleep(250); }
  assert(second, 'reconnected to a relay that never pings');
  await sleep(100_000);
  assert(status === 'running' && await connectedAt() === second, `no ping for 100s: SW still running and same connection kept (alarms keepalive; transitions: ${transitions.join(' -> ')})`);
  console.log('E2E-5 PASS');
} finally { await browser.close().catch(() => {}); relay.stop(); }
