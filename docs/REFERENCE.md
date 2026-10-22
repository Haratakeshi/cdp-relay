# リファレンス(詳細仕様)

cdp-relay の詳細な仕様・設定・制約です。導入手順は [INSTALL.md](../INSTALL.md)、概要は [README](../README.md)、設計は [DESIGN.md](DESIGN.md)、
エージェント向け MCP は [PLUGIN.md](PLUGIN.md)、実測の記録は [EXPERIMENT_LOG.md](EXPERIMENT_LOG.md) を参照してください。

構成:

```
 CDP クライアント(puppeteer / Playwright / *-mcp)
   │  http://127.0.0.1:9333/b/<name>/json/version   または  http://127.0.0.1:<専用port>/json/version
   │  ws://…/devtools/browser  (Target ドメインを facade.mjs が合成)   ws://…/devtools/page/<tabId> (素通し)
   ▼
 relay/server.mjs(常駐、127.0.0.1 のみ)
   ▲  ws://127.0.0.1:9333/extension?name=<name>&port=<専用port>&token=…
   │  {id, method, params} / {id, result|error} / {event, …}
 extension/(MV3 Service Worker、chrome.debugger + chrome.tabs)  ← ブラウザごと(プロファイルごと)に 1 つ
```

## ポートの考え方(2 種類ある)

| 種類 | いくつ必要か | 用途 |
|---|---|---|
| 中継ポート(既定 9333) | **全ブラウザで 1 つだけ** | すべての拡張がここに繋ぐ。ブラウザは名前で区別する(`/b/<name>/…`) |
| ブラウザ専用ポート(任意) | **使うブラウザごとに 1 つ、重複不可** | `/json/version` をルートに解決するクライアント専用。puppeteer の `browserURL`、chrome-devtools-mcp の `--browserUrl` |

Chrome を足しても Edge を足しても、プロファイルを増やしても、**中継ポートは 9333 のまま使い回す**。
Playwright の `connectOverCDP('http://127.0.0.1:9333/b/<name>')` や puppeteer の `browserWSEndpoint` を使うなら専用ポートは不要。
`browserURL` 形式のクライアント(chrome-devtools-mcp など)に渡したいブラウザにだけ、重複しない番号を割り当てる。

拡張機能はプロファイルごとに別インスタンスになる(`chrome.storage.local` も見えるタブもプロファイル単位)。
Chrome の別ユーザー、Edge の別ユーザーは、それぞれに拡張を読み込んで**別の名前**を付ける。名前が同じだと後から繋いだ方に置き換わる。

割り当て例:

| ブラウザ | 名前 | 専用ポート |
|---|---|---|
| Chrome 個人 | `chrome-personal` | 9341 |
| Chrome A 社 | `chrome-company-a` | 9342 |
| Edge 個人 | `edge-personal` | 9343 |
| Edge B 社 | `edge-company-b` | 9344 |

## 拡張機能の設定項目

導入手順は [INSTALL.md](../INSTALL.md)。拡張のツールバーアイコン(ポップアップ)でブラウザ名を設定でき、詳細はオプション画面で設定する。

- ブラウザ名(必須): 中継サーバー上の識別子(例 `chrome-company-a`)。プロファイルごとに一意にする。
  設定するまで拡張は接続しない(既定名で別プロファイルと蹴り合うのを防ぐため)
- 専用ポート(任意): 例 `9341`。指定するとそのブラウザ専用の `http://127.0.0.1:9341/json/version` が使える
- 中継サーバー URL: 既定 `ws://127.0.0.1:9333/extension`
- 共有トークン: 中継サーバーを `CDP_RELAY_TOKEN=…` で起動した場合に同じ値

ツールバーのバッジ: `!` = ブラウザ名が未設定、`OFF` = 中継に未接続(再接続を試行中)、数字 = デバッガを接続中のタブ数。
`curl http://127.0.0.1:9333/browsers` に名前が出れば接続済み(`portError` が出ていないことも確認する)。

中継サーバーが動いていない間、拡張は `ERR_CONNECTION_REFUSED` を出しながら最大 30 秒間隔で再接続を試み続ける
(異常ではない)。専用ポートは中継サーバーのポートとは別の番号にすること。

タブに attach している間、ブラウザに「『CDP Relay Bridge』がこのブラウザのデバッグを開始しました [キャンセル]」という
非モーダルのバーが表示されます。操作は妨げませんが、「キャンセル」を押すと detach されます。
エージェントのタブ(下記「自動処理」)はクライアントが繋いでいない間も中継が attach し続けるので、エージェントのタブが開いている間はバーが出たままになります。
ブラウザを `--silent-debugger-extension-api` 付きで起動するとこのバーは出ません(実測済み)。

## 常駐化(macOS LaunchAgent)

ログイン時に中継サーバーを自動起動し、落ちても再起動する。

```bash
pnpm daemon:install      # --port 9333 が既定。別ポートは pnpm daemon:install --port 9400 のように渡す
pnpm daemon:status       # state / pid / 最後の終了コード
pnpm daemon:log          # ~/Library/Logs/cdp-relay.log の末尾
pnpm daemon:uninstall    # 停止して plist を削除
```

- 実体は `~/Library/LaunchAgents/io.github.haratakeshi.cdp-relay.plist`。node は絶対パスで書き込む
  (LaunchAgent は PATH を引き継がないため。既定は `/opt/homebrew/bin/node`。nvm 配下はバージョン更新で消えるので選ばない)
- `KeepAlive` により強制終了しても即座に再起動する(実測 1 秒)。拡張は再接続のバックオフで自動的に繋ぎ直る
- 中継を再起動してもブラウザ側の作業は影響を受けない。attach していたタブは detach されるだけ

### Windows(常駐させない)

Windows では中継を常駐させない。`pnpm run setup`(または `pnpm daemon:install`)が中継をバックグラウンドで起動し、
再起動やログオフの後は、エージェントが最初にツールを使ったときに MCP シムが前回と同じ設定(`relay-<port>.json` に記録した `CDP_RELAY_*`)で起動する。
拡張は最大 30 秒間隔で再接続するので、その間 `browser_list` に出ないことがある。

```powershell
pnpm daemon:status       # 中継が応答するか / pid
pnpm daemon:restart      # 止めて、前回と同じ設定で起動し直す(relay/*.mjs を更新したとき)
pnpm daemon:uninstall    # 止める
pnpm daemon:log          # ~/.cdp-relay/relay-9333.log の末尾
```

- エージェント用のソケットは名前付きパイプ `\\?\pipe\<ユーザーフォルダ>\.cdp-relay\relay-<port>.sock`(Node の net は Windows でパイプ名しか受けないため)。
  状態ファイル・ログ・クライアント認証のトークンは `~/.cdp-relay/` に置く
- 閉じたプロファイルを開く処理(`browser_open`・CLI の `open`)は、`%LOCALAPPDATA%` の `Local State` からプロファイルを探し、
  `chrome.exe` / `msedge.exe` を `--profile-directory` 付きで起動する。macOS と違い、開いた窓は前面に出る
- [事実 2026-10-22] GitHub Actions の windows-latest(ヘッドレスの Chrome)で E2E-8 / 13 / 15 / 1 / 2 / 3 を確認。実機の Windows での確認は利用者に依頼している

常駐させると、複数の AI エージェントが同時に別々のブラウザへ接続できる。
同じタブに複数のクライアントが繋いだ場合は参照カウントで attach を共有し、最後の 1 つが離れたときだけ detach する
(エージェントのタブは detach せず、中継が付け直して監視を続ける。下記「自動処理」)。

## 自動処理(止まらないためのポリシー)

外出先のエージェントが承認待ち・ダイアログ待ちで止まらないよう、中継がブラウザごとに次を処理する。
「全部自動承認」ではなく、**クライアントが先に処理すれば何もしない。放置されたものだけをタイムアウト後にポリシーの既定動作で片付けて記録する**。

### 対象: エージェントのタブ(`scope`)

puppeteer / Playwright / CLI は接続すると**全タブに attach する**ので、「attach 中」はエージェントのタブを意味しない。
既定の `scope: "agentTabs"` では、中継は次の「エージェントのタブ」だけに介入する。

- 中継経由で作ったタブ(`Target.createTarget` = puppeteer の `newPage`、Playwright の `context.newPage`、CLI の `goto`)。
  url 付きの `createTarget` は `about:blank` で作ってエージェントのタブにしてから目的の URL へ遷移する(読み込み直後のダイアログや 401 を取りこぼさないため)
- エージェントのタブから開いたポップアップ(`window.open` / `target=_blank`。`chrome.tabs` の `openerTabId`)。新規タブページ(`chrome://newtab` 等)と
  URL が空・`about:blank` のままのタブは引き継がない(Ctrl+T で開いたタブにも opener が付くことがあるため。URL が確定した時点で判定する)
- 明示的に接続したタブ(タブ WS `/devtools/page/<tabId>`、`Target.attachToTarget`)
- `POST /b/<name>/tabs/<tabId>/adopt` で登録したタブ(応答の `wasAgent` は元々エージェントのタブだったか)。`DELETE` で外す。
  CLI の `--tab` / 直近のタブで既存タブを選んだときは、コマンドの実行中だけ adopt し、元々エージェントのタブでなければ終了時に外す

それ以外(ユーザーが手で使っているタブ)には**中継は**ダイアログの自動応答・ファイル選択の intercept・認証の応答・ダウンロードの移動・遷移し直しを一切しない。
ただし**クライアント自身の動作は別**: Playwright は接続中に見えている全ページで、`dialog` リスナーの無いダイアログを即座に dismiss する(beforeunload だけは accept。
`playwright-core` の `coreBundle.js` 62280〜62292 行)。ユーザーのタブで開いたダイアログも、Playwright が接続している間は Playwright が閉じる。
これはクライアント側の挙動で中継は関与しない(本物の Chrome に CDP で繋いだときも同じ)。puppeteer はリスナーが無ければ何もしない。
中継が送るのは応答確認のための `Page.enable` だけ(クライアント自身も全タブに送るので、追加の副作用は無い)。
エージェントのタブは中継が名前ごとに覚えている(拡張の再接続でも引き継ぎ、ブラウザ再起動で tabId が振り直されたら忘れる)。`GET /browsers` の `agentTabs`。

**エージェントのタブは、クライアントが繋いでいない間(CLI のコマンドの合間など)も中継が attach し続ける**。detach していると、その間に開いたダイアログ
(セッション切れの確認など)は Chrome から通知が来ず自動処理できない。次の接続では固まったタブとして同じ URL へ遷移し直すことになり、ページの状態を失う(実測)。
最後のクライアントが離れたときは、クライアントが有効にしたドメインや傍受(`Runtime.enable`、`Fetch.enable` 等)を持ち越さないよう付け直す
(持ち越すと次のクライアントの `Runtime.enable` に実行コンテキストが通知されず、puppeteer がページの初期化で止まる。実測)。そのとき開いているダイアログは、
もう誰も処理しないので `dialogTimeoutMs` を待たずにポリシーどおり閉じる(記録の `reason: "all clients left"`)。付け直しで Chrome の attach が外れる数 ms の間に
開いたダイアログは、付け直した後の確認で固まったタブとして扱われ、遷移し直しになることがある。拡張の再接続(SW の再起動・再読み込み)後は attach し直す。
インフォバーの「キャンセル」などでブラウザ側から detach されたタブはすぐには付け直さず、次にクライアントが繋いだ時点で監視を再開する
(それまでの間に開いたダイアログは、次の接続で遷移し直しになる)。`DELETE …/adopt` で外すと detach する。`GET /browsers` の `attachedTabs` に出る。

前面にないタブ・最小化したウィンドウのタブ(`visibilityState: hidden`)で開いたダイアログも、attach していれば通常どおり通知され自動処理される(E2E-14、Chrome 152)。

`scope: "allTabs"` は外出中モード。ユーザーのタブも含めて全タブを処理する(誰も画面を見ていないときに使う)。

| 事象 | 中継の動作(対象のタブ) |
|---|---|
| JS ダイアログ(alert / confirm / prompt / beforeunload) | 実 attach 直後に中継が `Page.enable`。`javascriptDialogOpening` から `dialogTimeoutMs` 以内に閉じられなければ `dialogs` の動作で `Page.handleJavaScriptDialog` |
| 未 attach 中に開いたダイアログで固まったタブ | attach し直しても Chrome は通知せず、`Page.enable` すら返らない(実測)。`unresponsiveTimeoutMs` 内に返らなければ、エージェントのタブは `unresponsiveTab: "renavigate"` で**同じ URL へ遷移し直す**(ページの状態は失われる。`"report"` なら記録だけ)。**エージェントのタブ以外は触らず、クライアントから見えなくする**(見せると puppeteer の `pages()` や Playwright の `connectOverCDP` がそのタブの初期化で止まる)。確認は全タブ並列なので、固まったタブがいくつあっても接続の遅れは `unresponsiveTimeoutMs` 1 回分(2 回目以降の接続は覚えているので待たない)。**隠したタブは、そのタブで遷移・クローズ・adopt が起きるまで見えないまま**(ユーザーがダイアログを閉じただけでは戻らない。必要なら `POST …/adopt`) |
| ファイル選択 | `fileChooser: "intercept"` ならネイティブの選択画面を出さず `Page.fileChooserOpened` を記録。puppeteer の `waitForFileChooser` / Playwright の `filechooser` はそのまま使える |
| Basic 認証 | 拡張の `webRequest.onAuthRequired` → 中継が判断。下記の条件をすべて満たすときだけ `auth` の資格情報を渡す(拒否されたら再送せず cancel)。それ以外は cancel(401 を表示して進む)。クライアントが `Fetch.enable({handleAuthRequests:true})` しているときは `onAuthRequired` 自体が発火せずクライアントが処理する(実測)。対象外のタブと proxy 認証はブラウザ既定のまま |
| ダウンロード | `Browser.setDownloadBehavior` を `chrome.downloads` で実現(下記) |
| 権限 | `Browser.grantPermissions` 等を `chrome.contentSettings` で実現(下記)。`permissions` は拡張の接続時に事前適用 |

ポリシーは `CDP_RELAY_POLICY` のパス(既定: リポジトリ直下の `policy.json`、`.gitignore` 済み)。ファイルが無ければ既定値で動く。
書式は [`policy.example.json`](../policy.example.json)。参照のたびに更新時刻を見て読み直すので、常駐中継を再起動せずに反映される
(`permissions` の変更は 1 秒ごとに見て接続中のブラウザへ適用し直す。ポリシーから消した型も clear する)。項目ごとに型と値を検証し、不正な項目は直前の正しい値(初回は既定値)のまま
中継ログに警告を出す。タイムアウト(`dialogTimeoutMs` / `unresponsiveTimeoutMs`)は 1〜2147483647(Node の `setTimeout` の上限)。
`auth` / `permissions` のキーはオリジン(または `"*"`)で、`about:blank` のようにオリジンにならないキーはそのキーだけ警告して捨てる。壊れた JSON でも中継は落ちない。

### 資格情報(`auth`)とトークン

`auth` の資格情報は、次を**すべて**満たすときだけ渡す。

1. 中継が `CDP_RELAY_TOKEN` 付きで動いている(拡張の接続を認証している)。未設定なら常に cancel し、中継ログに 1 回警告する
2. 相手が `features` を申告した拡張(0.2.0 以降)で、そのタブがエージェントのタブ(または `allTabs`)かつ attach 中
3. リクエストが最上位の遷移(`main_frame`)か、`initiator` のオリジンが認証先と同じもの(iframe・`<img>`・`fetch` も同一オリジンから始まったものだけ。
   他サイトが埋め込んだ iframe や他サイトの `fetch` で資格情報を引き出させない)

「本物の拡張」を実際に保証しているのは **トークンだけ**。Origin の `chrome-extension://` と `features` の申告は、ローカルの別プロセスなら偽装できる。

一度認証に成功すると、Chrome の HTTP 認証キャッシュにより、以後そのオリジン(同じ保護空間)への要求には Chrome が資格情報を自動で付ける。
これは Chrome の仕様で中継は関与しない(上の 3 の制限もキャッシュ済みの資格情報には効かない)。キャッシュはブラウザを閉じるまで残る。

資格情報はこのファイル由来のものだけを使い、エージェントやクライアントから渡された文字列は使わない。記録とログに資格情報は出さない。
`chmod 600 policy.json` にする(600 でなければ中継ログに警告)。

トークンの設定:

```bash
TOKEN=$(openssl rand -hex 16)
pnpm daemon:install --token "$TOKEN"     # LaunchAgent の環境変数 CDP_RELAY_TOKEN に入る(plist は 600 で書く)。常駐中継が再起動する
echo "$TOKEN"                             # 各プロファイルの拡張のオプション「共有トークン」に同じ値を入れて保存
```

手で起動するなら `CDP_RELAY_TOKEN=$TOKEN pnpm relay`。トークンを設定すると、同じ値を入れていない拡張は接続できなくなる(`closed 403` / `bad token`)。

### クライアント認証(任意)

`CDP_RELAY_CLIENT_AUTH=1` で起動した中継は、TCP 側のクライアント(HTTP の `/browsers` `/json/*` `/events` と近道 API、WS の `devtools/*`、専用ポート)に
`Authorization: Bearer <トークン>` を求め、無ければ 401 を返す。拡張の接続口 `/extension` は対象外(`CDP_RELAY_TOKEN` で別に検証する)。
エージェント(MCP)の経路は Unix ソケットなので影響を受けない。

```bash
pnpm daemon:install --client-auth        # 常駐中継で有効にする(初めて入れるときは pnpm run setup -- --client-auth でも可)
cat ~/.cdp-relay/relay-9333.client-token  # トークン(初回に中継が生成、0600。再起動しても同じ値)
```

| クライアント | 渡し方 |
|---|---|
| CLI(`cli.mjs`)・`pnpm run setup` | トークンのファイルを自動で読む(設定不要) |
| Playwright | `chromium.connectOverCDP(url, { headers: { authorization: 'Bearer <トークン>' } })`(`/json/version` の取得と WS の両方に付く) |
| puppeteer | `puppeteer.connect({ browserURL \| browserWSEndpoint, headers: { authorization: 'Bearer <トークン>' } })`(puppeteer 25 は `browserURL` の `/json/version` にも付ける) |
| curl | `curl -H "Authorization: Bearer $(cat ~/.cdp-relay/relay-9333.client-token)" http://127.0.0.1:9333/browsers` |

- ヘッダを渡せず URL しか受け付けないツールは使えなくなる
- トークンは本人だけが読めるファイルにあるので、**同じユーザーで動くプログラムは読めてしまう**。防げるのは、同じ Mac の別の OS ユーザーと、
  要求は送れるがファイルは読めないもの(サンドボックス内のアプリ、ローカルのサービスを踏み台にした SSRF など)
- トークンを作り直すには、ファイルを消して中継を再起動する(`pnpm daemon:restart`)。中継は起動時に読んだ値を使い続ける
- クエリ文字列(`?token=`)では受け付けない(URL はログやプロセス一覧に残りやすいため)

### 記録

処理した事象は `GET /b/<name>/events`(専用ポートでは `/events`、`?since=<seq>` で差分)に JSON で残り、中継ログにも出る。
ブラウザごとに直近 200 件。CLI では `events --browser <name>`。

```bash
curl -s http://127.0.0.1:9333/b/chrome-personal/events | jq '.[] | {type, action, dialogType, url}'
```

### ダウンロード(`Browser.setDownloadBehavior`)

- `allow` / `allowAndName` / `deny` / `default`、`downloadPath`(絶対パスのみ)、`eventsEnabled`(`Browser.downloadWillBegin` / `downloadProgress`)に対応。
  Playwright の `download.path()` / `saveAs`、puppeteer の `setDownloadBehavior({policy:'allow', downloadPath})` が動く
- 設定は facade クライアントごと。ブラウザとしての動作(deny で止めるか)は接続中のクライアントのうち最後に設定したもの。イベントは `eventsEnabled` の全員へ送り、
  ファイルは `allow` / `allowAndName` の各クライアントの `downloadPath` に置く。切断したクライアントの設定だけを外す(Playwright を 2 つ繋いで片方を閉じても、残った方は使える)
- `chrome.downloads` はブラウザのダウンロードフォルダにしか保存できないので、完了後に中継が `downloadPath`(`allowAndName` なら `downloadPath/<guid>`)へ**移動**する。
  中継とブラウザが同じマシンにある前提。同名のファイルがあれば上書きせず、Chrome と同じく `name (1).ext` の連番にする
- 対象はエージェントのタブ(`scope: allTabs` なら全タブ)で始まったダウンロードだけ。`Page.downloadWillBegin` と、新しく作られた `chrome.downloads` の item を
  URL で対応付ける(どちらが先に届いてもよい。間が 2 秒以内・`in_progress`・未対応のものだけ。完了済みの古い item は使わない)。ユーザーのタブのダウンロードには、クライアント接続中でも触らない
- 配置の結果はクライアントごとに返す(置けたクライアントには `completed` + `filePath`、置けなかったクライアントには `canceled`)。
  item と対応付かないまま完了したものは `downloadPath` に置けないので、保存先を期待するクライアントには `canceled`(ファイルはブラウザのダウンロードフォルダに残る)
- 危険なファイルは承認しない。`dialogTimeoutMs` 待っても承認されなければ cancel して `canceled` を送る(止まらないため)。判定待ち(`asyncScanning`)は結果を待つ
- 「ダウンロードごとに保存先を確認する」がオンのプロファイルでは保存ダイアログが出る。拡張 API では抑止できない [推測]
- ユーザー操作なしで続けてダウンロードすると「複数ファイルのダウンロード」の許可待ちで保留される(EXPERIMENT_LOG §23)。必要なサイトは
  `permissions` に `"automaticDownloads": "allow"` を入れる([推測] 効果は未検証)

### 権限(`Browser.grantPermissions` / `setPermission` / `resetPermissions`)

- `chrome.contentSettings` で実現する。対応するのは `geolocation`→`location`、`notifications`、`videoCapture`(camera)→`camera`、
  `audioCapture`(microphone)→`microphone`、`clipboardReadWrite`(clipboard-read)→`clipboard` のみ。それ以外(`midi`、`sensors`、
  Playwright の `clipboard-write` = `clipboardSanitizedWrite` など)を含む要求は、対応できない名前を列挙したエラーにして一部も適用しない
- `origin` あり → そのオリジンのパターン、なし → `http://*/*` と `https://*/*`(`<all_urls>` は既定値扱いで camera/microphone の allow を拒否されるため)
- 本物の `Browser.grantPermissions` は「列挙した権限以外を拒否」にするが、ここでは列挙した権限を許可するだけ(ユーザーの他の設定を巻き込まないため)
- contentSettings はタブ単位ではなくプロファイル全体(サイト単位)に効く。`scope` の対象外
- **contentSettings は実プロファイルに永続化される**。後始末は 3 段:
  facade クライアントの切断(と `resetPermissions`)で、そのクライアントが設定した型を消してポリシーと他の接続中クライアントの分を再適用する /
  拡張は中継との接続が切れたとき(中継の停止・クラッシュ・オプション保存による繋ぎ直し)と Service Worker の起動時に、自分が設定した規則を全部消す /
  中継は拡張の接続時にポリシーを適用し直す。`clear` は拡張が設定した規則だけを消すので、ユーザー自身がサイト設定で決めた値は残る。
  操作は中継側・拡張側ともに 1 本に直列化している(拡張側は set / 切断時の clear / 起動時の clear を同じ Promise チェーンで順に実行)

### 証明書エラー

`Security.setIgnoreCertificateErrors {ignore:true}` は拡張経由では実現できないのでエラーを返す(以前は黙って成功扱いだった)。
puppeteer の `acceptInsecureCerts: true` と Playwright の `ignoreHTTPSErrors` は使えない。`{ignore:false}` は `{}`。

### 拡張の更新(0.1.0 → 0.2.0)

0.2.0 で権限(`contentSettings`, `downloads`, `webRequest`, `webRequestAuthProvider`, `<all_urls>`)を追加した。0.1.0 には再読み込み用の
メソッドが無いので、**最初の 1 回だけ** `chrome://extensions` で各プロファイルの拡張を手で再読み込みする。以後は

```bash
curl -X POST http://127.0.0.1:9333/b/<name>/reload-extension   # chrome.runtime.reload。数秒で再接続する
curl -s http://127.0.0.1:9333/browsers | jq '.[] | {name, extVersion}'
```

- 開発者モードが OFF のプロファイルで再読み込みすると、Chrome 152 は未パック拡張を無効化する(実測)。無効化されると外出先からは戻せない。
  未パック拡張の読み込みには開発者モードが必要なので通常は ON のはず
- 新しい中継に 0.1.0 の拡張が繋がっても中継は落ちない。接続時に未対応機能をログに 1 回出し、ダウンロード・権限の要求にはエラーを返す。
  **Playwright の `connectOverCDP` は接続時に `Browser.setDownloadBehavior` を送るので、0.1.0 のままだと接続に失敗する**(拡張を更新すれば直る)

## うまく繋がらないとき

拡張の Service Worker のコンソール(`chrome://extensions` → 拡張の「Service Worker」リンク)と、
オプション画面の status(直近の切断理由 `lastClose` を含む)、`GET /browsers` の `portError` を見る。

| 症状 | 原因と対処 |
|---|---|
| `ERR_CONNECTION_REFUSED` と `closed 1006` を繰り返す | 中継サーバーがそのポートで動いていない。先に `pnpm relay` を起動する(既定 9333。別ポートなら `CDP_RELAY_PORT=<port> pnpm relay`)。再接続は最大 30 秒間隔で続くので、中継を起動すれば自動で復帰する。この再試行自体は設計どおりの挙動 |
| `/browsers` の `portError` に `same as the relay port` | 専用ポートに中継サーバーと同じポートを入れている。専用ポートは空欄にするか別の番号にする(`/b/<name>` 経由ではそのまま使える) |
| `portError` が `EADDRINUSE` | 専用ポートが他プロセスに使われている。別の番号にする |
| `closed 4000 replaced by new connection` | 同じブラウザ名で別の接続が来た。プロファイルごとに一意な名前を付ける |
| `closed 403` / `bad token` | 中継を `CDP_RELAY_TOKEN` 付きで起動しているのに、拡張のトークンが違う |

ポート番号は 49152 未満を選ぶ。macOS の一時ポート範囲は 49152〜65535 で、その範囲の番号は他プロセスに先取りされて
`EADDRINUSE` になることがある(`sysctl net.inet.ip.portrange.first` で確認できる)。

## エージェント向け MCP(プラグイン)

エージェントからは MCP サーバー `plugin/cdp-relay/mcp/server.mjs`(依存なし)を使うのが基本。中継の Unix ドメインソケット
`~/.cdp-relay/relay-<port>.sock`(0600)上に、MCP プロセス 1 つにつき 1 セッションを作る。セッションは自分用のタブを `t1` 等のハンドルで持ち、
アクセシビリティツリーの ref で操作する(`snapshot` / `act` / `read` / `screenshot`)。セッションが終わると(`session_end` かエージェントの終了)、
タブは閉じるか人に引き渡されて detach される(インフォバーが消える)。閉じるかどうかはエージェントが決め、結果を見せるときは残して人に伝える(HumanGate)。
不可逆に見える要素(`policy.json` の `humanGatePattern`)は `confirmed: true` なしではクリックしない。

導入は [INSTALL.md](../INSTALL.md)。

考え方・ツール一覧・ライフサイクル・ほかのエージェントへの組み込みは [PLUGIN.md](PLUGIN.md)。

## CLI

```bash
node cli.mjs browsers
node cli.mjs open chrome-company-a      # 未起動プロファイルの窓を開いて接続を待つ
node cli.mjs open --app chrome --profile "Profile 2"   # 初回。接続してきた名前を profiles.json に記録
node cli.mjs events --browser chrome-personal         # 自動処理の記録
node cli.mjs pages --browser chrome-personal
node cli.mjs snap --browser chrome-personal --tab 0       # 対話可能要素（@1, @2...）のHUDスナップショット
node cli.mjs click @2 --browser chrome-personal --tab 0  # Ref 番号で直接クリック（高速）
node cli.mjs fill @13 '値' --browser chrome-personal --tab 0 # Ref 番号で入力
node cli.mjs goto https://example.com --browser chrome-personal
node cli.mjs text --browser chrome-personal
node cli.mjs eval 'document.title' --browser chrome-personal --tab 0
node cli.mjs click 'button.submit' --browser chrome-personal --tab 0
node cli.mjs fill 'input#name' '値' --browser chrome-personal --tab 0
node cli.mjs shot /tmp/x.png --browser chrome-personal --full # HTTP shot.png 経由で超高速保存
node cli.mjs run /abs/script.mjs --browser chrome-personal --args '{"k":"v"}'
node cli.mjs close --browser chrome-personal
```

`--tab` はタブ番号・URL/タイトルの部分一致・`targetId`・`new` のいずれか。省略時はそのブラウザで直近に操作したタブ
(`goto` だけは省略時に新規タブ)。既存タブを選ぶと、コマンドの実行中だけ中継にエージェントのタブとして登録する(`adopt`。自動処理の対象になる。
元々エージェントのタブでなければ終了時に外す)。`run` に渡す .mjs は `export default async (browser, page, puppeteer, args) => result`。

拡張の Service Worker はプロファイルが開いている(ウィンドウがある)間しか動かないので、ウィンドウを閉じたプロファイルは中継に現れない。
`open` はそのプロファイルの窓を `open -g -na <アプリ> --args --profile-directory=<dir>` で背面に開き、拡張が中継に登録するまで待つ
(実測: 起動中の Chrome / Edge で約 0.7 秒)。`--front` で前面に出す。名前とプロファイルの対応は `profiles.json`(`.gitignore` 済み、
書式は [`profiles.example.json`](../profiles.example.json))。拡張は自分のプロファイルのディレクトリを知れないので、
`--app/--profile` で初回起動したときに新しく登録された名前を記録する。そのプロファイルが既に名前と対応付いていて接続中なら何もせず返り、
待っている間に 2 つ以上の新しい名前が現れたら(どれか判別できないので)記録せずにエラーにする。`browsers` は `profiles.json` にあって未接続のものを `offline` と表示する。

`browsers` と `pages` は attach しない。それ以外のコマンドは実行中だけそのブラウザの全タブに attach する(他のブラウザには影響しない)。

AI エージェントには上の MCP(プラグイン)を使う。CLI は MCP を使えない環境向け。

## 使い方(CDP クライアント側)

| クライアント | 接続方法 |
|---|---|
| ブラウザ一覧 | `GET http://127.0.0.1:9333/browsers` |
| タブ検索・解決 | `GET http://127.0.0.1:9333/b/<name>/tabs/resolve?q=<keyword>` |
| HUDスナップショット | `GET http://127.0.0.1:9333/b/<name>/tabs/<tabId>/snapshot[?format=json]` |
| スクリーンショット(PNG直接) | `GET http://127.0.0.1:9333/b/<name>/tabs/<tabId>/shot.png[?full=1]` |
| 高速クリック | `POST http://127.0.0.1:9333/b/<name>/tabs/<tabId>/click` (`{"ref": 2}` または `{"selector": "..."}`) |
| 高速入力 | `POST http://127.0.0.1:9333/b/<name>/tabs/<tabId>/fill` (`{"ref": 13, "value": "..."}`) |
| JS 評価 (ファイルレス) | `POST http://127.0.0.1:9333/b/<name>/tabs/<tabId>/eval` (`{"expression": "..."}`) |
| 生 CDP 送信 (HTTP) | `POST http://127.0.0.1:9333/b/<name>/tabs/<tabId>/cdp` (`{"method": "...", "params": {...}}`) |
| puppeteer-core | `puppeteer.connect({ browserURL: 'http://127.0.0.1:9341' })`(専用ポート必須。`browserURL` は `/json/version` をルートに解決するため `/b/<name>` は使えない)または `puppeteer.connect({ browserWSEndpoint: 'ws://127.0.0.1:9333/b/<name>/devtools/browser' })` |
| Playwright | `chromium.connectOverCDP('http://127.0.0.1:9333/b/<name>')` または専用ポート |
| chrome-devtools-mcp | `--browserUrl http://127.0.0.1:9341`(専用ポート)。未検証 |
| Playwright MCP | `--cdp-endpoint http://127.0.0.1:9333/b/<name>`。未検証 |
| 生 CDP(タブ単位 WS) | `GET /b/<name>/json/list` の `webSocketDebuggerUrl`(`ws://…/devtools/page/<tabId>`)へ直接 |

ブラウザが 1 つだけ接続されている間は `/b/<name>` を省略した `http://127.0.0.1:9333/json/version` も使えます。

## テスト

```bash
pnpm test:e2e        # E2E-1〜4, 6〜15(約 2.5 分)。テストは 94xx 帯を使うので常駐中継(9333)と衝突しない
node test/run.mjs e2e-relay e2e-agent   # テストを絞る(test:e2e の実体。OS を問わず動く)
pnpm test:lifetime   # E2E-5 Service Worker 寿命(約 3.5 分)
HEADED=1 pnpm test:e2e   # ウィンドウを表示して実行(目視デバッグ用)
pnpm exp:infobar     # インフォバー観察。これだけは画面つきで起動する(ブラウザ UI を撮るため)
CHROME_PATH="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" node test/e2e-puppeteer.mjs   # Edge で実行
```

**テストは既定でヘッドレス**。ウィンドウが前面を奪って作業を止めないようにしてある。`Extensions.loadUnpacked` も
`chrome.debugger` も新ヘッドレスで動作する(全 9 本を実測)。目視したいときだけ `HEADED=1` を付ける。
`pnpm exp:infobar` はブラウザのインフォバーそのものを撮る実験なので、常に画面つきで起動する。

| テスト | 内容 |
|---|---|
| E2E-8 `e2e-relay` | 中継単体の設定まわり(専用ポートの衝突、トークン検証)。ブラウザ起動なしで数秒 |
| E2E-1 `e2e-page` | タブ WS 素通し(navigate / evaluate / screenshot / エラー伝播 / 切断後もエージェントのタブは attach したままで次のクライアントに実行コンテキストが届く / adopt を外すと detach) |
| E2E-2 `e2e-puppeteer` | puppeteer-core の `connect({browserURL})` から facade 経由で一通り操作 |
| E2E-3 `e2e-playwright` | Playwright の `connectOverCDP` |
| E2E-4 `e2e-multi` | 別プロファイルの Chrome 2 つを専用ポートで同時操作 |
| E2E-9 `e2e-mixed` | Chrome と Edge を 1 つの中継に同時登録して別々に操作 |
| E2E-5 `e2e-lifetime` | Service Worker の寿命(アイドル 75 秒 / ping なし 100 秒) |
| E2E-6 `e2e-refcount` | attach 失敗時に参照カウントが漏れない、共有中の二重 detach で他クライアントが落ちない |
| E2E-7 `e2e-reconnect` | 名前未設定なら接続しない。接続中にオプション保存しても再接続ループにならない。`reload-extension` で再読み込み・再接続 |
| E2E-10 `e2e-dialogs` | 放置されたダイアログ(puppeteer / Playwright)、未 attach 中のダイアログで固まったタブ、ファイル選択、Basic 認証、ポリシーの読み直し、固まったユーザーのタブに触らず止まらない(agentTabs、probe は並列)/ 片付ける(allTabs)、CLI の一時 adopt、createTarget 直後のダイアログと 401、opener の継承 |
| E2E-11 `e2e-downloads` | Playwright の `download.path()` / `saveAs`、Playwright 2 クライアント、puppeteer の allow / deny、上書きしない、ユーザーのタブのダウンロードに触らない、切断で既定に戻る、`setIgnoreCertificateErrors` |
| E2E-12 `e2e-permissions` | ポリシーの事前適用と変更の反映、`grantPermissions` / `clearPermissions` / `setPermission`、対応不可の権限はエラー、切断で自分の分だけ消える、中継停止で拡張が消す |
| E2E-14 `e2e-unattended` | 背面タブ・タブ切替・最小化ウィンドウ(alert 時点の `hidden` を確認)のダイアログ、CLI のコマンドの合間に開いたダイアログを閉じてページの状態が残る、ダイアログを開いたままクライアントが離れたら待たずに閉じて付け直す、拡張の再読み込み後も監視を続ける、adopt を外すと detach |
| E2E-15 `e2e-agent` | MCP → エージェント用ソケット。信頼されたクリック・入力、HumanGate、自動処理の記録が応答に出る、shadow DOM・iframe、古い ref・覆われた要素を押さない、遷移待ち、出力の上限、セッションの分離、session_end / MCP の異常終了でタブを閉じずに detach・エージェントのタブから外す |
| E2E-13 `e2e-hardening` | ブラウザなし(拡張はスタブ)。Origin / Host の検査、資格情報の条件(トークン・sub_frame)、不正なポリシー・イベントで落ちない、危険なダウンロードの cancel、ダウンロードの到着順とクライアント別の結果、adopt の解除と opener、ポリシーのキー検証・タイムアウト上限・消した型の clear |

E2E-10〜13 は検証用のアーティファクト(`events.json`、スクリーンショット、ダウンロードしたファイル等)を `tmp/artifacts/<test>/` に残す。
E2E-8 は旧拡張(0.1.0 相当のスタブ)に新しい中継が繋いだときの互換も見る。

テストはユーザーの実ブラウザには触れません(`tmp/profile-*` の一時プロファイルで別プロセスを起動します)。
常駐中継(9333)とも別ポートなので、テスト中も実運用のブラウザ接続は維持されます。

## 制約(実測)

- **Target ドメインの大半が使えない**: `chrome.debugger` のセッションでは `Target.getTargets` / `attachToTarget` / `createTarget` などが `Not allowed`。中継サーバーが `chrome.tabs` を使って合成する(実装済み)
- **`data:` URL への最上位遷移は `net::ERR_ABORTED`**: 直結セッションでは成功するので拡張デバッガ固有の制限。`http(s)://` は問題なし
- **attach できないページ**: `chrome://` 等の WebUI、他拡張のページ、Chrome ウェブストア、(許可しない限り)`file://`
- **インフォバー**: 上記。抑止は起動フラグ `--silent-debugger-extension-api` かポリシー強制インストールのみ
- **中継が `Page.enable` する**: 自動処理と応答確認のため、実 attach のたびに中継が `Page.enable` する。タブ WS のクライアントには自分で有効にしていなくても
  `Page.*` イベントが届く。エージェントのタブでは、クライアントの `Page.disable`(と、`fileChooser: "intercept"` 時の `Page.setInterceptFileChooserDialog {enabled:false}`)を
  Chrome へ送らず `{}` を返す(セッションは全クライアント共有なので、1 クライアントの disable で中継の検知を止めない)
- **要求元の検査**: Host は `127.0.0.1` / `localhost` / `[::1]` だけを受ける(DNS rebinding 対策。トンネルで別名を使うなら `CDP_RELAY_ALLOWED_HOSTS=host1,host2`)。
  `Origin` ヘッダ付きの要求(= ブラウザのページからの要求)はすべて 403。`/extension` は `Origin: chrome-extension://…` だけを受ける。
  Node のクライアント(puppeteer / Playwright / MCP / CLI)は Origin を付けないので影響しない。DevTools のフロントエンド等、ブラウザ上のページからは繋げない。
  Origin はローカルの別プロセスなら偽装できるので、拡張の接続の認証は `CDP_RELAY_TOKEN` で行う
- **イベントと応答の順序**: chrome.debugger 経由ではコマンド応答よりイベントが先に届くことがある(Playwright の初期化はこの順序でも動作した)
- **タブの共有**: 同じタブに複数のクライアントが繋がると中継が参照カウントで attach を共有する。最後の 1 つが離れたときだけ detach する
  (エージェントのタブは中継自身も参照を 1 つ持ち、付け直して attach を続ける)
- **puppeteer の既定の起動引数**: `--disable-backgrounding-occluded-windows` / `--disable-renderer-backgrounding` 等があると、最小化・背面のタブでも
  `visibilityState` が `visible` のままになる(実測)。見えないタブの挙動を E2E で確かめるときは `ignoreDefaultArgs` で外す(E2E-14)
- **テストで CLI を同期実行しない**: テストページを返す HTTP サーバーと同じプロセスから `execFileSync` で `cli.mjs` を呼ぶと、イベントループが止まってページが
  読み込まれず `Navigation timeout of 30000 ms exceeded` になる(実測。2026-09-27 に「背面タブの alert で止まる」と誤認した原因)。`execFile` を使う
- **クライアント側は既定で無認証**: `CDP_RELAY_TOKEN` は拡張→中継の接続だけを検証する。既定では中継に到達できるプロセスは誰でも
  (`/json/version` と `devtools/*` WS 経由で)登録済みブラウザをログイン済みセッションごと完全に操作できる。塞ぐには下の「クライアント認証(任意)」を有効にする。
  既定の `127.0.0.1` bind のまま使い、外出先からは SSH / Tailscale 等のトンネルで到達させること。`CDP_RELAY_HOST` を
  `0.0.0.0` 等にすると LAN/公開 IP からも無認証で操作可能になるので設定しないこと(このリポジトリでは実験用途に限る)

## 未検証・次のステップ

| 項目 | 状態 |
|---|---|
| chrome-devtools-mcp / Playwright MCP からの実接続 | 上の表は仕様ベース |
| 危険ファイルのダウンロード(`dialogTimeoutMs` 後に cancel) | スタブでのみ確認。一時プロファイルでは危険判定が再現できなかった |
| 複数ファイルのダウンロード許可待ち | 5 件目が保留された。`permissions` の `automaticDownloads: allow` で回避できるかは未検証 |
| 拡張側の認証タイムアウト(10 秒で cancel)、proxy 認証の素通し | 未検証 |
| E2E-10〜13 を Edge で実行 | 未実行(E2E-1/2/3/6 は Edge 152 で PASS) |
| ディスプレイ消灯・画面ロック中の動作 | 未確認 |
| `ServiceWorker.stopWorker` で強制停止すると `starting` のまま復帰しない(test/debug-sw.mjs) | 自然なアイドル終了は 30 秒周期の alarms が防いでおり、100 秒以上の無通信でも生存した |
| Windows の実機 | CI(windows-latest、ヘッドレス)で E2E-8 / 13 / 15 / 1 / 2 / 3 のみ。プロファイルを開く処理、画面つきの実ブラウザ、名前付きパイプの権限は未確認 |
| Linux | 未対応(常駐化とプロファイルを開く処理が無い) |
