#!/usr/bin/env node
// 中継サーバーを macOS の LaunchAgent として常駐させる。
//   node scripts/daemon.mjs install [--port 9333] [--node /path/to/node] [--token <CDP_RELAY_TOKEN>]
//   node scripts/daemon.mjs uninstall | restart | status | log
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const plist = (node, port, token) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${join(REPO, 'relay/server.mjs')}</string></array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict><key>CDP_RELAY_PORT</key><string>${port}</string>${token ? `<key>CDP_RELAY_TOKEN</key><string>${token}</string>` : ''}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;

const commands = {
  install() {
    const node = pickNode();
    const port = opt('port', '9333');
    if (!node) throw new Error('node の絶対パスが見つかりません。--node で指定してください');
    tryLaunchctl('bootout', `${DOMAIN}/${LABEL}`); // 既存があれば止める(無ければエラーを無視)
    const token = opt('token', '');
    if (/[<>&]/.test(token)) throw new Error('--token には英数字等を使う(<>& は plist に書けない)');
    writeFileSync(PLIST, plist(node, port, token), { mode: 0o600 });
    chmodSync(PLIST, 0o600); // トークンを含むので本人だけが読める(既存ファイルの上書きでは mode が効かないので明示)
    launchctl('bootstrap', DOMAIN, PLIST);
    console.log(`installed: ${PLIST}\n  node: ${node}\n  port: ${port}\n  token: ${token ? 'set' : 'not set'}\n  log : ${LOG}`);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) { // setup.mjs から LABEL だけを読むときは実行しない
  if (!commands[cmd]) { console.error('usage: node scripts/daemon.mjs install|uninstall|restart|status|log [--port 9333] [--node /abs/node] [--token <token>]'); process.exit(2); }
  commands[cmd]();
}
