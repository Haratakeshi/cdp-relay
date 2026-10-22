# インストール手順

この文書は、**人がそのまま読んでも、AI エージェントが上から順に実行しても**導入できるように書いています。

> **AI エージェントへ**
> - ユーザーに「cdp-relay を使いたい」と頼まれたら、この手順を 1 から順に実行してください。各ステップの「完了条件」を満たしてから次へ進みます
> - 人の操作が必要なのは **ステップ 4(拡張機能の読み込みとブラウザ名の入力)だけ**です。そこでは手順をユーザーに伝えて、終わるまで待ってください
> - グローバルなツール(Node.js、pnpm)を新たに入れる必要があるときは、入れる前にユーザーの了承を取ってください
> - この手順は macOS 専用です。ほかの OS では、対応していないことをユーザーに伝えて止まってください

## 1. 前提を確かめる

```bash
uname -s            # Darwin であること
node --version      # v22 以上
pnpm --version      # 入っていること
```

- Node.js が無い・22 未満: `brew install node`(Homebrew がある場合)など。**ユーザーの了承を取ってから**入れる
- pnpm が無い: `brew install pnpm`、または Node に同梱の `corepack enable pnpm`。**ユーザーの了承を取ってから**入れる
- Chrome または Edge が入っていること(`/Applications/Google Chrome.app` か `/Applications/Microsoft Edge.app`)

完了条件: 3 つのコマンドが期待どおりの結果を返す。

## 2. リポジトリを置く

置き場所は、ユーザーの指定が無ければ `~/cdp-relay` にします。常駐中継はこの場所から動くので、**外付けディスクは避けてください**(取り外している間は中継が起動できません)。

```bash
git clone https://github.com/Haratakeshi/cdp-relay.git ~/cdp-relay
cd ~/cdp-relay
pnpm install --frozen-lockfile
```

既に clone 済みなら `git -C ~/cdp-relay pull --ff-only` のあと同じく `pnpm install --frozen-lockfile`。

完了条件: `~/cdp-relay/node_modules/ws` が存在する。

## 3. 常駐中継を入れる

```bash
cd ~/cdp-relay
pnpm run setup
```

`setup` は何度実行しても安全です。足りないものだけを入れ、最後に「次にやること」を表示します。

- ログイン時に自動起動する LaunchAgent(`~/Library/LaunchAgents/io.github.haratakeshi.cdp-relay.plist`)を入れ、中継を `127.0.0.1:9333` で起動します
- 落ちても自動で再起動します。ログは `~/Library/Logs/cdp-relay.log`

完了条件: 出力の「[常駐中継]」に ✔ が出る。この時点では「[ブラウザ(拡張機能)]」は ✖ で正常です。

## 4. 拡張機能を読み込む(人の操作)

> **AI エージェントへ**: Chrome の仕様で、拡張機能の読み込みはコマンドからできません。以下をユーザーに伝えて、終わったら知らせてもらってください。
> `open ~/cdp-relay/extension` で Finder に拡張機能のフォルダを開いておくと、ユーザーが選びやすくなります。

使いたいブラウザ(プロファイル)ごとに、次を行います。

1. アドレスバーに `chrome://extensions`(Edge は `edge://extensions`)と入力して開く
2. **デベロッパーモード** のスイッチを ON にする(Chrome は右上、Edge は左側のメニュー)
3. **パッケージ化されていない拡張機能を読み込む** を押し、`~/cdp-relay/extension` フォルダを選ぶ
4. ツールバーのパズルアイコンから **CDP Relay Bridge** をピン留めし、アイコンを押す
5. **ブラウザ名** に、そのプロファイルを表す一意な名前を入れて保存する(例: `chrome-personal`、`edge-company-a`)
6. バッジが消えて「接続中」と表示されれば完了

名前はエージェントがブラウザを選ぶときに使います。**プロファイルごとに別の名前**にしてください(同じ名前だと、後から繋いだ方に置き換わります)。

完了条件: もう一度 `pnpm run setup` を実行し、「[ブラウザ(拡張機能)]」に読み込んだブラウザが ✔ で並ぶ。

## 5. エージェントに登録する

### Claude Code

```bash
claude plugin marketplace add ~/cdp-relay
claude plugin install cdp-relay@cdp-relay
```

新しいセッションから MCP サーバー `cdp-relay` とスキル `cdp-relay:cdp-relay` が使えます。
ローカルの clone を marketplace にしているので、`git pull` すると中継とプラグインが同じ版にそろいます。

GitHub から直接入れることもできます(`claude plugin marketplace add Haratakeshi/cdp-relay`)。その場合も、中継のためにステップ 2〜4 は必要です。

### そのほかの MCP クライアント(Codex / Gemini CLI / Cursor / Antigravity など)

stdio の MCP サーバーとして、次を登録します。`pnpm run setup` の出力に、この Mac の絶対パスを入れた設定が表示されます。

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

- GUI アプリから起動されるクライアントは PATH に node が無いことがあるので、`command` は node の絶対パス(`which node`)にします
- 中継を 9333 以外のポートで動かしたときだけ `"env": {"CDP_RELAY_PORT": "<port>"}` を足します
- エージェントへの指針(HumanGate、タブの後始末)は MCP の初期化時にサーバーから伝わります。スキルの仕組みがあるクライアントでは
  [plugin/cdp-relay/skills/cdp-relay/SKILL.md](plugin/cdp-relay/skills/cdp-relay/SKILL.md) をスキルとして登録するとより確実です

完了条件: エージェントのツール一覧に `browser_list` などの cdp-relay のツールが出る(Claude Code は `claude mcp list` で `cdp-relay` が Connected)。

## 6. 動作確認

エージェントで次を実行します(ユーザーのタブには触れず、自分で開いたタブだけを使います)。

1. `browser_list` — ステップ 4 で付けた名前が `online` で出る
2. `tab_open {browser: "<名前>", url: "https://example.com"}` — 背面にタブが開き、スナップショットが返る
3. `session_end {close_tabs: true}` — タブが閉じ、ブラウザ上部の「デバッグしています」のバーが消える

完了条件: 3 つとも成功する。ユーザーに「準備完了」と伝えてください。

---

## 更新

```bash
cd ~/cdp-relay
git pull --ff-only
pnpm install --frozen-lockfile
pnpm daemon:restart        # 中継を新しいコードで起動し直す
pnpm run setup             # 拡張の版が古ければ、更新コマンドが表示される
```

- 拡張機能は `curl -X POST http://127.0.0.1:9333/b/<名前>/reload-extension` でディスクから読み直せます(`setup` が表示します)。
  `manifest.json` の権限が増えた版では、`chrome://extensions` で手動の再読み込みが必要です
- Claude Code のプラグイン: `claude plugin marketplace update cdp-relay` → `claude plugin update cdp-relay@cdp-relay`

## アンインストール

```bash
cd ~/cdp-relay
pnpm daemon:uninstall                         # 常駐中継を止めて LaunchAgent を削除
claude plugin uninstall cdp-relay@cdp-relay   # Claude Code を使っている場合
claude plugin marketplace remove cdp-relay
rm -rf ~/.cdp-relay                           # ソケットと状態ファイル
```

各ブラウザの `chrome://extensions` から CDP Relay Bridge を削除し、最後に `~/cdp-relay` を削除します。

## うまくいかないとき

まず `pnpm run setup` を実行してください。状態と次の一手を表示します。

| 症状 | 原因と対処 |
|---|---|
| バッジが `OFF` のまま | 中継が動いていない。`pnpm run setup`。ログは `pnpm daemon:log` |
| バッジが `!` | ブラウザ名が未設定。拡張のアイコンを押して入れる |
| エージェントが `cdp-relay is not running` | 中継が一度も起動していない。ステップ 3 を実行する |
| エージェントが `browser "…" is not connected` | そのプロファイルのウィンドウが閉じている(エージェントは `browser_open` で開ける)か、拡張が未読み込み |
| 2 つのプロファイルが交互に切れる | 同じブラウザ名を付けている。別の名前にする |
| `pnpm run setup` が別の場所の中継を検出した | 以前に別の場所から入れた中継が動いている。`setup` がこの clone で入れ直す |
| 開発者モードを OFF にしたら拡張が消えた | 未パックの拡張は開発者モードが必要。ON に戻して再読み込みする |

詳しい仕様と制約は [docs/REFERENCE.md](docs/REFERENCE.md) にあります。
