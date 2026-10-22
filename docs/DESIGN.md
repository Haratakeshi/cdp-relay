# 設計メモ

## 登場要素

| 要素 | ファイル | 役割 |
|---|---|---|
| 拡張機能 | `extension/background.js` | 中継へ WebSocket 接続し、`chrome.debugger` / `chrome.tabs` を薄い RPC として公開する。判断は持たない |
| 設定画面 | `extension/options.*` | ブラウザ名・専用ポート・中継 URL・トークンを `chrome.storage.local` に保存。保存すると SW が `storage.onChanged` で再接続 |
| 中継サーバー | `relay/server.mjs` | 拡張の登録、HTTP `/json/*`、タブ WS の素通し、専用ポートの開設、20 秒 ping |
| ブラウザ facade | `relay/facade.mjs` | ブラウザレベル CDP の模倣(Target ドメイン合成、sessionId ルーティング) |
| 自動処理 | `relay/autopilot.mjs` | ブラウザごと。放置されたダイアログ・固まったタブ・ファイル選択・Basic 認証の処理、ダウンロードと権限の実装、記録(`/events`) |
| エージェント操作 | `relay/agent.mjs` | Unix ドメインソケット `~/.cdp-relay/relay-<port>.sock`(0600)上のセッション。タブのハンドル、AX ツリーの ref(backendDOMNodeId + 文書の loaderId)、信頼された入力、HumanGate、セッション終了時の後始末。MCP シム `plugin/cdp-relay/mcp/server.mjs` の相手。詳細は docs/PLUGIN.md |
| プロファイル | `relay/profiles.mjs` | `profiles.json` と、閉じたプロファイルの窓を開く処理(CLI の `open` と MCP の `browser_open` が共有) |
| ポリシー | `relay/policy.mjs` | `CDP_RELAY_POLICY`(既定 `policy.json`)の読み込み。既定値はここに 1 か所。mtime で読み直し、600 以外は警告 |

## 拡張 ⇔ 中継 プロトコル(JSON、WebSocket)

中継 → 拡張: `{id, method, params}`。拡張 → 中継: `{id, result}` または `{id, error:{message}}`、イベントは `{event, …}`。

| method | 内容 |
|---|---|
| `ping` | SW 延命用。`{pong}` |
| `ext.info` | `{name, userAgent, version, attached[], features[], contentSettingTypes[]}`。`features`(`auth` / `downloads` / `contentSettings` / `reload`)が無い旧拡張は未対応として扱う |
| `ext.listTabs` | `chrome.tabs.query({})` + `chrome.debugger.getTargets()` の id を `targetId` として添える |
| `ext.createTab` / `ext.closeTab` / `ext.activateTab` | `chrome.tabs.*` |
| `ext.attach` / `ext.detach` | `chrome.debugger.attach({tabId}, '1.3')` / `detach` |
| `cdp` | `{tabId, sessionId?, method, params}` → `chrome.debugger.sendCommand`。`sessionId` は flatten された子セッション宛て |
| `ext.authRespond` | `{requestId, response}` を `webRequest.onAuthRequired`(asyncBlocking)の callback に渡す |
| `ext.downloadCancel` | `chrome.downloads.cancel(id)` |
| `ext.setContentSettings` | `{clear:[型], set:[{type, pattern, setting}]}`。clear は拡張が設定した規則だけを消す。失敗は `{errors}` で返し、残りは続ける。拡張は中継との接続が切れたときと SW 起動時に自分の規則を全部消す(この後始末の完了を待ってから適用する) |
| `ext.reload` | 応答後に `chrome.runtime.reload()` |
| `ext.navigateTab` | `{tabId, url}` → `chrome.tabs.update`(facade の `Target.createTarget` が about:blank で作ってから遷移するのに使う) |

イベント: `cdp.event {tabId, sessionId?, method, params}`、`ext.detached {tabId, reason}`、`ext.tabCreated/tabUpdated {tab}`、`ext.tabRemoved {tabId}`、
`ext.authRequired {requestId, tabId, url, realm, scheme, type, initiator}`(attach 中のタブ・proxy 以外のみ。中継が `AUTH_TIMEOUT_MS` 内に応答しなければ拡張が cancel)、
`ext.downloadCreated/downloadChanged {item}`(`chrome.downloads` の全ダウンロード。振り分けは中継)。

SW 起動時は `chrome.debugger.getTargets()` で `attached` な自タブを detach して状態を揃える(前 SW の孤児 attach 対策)。

## 中継が提供するエンドポイント

| パス | 内容 |
|---|---|
| `GET /browsers` | 接続中の拡張 `[{name, port, connectedAt, attachedTabs}]` |
| `GET /b/<name>/json/version` (`/json/version/` 可) | `{Browser, Protocol-Version, User-Agent, webSocketDebuggerUrl}` |
| `GET /b/<name>/json/list` (`/json`) | タブ一覧。`id` は Chrome の targetId、`webSocketDebuggerUrl` はタブ WS |
| `WS /b/<name>/devtools/browser` | facade(ブラウザレベル) |
| `WS /b/<name>/devtools/page/<tabId>` | attach して素通し。複数クライアントで同一タブを共有でき、参照カウントで detach |
| `GET /b/<name>/json/list` の `id` | Chrome 本来の targetId。facade の `Target.*` が返す id と一致する(取得できないタブのみ `tab-<tabId>`) |
| `GET /b/<name>/events[?since=<seq>]` | 自動処理の記録(直近 200 件) |
| `POST /b/<name>/reload-extension` | `ext.reload`。旧拡張は 501。`/b/<name>` 必須(専用ポートやブラウザ名なしは 400) |
| `POST /b/<name>/tabs/<tabId>/adopt` | 既存タブをエージェントのタブにする(存在しない tabId は 404)。応答 `{tabId, wasAgent}` |
| `DELETE /b/<name>/tabs/<tabId>/adopt` | エージェントのタブから外す(ファイル選択の intercept を戻し、待っているダイアログの自動処理をやめる)。応答 `{tabId, wasAgent}` |

全エンドポイント共通: Host が `127.0.0.1` / `localhost` / `[::1]` / `CDP_RELAY_ALLOWED_HOSTS` 以外、または `Origin` ヘッダ付きなら 403。
`/extension` だけは `Origin: chrome-extension://…` を必須にする(Chrome・Edge とも拡張の SW の WebSocket はこの Origin を付ける。実測)。
| 専用ポート `http://127.0.0.1:<port>/…` | 上記の `/b/<name>` を省いた形。拡張が `?port=` で申告したときだけ開く |

`/b/<name>` を省略したパスは、接続中のブラウザが 1 つのときだけそのブラウザに解決する。

## facade の合成規則

`chrome.debugger` のセッションは Target ドメインが auto-attach 限定(`kAutoAttachOnly`)なので、ブラウザレベルの
操作は `chrome.tabs` で代替し、クライアントには CDP のイベント/応答として返す。

| クライアントからの要求 | 処理 |
|---|---|
| `Browser.getVersion` | UA から `Chrome/x` または `Edg/x` を合成 |
| `Browser.setDownloadBehavior` | autopilot が `chrome.downloads` で実現(下の「自動処理」)。クライアント切断で既定に戻す |
| `Browser.grantPermissions` / `setPermission` / `resetPermissions` | autopilot が `chrome.contentSettings` で実現。クライアント切断でそのクライアントの分を消す |
| `Security.setIgnoreCertificateErrors` | `ignore:true` はエラー(chrome.debugger では不可能。黙って成功にしない)、`ignore:false` は `{}` |
| `Browser.close` | facade の WS を閉じるだけ(ブラウザは閉じない) |
| `Target.setDiscoverTargets {discover:true}` | `browser` ターゲットと全タブの `Target.targetCreated` を送る。以後タブ増減で `targetCreated/targetInfoChanged/targetDestroyed` |
| `Target.setAutoAttach {autoAttach:true}` | 全タブに attach し `Target.attachedToTarget {sessionId:"session-<tabId>", waitingForDebugger:false}`。以後新規タブも自動 attach |
| `Target.getTargets` / `getTargetInfo` / `getBrowserContexts` | 保持している一覧から合成(`getTargetInfo` 引数なしは browser ターゲット。Playwright が connect 直後に呼ぶ) |
| `Target.createTarget` / `closeTarget` / `activateTarget` | `chrome.tabs.create / remove / update` |
| `Target.attachToTarget` / `detachFromTarget` | 参照カウント付き attach / detach |
| `sessionId: "session-<tabId>"` 付きコマンド | `cdp` でそのタブへ。`Target.setAutoAttach`(iframe/worker)もそのまま通す |
| Chrome 由来の子 `sessionId` 付きコマンド | `Target.attachedToTarget` イベントで学習した tabId へ `cdp {sessionId}` |

targetId は Chrome 本来の id を使う(`getTargets().id`、attach 後は `Target.getTargetInfo`)。Playwright は
「page の targetId == メインフレーム id」を前提に `_sessionForFrame` を引くため、合成 id では `Frame has been detached` になる(実測)。
`browserContextId` は Playwright が必須とするため、attach 後は実値、未 attach 時は `default` を入れる。

`Target.createTarget` の応答は、`ext.tabCreated` イベントとの競合に関わらず `Target.attachedToTarget` より後に返す
(`ensureTab` が `ready` を待つ)。Playwright は応答受信時点で該当ページが登録済みであることを前提にする。

## 参照カウント attach の規約(`ExtensionLink.attach` / `detach`)

同じタブに複数のクライアント(タブ WS、facade のセッション)が繋がることを許す。守る性質:

- 失敗した attach は数えない。`ext.attach` が失敗(`chrome://` などの attach 不可ページ)したらカウントを増やさず例外を投げる。
  カウントだけ残ると「attach 済みに見えるが実際には未 attach」のタブが永久に使えなくなる
- 同時 attach は 1 回にまとめる(`attaching` の in-flight Promise を共有)
- カウントが 0 のタブへの `detach` は無視する。二重 `Target.detachFromTarget` や重複クローズで他クライアントの attach を落とさない
- facade 側でも `detachTab` が未 attach のタブで早期 return し、`link.detach` を呼ばない
- エージェントのタブには中継自身の参照(`watch`、`ExtensionLink.watched`)を 1 つ足す。adopt で付け、unadopt・タブの削除・ブラウザ側からの detach で外す。
  クライアントの参照が 0 になった(残りが watch だけの)ときは、開いているダイアログを `flushDialogs` で閉じてから detach → attach し直す(`#rewatch`)。
  クライアントが有効にしたドメインを次のクライアントへ持ち越さないため。拡張の再接続時は `registerExtension` が生き残ったエージェントのタブを watch し直す。
  ブラウザ側から detach されたエージェントのタブは、次のクライアントの `attach` で watch し直す
- 参照は数でしか持たないので、「残りが watch だけ(`n === 2 && watched`)」の判定は参照を正しく返すことが前提になる。watch は印(`watched` の値)で
  自分の参照かを見分け、attach の往復中に unadopt → 再 adopt されても古い watch の参照を返す。ページ WS は自分の参照を持っている間だけ close で返す
  (ブラウザ側からの detach で参照が消えた後の遅れた close が、後から繋いだクライアントの参照を減らさないように。close は相手の応答を最大 30 秒待つ)

## 専用ポートが開けないとき

専用ポートは補助的な入口(`/b/<name>` でも同じブラウザを使える)なので、開けなくても拡張の接続は切らない。
中継ポートと同じ番号、または使用中の番号を指定された場合は `link.portError` に理由を残し、`GET /browsers` で報告する。
切断するとブラウザが 1 つも登録されないまま再接続ループになり、`/b/<name>` すら使えなくなるため。

## 拡張の再接続と初期状態

ブラウザ名が未設定の間は接続しない。既定名を持たせると、別プロファイルに同じ拡張を入れたとき同名で互いを蹴り合う
(後勝ちで `4000 replaced by new connection`)。名前は必須項目として扱う。



設定変更は `chrome.storage.onChanged` で検知して繋ぎ直す。古いソケットの `onclose` が新しい接続を巻き込まないよう、
`ws !== sock` のときは無視する(これがないと close → 即 connect → 古い close ハンドラが新ソケットを捨てる、の無限ループになる。E2E-7 が回帰を防ぐ)。

## 複数ブラウザ

拡張 1 つ = ブラウザ(プロファイル)1 つ。名前で識別し、パス `/b/<name>` か専用ポートで選ぶ。
puppeteer の `browserURL` と chrome-devtools-mcp の `--browserUrl` は `new URL('/json/version', browserURL)` でパスを
捨てるため専用ポートが必要。Playwright は相対解決(`json/version/`)なのでパス方式で足りる。

## 自動処理(`relay/autopilot.mjs`)

目的は「外出先のエージェントが承認・ダイアログ待ちで止まらない」こと。全自動承認ではなく、クライアントが処理しなかったものだけを
タイムアウト後にポリシーの既定動作で片付け、`/events` と中継ログに記録する。

- **対象(`scope`)**: クライアントは全タブに attach するので attach 中かどうかでは判定しない。中継が名前ごとに「エージェントのタブ」
  (`agentTabs`: tabId → targetId)を持つ。登録は `Target.createTarget` / `Target.attachToTarget` / タブ WS / `POST …/adopt` /
  エージェントのタブを opener とするタブ(URL が確定した時点で、新規タブページ・空・about:blank でなければ)。
  `Target.createTarget {url}` は about:blank で作って adopt し、attach(autoAttach 中は `Page.enable` まで)を済ませてから `ext.navigateTab` で遷移する
  (url 付きで作ると adopt より先に読み込みが始まり、直後のダイアログや 401 を取りこぼす。E2E-10 で url 付き作成に戻すと失敗することを確認)。
  `DELETE …/adopt` と `ext.tabRemoved` で消え、拡張の再接続時に targetId が一致しないものは忘れる(ブラウザ再起動対策)。
  `autopilot.inScope(tabId)` = `scope === 'allTabs' || agentTabs.has(tabId)`。対象外のタブにはダイアログ・ファイル選択・認証・ダウンロードで何もしない
- **attach 時の準備**: `ExtensionLink.attach` の実 attach 直後に `Page.enable` を送り、その応答で「固まっていないか」を見る(probe)。対象のタブには
  `fileChooser: "intercept"` なら `Page.setInterceptFileChooserDialog` も送る(後から adopt されたら、そのとき送る)。完了は待たない
  (同じ chrome.debugger セッションで後続のクライアントコマンドより先に処理される)
- **ダイアログ**: `javascriptDialogOpening` でタイマー、`javascriptDialogClosed` で解除。発火したら `dialogs[type]` で `handleJavaScriptDialog`
  (prompt の accept は `defaultPrompt`)。キーは tabId + 子 sessionId
- **固まったタブ**: 未 attach 中に開いたダイアログは attach し直しても通知されず、`Page.enable` も `Runtime.evaluate` も返らず、
  `handleJavaScriptDialog` は `No dialog is showing`、タブ切り替えでも閉じない。閉じるのは遷移だけ(EXPERIMENT_LOG §19)。
  probe が `unresponsiveTimeoutMs` 内に返らなければ、対象のタブは `unresponsiveTab` に従い同じ URL へ `Page.navigate`(GET で遷移し直すので POST の再送はしない)。
  対象外のタブは `stuck` に入れて触らない。facade は対象外タブの attach で probe を待ち(`setAutoAttach` / `syncTabs` は全タブ並列なので、
  固まったタブが何個あっても待ちは `unresponsiveTimeoutMs` 1 回分)、固まっていれば detach して**クライアントに見せない**
  (`Target.attachedToTarget` を出さず、discover 中なら `Target.targetDestroyed`、`getTargets` からも除く)。見せると puppeteer の `pages()`
  (全ページの `Page.enable` を待つ)と Playwright の `connectOverCDP`(全ページの初期化を待つ)が止まる。puppeteer の接続待ちは `tab` 型だけが対象なので、
  `page` 型を出さないことで接続は止まらない(`TargetManager.#targetsIdsForInit`)。遷移(`ext.tabUpdated`)・クローズ・adopt で `stuck` から外れる
- **クライアントコマンドの前処理**(`ExtensionLink.clientCdp`): 対象のタブのトップレベルの `Page.disable`、intercept 時の `setInterceptFileChooserDialog {enabled:false}`
  は送らず `{}`
- **Basic 認証**: 対象外のタブ → `{}`(ブラウザ既定)。対象のタブで資格情報を渡すのは、トークン設定済み・features を申告した拡張・attach 中・
  (`main_frame` か `initiator` が同一オリジン。`sub_frame` も initiator で判定)・同じ requestId に未送信、のすべてを満たすときだけ。それ以外は cancel。
  「本物の拡張」を保証するのはトークンだけ(Origin と features はローカルプロセスなら偽装できる)。
  Chrome 152 ではクライアントが Fetch で認証を処理するとき `webRequest.onAuthRequired` は発火しない(実測)ので、Fetch の追跡はしない
- **ダウンロード**: 設定は facade クライアントごと(`dlClients`)。ブラウザとしての動作は最後に設定したクライアントのもの(deny なら cancel)、
  イベントは `eventsEnabled` の全員、ファイルは `allow` / `allowAndName` の各クライアントへ(最後の 1 つは移動、他はコピー。ブラウザとしての動作が default なら元を残す)。
  対象のタブの `Page.downloadWillBegin`(guid, frameId)と `onCreated` で作られた `in_progress` の item を、間が `DOWNLOAD_MATCH_MS` 以内なら URL で対応付ける
  (どちらが先でもよい。先に来た item は `created` に短時間だけ置き、完了・中断したら外す)。対応済み(`matched`)は使わない。完了は chrome.downloads の complete を待ち、移してから `Browser.downloadProgress {state:'completed', filePath}` を
  送る(Playwright は completed 受信時点で `downloadPath/<guid>` を読むため、対応付いたものの Page 由来の completed は捨てる)。配置の結果はクライアントごと
  (置けたら completed + filePath、失敗したら canceled)。対応付かないまま完了したものは、保存先を期待するクライアントに canceled(ファイルは downloadPath に無い)。
  同名は `name (n).ext`(同一ボリュームは hard link + unlink、別ボリュームは `COPYFILE_EXCL` でコピー)で上書きしない。
  危険判定(`safe` / `accepted` / `allowlistedByPolicy` / `deepScannedSafe` 以外。`asyncScanning` 系は待つ)は記録し、`dialogTimeoutMs` 後も未承認なら cancel して canceled を送る
- **権限**: クライアントごとに設定を覚え、reset / 切断時は該当する型を clear してから「ポリシー → 残りのクライアント」の順に再適用する(後勝ち)。
  操作は `csQueue` で直列化し、grant は送信前に `grants` へ登録する(往復中の grant と別クライアントの切断による再適用が入れ違わないように)。
  再適用の内容はキューで実行する時点の状態から作る。拡張の接続時と `policy.json` の `permissions` 変更時(`watchFile` 1 秒)は対象の型
  (CDP の 5 型 + 今と直前のポリシーの型)をすべて clear してからポリシーを適用する。ポリシーのキーは読み込み時に検証済みなので、後始末の clear は必ず送れる。
  拡張側も set / 切断時の clear / 起動時の clear を 1 本の Promise チェーンで直列化する。
  拡張が切断済みなら中継からは送らない(拡張が自分で消している)
- **堅牢性**: 拡張からのイベントはリスナーごとに try/catch(非同期は `.catch`)で包み、不正な内容で中継を落とさない。ポリシーは項目ごとに検証し、
  不正な項目は直前の値のまま警告する。切断後の `link.call` は即座に reject してタイマーを残さない
- **旧拡張**: `ext.info.features` に無い機能は `requireFeature` がエラーにする。ログは接続時に 1 回
