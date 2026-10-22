// ポップアップとオプション画面で共通: Service Worker から状態を取り、表示用に整える
export const $ = id => document.getElementById(id);
export const getStatus = () => chrome.runtime.sendMessage({ type: 'status' }).catch(e => ({ error: e.message }));

/** 状態 → { tone, label, hint }。tone は .pill の色 */
export function describe(s) {
  if (s.error) return { tone: 'bad', label: '拡張の応答なし', hint: s.error };
  if (!s.configured) return { tone: 'warn', label: '未設定', hint: 'ブラウザ名を設定すると中継サーバーに接続します' };
  if (s.connected) return { tone: 'good', label: '接続中', hint: s.attached.length ? `${s.attached.length} 個のタブを操作中(デバッガ接続中)` : '待機中(操作中のタブはありません)' };
  const why = s.lastClose ? `直近の切断: ${s.lastClose.code}${s.lastClose.reason ? ` ${s.lastClose.reason}` : ''}` : '';
  return { tone: 'bad', label: '再接続中', hint: s.lastClose?.code === 1006 ? '中継サーバーが動いていません。リポジトリで `pnpm run setup` を実行してください' : why };
}

export function renderStatus(s, root) {
  const d = describe(s);
  root.querySelector('.pill').className = `pill ${d.tone}`;
  root.querySelector('.pill').textContent = d.label;
  root.querySelector('.hint').textContent = d.hint;
  const kv = root.querySelector('dl.kv');
  kv.replaceChildren();
  const rows = s.error ? [] : [
    ['ブラウザ名', s.config?.name || '(未設定)'],
    ['中継サーバー', s.config?.relayUrl],
    ...(s.config?.port ? [['専用ポート', s.config.port]] : []),
    ['操作中のタブ', String(s.attached?.length ?? 0)],
    ['トークン', s.config?.token ? '設定済み' : 'なし'],
  ];
  for (const [k, v] of rows) kv.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v }));
}
