// E2E-12: Browser.grantPermissions / setPermission / resetPermissions を chrome.contentSettings で実現する
//  - 拡張の接続時にポリシーの permissions を事前適用
//  - Playwright: context.grantPermissions → navigator.permissions.query が granted、clearPermissions で prompt に戻り、ポリシー分は残る
//  - 対応できない権限を含むと列挙したエラーで、部分的にも適用しない
//  - puppeteer: overridePermissions / setPermission(denied)/ clearPermissionOverrides
//  - クライアント切断で、そのクライアントが設定した分だけ消える(他のクライアントの設定とポリシーは残る)
//  - policy.json の permissions を書き換えると接続中のブラウザへ反映される
//  - 中継が止まる(拡張が切断する)と拡張が自分の規則を消す。再接続でポリシーが戻る
import puppeteer from 'puppeteer-core';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRelay, launchChromeWithExtension, waitForBrowser, startLocalSite, RELAY, sleep, assert, artifactsDir, relayEvents } from './harness.mjs';

const NAME = 'perm';
const site = await startLocalSite();
const origin = new URL(site.url).origin;
const out = artifactsDir('e2e-permissions');
const policyPath = join(out, 'policy.json');
writeFileSync(policyPath, JSON.stringify({ permissions: { [origin]: { notifications: 'allow', noSuchType: 'allow' } } }, null, 1)); chmodSync(policyPath, 0o600);
let relay = await startRelay({ CDP_RELAY_POLICY: policyPath });
const { browser: chrome } = await launchChromeWithExtension({ name: NAME });
const query = (page, ...names) => page.evaluate(ns => Promise.all(ns.map(n => navigator.permissions.query({ name: n }).then(s => s.state))), names).then(r => r.join());
const snapshots = {};
try {
  await waitForBrowser(NAME);
  for (let i = 0; i < 40 && !(await relayEvents(NAME)).some(e => e.type === 'permission'); i++) await sleep(100);

  // 中継のタブ WS で直接確かめる(クライアント切断後の状態を見るため)
  const tab = (await fetch(`${RELAY}/b/${NAME}/json/list`).then(r => r.json()))[0];
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.once('open', r));
  let id = 0; const send = (method, params) => new Promise(r => { const my = ++id; ws.on('message', m => { m = JSON.parse(m); if (m.id === my) r(m.result); }); ws.send(JSON.stringify({ id: my, method, params })); });
  await send('Page.navigate', { url: site.url + 'raw' }); await sleep(500);
  const rawQuery = async (...names) => (await send('Runtime.evaluate', { expression: `Promise.all(${JSON.stringify(names)}.map(n => navigator.permissions.query({ name: n }).then(s => s.state))).then(r => r.join())`, awaitPromise: true, returnByValue: true })).result.value;
  snapshots.initial = await rawQuery('notifications', 'geolocation', 'camera');
  assert(snapshots.initial === 'granted,prompt,prompt', `接続時にポリシーを事前適用(notifications,geolocation,camera = ${snapshots.initial})`);

  // --- Playwright ---
  const pw = await chromium.connectOverCDP(`${RELAY}/b/${NAME}`, { timeout: 30_000 });
  const ctx = pw.contexts()[0];
  const pp = await ctx.newPage(); await pp.goto(site.url + 'pw');
  await ctx.grantPermissions(['geolocation'], { origin });
  snapshots.playwrightGranted = await query(pp, 'geolocation', 'camera', 'notifications');
  assert(snapshots.playwrightGranted === 'granted,prompt,granted', `Playwright grantPermissions(['geolocation']) → ${snapshots.playwrightGranted}`);
  let err; try { await ctx.grantPermissions(['camera', 'midi'], { origin }); } catch (e) { err = e; }
  assert(err && /not supported.*midi/.test(err.message) && await query(pp, 'camera') === 'prompt', `対応できない権限を含むとエラーで、camera も適用しない: ${err?.message.split('\n')[0].slice(0, 120)}`);
  let err2; try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }); } catch (e) { err2 = e; }
  assert(err2 && /clipboardSanitizedWrite/.test(err2.message), 'clipboard-write(clipboardSanitizedWrite)は contentSettings に無いので対応不可と明示');
  await ctx.clearPermissions();
  snapshots.playwrightCleared = await query(pp, 'geolocation', 'notifications');
  assert(snapshots.playwrightCleared === 'prompt,granted', `clearPermissions → geolocation は prompt、ポリシーの notifications は残る(${snapshots.playwrightCleared})`);
  for (const [bad, re] of [['ws://example.com', /rejected.*Invalid scheme/], ['chrome://settings', /Invalid origin/]]) {
    let e3; try { await ctx.grantPermissions(['geolocation'], { origin: bad }); } catch (e) { e3 = e; }
    assert(e3 && re.test(e3.message) && await query(pp, 'geolocation') === 'prompt', `パターンにできないオリジン(${bad})は黙って成功にしない: ${e3?.message.split('\n')[0].slice(-70)}`);
  }
  await ctx.grantPermissions(['camera']); // origin なし = 全サイト(http://*/* と https://*/*)
  assert(await query(pp, 'camera') === 'granted', 'origin なしの grantPermissions は全サイトに適用');

  // --- puppeteer(Playwright の接続を残したまま)---
  const pb = await puppeteer.connect({ browserURL: `${RELAY}/b/${NAME}`, defaultViewport: null, protocolTimeout: 30_000 });
  const bctx = pb.defaultBrowserContext();
  const page = await pb.newPage(); await page.goto(site.url + 'pptr');
  await bctx.overridePermissions(origin, ['microphone', 'geolocation']);
  await bctx.setPermission(origin, { permission: { name: 'notifications' }, state: 'denied' });
  snapshots.puppeteer = await query(page, 'microphone', 'geolocation', 'notifications', 'camera');
  assert(snapshots.puppeteer === 'granted,granted,denied,granted', `puppeteer overridePermissions + setPermission(denied) → ${snapshots.puppeteer}`);
  await page.close(); pb.disconnect(); await sleep(500); // clearPermissionOverrides を呼ばずに切断
  snapshots.afterPuppeteerDisconnect = await rawQuery('microphone', 'geolocation', 'notifications', 'camera');
  assert(snapshots.afterPuppeteerDisconnect === 'prompt,prompt,granted,granted', `puppeteer 切断でその分だけ消える(Playwright の camera とポリシーは残る): ${snapshots.afterPuppeteerDisconnect}`);

  await pp.close(); await pw.close(); await sleep(500);
  snapshots.afterAllDisconnect = await rawQuery('notifications', 'geolocation', 'camera');
  assert(snapshots.afterAllDisconnect === snapshots.initial, `全クライアント切断で接続時の状態(ポリシーのみ)に戻る: ${snapshots.afterAllDisconnect}`);

  writeFileSync(policyPath, JSON.stringify({ permissions: { [origin]: { notifications: 'allow', location: 'allow' } } }, null, 1));
  for (let i = 0; i < 30 && await rawQuery('geolocation') !== 'granted'; i++) await sleep(200);
  snapshots.afterPolicyEdit = await rawQuery('notifications', 'geolocation');
  assert(snapshots.afterPolicyEdit === 'granted,granted', `policy.json の permissions の変更が接続中のブラウザに反映される(${snapshots.afterPolicyEdit})`);

  // 中継を止める(クライアントの grant を残したまま)→ 拡張が切断を検知して自分の規則を消す
  const pw2 = await chromium.connectOverCDP(`${RELAY}/b/${NAME}`, { timeout: 30_000 });
  await pw2.contexts()[0].grantPermissions(['camera'], { origin });
  assert(await rawQuery('camera') === 'granted', '(前提)クライアントの grant が効いている');
  ws.close(); relay.stop(); await sleep(1500);
  const direct = await chrome.newPage(); await direct.goto(site.url + 'direct'); // 中継を通さない直結(テスト用 pipe)で確かめる
  snapshots.afterRelayStopped = await query(direct, 'notifications', 'geolocation', 'camera');
  assert(snapshots.afterRelayStopped === 'prompt,prompt,prompt', `中継停止後は拡張が設定した規則(ポリシーとクライアントの grant)が消える(${snapshots.afterRelayStopped})`);
  await pw2.close().catch(() => {});
  relay = await startRelay({ CDP_RELAY_POLICY: policyPath });
  await waitForBrowser(NAME, 40_000);
  for (let i = 0; i < 30 && await query(direct, 'notifications') !== 'granted'; i++) await sleep(200);
  snapshots.afterReconnect = await query(direct, 'notifications', 'geolocation', 'camera');
  assert(snapshots.afterReconnect === 'granted,granted,prompt', `再接続でポリシーだけが戻る(${snapshots.afterReconnect})`);
  console.log('E2E-12 PASS');
} finally {
  writeFileSync(join(out, 'events.json'), JSON.stringify(await relayEvents(NAME).catch(e => ({ error: e.message })), null, 1));
  writeFileSync(join(out, 'permission-states.json'), JSON.stringify(snapshots, null, 1));
  await chrome.close().catch(() => {}); relay.stop(); site.stop();
}
