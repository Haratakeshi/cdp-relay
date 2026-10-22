#!/usr/bin/env node
// 中継サーバーを macOS の LaunchAgent として常駐させる。Windows は常駐化せず、中継をバックグラウンドで起動・停止するだけ
// (ログオン後は、エージェントが最初に使うときに MCP シムが前回と同じ設定で起動する)。
//   node scripts/daemon.mjs install [--port 9333] [--node /path/to/node] [--token <CDP_RELAY_TOKEN>] [--client-auth]
//   node scripts/daemon.mjs uninstall | restart | status | log [--port 9333]
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, writeFileSync, existsSync, unlinkSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statePath } from '../relay/paths.mjs';

export const LABEL = 'io.github.haratakeshi.cdp-relay';
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), 'Library/Logs/cdp-relay.log');
const DOMAIN = `gui/${userInfo().uid}`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const launchctl = (...args) => execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryLaunchctl = (...args) => { try { return launchctl(...args); } catch (e) { return (e.stderr || e.message).trim(); } };

// LaunchAgent は PATH を引き継がないので node は絶対パスで書く。nvm 配下はバージョン更新で消えるため Homebrew を優先する
export const stableNode = () => ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath].find(existsSync);
const pickNode = () => opt('node', stableNode());

const plist = (node, port, token, clientAuth) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${join(REPO, 'relay/server.mjs')}</string></array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict><key>CDP_RELAY_PORT</key><string>${port}</string>${token ? `<key>CDP_RELAY_TOKEN</key><string>${token}</string>` : ''}${clientAuth ? '<key>CDP_RELAY_CLIENT_AUTH</key><string>1</string>' : ''}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;

const SERVER = join(REPO, 'relay/server.mjs');
const readInfo = port => { try { return JSON.parse(readFileSync(statePath('.json', port), 'utf8')); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const relayUp = port => fetch(`http://127.0.0.1:${port}/browsers`).then(() => true, () => false); // 401(クライアント認証あり)も応答あり

/** Windows: 中継を親から切り離して起動する。env は CDP_RELAY_* の設定(他の CDP_RELAY_* は持ち込まない) */
function startDetached(port, env) {
  const logFile = statePath('.log', port);
  mkdirSync(dirname(logFile), { recursive: true });
  const out = openSync(logFile, 'a');
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CDP_RELAY_')));
  spawn(pickNode(), [SERVER], { cwd: REPO, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: { ...base, ...env, CDP_RELAY_PORT: String(port) } }).unref();
  console.log(`started: ${SERVER} (port ${port}, log ${logFile})`);
}
/** Windows: 動いている中継を止める。応答しない(= pid が古い可能性がある)ときは何も殺さない */
async function stopRelay(port) {
  const info = readInfo(port);
  if (!info?.pid || !await relayUp(port)) return console.log('not running');
  process.kill(info.pid);
  for (let i = 0; i < 50 && await relayUp(port); i++) await sleep(100);
  console.log(`stopped: pid ${info.pid}`);
}

const windowsCommands = {
  install() {
    const port = opt('port', '9333');
    const token = opt('token', '');
    startDetached(port, { ...(token ? { CDP_RELAY_TOKEN: token } : {}), ...(argv.includes('--client-auth') ? { CDP_RELAY_CLIENT_AUTH: '1' } : {}) });
    console.log('Windows では常駐化しません。ログオン後は、エージェントが最初に使うときに MCP が同じ設定で起動します');
  },
  uninstall: () => stopRelay(opt('port', '9333')),
  async restart() { const port = opt('port', '9333'); const env = readInfo(port)?.env ?? {}; await stopRelay(port); startDetached(port, env); }, // 前回の設定を引き継ぐ
  async status() { const port = opt('port', '9333'); const info = readInfo(port); console.log(await relayUp(port) ? `running: pid ${info?.pid} (${info?.server})` : 'not running'); },
  log() { try { console.log(readFileSync(statePath('.log', opt('port', '9333')), 'utf8').split('\n').slice(-31).join('\n')); } catch { console.log('no log'); } },
};

const macCommands = {
  install() {
    const node = pickNode();
    const port = opt('port', '9333');
    if (!node) throw new Error('node の絶対パスが見つかりません。--node で指定してください');
    tryLaunchctl('bootout', `${DOMAIN}/${LABEL}`); // 既存があれば止める(無ければエラーを無視)
    const token = opt('token', '');
    if (/[<>&]/.test(token)) throw new Error('--token には英数字等を使う(<>& は plist に書けない)');
    const clientAuth = argv.includes('--client-auth');
    writeFileSync(PLIST, plist(node, port, token, clientAuth), { mode: 0o600 });
    chmodSync(PLIST, 0o600); // トークンを含むので本人だけが読める(既存ファイルの上書きでは mode が効かないので明示)
    launchctl('bootstrap', DOMAIN, PLIST);
    console.log(`installed: ${PLIST}\n  node: ${node}\n  port: ${port}\n  token: ${token ? 'set' : 'not set'}\n  client auth: ${clientAuth ? 'required' : 'off'}\n  log : ${LOG}`);
  },
  uninstall() {
    console.log(tryLaunchctl('bootout', `${DOMAIN}/${LABEL}`) || 'stopped');
    if (existsSync(PLIST)) { unlinkSync(PLIST); console.log(`removed: ${PLIST}`); }
  },
  restart() { console.log(tryLaunchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`) || 'restarted'); }, // 中継(relay/*.mjs)を更新したとき
  status() {
    console.log(tryLaunchctl('print', `${DOMAIN}/${LABEL}`).split('\n').filter(l => /state|pid|last exit|path =/.test(l)).join('\n') || 'not loaded');
  },
  log() { execFileSync('tail', ['-n', '30', LOG], { stdio: 'inherit' }); },
};

const self = fileURLToPath(import.meta.url);
if (process.platform === 'win32' ? process.argv[1]?.toLowerCase() === self.toLowerCase() : process.argv[1] === self) { // setup.mjs から読むときは実行しない(Windows はドライブ文字の大小が揃わないことがある)
  const commands = process.platform === 'win32' ? windowsCommands : macCommands;
  if (!commands[cmd]) { console.error('usage: node scripts/daemon.mjs install|uninstall|restart|status|log [--port 9333] [--node /abs/node] [--token <token>] [--client-auth]'); process.exit(2); }
  await commands[cmd]();
}
