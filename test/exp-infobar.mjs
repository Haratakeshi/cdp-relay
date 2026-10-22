// 実験 E1: chrome.debugger attach 時のインフォバーを観察する(通常起動 vs --silent-debugger-extension-api)
// キャプチャは CDP の Browser.getWindowBounds で得た「起動した窓」の領域だけに限定する(ユーザーの実ブラウザを保存しないため)
import { execSync } from 'node:child_process';
import { startRelay, launchChromeWithExtension, waitForBrowser, startLocalSite, RELAY, sleep } from './harness.mjs';
import { WebSocket } from 'ws';

const site = await startLocalSite();
const relay = await startRelay();
for (const [label, args] of [['normal', []], ['silent-flag', ['--silent-debugger-extension-api']]]) {
  // --enable-automation(puppeteer 既定)は「自動テスト ソフトウェアによって制御されています」バーを出すので外し、実運用の Chrome に近づける
  const { browser } = await launchChromeWithExtension({ name: 'infobar', headless: false, args, ignoreDefaultArgs: ['--enable-automation'] });
  try {
    await waitForBrowser('infobar');
    const tabs = await fetch(`${RELAY}/b/infobar/json/list`).then(r => r.json());
    const ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: site.url + label } }));
    await sleep(2000);

    const page = (await browser.pages())[0];
    await page.bringToFront(); // 窓を最前面に出してから撮る
    await sleep(600);
    const cdp = await browser.target().createCDPSession();
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.target()._targetId });
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    const h = Math.min(bounds.height, 260); // 上端(タブバー〜インフォバー)だけで足りる
    execSync(`screencapture -x -R${bounds.left},${bounds.top},${bounds.width},${h} tmp/infobar-${label}.png`);
    console.log(`captured tmp/infobar-${label}.png from window bounds ${JSON.stringify(bounds)}`);
    ws.close();
  } finally { await browser.close().catch(() => {}); }
  await sleep(500);
}
relay.stop(); site.stop();
