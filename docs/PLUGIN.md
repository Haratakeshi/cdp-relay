# cdp-relay プラグイン: 考え方と実装(Claude Code / Antigravity 共通)

エージェントに、ユーザーが起動中の Chrome / Edge(会社・用途ごとのログイン済みプロファイル)を操作させるためのプラグインの設計書。
Claude Code 用は `plugin/cdp-relay/` に実装済み。ほかのエージェントは MCP サーバーの登録で使える(7 章)。導入手順は [INSTALL.md](../INSTALL.md)。

## 1. 考え方

| 原則 | 中身 |
|---|---|
| 承認待ちで止まらない | Chrome/Edge 144+ の DevTools 直結は接続ごとに承認ダイアログが出る。拡張機能(`chrome.debugger`)と常駐中継を経由する。直結の MCP(chrome-devtools-mcp 等)は使わない |
| 中継が状態を持ち、MCP は薄い | 操作の実体(セッション・タブ・ref・HumanGate・後始末)は中継の `relay/agent.mjs` にある。MCP サーバーは中継へ渡すだけのシムなので、**どのエージェントでも同じ動作になる**。エージェントごとに作り直すのは「登録の仕方」と「スキルの文面」だけ |
| 1 MCP プロセス = 1 セッション | エージェントが MCP サーバーを起動すると、最初のツール呼び出しで中継にセッションができる。エージェントの終了(stdin が閉じる)でセッションが終わる |
| 中継は常駐、入口だけ閉じる | 中継(macOS は LaunchAgent。Windows は常駐させず、落ちていればシムが起こす)は止めない。拡張との接続は維持し、次の操作もすぐ始められる。セッションが終わると、そのセッションのタブは detach され(ブラウザ上部の「デバッグしています」のバーが消える)、自動処理の対象からも外れる |
| 自分のタブで作業する | `tab_open` で背面に自分用のタブを開く。ユーザーが見ているタブは奪わない。既存タブを使うのは、ユーザーが指したときの `tab_adopt` だけ |
| タブの後始末はエージェントが決める | 推奨は「使い終わったら閉じる」。結果を見せたいときは残して人に伝える(HumanGate)。中継は勝手に閉じない(異常終了時も開いたまま人に引き渡す) |
| HumanGate | 送信・削除・購入などの不可逆操作は人の確認を取ってから。中継も名前で不可逆そうな要素を判定し、`confirmed: true` なしではクリックしない(安全網) |
| 誤操作しない | ref は取得した文書でだけ有効。遷移・再描画で消えた要素、オーバーレイに覆われた要素は押さず、エラーと次の一手(hint)を返す |
| 速く、少ない往復で | puppeteer を通さず CDP を直接使う。タブは対象のものだけ attach し、セッション中は付けたまま。`act` が複数手順・遷移待ち・差分スナップショット・自動処理の記録を 1 回で返す |

## 2. 構成

```
エージェント(Claude Code / Antigravity …)
  │ MCP(stdio、JSON-RPC)
  ▼
plugin/cdp-relay/mcp/server.mjs  … シム。Node 22 の標準モジュールだけ(依存なし)。どこにコピーしても動く
  │ 改行区切り JSON、Unix ドメインソケット ~/.cdp-relay/relay-9333.sock(0600 = ファイル権限がローカルの認証)
  ▼
relay/server.mjs + relay/agent.mjs … 中継(macOS は LaunchAgent io.github.haratakeshi.cdp-relay)。セッション・操作の実体
  │ WebSocket 127.0.0.1:9333/extension
  ▼
extension/(CDP Relay Bridge)… プロファイルごと。chrome.debugger / chrome.tabs
```

| ファイル | 役割 |
|---|---|
| `plugin/cdp-relay/mcp/server.mjs` | MCP サーバー。ツール定義(名前・説明・入力スキーマ)と、エージェントへの指針(`instructions`)はここが正 |
| `plugin/cdp-relay/skills/cdp-relay/SKILL.md` | Claude Code 用のスキル(使い方・HumanGate・後始末) |
| `plugin/cdp-relay/.mcp.json` / `.claude-plugin/plugin.json` | Claude Code のプラグイン定義 |
| `.claude-plugin/marketplace.json` | このリポジトリを marketplace(名前 `cdp-relay`)として登録するための定義 |
| `relay/agent.mjs` | セッション、タブのハンドル、snapshot / act / read / screenshot / eval、HumanGate、後始末 |
| `relay/profiles.mjs` | `profiles.json`(ブラウザ名 → プロファイル)と、閉じたプロファイルを開く処理(CLI の `open` と共通) |
| `test/e2e-agent.mjs` | E2E-15。MCP から操作したときの契約(下の 5 章)を確かめる |

## 3. ツール(MCP)

| ツール | 内容 |
|---|---|
| `browser_list` | プロファイル一覧(`online` / `offline`) |
| `browser_open {name}` | 閉じているプロファイルの窓を背面で開き、拡張が繋がるのを待つ |
| `tab_list {browser, query?}` | タブ一覧(attach しない)。自分のタブには `tab` が付く |
| `tab_open {browser, url?, active?, snapshot?}` | 自分用のタブを背面に開く。`about:blank` で作ってエージェントのタブにしてから遷移する(読み込み直後のダイアログも自動処理の対象)。ハンドル `t1` 等と snapshot を返す |
| `tab_adopt {browser, tab_id? \| query?}` | ユーザーが指した既存タブを借りる。終わると手を付けずに返す |
| `snapshot {tab, mode?, query?, max_chars?}` | アクセシビリティツリー。操作できる要素に `[e12]` の ref。`interactive`(既定)/ `full`(本文も)/ `diff`(前回からの変化だけ)。同一プロセスの iframe と shadow DOM を含む |
| `act {tab, steps[], snapshot?}` | 手順を順に実行する。`goto` `click` `fill` `select` `press` `type` `hover` `scroll` `wait_for`。最初の失敗で止まり、どこまで実行したかを返す。応答に遷移後の URL・スナップショットの差分・自動処理の記録(`events`) |
| `read {tab, ref?, offset?, max_chars?}` | 本文(ページ単位) |
| `screenshot {tab, ref?, full_page?, format?, path?}` | 画像を返す。`path` を渡すとファイルに保存 |
| `eval {tab, expression}` | 逃げ道。結果は JSON を切り詰めて返す |
| `events {tab? \| browser?}` | 中継が自動処理したダイアログ・認証・ダウンロード等 |
| `tab_close {tab}` | 自分のタブを閉じる |
| `tab_handoff {tab}` | HumanGate: タブを残して人に渡す。`tell_user`(人に伝える文)を返す |
| `session_end {close_tabs}` | セッションを終える。`true` = 全部閉じる(推奨)/ `false` = 全部残して人に渡す / ハンドルの配列 = それだけ閉じる。**必須引数**(閉じるかどうかを必ずエージェントに決めさせる) |

エラーは MCP の `isError: true` の結果で返し、本文は `Error: …` / `Hint: …`(次の一手)/ 途中経過の JSON。

## 4. ライフサイクル

1. エージェントが MCP サーバーを起動する(プラグインの有効化)。この時点では中継に触れない
2. 最初のツール呼び出しでソケットに繋ぎ、`session.hello` でセッションを作る。ソケットが無ければ中継を起こす
   (中継が自分で書く `~/.cdp-relay/relay-9333.json` を見て、launchd の常駐なら `launchctl kickstart`、それ以外は前回と同じ CDP_RELAY_* の設定で起動する。状態ファイルが無く、シムが clone の中にあれば隣の `relay/server.mjs` を起動する)
3. `tab_open` / `tab_adopt` したタブは、セッション中は attach したまま、エージェントのタブとして自動処理の対象になる
4. 終わり方は 3 通り
   - `session_end {close_tabs}`: 指定どおり閉じる / 残す。次のツール呼び出しは新しいセッションになる(ハンドルは `t1` から振り直し)
   - エージェントの終了・MCP プロセスの異常終了: ソケットが閉じ、中継が**全タブを開いたまま人に引き渡す**(閉じない)
   - 中継の再起動: シムが次の呼び出しで繋ぎ直し、まだ存在するタブのハンドルを引き継ぐ(拡張の再接続を最大 10 秒待つ)
5. 人に渡したタブは、エージェントのタブから外れ(ダイアログ等の自動処理をしない)、detach される

## 5. 守る契約(E2E-15 `test/e2e-agent.mjs` が確かめる)

- MCP の初期化で HumanGate とタブの後始末の指針が伝わる
- `fill` / `click` / `press` は信頼されたイベント(`isTrusted: true`)で届き、form の submit も起きる
- 不可逆に見える要素は `confirmed: true` なしでは押さない
- 中継が自動で閉じた confirm は `act` の応答の `events` に出る
- shadow DOM・iframe の要素を snapshot で見られ、クリックできる
- 消えた要素・遷移前の ref は `stale` で押さない。覆われた要素は `covered by …` で押さない
- クリックによる遷移を待ってから、遷移後のスナップショットを返す
- `read` / `snapshot` は上限で切る
- 他のセッションのハンドルは使えない
- `session_end {close_tabs:false}` はタブを閉じず、detach してエージェントのタブから外す。`true` は自分のタブだけ閉じる
- MCP プロセスが落ちても、タブは開いたまま detach されエージェントのタブから外れる

## 6. Claude Code への導入

```bash
claude plugin marketplace add ~/cdp-relay      # clone の場所
claude plugin install cdp-relay@cdp-relay
```

- 新しいセッションから MCP サーバー `cdp-relay` とスキル `cdp-relay:cdp-relay` が使える。`.mcp.json` は `node` を PATH から使う(Node 22 以上)
- [事実 2026-10-11] ローカルの marketplace から入れたプラグインの MCP サーバーは、キャッシュ(`~/.claude/plugins/cache/…`)ではなく
  clone の `plugin/cdp-relay/mcp/server.mjs` から起動された(`claude mcp list` の表示)。シムの変更は次のセッションから効く。
  `plugin.json` / `.mcp.json` / スキルを変えたら `claude plugin update cdp-relay@cdp-relay` で反映する
- GitHub から入れた場合(`claude plugin marketplace add Haratakeshi/cdp-relay`)、シムはキャッシュから起動する。シムは依存なしで、中継の場所を
  中継自身が書く `~/.cdp-relay/relay-<port>.json` から知るので動作するが、中継が一度も起動していないと「setup を実行せよ」というエラーになる
- 起動中の Claude Code の各セッションが、それぞれシムを 1 プロセス起動する(待機中は 1 つ約 42MB、中継には繋がない)
- 中継側(`relay/*.mjs`)を更新したら常駐中継を再起動する: `pnpm daemon:restart`

## 7. ほかのエージェント(Codex / Gemini CLI / Cursor / Antigravity など)への組み込み

### 方針

- **中継・シムは共有し、作り直さない**。どのエージェントからも `plugin/cdp-relay/mcp/server.mjs` を MCP サーバーとして登録する。ツールの名前・意味・HumanGate の動作は Claude Code と同じになる
- エージェント側で作るのは「MCP サーバーの登録」と、スキルの仕組みがあれば「スキル」だけ
- ツールを変えたいときは、エージェント側で別のツールを作らず、シムと `relay/agent.mjs` を直して全エージェントに効かせる(下の「変更の手順」)

### 作業

1. **MCP サーバーを登録する**(stdio、`mcpServers` 形式)。`pnpm run setup` がこのコンピューターの絶対パスを入れた設定を表示する

   ```json
   {
     "mcpServers": {
       "cdp-relay": {
         "command": "/absolute/path/to/node",
         "args": ["/Users/<you>/cdp-relay/plugin/cdp-relay/mcp/server.mjs"]
       }
     }
   }
   ```

   - GUI アプリから起動されると PATH に node が無いことがあるので、node は絶対パスにする
   - ほかの環境変数は不要(既定で `127.0.0.1:9333` の中継に繋ぐ)。別ポートの中継なら `"env": {"CDP_RELAY_PORT": "<port>"}`

2. **スキル(あれば)**: `plugin/cdp-relay/skills/cdp-relay/SKILL.md` をそのまま使う。エージェントへの指針の要点(自分のタブで作業する、HumanGate、後始末)は
   MCP の初期化時に `instructions` でも伝わる。DevTools ポートへ直結する MCP(chrome-devtools-mcp 等)を実ブラウザに使わせない旨も入れておく(承認ダイアログで止まる)
3. **確かめる**(実ブラウザで。ユーザーの許可を得た範囲で)
   - `browser_list` → `tab_open {browser, url:"https://example.com"}` → `snapshot` → `session_end {close_tabs:true}` でタブが閉じ、ブラウザ上部のバーが消える
   - 途中でエージェントを終了したとき、タブが開いたまま残り、バーが消える
   - 中継のログ(macOS は `~/Library/Logs/cdp-relay.log`、それ以外は `~/.cdp-relay/relay-9333.log`)に `agent session N (<クライアント名>): started` と `ended (...)` が出る

### エージェントに任せないこと

- 中継・シムの挙動の変更(全エージェントに効くので、このリポジトリで変更し E2E-15 を通す)
- 資格情報(`policy.json` の `auth`)・トークンの設定
- 実ブラウザでテストタブを開く・閉じる操作の自動化(ユーザーの許可を取ってから)

## 8. 変更の手順(ツールを足す・変える)

1. `relay/agent.mjs` の `methods` に実装する(エラーは `AgentError(message, hint)`)
2. `plugin/cdp-relay/mcp/server.mjs` の `TOOLS` に定義を足す(名前は `methods` と同じ)。指針が変わるなら `INSTRUCTIONS` も
3. 守るべき性質なら `test/e2e-agent.mjs` に足し、`pnpm test:e2e` を通す
4. 常駐中継を再起動し(`pnpm daemon:restart`)、Claude Code のプラグインを更新する(6 章)。ほかのエージェントは同じファイルを直接参照しているので、MCP サーバーの再起動だけでよい
5. シムの `VERSION` と `plugin.json` の `version` を上げる

## 9. 既知の制約

- 背面のタブには CDP のマウス・キー入力が届かない(実ブラウザで実測)。セッションがタブを保持する間は `Emulation.setFocusEmulationEnabled` で visible にして届かせている(タブは前面に出さない)。そのため保持中のタブではページから見て `document.visibilityState === 'visible'`、`document.hasFocus() === true`

- `screenshot` は撮影の直前にスクリーンキャストを一瞬始めて描画を起こす。Windows では背面タブの `Page.captureScreenshot` が直前の撮影や遷移の直後に 20 秒止まるため(windows-latest で実測、`test/exp-screenshot-background.mjs`)
- 別プロセスの iframe(多くのクロスサイト iframe)は snapshot に中身が出ず、操作できない
- `select` 以外の値の設定は `Input.insertText`(IME を通らない確定入力)。キーボードショートカットはブラウザのコマンドとしては効かないことがある
- HumanGate の判定は要素の名前(`policy.json` の `humanGatePattern`)によるので取りこぼしがある。エージェント自身の判断が主
- 中継の TCP 側(`/json/*`、`devtools/*`、HTTP の近道 API)は従来どおり。エージェント用の操作はソケット側だけにある
