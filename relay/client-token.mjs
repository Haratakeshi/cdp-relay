// クライアント認証(任意)のトークン。CDP_RELAY_CLIENT_AUTH=1 の中継は、TCP 側のクライアント(HTTP / WS / 専用ポート)に
// Authorization: Bearer <トークン> を求める。トークンはエージェント用ソケットの隣のファイル(0600)に置き、
// 中継が初回に生成して以後も同じ値を使う(クライアントの設定を変えずに中継を再起動できる)。CLI などはこのファイルを読む
import crypto from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const defaultPort = () => Number(process.env.CDP_RELAY_PORT || 9333);
export const agentSocketPath = (port = defaultPort()) => process.env.CDP_RELAY_SOCKET || join(homedir(), '.cdp-relay', `relay-${port}.sock`);
export const clientTokenPath = (port = defaultPort()) => `${agentSocketPath(port).replace(/\.sock$/, '')}.client-token`;
const readToken = path => { try { const t = readFileSync(path, 'utf8').trim(); return /^[0-9a-f]{64}$/.test(t) ? t : null; } catch { return null; } };

/** 中継用: トークンを読む。無い・壊れていれば生成する */
export function ensureClientToken(port) {
  const path = clientTokenPath(port);
  const existing = readToken(path);
  if (existing) { chmodSync(path, 0o600); return existing; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // 既存ファイルの上書きでは mode が効かない
  return token;
}

/** クライアント用: 付けるヘッダ。ファイルが無ければ空(認証なしの中継にはそのまま繋がる。付けても無視される) */
export const clientAuthHeaders = port => { const t = readToken(clientTokenPath(port)); return t ? { authorization: `Bearer ${t}` } : {}; };
