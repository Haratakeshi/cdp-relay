---
name: cdp-relay
description: ユーザーが起動中の Chrome / Edge(ログイン済みセッション)を、拡張機能と常駐中継サーバー経由で操作する。会社・用途ごとに分けた複数プロファイルを名前で選べる。Gmail・Google サイト・Slack・社内システムなどログイン済みのサービスをブラウザ操作したいとき、Claude in Chrome が使えない/別アカウントのときに使う。DevTools ポートへの直結は Chrome 144+ の承認ダイアログで詰まるため、必ずこの経路を使う。
---

# cdp-relay: 起動中のブラウザを操作する

このプラグインの MCP サーバー `cdp-relay` のツールで操作する。中継(常駐、`127.0.0.1:9333` + `~/.cdp-relay/relay-9333.sock`)と、
各プロファイルに入れた拡張機能「CDP Relay Bridge」が前提。仕組みと制約はリポジトリ(https://github.com/Haratakeshi/cdp-relay)の README.md / docs/PLUGIN.md。

## 手順

1. `browser_list` で対象を確認する。名前は会社・用途ごとのプロファイル。`offline` なら **ユーザーに頼まず** `browser_open`(背面で窓を開いて接続を待つ)
2. `tab_open {browser, url}` で**自分用のタブ**を開く(背面に開くので、ユーザーが見ているタブを奪わない)。戻り値の `tab`(`t1` 等)で以後のタブを指す
3. `snapshot` で要素と ref(`[e12]`)を見る。`act` で操作する。1 回の `act` に複数の手順を並べると往復が減る
   - `{"fill":"e5","value":"..."}` `{"click":"e7"}` `{"press":"Enter"}` `{"select":"e9","value":"Green"}` `{"goto":"https://…"}` `{"wait_for":{"text":"完了"}}`
   - 応答には変化(スナップショットの差分)と、中継が自動処理したダイアログ等(`events`)が入る
4. 結果は `read`(本文、ページ単位)/ `screenshot` で確かめる。`eval` は最後の手段
5. 終わったら後始末する(下記)

ユーザーが「このタブ」と指したときだけ `tab_adopt {browser, query}` で既存タブを借りる。それ以外のユーザーのタブには触らない。

## ref の規則

- ref はそのタブの**直近の snapshot の、その文書**でだけ有効。遷移や再描画で消えた要素の ref は `stale` エラーになり、別の要素は押さない
- `stale` が出たら snapshot を取り直す。ref を推測しない
- 要素がオーバーレイ等に覆われているとクリックしない(`covered by …`)。覆っているもの(ダイアログ・バナー)を先に閉じる

## HumanGate(人の確認)

- 送信・投稿・公開・削除・購入・支払い・個人情報を含むフォームの送信・アカウント設定の変更は、**直前で止めてユーザーに確認する**(下書き保存までは可)
- `act` は名前が不可逆に見える要素(送信・削除・購入…。`policy.json` の `humanGatePattern`)を `"confirmed": true` なしでは押さない。
  `confirmed` は**ユーザーがその操作を承認した後にだけ**付ける
- パスワード・決済情報・身分証番号は入力しない
- 自動処理で confirm() が閉じられた(`events` に `dialog` / `dismiss`)ときは、操作が実行されていない可能性が高い。結果を確かめて報告する

## 後始末(セッションの終わり)

- **推奨: 使い終わったタブは閉じる**(`tab_close`、または `session_end {close_tabs: true}`)
- 結果をユーザーに見せたいとき(承認待ちの下書き、入力済みのフォーム、レポート画面)は、そのタブを `tab_handoff` で残し、
  **タイトルと URL をユーザーに伝える**(HumanGate: ここから先は人が引き継ぐ)。`session_end {close_tabs: false}` は全タブを残す
- 最後に必ず `session_end` を呼ぶ。中継が detach し、ブラウザ上部の「デバッグしています」のバーが消える。
  呼ばずにエージェントが終了しても、中継がタブを開いたまま人に引き渡して detach する
- ユーザーにタブを閉じるよう頼まれたら `tab_close`

## うまく動かないとき

| 症状 | 対処 |
|---|---|
| `cdp-relay is not running` | 中継が未導入か落ちている。ユーザーの cdp-relay の clone で `pnpm run setup` を実行する(状態と次の一手が出る)。導入手順は https://github.com/Haratakeshi/cdp-relay の INSTALL.md |
| `browser "…" is not connected` | `browser_list` → `offline` なら `browser_open`。一覧にも無ければ、そのプロファイルに拡張が無いか名前が未設定。ユーザーに依頼する |
| `timed out` | ダイアログやページの処理で固まっている可能性。`events` を見て、`snapshot` を取り直す |
| 何をしても動かない | clone が外付けディスクにあり、取り外されていると中継が起動できない。`pnpm run setup` の出力を確認する |

## 既知の制約

- `chrome://` / `edge://` などの内部ページ、他拡張のページ、ウェブストアには attach できない
- `data:` URL への最上位遷移は失敗する。`http(s)://` を使う
- 別プロセスの iframe(多くのクロスサイト iframe)は snapshot に中身が出ない(`not accessible`)
- キーボードのショートカット(`Meta+a` 等)はブラウザのコマンドとしては効かないことがある。値の入れ替えは `fill` を使う
- MCP が使えない環境では CLI(`node <リポジトリ>/cli.mjs …`)も使える(docs/REFERENCE.md の「CLI」)
