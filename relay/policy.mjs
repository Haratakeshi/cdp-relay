// 中継の自動処理ポリシー。場所は CDP_RELAY_POLICY(既定: リポジトリ直下 policy.json)。ファイルが無ければ DEFAULT_POLICY で動く。
// 参照のたびに mtime を見て読み直すので、常駐中継を再起動せずに編集を反映できる。資格情報を含むので 600 でなければ警告する。
// 項目ごとに型と値を検証し、不正な項目は直前の正しい値(初回は既定値)のまま警告する(中継を落とさない)
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const POLICY_PATH = process.env.CDP_RELAY_POLICY || fileURLToPath(new URL('../policy.json', import.meta.url));
export const DEFAULT_POLICY = {
  // agentTabs: エージェントのタブ(中継経由で作った・明示的に接続/adopt した・そこから開いたポップアップ)だけを自動処理する。
  // allTabs: 全タブ(外出中モード。ユーザーが手で使っているタブのダイアログや認証にも介入する)
  scope: 'agentTabs',
  dialogTimeoutMs: 8000, // クライアントがこの時間内に処理しなかったダイアログを dialogs の動作で閉じる。危険なダウンロードの cancel までの時間にも使う
  dialogs: { alert: 'accept', beforeunload: 'accept', confirm: 'dismiss', prompt: 'dismiss' },
  fileChooser: 'intercept', // 'intercept': ネイティブのファイル選択を出さずイベント化する。'native': ブラウザ既定
  unresponsiveTimeoutMs: 5000, // attach 直後の Page.enable がこの時間内に返らないタブを「固まっている」とみなす(未 attach 中に出たダイアログ等)
  unresponsiveTab: 'renavigate', // 固まったエージェントのタブ: 'renavigate'(同じ URL へ遷移し直す)| 'report'(記録だけ)。エージェントのタブ以外は facade から隠すだけ
  auth: {}, // { "<origin>": { "username": "…", "password": "…" } }。CDP_RELAY_TOKEN を設定した中継でだけ使う
  permissions: {}, // { "<origin>": { "<chrome.contentSettings の型>": "allow" | "block" | "ask" } }
  // MCP の act が、確認なし(confirmed: true なし)ではクリックしない要素の名前(大文字小文字を区別しない正規表現)。送信・削除・購入などの不可逆操作の手前で
  // エージェントに人の確認を取らせる(HumanGate)。名前による推定なので取りこぼしはある(エージェント自身の判断が主で、これは安全網)。"" で無効
  humanGatePattern: '送信|削除|購入|支払|注文|確定|公開|投稿|申し?込|退会|解約|振込|\\b(submit|send|delete|remove|purchase|buy|pay|checkout|order|publish|post|confirm|unsubscribe)\\b',
};

const MAX_TIMEOUT_MS = 2 ** 31 - 1; // Node の setTimeout の上限。超えると 1ms 扱いになり、即座に自動処理してしまう
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = (...xs) => v => xs.includes(v);
const posInt = v => Number.isInteger(v) && v > 0 && v <= MAX_TIMEOUT_MS;
/** ポリシーのオリジンのキーとして使えるか('*' = 全サイト。about:blank のように origin が "null" になるものは不可) */
export const validOriginKey = k => k === '*' || (URL.canParse(k) && new URL(k).origin !== 'null');
const VALID = {
  scope: oneOf('agentTabs', 'allTabs'),
  dialogTimeoutMs: posInt,
  dialogs: v => isObj(v) && Object.values(v).every(oneOf('accept', 'dismiss')),
  fileChooser: oneOf('intercept', 'native'),
  unresponsiveTimeoutMs: posInt,
  unresponsiveTab: oneOf('renavigate', 'report'),
  auth: v => isObj(v) && Object.values(v).every(c => isObj(c) && typeof c.username === 'string' && typeof c.password === 'string'),
  permissions: v => isObj(v) && Object.values(v).every(p => isObj(p) && Object.values(p).every(s => typeof s === 'string')),
  humanGatePattern: v => { if (typeof v !== 'string') return false; try { new RegExp(v, 'i'); return true; } catch { return false; } },
};

let cache = { mtimeMs: undefined, policy: DEFAULT_POLICY };
export function getPolicy(log) {
  let st;
  try { st = statSync(POLICY_PATH); } catch { if (cache.mtimeMs !== null) log(`policy: ${POLICY_PATH} not found, using defaults`); cache = { mtimeMs: null, policy: DEFAULT_POLICY }; return DEFAULT_POLICY; }
  if (st.mtimeMs === cache.mtimeMs) return cache.policy;
  cache.mtimeMs = st.mtimeMs;
  if (st.mode & 0o077) log(`policy: WARNING ${POLICY_PATH} is mode ${(st.mode & 0o777).toString(8)}; it may hold credentials, chmod 600 it`);
  let p;
  try { p = JSON.parse(readFileSync(POLICY_PATH, 'utf8')); } catch (e) { log(`policy: WARNING cannot read ${POLICY_PATH} (${e.message}); keeping the previous policy`); return cache.policy; }
  if (!isObj(p)) { log(`policy: WARNING ${POLICY_PATH} is not a JSON object; keeping the previous policy`); return cache.policy; }
  if (isObj(p.dialogs)) p.dialogs = { ...DEFAULT_POLICY.dialogs, ...p.dialogs };
  const next = { ...cache.policy };
  for (const [k, ok] of Object.entries(VALID)) {
    if (!(k in p)) next[k] = DEFAULT_POLICY[k];
    else if (ok(p[k])) next[k] = p[k];
    else log(`policy: WARNING invalid "${k}" in ${POLICY_PATH}; keeping ${JSON.stringify(k === 'auth' ? '(previous credentials)' : next[k])}`);
  }
  for (const k of Object.keys(p)) if (!(k in VALID)) log(`policy: WARNING unknown key "${k}" in ${POLICY_PATH}, ignored`);
  for (const k of ['auth', 'permissions']) { // オリジンとして使えないキーは項目ごとに捨てる(残りは使う)
    const bad = Object.keys(next[k]).filter(o => !validOriginKey(o));
    if (bad.length) { log(`policy: WARNING invalid origin key(s) in "${k}": ${bad.join(', ')}; ignored`); next[k] = Object.fromEntries(Object.entries(next[k]).filter(([o]) => validOriginKey(o))); }
  }
  cache.policy = next;
  log(`policy: loaded ${POLICY_PATH}`);
  return next;
}
