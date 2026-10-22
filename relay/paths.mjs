// 中継のローカルの置き場所: エージェント用ソケット、状態ファイル(relay-<port>.json)、クライアント認証のトークン。
// 状態ファイルは ~/.cdp-relay/relay-<port>.*(CDP_RELAY_SOCKET を指定したときはそのパスの隣)。
// エージェント用ソケットは、Unix ではそのファイルパスの Unix ドメインソケット、Windows では同じパスを名前に含む名前付きパイプ
// (Node の net は Windows で \\?\pipe\ か \\.\pipe\ の名前しか受けない)。plugin/cdp-relay/mcp/server.mjs も同じ規則で計算する(シムは依存なしのため複製)
//
// クライアント認証(任意): CDP_RELAY_CLIENT_AUTH=1 の中継は、TCP 側のクライアント(HTTP / WS / 専用ポート)に
// Authorization: Bearer <トークン> を求める。トークンは状態ファイルの隣(0600)に置き、中継が初回に生成して以後も同じ値を使う
// (クライアントの設定を変えずに中継を再起動できる)。CLI などはこのファイルを読む
import crypto from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const defaultPort = () => Number(process.env.CDP_RELAY_PORT || 9333);
const socketFile = port => resolve(process.env.CDP_RELAY_SOCKET || join(homedir(), '.cdp-relay', `relay-${port}.sock`));
export const agentSocketPath = (port = defaultPort()) => process.platform === 'win32' ? `\\\\?\\pipe\\${socketFile(port)}` : socketFile(port);
/** 状態ファイルのパス(ext: '.json' / '.client-token' / '.log') */
export const statePath = (ext, port = defaultPort()) => `${socketFile(port).replace(/\.sock$/, '')}${ext}`;
export const clientTokenPath = (port = defaultPort()) => statePath('.client-token', port);
const readToken = path => { try { const t = readFileSync(path, 'utf8').trim(); return /^[0-9a-f]{64}$/.test(t) ? t : null; } catch { return null; } };

/** 中継用: トークンを読む。無い・壊れていれば生成する */
export function ensureClientToken(port) {
  const path = clientTokenPath(port);
  const existing = readToken(path);
  if (existing) { chmodSync(path, 0o600); return existing; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // 既存ファイルの上書きでは mode が効かない(Windows では無視され、ユーザーフォルダの ACL で守られる)
  return token;
}

/** クライアント用: 付けるヘッダ。ファイルが無ければ空(認証なしの中継にはそのまま繋がる。付けても無視される) */
export const clientAuthHeaders = port => { const t = readToken(clientTokenPath(port)); return t ? { authorization: `Bearer ${t}` } : {}; };
