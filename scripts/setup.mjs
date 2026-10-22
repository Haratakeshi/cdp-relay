#!/usr/bin/env node
// 導入と診断を 1 つにしたコマンド。何度実行してもよい(足りないものだけを入れ、状態と次の一手を表示する)。
//   pnpm run setup [-- --port 9333] [-- --token <CDP_RELAY_TOKEN>] [-- --client-auth]
// 1. 前提(macOS / Node 22+ / 依存)を確かめる
// 2. 常駐中継(LaunchAgent)が未導入・別の場所のリポジトリを指していれば、このリポジトリで入れ直す
// 3. 中継が応答するのを待ち、接続中のブラウザと拡張のバージョンを確かめる
// 4. エージェント(MCP)への登録方法を表示する
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABEL, stableNode } from './daemon.mjs';
import { clientAuthHeaders, clientTokenPath } from '../relay/client-token.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const PORT = Number(opt('port') ?? process.env.CDP_RELAY_PORT ?? 9333);
const SERVER = join(REPO, 'relay/server.mjs');
const EXTENSION = join(REPO, 'extension');
const SHIM = join(REPO, 'plugin/cdp-relay/mcp/server.mjs');
const INFO = join(homedir(), '.cdp-relay', `relay-${PORT}.json`);
const EXT_VERSION = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8')).version;
const WAIT_MS = 10_000;
const RECONNECT_MS = 35_000; // 拡張の再接続の間隔は最大 30 秒(extension/background.js の backoff)

const ok = msg => console.log(`  ✔ ${msg}`);
const ng = msg => console.log(`  ✖ ${msg}`);
const next = [];
const fail = (msg, todo) => { ng(msg); console.log(`\n次にやること: ${todo}`); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readInfo = () => { try { return JSON.parse(readFileSync(INFO, 'utf8')); } catch { return null; } };
const newer = (a, b) => { const [x, y] = [a, b].map(v => String(v).split('.').map(Number)); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false; };
const browsers = () => fetch(`http://127.0.0.1:${PORT}/browsers`, { headers: clientAuthHeaders(PORT) }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

console.log(`cdp-relay setup(${REPO})\n\n[前提]`);
if (process.platform !== 'darwin') fail(`macOS 専用です(この OS: ${process.platform})`, '中継だけなら `pnpm relay` で手動起動できますが、常駐化とプロファイルを開く機能は macOS のみ対応です');
ok(`macOS`);
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) fail(`Node ${process.versions.node}(22 以上が必要)`, 'Node 22 以上を入れてから再実行してください');
ok(`Node ${process.versions.node}`);
if (!existsSync(join(REPO, 'node_modules/ws'))) fail('依存が未インストール', '`pnpm install --frozen-lockfile` を実行してから再実行してください');
ok('依存(node_modules)');
if (REPO.startsWith('/Volumes/')) next.push(`リポジトリが外付けボリューム(${REPO})にあります。未マウントの間は常駐中継が起動できません。内蔵ディスク(例 ~/cdp-relay)への配置を勧めます`);

console.log('\n[常駐中継]');
const running = readInfo();
const before = await browsers().catch(() => null); // 入れ直す前に繋がっていたブラウザ(入れ直した後、再接続を待つ)
const reachable = await fetch(`http://127.0.0.1:${PORT}/browsers`).then(() => true, () => false); // 401(クライアント認証あり)も「動いている」。入れ直して認証を外さない
if (reachable && running?.server === SERVER && running.launchdLabel === LABEL) ok(`LaunchAgent ${LABEL} で稼働中(127.0.0.1:${PORT})`);
else {
  if (reachable && running?.server && running.server !== SERVER) console.log(`  … ポート ${PORT} の中継は別の場所(${running.server})から動いています。このリポジトリで入れ直します`);
  const args = ['install', '--port', String(PORT), ...(opt('token') ? ['--token', opt('token')] : []), ...(argv.includes('--client-auth') ? ['--client-auth'] : [])];
  console.log(`  … node scripts/daemon.mjs ${args.join(' ').replace(/--token \S+/, '--token ***')}`);
  execFileSync(process.execPath, [join(REPO, 'scripts/daemon.mjs'), ...args], { stdio: 'inherit' });
  const deadline = Date.now() + WAIT_MS;
  const fresh = () => readInfo()?.launchdLabel === LABEL && readInfo()?.server === SERVER;
  while (Date.now() < deadline && !(fresh() && await browsers().then(() => true, () => false))) await sleep(300);
  if (!fresh()) fail(`中継が ${WAIT_MS / 1000} 秒以内に起動しませんでした`, '`pnpm daemon:log` でログを確認してください');
  ok(`常駐中継を導入して起動しました(127.0.0.1:${PORT})`);
}

console.log('\n[ブラウザ(拡張機能)]');
let list = await browsers().catch(e => fail(`中継に拒否されました(${e.message})`, `クライアント認証が有効です。トークンのファイル ${clientTokenPath(PORT)} を確認してください(作り直すなら消してから \`pnpm daemon:restart\`)`));
const missing = () => (before ?? []).filter(b => !list.some(x => x.name === b.name));
if (missing().length) {
  console.log(`  … 拡張の再接続を待っています(${missing().map(b => b.name).join(', ')}、最大 ${RECONNECT_MS / 1000} 秒)`);
  const deadline = Date.now() + RECONNECT_MS;
  while (Date.now() < deadline && missing().length) { await sleep(1000); list = await browsers(); }
}
const online = list.filter(b => b.extVersion);
for (const b of online) {
  if (newer(EXT_VERSION, b.extVersion)) {
    ng(`${b.name}: 拡張 ${b.extVersion}(リポジトリは ${EXT_VERSION})`);
    next.push(`拡張を更新: curl -X POST http://127.0.0.1:${PORT}/b/${encodeURIComponent(b.name)}/reload-extension (権限が増えた版では chrome://extensions で手動の再読み込みが必要)`);
  } else ok(`${b.name}: 接続中(拡張 ${b.extVersion})`);
}
if (!online.length) {
  ng('接続中のブラウザがありません');
  next.push(['拡張機能を、使いたいブラウザ(プロファイル)ごとに読み込む。この手順は人の操作が必要です:',
    '   1. chrome://extensions(Edge は edge://extensions)で「デベロッパーモード」を ON',
    `   2. 「パッケージ化されていない拡張機能を読み込む」で ${EXTENSION} を選ぶ`,
    '   3. ツールバーの拡張アイコン → 「ブラウザ名」に一意な名前(例 chrome-personal)を入れて保存',
    '   4. もう一度 `pnpm run setup` を実行して、ここに ✔ が出ることを確かめる'].join('\n'));
}

console.log('\n[エージェントへの登録]');
let claudeHas = false;
try { claudeHas = /cdp-relay@cdp-relay(?![\w-])/.test(execFileSync('claude', ['plugin', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch {}
if (claudeHas) ok('Claude Code: プラグイン cdp-relay@cdp-relay を導入済み');
else console.log(`  Claude Code:\n    claude plugin marketplace add ${REPO}\n    claude plugin install cdp-relay@cdp-relay`);
console.log(`  そのほかの MCP クライアント(Codex / Gemini CLI / Cursor / Antigravity など)には stdio の MCP サーバーとして登録:\n    ${JSON.stringify({ mcpServers: { 'cdp-relay': { command: stableNode(), args: [SHIM] } } })}`);

console.log(next.length ? `\n次にやること:\n${next.map(s => `- ${s}`).join('\n')}` : '\n準備完了です。エージェントに「cdp-relay でブラウザを操作して」と頼めます。');
