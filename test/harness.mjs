// E2E 共通: 中継サーバーを子プロセスで起動し、拡張入りの Chrome を一時プロファイルで起動する
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const DEFAULT_CHROME = { darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', linux: '/usr/bin/google-chrome' }[process.platform];
export const CHROME = process.env.CHROME_PATH || DEFAULT_CHROME;
export const RELAY_PORT = Number(process.env.CDP_RELAY_PORT || 9400); // 常駐中継(既定 9333)と実運用の専用ポートに当たらない帯を使う
export const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const TMP = resolve('tmp');
mkdirSync(TMP, { recursive: true }); // clone 直後(tmp/ は .gitignore 済みで存在しない)でも動くように

export async function startRelay(env = {}) {
  if (await fetch(`${RELAY}/browsers`).then(() => true).catch(() => false)) throw new Error(`port ${RELAY_PORT} already in use (stale relay?): pkill -f relay/server.mjs`);
  const out = openSync(join(TMP, `relay-${RELAY_PORT}.log`), 'a');
  // CDP_RELAY_POLICY は既定で存在しないパス(= 既定ポリシー)。リポジトリ直下の実運用 policy.json(資格情報を含みうる)をテストに読ませない
  const child = spawn(process.execPath, [resolve('relay/server.mjs')], { stdio: ['ignore', out, out], env: { ...process.env, CDP_RELAY_PORT: String(RELAY_PORT), CDP_RELAY_POLICY: join(TMP, 'no-policy.json'), CDP_RELAY_SOCKET: join(TMP, `agent-${RELAY_PORT}.sock`), ...env } }); // エージェント用ソケットもホームではなく tmp/ に作る
  process.on('exit', () => child.kill()); // クラッシュ終了でも子を残さない
  for (let i = 0; i < 40; i++) { if (await fetch(`${RELAY}/browsers`).then(() => true).catch(() => false)) return { child, stop: () => child.kill() }; await sleep(100); }
  throw new Error('relay did not start; see tmp/relay.log');
}

// 既定はヘッドレス(ウィンドウが前面を奪って作業を止めないように)。HEADED=1 で画面つき起動に切り替える
export const HEADED = process.env.HEADED === '1';
// prefs はプロファイルの Default/Preferences に書く(例: ダウンロード先を一時ディレクトリにして ~/Downloads を汚さない)
export async function launchChromeWithExtension({ name, port, token, headless = !HEADED, args = [], ignoreDefaultArgs, executablePath = CHROME, userDataDir: dir, configure = true, prefs }) {
  const userDataDir = dir ?? mkdtempSync(join(TMP, `profile-${name}-`));
  if (prefs) { mkdirSync(join(userDataDir, 'Default'), { recursive: true }); writeFileSync(join(userDataDir, 'Default', 'Preferences'), JSON.stringify(prefs)); }
  const browser = await puppeteer.launch({
    executablePath, headless, userDataDir, enableExtensions: true, defaultViewport: null, ignoreDefaultArgs,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1000,700', ...args],
  });
  const extId = await browser.installExtension(resolve('extension'));
  // 拡張の Service Worker に設定を注入する(storage.onChanged で再接続される。実運用ではオプション画面で設定する)
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`), { timeout: 10_000 });
  const worker = await sw.worker();
  const config = () => worker.evaluate(cfg => chrome.storage.local.set(cfg), { name, relayUrl: `ws://127.0.0.1:${RELAY_PORT}/extension`, ...(port ? { port: String(port) } : {}), ...(token ? { token } : {}) });
  if (configure) await config();
  return { browser, extId, userDataDir, worker, config };
}

export async function waitForBrowser(name, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = await fetch(`${RELAY}/browsers`).then(r => r.json()).catch(() => []);
    if (list.some(b => b.name === name)) return list;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`browser ${name} did not register with relay within ${timeoutMs}ms`);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
/** 検証用アーティファクトの置き場 tmp/artifacts/<test>/(実行ごとに作り直す) */
export function artifactsDir(test) { const dir = join(TMP, 'artifacts', test); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); return dir; }
/** 中継が自動処理した記録(GET /b/<name>/events) */
export const relayEvents = (name, since = 0) => fetch(`${RELAY}/b/${name}/events?since=${since}`).then(r => r.json());
export function assert(cond, msg) { if (!cond) throw new Error(`ASSERT: ${msg}`); console.log('  ok -', msg); }

/** テスト用ローカルサイト(data: URL は chrome.debugger 経由の最上位遷移で net::ERR_ABORTED になるため使わない) */
export async function startLocalSite() {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const name = req.url.slice(1) || 'index';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<title>${name}</title><h1 id="h">page ${name}</h1><input id="i"><button id="b" onclick="document.title=document.getElementById('i').value">go</button>`);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/`, stop: () => srv.close() };
}
