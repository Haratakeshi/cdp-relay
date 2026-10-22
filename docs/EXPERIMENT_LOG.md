# 実験ログ

環境: macOS(Darwin 25.6.0)、Google Chrome 152.0.7977.83、Microsoft Edge 152.0.4191.66、Node 22.18.0、pnpm 10.12.4、
puppeteer-core 25.10.0、playwright-core 1.63.0、ws 8.21.3。日付は 2026-09-11。

## 0. 前提の検証: 「そのまま CDP を繋ぐとポップアップで進行不能」の正体

観測(ユーザーの実ブラウザに対する読み取り専用の疎通のみ):

| 項目 | Chrome | Edge |
|---|---|---|
| プロセス引数 | `--remote-debugging-port` なし | 同左 |
| `Local State` | `"remote_debugging":{"user-enabled":true}` | 同左 |
| `DevToolsActivePort` | あり(9222) | あり(61495) |
| `GET /json/version` | 404 | 404 |
| `/devtools/browser/<uuid>` へ WS Upgrade | 1回目 2.7 秒後に 101、2回目 204 秒後に 101、3回目 0.9 秒後に 101 | 即 403 `Connection rejected` |

一次情報(Chromium `content/browser/devtools/devtools_http_handler.cc`、`chrome/browser/devtools/remote_debugging_server.cc`、
Chrome 公式ブログ)との突き合わせ:

- [事実] Chrome 136 以降、`--remote-debugging-port` / `--remote-debugging-pipe` は既定の user-data-dir では無視される
- [事実] Chrome 144 以降、`chrome://inspect/#remote-debugging` のトグルで起動するリモートデバッグサーバーは「承認モード」で、
  `/json/*` は常に 404、`/devtools/browser/…` への接続は `DevToolsConnectionDialog`(ユーザー同意ダイアログ)を経由し、
  拒否・未応答なら `403 Connection rejected` を返す
- [推測](確信度 85%) 上の観測はこの承認モードそのもの。Chrome の 204 秒待ちは、この Mac を操作中だったユーザーがダイアログを
  承認するまで接続が保留されていたと解釈できる(誰が承認したかは未確認)。Edge の即時 403 は、同じ Chromium 実装で
  ダイアログが拒否済み/表示できない状態と整合する。§15 の追試で、同じ Edge が後に `101` を返すことを確認した
  (承認はブラウザセッション中保持されると見られる)
- 以前使っていた DevTools 直結方式のツールは 2026-09-07 まで接続できており、2026-09-10 から `403` になっている。
  Edge の自動更新で承認モードに切り替わったという説明と時系列が一致する

結論: ユーザーの言う「ポップアップモーダル」は Chrome/Edge 144+ の承認ダイアログで、接続ごとに人の承認が要る。
無人運用には拡張機能経由(`chrome.debugger`)が必要という前提は妥当。

## 1. 拡張のロード方法(自動テストのため)

- [事実] Chrome 152 のバイナリに文字列 `--load-extension is not allowed in Google Chrome` がある。`--load-extension` は使えない
- [事実] `puppeteer-core` の `enableExtensions: true` + `browser.installExtension(dir)`(= `--remote-debugging-pipe` + CDP `Extensions.loadUnpacked`)で
  Chrome 152 ブランド版・Edge 152 の両方に未パック拡張を読み込めた(`test/debug-launch.mjs`、`test/harness.mjs`)。
  Chrome の起動フラグに `--enable-unsafe-extension-debugging` は不要だった(バイナリにその文字列は存在しない)

## 2. E2E-1 タブ WS 素通し(`test/e2e-page.mjs`)PASS

- 拡張が中継に登録 → `/json/version` → `/json/list` → タブ WS → `Page.enable` / `Page.navigate` / `Page.loadEventFired` 受信(約 110 ms)
  / `Runtime.evaluate` / `Page.captureScreenshot` / エラー伝播 / 切断で detach
- [事実] `chrome.debugger.getTargets()` の `id` は、そのタブに attach して取った `Target.getTargetInfo().targetId` と一致する
- [事実] `Target.getTargets` を chrome.debugger 経由で送ると `{"code":-32000,"message":"Not allowed"}`(調査どおり auto-attach 限定)
- [事実] `Page.navigate` で `data:` URL に遷移すると `net::ERR_ABORTED`(`Page.frameStartedNavigating` → `frameStoppedLoading` のみ)。
  同じタブに puppeteer の直結セッションから `goto('data:…')` すると成功する。`http://127.0.0.1` と `about:blank` は拡張経由でも成功
  (`test/debug-nav.mjs`)

## 3. E2E-2 puppeteer-core `connect({browserURL})`(`test/e2e-puppeteer.mjs`)PASS(Chrome / Edge)

`browser.pages()`、`newPage()`(→ `chrome.tabs.create`)、`goto`、`title`、`$eval`、`screenshot`、`type`/`click`(Input ドメイン)、
`page.close()`(→ `chrome.tabs.remove`)、`disconnect()` で全タブ detach。

途中で見つけて直した不具合:
- `Target.setAutoAttach` 到達時に既知タブへ attach していなかった(`setDiscoverTargets` が先に来ると `pages()` が 0 件)
- タブ WS で attach 完了前に届いたコマンドを取りこぼしていた(`Page.enable` が永遠に返らない)

## 4. E2E-3 Playwright `connectOverCDP`(`test/e2e-playwright.mjs`)PASS(Chrome / Edge)

Playwright 固有に必要だった合成:
- `Target.attachedToTarget` の `targetInfo.browserContextId` が必須(assert で落ちる)
- connect 直後に引数なしの `Target.getTargetInfo` を送り、ブラウザ自身の情報を期待する
- `Target.createTarget` の応答より前に `Target.attachedToTarget` が届いている必要がある(`newPage` が `_page` を即参照する)
- **targetId は Chrome 本来の id でなければならない**。合成 id(`tab-<n>`)だと `_sessionForFrame` が
  `Frame has been detached.` を投げる(メインフレーム id == targetId を前提に `_sessions` を引くため)
- [事実] chrome.debugger 経由ではコマンド応答よりイベントが先に届くことがある(`Page.setLifecycleEventsEnabled` 由来の
  `Page.lifecycleEvent` が `Page.enable` の応答より前に到着)。Playwright の初期化はこの順序でも成功した

## 5. E2E-4 複数ブラウザ同時操作(`test/e2e-multi.mjs`)PASS

- 別プロファイルの Chrome 2 つ(`company-a`=9341、`company-b`=9342)を 1 つの中継に登録し、puppeteer から同時に別ページへ遷移
- タブ一覧はブラウザごとに分離される
- [事実] puppeteer の `browserURL` は `new URL('/json/version', browserURL)` でパスを捨てるため、`/b/<name>` では選べない
  → 拡張が申告する専用ポートを中継が開く方式にした。2 つ以上接続中にルートの `/json/version` を叩くと 404 で名前の指定を促す

## 6. E2E-5 Service Worker 寿命(`test/e2e-lifetime.mjs`)PASS

- 未 attach で 75 秒放置しても同じ WS 接続が維持された(中継の 20 秒 ping)
- ping を止めた中継に繋ぎ直して 100 秒無通信でも SW は `running` のままで接続維持。拡張側の 30 秒周期 `chrome.alarms` が
  イベント発火でアイドルタイマーをリセットしていると解釈(未パック拡張。ストア配布版でも最小周期は 30 秒)
- 中継を停止した場合も再接続試行が同様にタイマーをリセットし、SW は終了しなかった
- [未解決] `ServiceWorker.stopWorker` で SW を強制停止すると、30 秒後の alarm で `starting` になったまま `running` に戻らず、
  タブ作成イベントでも起きなかった(`test/debug-sw.mjs`)。DevTools 経由の停止固有の挙動か、Chrome が自然に終了させた場合も同じかは未確認。
  実ブラウザで `chrome://serviceworker-internals` から停止して確認する必要がある

## 7. インフォバー観察(`test/exp-infobar.mjs`、`tmp/infobar-*.png`)

- 通常起動(`--enable-automation` を外した状態): attach 中、ウィンドウ上部に
  「『CDP Relay Bridge』がこのブラウザのデバッグを開始しました [キャンセル] ×」の非モーダルバー。ページ操作は続行可能
- `--silent-debugger-extension-api` 付き: バーなし
- puppeteer 既定の `--enable-automation` 付きでは「Chrome は自動テスト ソフトウェアによって制御されています」のバーだけが見え、
  デバッグ開始のバーは表示されなかった(理由は未確認)
- キャプチャ方法: 当初 `screencapture -x` で全画面を撮っていたが、ユーザーの実ブラウザの内容が画像に入ってしまった(削除済み)。
  現在は CDP の `Browser.getWindowForTarget` / `Browser.getWindowBounds` で起動した窓の位置を取り、その領域だけを撮る。
  `--window-position` は実際には反映されず窓は (22,52) に出たので、固定領域の指定では対象を外す

## 8. レビュー指摘と修正(独立レビュアーによる反証レビュー)

実装の文脈を渡さない別エージェントに成果物と受入基準だけを渡してレビューさせ、次の欠陥が確認された(いずれも修正済み、回帰テスト付き)。

| 指摘 | 内容 | 修正 |
|---|---|---|
| 1(ブロッカー) | 接続中にオプションを保存すると再接続ループ。`ws.onclose` が無条件に `ws = null` にするため、close → 即 connect で生まれた新ソケットを古い close ハンドラが捨て、毎秒数回の connect/disconnect が続いて回復しない | `onclose` で `ws !== sock` なら無視。設定変更時は先に `ws` を差し替える。E2E-7 で回帰検出 |
| 2 | `ext.attach` 失敗時も参照カウントを増やしていたため、`chrome://` 等の attach 不可タブに触ると以後そのタブが恒久的に使用不能(attach 済みに見えて実際は未 attach) | 失敗した attach は数えない。同時 attach は in-flight Promise を共有。E2E-6 で回帰検出 |
| 3 | 共有中のタブに二重 `Target.detachFromTarget` を送ると他クライアントの attach まで落ちる(カウント下限がない) | カウント 0 の detach は無視。facade 側も未 attach なら `link.detach` を呼ばない。E2E-6 で回帰検出 |
| 4 | クライアント側は無認証(`CDP_RELAY_TOKEN` は拡張の接続のみ検証)で、中継に到達できる任意のローカルプロセスがブラウザを完全操作できる。README に記載がなく、`CDP_RELAY_HOST` の案内が「127.0.0.1 のみ bind」の記述と矛盾 | README の制約節に明記し、`CDP_RELAY_HOST` を変更しないよう案内 |

レビュー中に発覚した別件: `/json/list` の `id` を実 targetId にする編集が適用漏れで失われており、`id` がタブ ID のままだった。
このため facade の `Target.attachToTarget` に `/json/list` の id を渡すと `No target with given id found` になる。修正して E2E-1 と E2E-6 で検証している。

## 9. 実機セットアップで出た問題(ユーザーの Chrome、2026-09-11)

ユーザーが自分の Chrome に拡張を読み込んだところ、`ERR_CONNECTION_REFUSED` と `closed 1006` の繰り返しになった。
設定は中継 URL `ws://127.0.0.1:53333/extension`、専用ポート `53333`、トークンなし。

- [事実] 実機を確認したところ 53333 でも 9333 でも LISTEN しておらず、`relay/server.mjs` のプロセスも無かった。
  中継サーバーが起動していないだけで、再接続の繰り返し自体は設計どおりの挙動
- [事実] 中継ポートと専用ポートが同じ 53333 なので、中継を起動しても専用ポートの `listen` が `EADDRINUSE` で失敗する。
  修正前はこのとき拡張の接続を `4002` で切っていたため、起動しても connect/disconnect のループになる(再現済み)
- 修正: 専用ポートが開けない場合は接続を維持し、`link.portError` に理由を残して `GET /browsers` で報告する。
  中継ポートと同じ番号は `listen` を試みずに弾く。E2E-8(`test/e2e-relay.mjs`)で回帰を検出する
- 修正: 拡張の status に直近の切断理由(`lastClose`)を含め、オプション画面から診断できるようにした
- [事実] 53333 は macOS の一時ポート範囲(`net.inet.ip.portrange.first` = 49152 以上)に入るため、他プロセスに先取りされうる。
  README で 49152 未満を選ぶよう案内した

## 10. 実機接続の確認(ユーザーの Chrome `chrome-personal`、2026-09-11)

ユーザーが自分の Chrome(ログイン済みプロファイル)に拡張を読み込み、中継 9333 / 専用ポート 9341 で接続した状態で確認した。
既存タブには attach せず、`Target.createTarget` で作った自分用タブだけを操作して閉じている。

| 確認項目 | 結果 |
|---|---|
| `/b/chrome-personal/json/version` | `Chrome/152.0.0.0`(実 UA を返す) |
| 専用ポート `http://127.0.0.1:9341/json/version` | 同上。`browserURL` 形式のクライアントから使える |
| `/json/list` | 実タブ 3 件を列挙。attach 済み 0 件(列挙だけでは attach しない) |
| `Target.createTarget` → `attachToTarget` | 新規タブ 1 つだけに attach。`targetId` は Chrome 本来の id |
| `Page.navigate` → `Page.loadEventFired` → `Runtime.evaluate` | `https://example.com/` で `title` と `h1` を取得 |
| `Page.captureScreenshot` | 18KB の PNG。実描画を確認 |
| `Network.getCookies` | ログイン済みプロファイルの cookie を参照できる(google.com 22 件、mail.google.com 27 件、github.com 3 件。値は記録しない) |
| `Target.closeTarget` 後 | `attachedTabs` が空に戻る。孤児 attach なし |

[事実] 実プロファイルの cookie が読めたので、外出先からログイン済みセッションを操作するという当初の目的は、この経路で達成できる。

## 11. 複数ブラウザ・複数プロファイルの扱い(2026-09-11)

- [事実] Chrome と Edge を 1 つの中継(1 ポート)に同時登録し、それぞれの専用ポートから別ブラウザとして操作できた。
  `json/version` は `Chrome/152.0.0.0` と `Edg/152.0.0.0` を返し分け、タブ一覧も分離されている(E2E-9 `test/e2e-mixed.mjs`)
- [事実] 専用ポートは重複できない。同じ番号を 2 つのブラウザに割り当てると 2 つ目が `EADDRINUSE` になる(E2E-8)
- [事実] 中継ポートは全ブラウザで共有する。拡張は名前で区別され、同名で繋ぐと後勝ちで前の接続が `4000` で切られる
- [事実] 実機で確認した(ユーザーが 4 ブラウザに拡張を導入した状態、2026-09-11)。Chrome 2 プロファイルと Edge 2 プロファイルが
  1 つの常駐中継に同時登録され、専用ポートもそれぞれ別番号で応答した。タブは合計 14 件で、同じ targetId が 2 つ以上のブラウザに
  現れることはない = プロファイルごとに完全に分離されている

  | 名前 | 専用ポート | `json/version` | タブ数 |
  |---|---|---|---|
  | chrome-personal | 9341 | Chrome/152 | 3 |
  | chrome-company-a | 9342 | Chrome/152 | 1 |
  | edge-company-b | 9351 | Edg/152 | 7 |
  | edge-company-c | 9352 | Edg/152 | 3 |

- 自動テストでは同一プロセス内の別プロファイルを再現できなかった。macOS でバイナリを直接起動したインスタンスに対し、
  2 回目の起動(`--profile-directory` 指定)が ProcessSingleton の受け渡しに失敗して中断する
  (`Failed to create SingletonLock: File exists` → `Aborting now to avoid profile corruption`)。
  Singleton の symlink 自体は正しく作られているので、LaunchServices を経由しない直接起動固有の挙動と見られる
- [事実] 外付けボリューム(`/Volumes/...`)に user-data-dir を置くと `SingletonLock` の symlink を作れない。
  テスト用プロファイルはローカルディスクに置く

## 12. 常駐化(2026-09-11)

- `scripts/daemon.mjs` で LaunchAgent を導入(現在のラベルは `io.github.haratakeshi.cdp-relay`)。`RunAtLoad` + `KeepAlive`、ログは `~/Library/Logs/cdp-relay.log`
- [事実] `kill -9` で落としても 1 秒で再起動し、拡張はバックオフ再接続で自動的に復帰した(`connectedAt` が更新される)
- [事実] node は `/opt/homebrew/bin/node`(24.1.0)で動作。LaunchAgent は PATH を引き継がないので絶対パスで書く。
  nvm 配下(`~/.nvm/versions/node/v22.18.0/bin/node`)はバージョン更新で消えるため選ばない
- テストのポートは 94xx 帯へ隔離し、常駐中継(9333)と実運用の専用ポートに当たらないようにした

## 13. 既定のブラウザ名を廃止(2026-09-11)

常駐中継のログに、テスト用ブラウザが既定名 `chrome` で一瞬接続した記録が残った。拡張は設定注入前に既定設定で 9333 へ繋ぎに行くため。
実運用の中継に別のブラウザが同名で割り込むと、既存の接続が `4000 replaced by new connection` で切られる。
既定名を廃止し、ブラウザ名が未設定の拡張は接続しないようにした(E2E-7 で検証)。修正後の全テスト実行では常駐中継への混入は無い。

## 14. テストのヘッドレス化(2026-09-11)

画面つき起動ではテストのたびにウィンドウが前面を奪い、ユーザーの作業が中断する。既定をヘッドレスに変更した。

- [事実] 新ヘッドレス(`--headless=new`)でも `Extensions.loadUnpacked` で未パック拡張を読み込め、Service Worker も起動する
- [事実] E2E-1〜9 のすべてがヘッドレスで PASS。Chrome・Edge とも同じ。所要時間は約 3 分から **28 秒**に短縮
- [事実] E2E-5(SW 寿命)もヘッドレスで PASS。アイドル延命と alarms の挙動は画面の有無で変わらない
- `HEADED=1` で画面つきに戻せる(実測で PASS)。`test/exp-infobar.mjs` はブラウザ UI を撮る実験なので常に画面つき

## 15. 承認モードの追試(2026-09-11 夕)

セッション終盤に Edge の `DevToolsActivePort` へ再度 WebSocket で接続したところ、**`101` で受け入れられた**(朝は即 `403 Connection rejected`)。
`/json/version` は依然 404。

- [推測](確信度 80%) 承認はブラウザセッション単位で保持される。朝の 403 は当時ダイアログが拒否/無応答だった状態、
  Chrome で観測した「1 回目 204 秒待ち → 2 回目 0.9 秒」も、待っている間に承認が行われたと解釈すると整合する
- 結論は変わらない。**無人実行では人の承認を待てないので直結は使えない**。`/json/*` が 404 のままなので
  `browserURL` / `--browserUrl` 形式のクライアントは承認後も動かない
- §0 の「403 になる」という記述は「承認されるまで保留され、拒否・無応答なら 403」に改めた

## 16. スキル化(2026-09-11)

- `cli.mjs` を追加。`browsers` / `pages` / `goto` / `text` / `shot` / `run` / `close`。`run` は従来の puppeteer スクリプトと同じ
  `async (browser, page, puppeteer, args) => result` 形式なので既存スクリプトを流用できる
- `--tab` 省略時はそのブラウザで直近に操作したタブ(`tmp/last-tab.json`)。`goto` だけは省略時に新規タブを開く
- [事実] `browsers` / `pages` は attach しない。それ以外のコマンドは実行中だけ**そのブラウザの全タブ**に attach する
  (実測: 実行中 attached=4、終了後 0)。他のブラウザには影響しない
- スキルを Claude Code と Antigravity の両方に設置(のちにプラグインへ一本化。docs/PLUGIN.md)
- [注意] リポジトリを外付けボリュームに置くと、未マウントの間は LaunchAgent も CLI も動かない

## 17. 実行状況(2026-09-11 最終)

| テスト | Chrome 152 | Edge 152 |
|---|---|---|
| E2E-1 タブ WS 素通し | PASS | PASS |
| E2E-2 puppeteer-core | PASS | PASS |
| E2E-3 Playwright | PASS | PASS |
| E2E-4 複数ブラウザ | PASS | 未実行 |
| E2E-5 SW 寿命 | PASS | 未実行 |
| E2E-6 参照カウント | PASS | PASS |
| E2E-7 再接続 | PASS | 未実行 |
| E2E-8 中継単体(専用ポート/トークン) | PASS(ブラウザ非依存) | 同左 |
| E2E-9 Chrome + Edge 同時 | PASS(両方を同時に起動して検証) | 同左 |

すべて既定のヘッドレスで実行した結果。`HEADED=1` でも E2E-1 の PASS を確認している。

## 18. 未検証事項(次の実験)

1. Edge の実プロファイルでの動作(Chrome は §10 で確認済み)。インフォバーを常時出したまま使う運用に耐えるかの判断も含む
2. chrome-devtools-mcp(`--browserUrl`)と Playwright MCP(`--cdp-endpoint`)からの実接続
3. 4 ブラウザを同時に操作したときの負荷と安定性(登録は確認済み。同時 attach 下での長時間運用は未検証)
4. iframe / worker(flatten 子セッション)を含むページでの動作。合成は実装済みだがテスト未整備
5. SW 強制停止からの復帰(§6)
6. クライアント側の認証(現状は無認証。トンネル前提の運用でよいかの判断を含む)

## 19. 未 attach 中に開いたダイアログへ後から attach する(`test/exp-dialog-reattach.mjs`、2026-09-27)

CLI はコマンドごとに attach し直すので、attach していない間に出た alert を拾えるかを確かめた。一時プロファイル Chrome 152、新ヘッドレス。
手順: タブ WS で `/late`(1.5 秒後に alert)へ遷移 → すぐ切断(detach)→ 3 秒待つ → 別の WS で attach し直す。

- [事実] attach し直して `Page.enable` を送っても `Page.javascriptDialogOpening` は届かない。**`Page.enable` 自体が応答しない**(3 秒でタイムアウト)
- [事実] `Runtime.evaluate` も応答しない。`Page.handleJavaScriptDialog` は即座に `No dialog is showing`(-32602)
- [事実] 別タブをアクティブにして戻しても閉じない(ヘッドレス)
- [事実] `Page.navigate` は 16ms で応答し、`Page.javascriptDialogClosed` が届いてダイアログが閉じ、以後の `Runtime.evaluate` は通常どおり返る
- [推測](確信度 75%) Chromium の PageHandler は「有効な間に開いたダイアログ」だけを保持しており、後から有効にしたハンドラには渡されない。
  画面つき(実ブラウザ)でもネイティブのダイアログが残るだけで同じと見ているが、画面つきでは未確認
- 対応: attach 直後の `Page.enable` が `unresponsiveTimeoutMs` 内に返らなければ、エージェントのタブはポリシー `unresponsiveTab: "renavigate"` で同じ URL へ遷移し直す
  (ユーザーのタブはクライアントから隠すだけ。§25)。E2E-10 で「固まったタブに attach したクライアントの `Runtime.evaluate` が約 1.5 秒(= テストの値)後に返る」ことを確認

## 20. 拡張 0.2.0 が流す事実の順序(`test/exp-extension-events.mjs`、スタブの中継で観察、2026-09-27)

- [事実] `Page.downloadWillBegin`(`frameId` / `guid` / `suggestedFilename` 付き)は chrome.debugger 経由で届く(中継が `Page.enable` 済みのタブ)。
  `Page.downloadProgress` も同じ guid で届く。同じダウンロードの `chrome.downloads.onCreated` はその直後(同じ ms)。完了は `Page.downloadProgress completed` の数 ms 後に
  `chrome.downloads.onChanged`(state complete)。chrome.downloads の item に guid は無いので URL で対応付ける
- [事実] プロファイルの `Default/Preferences` に `download.default_directory` を書いておくと、テストのダウンロードが `~/Downloads` に入らない
- [事実] **クライアントが `Fetch.enable({handleAuthRequests:true})` しているとき、`webRequest.onAuthRequired` は発火しない**。`Fetch.authRequired` だけが届き、
  `continueWithAuth` で通る。Fetch なしでは `onAuthRequired` が届き、`{cancel:true}` で 401 のページが表示されて読み込みが完了する
- [事実] `chrome.contentSettings.location/camera` をポート付きパターン `http://127.0.0.1:<port>/*` で allow にすると、`navigator.permissions.query` が即座に granted、
  `clear` で prompt に戻る
- [事実] `contentSettingTypes`(Chrome 152): automaticDownloads, autoVerify, camera, clipboard, cookies, fullscreen, images, javascript, location, microphone,
  mouselock, notifications, plugins, popups, sound, unsandboxedPlugins

## 21. contentSettings のパターン(2026-09-27)

- [事実] `<all_urls>` と `*://*/*` は「既定値」扱いで、camera / microphone に allow を設定すると `'allow' is not supported as the default setting of camera.`。
  block は通る。location / notifications / clipboard は allow も通る
- [事実] `http://*/*` と `https://*/*` はどの型でも allow / block が通る → origin なしの grant はこの 2 パターンにした
- [事実] `ws://` / `ftp://` / `chrome-extension://` / `blob:` のパターンは `Invalid scheme.`。`http://[::1]:8080/*` は通る
- [事実] Playwright は `grantPermissions` の `origin` を `new URL(origin).origin` に正規化して送るので、`chrome://settings` は `"null"` になって届く

## 22. 拡張の再読み込み(`chrome.runtime.reload`、2026-09-27)

- [事実] 開発者モードが OFF のプロファイル(CDP の `Extensions.loadUnpacked` で読み込んだ一時プロファイル)で `chrome.runtime.reload()` すると、
  拡張は `DISABLED`(`disableReasons.unsupportedDeveloperExtension: true`)になり再接続しない
- [事実] `chrome://extensions` で `chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})` の後なら、再読み込みして再接続する
  (E2E-7。再接続まで 0.5〜6 秒)。`Default/Preferences` に `extensions.ui.developer_mode: true` を書いても効かなかった
- [推測](確信度 85%) 実ブラウザでは未パック拡張の読み込みに開発者モードを ON にしているので再読み込みできる。OFF にすると無効化され、外出先からは戻せない

## 23. ダウンロードの危険判定と複数ダウンロード(2026-09-27)

- [事実] 一時プロファイルで `.pkg` / `.exe` / `.command` / `.jar` を 127.0.0.1 から(クリックで)ダウンロードすると、いずれも `danger: "safe"` で完了した。
  危険判定を再現できず、`download.dangerous` の記録は未検証
- [事実] 続けてユーザー操作なし(`location.href`)で 5 件目をダウンロードすると、`chrome.downloads` に現れなかった
- [推測](確信度 70%) 「複数ファイルのダウンロード」の許可待ちで保留されている。`permissions` に `automaticDownloads: "allow"` を入れれば避けられる見込み(未検証)

## 24. 自動処理の E2E(E2E-10〜12、2026-09-27)

- E2E-10 `e2e-dialogs`: puppeteer で `page.on('dialog')` なしの confirm / prompt / alert が dialogTimeoutMs(テストでは 1500ms)後にポリシーどおり閉じる。
  自分で処理した prompt(15ms)には中継は手を出さない。beforeunload を accept して遷移が完了。Playwright はリスナーなしなら自分で即 dismiss(約 20ms、中継は何もしない)、
  何もしないリスナーだけなら中継が閉じる。ポリシーファイルを消すと既定値(8 秒・confirm は dismiss)に戻る。Basic 認証は資格情報あり 200 / なし 401 / 拒否されたら
  再送せず 401 / puppeteer の `page.authenticate`(Fetch)が優先。クライアントの `Page.disable` 後もダイアログを閉じる
  (このガードを外すと失敗することを確認済み)
- E2E-11 `e2e-downloads`: Playwright の `download.path()` が `downloadPath/<guid>` を返し中身が一致、`saveAs` 可。ブラウザのダウンロードフォルダには残らない。
  puppeteer の allow で `downloadPath/<元の名前>`、deny で保存されない。切断後のダウンロードはブラウザ既定のフォルダに入り中継は記録しない。
  `acceptInsecureCerts` は接続時にエラー
- E2E-12 `e2e-permissions`: ポリシーの notifications が接続時に granted。Playwright `grantPermissions(['geolocation'])` → granted、`['camera','midi']` はエラーで camera も未適用、
  `clearPermissions` で prompt に戻りポリシー分は残る。puppeteer の `overridePermissions` / `setPermission(denied)`。puppeteer を reset せずに切断すると
  その分だけ消え、Playwright の grant とポリシーは残る。全クライアント切断で接続時の状態に戻る
- 実行状況(2026-09-27): `pnpm test:e2e`(E2E-1〜4, 6〜12)全体が exit 0、約 85 秒。Chrome 152 ヘッドレス。E2E-10〜12 は Edge では未実行
  (E2E-9 で Edge 152 が新しい中継・拡張 0.2.0 で従来機能どおり動くことは確認)

## 25. 独立レビュー 2 本を受けた修正と、その過程の実測(2026-09-27)

レビュー(実装の文脈なしの panel-refuter 2 本)の指摘を一次情報で確認した再現スクリプト(偽の拡張で中継を動かすもの)で、修正前後を比べた。

| 指摘 | 修正前(再現) | 修正後 |
|---|---|---|
| 自動処理がユーザーのタブにも及ぶ(クライアントは全タブに attach する) | 設計上の欠陥 | `scope: agentTabs` を既定にし、エージェントのタブだけを処理(E2E-10 / 11 で確認) |
| 偽の拡張が資格情報を引き出せる | Origin なし・トークンなしの偽拡張に `policy.auth` の資格情報を返した | `/extension` は `chrome-extension://` の Origin のみ、資格情報はトークン設定時・本物の拡張・attach 中のエージェントのタブ・遷移か同一オリジンのときだけ(E2E-13) |
| Origin 付き POST で `/reload-extension` | ブラウザ名なし・Origin 付きで通った | Origin 付きは 403、`/b/<name>` 必須 |
| ダウンロード設定が最後のクライアントに上書きされ、別クライアントの切断で全部消える | A が allow のまま B の切断後に A へイベントもファイルも届かない | クライアントごとに保持(偽拡張で A に届くことを確認、E2E-11 で Playwright 2 つ) |
| 移動先の同名ファイルを上書き | 既存の `report.txt` が置き換わった | `report (1).txt`(E2E-11 で `pptr (1).txt`) |
| 同じ URL の 2 回目のダウンロードで、1 回目の item を取り違える / ユーザーの同じ URL の item を取り違える | `sim.mjs` / `sim2.mjs` で誤対応 | `downloadWillBegin` の後に作られた `in_progress` の item だけを対応付け、対応済みは使わない(sim で g1=item1, g2=item2 / ユーザーの item7 ではなく item8) |
| contentSettings の grant 往復中に別クライアントが切断すると、成功と返した grant が消える | `race.mjs` で最終状態が空 | 直列キュー + 送信前に登録。最終状態に B の grant が残る |
| 不正なポリシー / イベントで中継が落ちる | `crash.mjs` で中継プロセスが終了 | 全ケースで生存(E2E-13) |

実測で分かったこと:

- [事実] **`chrome.contentSettings.<type>.clear()` は Chrome 152 の MV3 Service Worker で Promise を返さない(`undefined`)**。`set()` は Promise を返す。
  修正前の拡張は `await clear()` のつもりで待っておらず、clear と直後の set の順序が保証されていなかった(それまでの E2E は偶然通っていた)。
  `.catch` を付けたことで例外になって発覚した。callback 形式で待つようにした
- [事実] Chrome 152・Edge 152 とも、拡張の Service Worker の `WebSocket` は `Origin: chrome-extension://<id>` を付ける(E2E-9 が Origin 検査つきで通る)
- [事実] Node の `fetch`(undici)と `ws` は Origin を付けない(GET / POST とも)。puppeteer・Playwright・CLI は Origin 検査の影響を受けない
- [事実] ダイアログで固まったユーザーのタブがあるとき(`scope: agentTabs`)、Playwright の `connectOverCDP` は約 1.5 秒(= テストの `unresponsiveTimeoutMs`)で完了し、
  そのタブは `pages()` に現れない。以後の接続は固まったタブを覚えているので待たない(puppeteer の `pages()` 4ms)。タブの URL とダイアログはそのまま
- [事実] 同じ状況で `scope: allTabs` にすると、固まったユーザーのタブ 2 つを遷移し直してダイアログが閉じる
- [事実] ミューテーション確認: 自動処理の対象判定(`#onCdpEvent` の `inScope`)を外すと E2E-11 の「ユーザーのタブのダウンロードに触らない」が失敗する
- 実行状況(2026-09-27、2 回目のレビュー修正後): `pnpm test:e2e`(E2E-1〜4, 6〜13)exit 0・100 秒、`pnpm test:lifetime`(E2E-5)exit 0・179 秒。Chrome 152 ヘッドレス(E2E-9 は Edge 152 も)

## 26. 2 回目の独立レビューを受けた修正(2026-09-27)

再現スクリプト(偽の拡張、scratchpad/r2 の t1〜t6)で修正前後を確認した。t1: ポリシーに `about:blank` キーがあると接続時の適用もクライアント切断の後始末(clear)も
例外で止まっていた → キーを捨てて適用し、clear も送る。t2: ポリシーから消した型(popups)が clear されなかった → clear される。
t3: 3e9 のタイムアウトが `setTimeout` の 1ms 扱いで即時に自動処理・遷移し直しをしていた → 2^31-1 超は不正として既定値。
t4: opener の連鎖でエージェントのタブが増え続け、外す手段が無かった / onCreated が先に届くと completed を filePath なしで送っていた → 解消。t6: 落ちない(修正前から)。

- [事実] `window.open` で開いたタブの `chrome.tabs.onCreated` は `openerTabId` を持つが `url` は空で `pendingUrl` も無い。URL は最初の `onUpdated` で付く
- [事実] `chrome.tabs.create({openerTabId})`(新規タブページ = Ctrl+T 相当)は `onCreated` に `openerTabId` が無く(`pendingUrl: chrome://newtab/`)、`onUpdated` で付く。
  このため opener からの継承は「opener がエージェントのタブ」を onCreated で覚え、URL が確定した時点で新規タブページ・空・about:blank でなければ adopt する
- [事実] Chrome は一度 Basic 認証に通ったオリジンへの以後の要求に、HTTP 認証キャッシュから資格情報を自動で付ける。E2E で同じオリジンに `createTarget` しても
  401 が起きず `onAuthRequired` も来なかった。テストは一度も認証していない別ポートのオリジンを使う
- [事実] ミューテーション確認(確認後に元に戻した):
  - `setAutoAttach` の probe を直列に戻すと、固まったタブ 2 つで接続に 3032ms かかり E2E-10 が失敗する(並列では約 1.5 秒)
  - `Target.createTarget` を url 付きの作成に戻すと、読み込み直後の alert を中継が処理せず E2E-10 が失敗する

## 27. 背面タブ・非表示のタブのダイアログと、クライアント未接続の間のダイアログ(2026-09-27)

当時の引き継ぎメモにあった疑い(「背面タブで alert が開くと Chrome が `javascriptDialogOpening` を出さず止まる」)と、ユーザーの疑い
(「無操作・スリープの間に開いた alert を拡張が検知できない」)を確かめた。実験は `test/exp-background-dialog.mjs`(条件の全組み合わせ。
拡張の `chrome.debugger.onEvent` / 中継のクライアント / レンダラーの 3 層を同時に記録)、成果物は `tmp/artifacts/exp-background-dialog-*`。

- [事実] 背面タブ(`createTarget {background:true}`)、作成後にユーザーが別のタブへ切り替えたタブ、最小化したウィンドウのタブのいずれでも、
  alert は拡張・中継の両方に通知され、中継が閉じた(Chrome 152、ヘッドレス・画面つきの両方)。alert 直前の `visibilityState` はどれも `hidden`。
  **背面タブで止まる疑いは否定**
- [事実] puppeteer の既定の起動引数(`--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、`--disable-background-timer-throttling` 等)が
  あると、タブ切替・最小化でも `visibilityState` が `visible` のままになる。それまでの E2E は見えないタブを一度も試していなかった。`ignoreDefaultArgs` で外すと
  ヘッドレスでも `hidden` になる
- [事実] 別ウィンドウを同じ位置・大きさで重ねても(被覆)`visible` のままだった(この方法では macOS の被覆判定が起きない)。根拠には使わない
- [事実] `Page.setWebLifecycleState {state:'frozen'}` で凍結したタブはタイマーが動かず alert 自体が出ない。`Runtime.evaluate` は返る(止まりはしない)
- [事実] 拡張の再読み込み直後(`chrome.runtime.reload`)でも同じく通知された
- [事実] 2026-09-27 09:06Z の失敗(実ブラウザで `cli.mjs goto` が `Navigation timeout of 30000 ms exceeded`、記録なし)の原因は、検証スクリプト
  (前セッションの `real-check.mjs`)が alert ページを返す HTTP サーバーと同じプロセスから `execFileSync` で CLI を呼んでいたこと。イベントループが止まり、
  ページが一度も読み込まれなかった。一時プロファイルで同じ形にすると 30169ms でタイムアウト・サーバーへの要求 0 件、非同期の `execFile` では成功
  (`tmp/artifacts/exp-execfilesync/result.json`)。当日のディスプレイ消灯は 17:23〜17:46 JST で、失敗(18:06 JST)の間は点灯していた(`pmset -g log`)
- [事実] 本物の弱点は別にあった: **クライアントが繋いでいない間(CLI のコマンドの合間)にエージェントのタブで開いたダイアログは通知されない**。
  中継は最後のクライアントが離れると detach していたため。次のコマンドの attach で `Page.enable` が返らず、`tab.unresponsive` → 遷移し直しで
  alert 前の入力値が消えた(`input: ""`)
- 修正: エージェントのタブは中継自身が参照を 1 つ持って attach し続ける(`ExtensionLink.watch`)。修正前のコードで E2E-14 を走らせると
  「cli 終了後もエージェントのタブは中継が attach したまま」で失敗し、修正後は通る
- [事実] attach を持ち続けるだけだと、次の puppeteer クライアント(`cli.mjs run`)が `Timed out after waiting 30000ms` で止まった。前のクライアントが
  `Runtime.enable` 済みのセッションを共有するため、次の `Runtime.enable` で `executionContextCreated` が来ない。最後のクライアントが離れたら付け直す(`#rewatch`)ことで解消
- [事実] ダイアログを開いたままクライアントが離れた場合、付け直す前に閉じる(`flushDialogs`)。E2E-14 では 2ms 後に accept され、以後のコマンドも普通に動いた
- 独立レビュー(panel-refuter、実装の文脈なし)の指摘と対応。いずれもスタブの拡張で到着順を制御する E2E-13 に回帰テストを足し、修正を 1 つずつ戻すと失敗することを確認した:
  - [事実] attach の往復中に unadopt → 再 adopt すると watch の参照が 2 つ数えられ、最後に外しても detach されなかった → watch に印を持たせ、古い watch の参照を返す
  - [事実] ブラウザ側から detach された後のページ WS の遅れた close(ws の close は相手の応答を最大 30 秒待つ)が、後から繋いだクライアントの参照を減らし、
    そのクライアントの接続中にダイアログを閉じて付け直していた。その後は監視が失われたままになった → ページ WS は自分の参照を持っている間だけ返す
  - [事実] ブラウザ側から detach された後は、次のクライアントが繋いで離れても監視が戻らなかった → クライアントの attach で watch し直す
  - E2E-1 の「次のクライアントに実行コンテキストが届く」は、最初のクライアントが `Runtime.enable` していなかったので付け直しを検証していなかった → 送るように直し、
    付け直し(`#rewatch`)を外すと失敗することを確認
  - E2E-14 の再読み込み後の assert を、ダイアログを閉じてページが先へ進んだことまで見るよう強化
- 残る穴: 付け直しで attach が外れる数 ms の間に開いたダイアログ(遷移し直しになりうる)。ブラウザ側から detach されてから次にクライアントが繋ぐまでの間。
  実機のディスプレイ消灯・画面ロック中の挙動は未検証(最小化 = `hidden` のタブで代用している)
