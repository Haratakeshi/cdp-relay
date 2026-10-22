// 中継の自動処理(ブラウザ = ExtensionLink ごとに 1 つ)。外出先のエージェントが承認・ダイアログ待ちで止まらないよう、
// クライアントが処理しなかった事象をタイムアウト後にポリシー(policy.mjs)の既定動作で片付け、記録する(GET /b/<name>/events)。
// 「全部自動承認」ではない: クライアントが先に処理すれば何もしない。危険なダウンロードは承認せず cancel する。
// 対象は scope で決める。既定の agentTabs ではエージェントのタブ(link.agentTabs)だけに介入し、ユーザーが手で使っているタブの
// ダイアログ・ファイル選択・認証・ダウンロードには触らない(puppeteer / Playwright / CLI は全タブに attach するので「attach 中」では判定しない)
import { copyFileSync, constants, linkSync, mkdirSync, unlinkSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { getPolicy, validOriginKey } from './policy.mjs';

const EVENTS_MAX = 200; // ブラウザごとに保持する記録の数(古いものから捨てる)
const AUTH_RETRY_WINDOW_MS = 60_000; // 資格情報を渡した requestId に再び認証要求が来たら「拒否された」とみなす期間(同じ資格情報で無限に再送しない)
const DOWNLOAD_MATCH_MS = 2000; // Page.downloadWillBegin と onCreated の間がこの時間内の item だけを対応付ける(実測では同じ ms、willBegin が先。逆順も受ける)
const DOWNLOAD_BEHAVIORS = ['allow', 'allowAndName', 'deny', 'default'];
const SAVES = b => b === 'allow' || b === 'allowAndName';
const DANGER_SAFE = ['safe', 'accepted', 'allowlistedByPolicy', 'deepScannedSafe'];
const DANGER_SCANNING = ['asyncScanning', 'asyncLocalPasswordScanning']; // 判定待ち。結果が出るまで何もしない
// CDP の PermissionType(Browser.grantPermissions)/ Web の権限名(Browser.setPermission)→ chrome.contentSettings の型。
// contentSettings に無いもの(sensors, midi, clipboardSanitizedWrite 等)は対応不可としてエラーにする(部分成功を黙って返さない)
const CDP_PERMISSION = { geolocation: 'location', notifications: 'notifications', videoCapture: 'camera', audioCapture: 'microphone', clipboardReadWrite: 'clipboard' };
const WEB_PERMISSION = { geolocation: 'location', notifications: 'notifications', camera: 'camera', microphone: 'microphone', 'clipboard-read': 'clipboard' };
const PERMISSION_SETTING = { granted: 'allow', denied: 'block', prompt: 'ask' };
// origin なし = 全サイト。<all_urls> や *://*/* は「既定値」扱いで camera/microphone の allow を拒否されるので、スキーム別のワイルドカードにする。
// ポート付きのオリジンのパターンも効く(いずれも実測)
const originPatterns = origin => {
  if (!origin || origin === '*') return ['http://*/*', 'https://*/*'];
  if (!validOriginKey(origin)) throw new Error(`Invalid origin: ${origin}`);
  return [`${new URL(origin).origin}/*`];
};
// Ctrl+T 等の新規タブページ(開いたタブの openerTabId が付くことがある)。これはユーザーのタブなので opener から引き継がない
const NEW_TAB_PAGE = /^(chrome|edge):\/\/(newtab|new-tab-page)\b/;
const originOf = u => URL.canParse(u) ? new URL(u).origin : undefined;
const sessionKey = (tabId, sessionId) => `${tabId}/${sessionId ?? ''}`;
/** dir/name に置く。同名があれば Chrome と同じく "name (1).ext" と連番にして上書きしない。move は元を消す(同一ボリュームは hard link + unlink) */
function placeFile(src, dir, name, move) {
  mkdirSync(dir, { recursive: true });
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) {
    const to = join(dir, n ? `${stem} (${n})${ext}` : name);
    try {
      if (move) { try { linkSync(src, to); } catch (e) { if (e.code !== 'EXDEV') throw e; copyFileSync(src, to, constants.COPYFILE_EXCL); } unlinkSync(src); }
      else copyFileSync(src, to, constants.COPYFILE_EXCL);
      return to;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

export class Autopilot {
  constructor(link, log) {
    this.link = link; this.log = log;
    this.events = []; this.seq = 0;
    this.dialogTimers = new Map(); // sessionKey -> { timer, fire }(fire: 待たずにポリシーどおり閉じる)
    this.probes = new Map(); // tabId -> Promise<boolean>(attach 直後の Page.enable が unresponsiveTimeoutMs 内に返ったか)
    this.stuck = new Set(); // 固まっていたエージェント以外のタブ。facade から隠す(遷移・クローズ・adopt で解除)
    this.authTried = new Set(); // 資格情報を渡した webRequest の requestId
    this.dlClients = new Map(); // facade クライアント -> { emit, behavior, downloadPath, eventsEnabled, seq }
    this.dlSeq = 0;
    this.downloads = new Map(); // CDP の guid -> { guid, url, frameId, suggestedFilename, tabId, at, id?, item?, dangerTimer? }
    this.matched = new Set(); // guid と対応付け済みの chrome.downloads id(他のダウンロードに使い回さない)
    this.created = new Map(); // guid と未対応の新しい item(id -> { item, at })。onCreated が downloadWillBegin より先に届いた場合用。DOWNLOAD_MATCH_MS で捨てる
    this.grants = new Map(); // facade クライアント -> そのクライアントが設定した [{ type, pattern, setting }]
    this.csQueue = Promise.resolve(); // contentSettings の操作は 1 本に直列化する(往復中の set と reset が入れ違わないように)
    this.policyTypes = new Set(); // 直前に適用したポリシーの型(ポリシーから消した型も次の適用で clear するため)
    this.openedBy = new Map(); // URL が未確定のまま作られた、エージェントのタブを opener とするタブ(tabId -> openerTabId)。最初の URL で判定する
    this.warned = new Set();
  }
  policy() { return getPolicy(this.log); }
  inScope(tabId) { return this.policy().scope === 'allTabs' || this.link.agentTabs.has(tabId); }
  record(type, data) {
    const e = { ...data, seq: ++this.seq, at: new Date().toISOString(), type };
    this.events.push(e);
    if (this.events.length > EVENTS_MAX) this.events.shift();
    this.log(`autopilot ${this.link.name}: ${type} ${JSON.stringify(data)}`);
  }
  warnOnce(key, msg) { if (!this.warned.has(key)) { this.warned.add(key); this.log(`autopilot ${this.link.name}: WARNING ${msg}`); } }

  /** 拡張の接続直後(ext.info 取得後)とポリシーの permissions 変更時。拡張の規則を消してからポリシーの権限を適用する */
  async onConnected() {
    if (!this.link.hasFeature('contentSettings')) return;
    const now = this.#policyGrants().map(g => g.type);
    await this.#reapply([...new Set([...Object.values(CDP_PERMISSION), ...this.policyTypes, ...now])]);
    this.policyTypes = new Set(now);
  }

  /**
   * 実 attach の直後。Page を有効にしてダイアログを検知できるようにし、同時に「固まっていないか」を確かめる(Page.enable の応答で判定)。
   * 未 attach 中に出たダイアログで固まったタブでは Page.enable が返らず、handleJavaScriptDialog も "No dialog is showing" で
   * 閉じられない(実測)。エージェントのタブなら unresponsiveTab に従い同じ URL へ遷移し直す。それ以外のタブには触らず stuck に入れ、
   * facade はクライアントに見せない(見せると puppeteer の pages() や Playwright の connect がそのタブの初期化で止まる)。
   * エージェント以外のタブにも Page.enable は送る(クライアント自身も全タブで送るので追加の副作用は無い)。ファイル選択の intercept は送らない
   */
  onAttached(tabId) {
    const { unresponsiveTimeoutMs } = this.policy();
    let timer;
    const probe = new Promise(resolve => {
      timer = setTimeout(() => {
        if (!this.inScope(tabId)) this.stuck.add(tabId); // probe を待つ facade がすぐ隠せるよう、resolve より先に入れる
        resolve(false);
        this.#onUnresponsive(tabId, unresponsiveTimeoutMs).catch(e => this.log(`autopilot ${this.link.name}: unresponsive tab ${tabId}: ${e.message}`));
      }, unresponsiveTimeoutMs);
      this.link.cdp(tabId, 'Page.enable').then(() => resolve(true), e => { this.log(`autopilot ${this.link.name}: Page.enable tab ${tabId} failed: ${e.message}`); resolve(true); })
        .finally(() => clearTimeout(timer));
    });
    this.probes.set(tabId, probe);
    if (this.inScope(tabId)) this.#interceptFileChooser(tabId);
  }
  probe(tabId) { return this.probes.get(tabId) ?? true; }
  /** エージェントのタブに加わった(attach 済みなら、ここでファイル選択の intercept を有効にする。attach 中なら onAttached が送る) */
  onAdopted(tabId) {
    this.stuck.delete(tabId);
    if (this.probes.has(tabId)) this.#interceptFileChooser(tabId);
  }
  /** エージェントのタブから外れた。ファイル選択の intercept を戻し、待っているダイアログの自動処理をやめる */
  onUnadopted(tabId) {
    for (const [k, d] of this.dialogTimers) if (k.startsWith(`${tabId}/`)) { clearTimeout(d.timer); this.dialogTimers.delete(k); }
    if (this.probes.has(tabId) && this.policy().scope !== 'allTabs') this.#interceptFileChooser(tabId, false);
  }
  #interceptFileChooser(tabId, enabled = true) {
    if (this.policy().fileChooser === 'intercept') this.link.cdp(tabId, 'Page.setInterceptFileChooserDialog', { enabled }).catch(e => this.log(`autopilot ${this.link.name}: intercept file chooser tab ${tabId} failed: ${e.message}`));
  }
  async #onUnresponsive(tabId, ms) {
    const url = (await this.link.call('ext.listTabs').catch(() => [])).find(t => t.tabId === tabId)?.url;
    const reason = `Page.enable did not respond within ${ms}ms after attach (likely a dialog opened while not attached)`;
    if (!this.inScope(tabId)) { return this.record('tab.unresponsive', { tabId, url, action: 'hidden from clients (not an agent tab; left untouched)', reason }); }
    const { unresponsiveTab: action } = this.policy();
    const entry = { tabId, url, action, reason };
    if (action === 'renavigate' && url) await this.link.cdp(tabId, 'Page.navigate', { url }).catch(e => { entry.error = e.message; });
    this.record('tab.unresponsive', entry);
  }
  onDetached(tabId) {
    for (const [k, d] of this.dialogTimers) if (k.startsWith(`${tabId}/`)) { clearTimeout(d.timer); this.dialogTimers.delete(k); }
    this.probes.delete(tabId);
  }

  /** クライアント由来のコマンドの前処理。値を返したら Chrome へ送らずそれを応答にする */
  beforeClientCommand(tabId, method, params, sessionId) {
    if (sessionId || !this.inScope(tabId)) return;
    // chrome.debugger のセッションはタブごとに 1 つを全クライアントで共有する。1 クライアントの disable で中継の検知を止めない
    if (method === 'Page.disable') return {};
    if (method === 'Page.setInterceptFileChooserDialog' && !params?.enabled && this.policy().fileChooser === 'intercept') return {};
  }

  /** 拡張からのイベント。不正な内容で例外になっても中継を落とさない */
  onEvent(ev, m) {
    try {
      const r = this.#dispatch(ev, m);
      if (r?.catch) r.catch(e => this.log(`autopilot ${this.link.name}: ${ev} handler failed: ${e.message}`));
    } catch (e) { this.log(`autopilot ${this.link.name}: ${ev} handler failed: ${e.message}`); }
  }
  #dispatch(ev, m) {
    switch (ev) {
      case 'cdp.event': return this.#onCdpEvent(m);
      case 'ext.authRequired': return this.#onAuthRequired(m);
      case 'ext.downloadCreated': case 'ext.downloadChanged': return this.#onChromeDownload(ev === 'ext.downloadCreated', m.item);
      // エージェントのタブが開いたポップアップ(window.open / target=_blank)だけを引き継ぐ。実測(Chrome 152): window.open のタブは onCreated に
      // openerTabId があるが URL は空で、最初の onUpdated で URL が付く。新規タブページ(Ctrl+T 相当)は onCreated に openerTabId が無く後から付く
      case 'ext.tabCreated':
        if (this.link.agentTabs.has(m.tab.openerTabId)) this.openedBy.set(m.tab.tabId, m.tab.openerTabId);
        return this.#adoptPopup(m.tab);
      case 'ext.tabUpdated': this.stuck.delete(m.tab.tabId); return this.#adoptPopup(m.tab);
      case 'ext.detached': return this.onDetached(m.tabId);
      case 'ext.tabRemoved': this.stuck.delete(m.tabId); this.openedBy.delete(m.tabId); return this.onDetached(m.tabId);
      case 'link.closed': for (const d of this.dialogTimers.values()) clearTimeout(d.timer); for (const d of this.downloads.values()) clearTimeout(d.dangerTimer);
    }
  }
  #adoptPopup(tab) {
    const opener = this.openedBy.get(tab.tabId), url = tab.url || tab.pendingUrl || '';
    if (opener === undefined || !url || url === 'about:blank') return; // URL が確定するまで待つ
    this.openedBy.delete(tab.tabId);
    if (!NEW_TAB_PAGE.test(url)) this.link.adopt(tab.tabId, `opened by agent tab ${opener}`);
  }
  #onCdpEvent(m) {
    if (!this.inScope(m.tabId)) return;
    const key = sessionKey(m.tabId, m.sessionId);
    switch (m.method) {
      case 'Page.javascriptDialogOpening': return this.#armDialog(key, m);
      case 'Page.javascriptDialogClosed': clearTimeout(this.dialogTimers.get(key)?.timer); return this.dialogTimers.delete(key);
      case 'Page.fileChooserOpened':
        if (this.policy().fileChooser === 'intercept') this.record('fileChooser', { tabId: m.tabId, mode: m.params.mode, frameId: m.params.frameId, backendNodeId: m.params.backendNodeId, action: 'intercepted (no native picker)' });
        return;
      case 'Page.downloadWillBegin': return this.#onDownloadWillBegin(m.tabId, m.params);
      case 'Page.downloadProgress': return this.#onDownloadProgress(m.params);
    }
  }

  // --- JS ダイアログ: クライアントが dialogTimeoutMs 内に閉じなければ(javascriptDialogClosed が来なければ)ポリシーどおり閉じる ---
  #armDialog(key, m) {
    const { type, message, url, defaultPrompt } = m.params; // 不正なイベントはここで例外になる(タイマーの中で落とさない)
    clearTimeout(this.dialogTimers.get(key)?.timer);
    const { dialogTimeoutMs, dialogs } = this.policy();
    const t0 = Date.now();
    const fire = async reason => {
      this.dialogTimers.delete(key);
      const accept = dialogs[type] === 'accept';
      const entry = { tabId: m.tabId, dialogType: type, message, url, action: accept ? 'accept' : 'dismiss', afterMs: Date.now() - t0, ...(reason ? { reason } : {}) };
      await this.link.cdp(m.tabId, 'Page.handleJavaScriptDialog', { accept, ...(accept && type === 'prompt' ? { promptText: defaultPrompt ?? '' } : {}) }, m.sessionId)
        .catch(e => { entry.error = e.message; }); // 直前にクライアントが閉じた等
      this.record('dialog', entry);
    };
    this.dialogTimers.set(key, { timer: setTimeout(fire, dialogTimeoutMs), fire });
  }
  /** クライアントが全員離れたタブで開いているダイアログを、dialogTimeoutMs を待たずにポリシーどおり閉じる(もう誰も処理しない) */
  flushDialogs(tabId) {
    return Promise.all([...this.dialogTimers].filter(([k]) => k.startsWith(`${tabId}/`)).map(([, d]) => { clearTimeout(d.timer); return d.fire('all clients left'); }));
  }

  // --- Basic 認証 ---
  // 資格情報はポリシーファイル由来のみ(クライアント/エージェント由来の文字列は使わない)。渡すのは次をすべて満たすときだけ:
  // CDP_RELAY_TOKEN 設定済み(= 拡張の接続を認証している)、features を申告した本物の拡張、エージェントのタブで attach 中、
  // 最上位の遷移か、認証先と同じオリジンが始めたリクエスト(他サイトの iframe / img / fetch で資格情報を引き出させない)
  #onAuthRequired({ requestId, tabId, url, realm, scheme, type, initiator }) {
    if (!this.inScope(tabId)) return this.link.call('ext.authRespond', { requestId, response: {} }); // 介入しない(ブラウザ既定の認証ダイアログ)
    const origin = originOf(url);
    const cred = Object.entries(this.policy().auth).find(([o]) => originOf(o) === origin)?.[1];
    let response = { cancel: true }, decision;
    if (!cred) decision = 'cancel (no credentials in policy)';
    else if (!this.link.tokenSet) { decision = 'cancel (CDP_RELAY_TOKEN not set)'; this.warnOnce('token', 'policy.auth is ignored because CDP_RELAY_TOKEN is not set (the extension connection is not authenticated)'); }
    else if (!this.link.hasFeature('auth') || !this.link.tabRefs.get(tabId)) decision = 'cancel (not an attached tab of a verified extension)';
    else if (type !== 'main_frame' && originOf(initiator) !== origin) decision = `cancel (${type} from another origin ${initiator})`;
    else if (this.authTried.has(requestId)) decision = 'cancel (policy credentials rejected)';
    else {
      response = { authCredentials: { username: cred.username, password: cred.password } }; decision = 'policy credentials';
      this.authTried.add(requestId); setTimeout(() => this.authTried.delete(requestId), AUTH_RETRY_WINDOW_MS);
    }
    this.record('auth', { tabId, origin, realm, scheme, requestType: type, decision });
    return this.link.call('ext.authRespond', { requestId, response });
  }

  // --- ダウンロード(Browser.setDownloadBehavior を chrome.downloads で実現) ---
  // 設定は facade クライアントごと。ブラウザとしての動作(deny で止めるか)は接続中で最後に設定したクライアントのもの、イベントは eventsEnabled の
  // 全員へ、ファイルは allow / allowAndName の各クライアントの downloadPath へ置く。切断したクライアントの設定だけを外す。
  // chrome.debugger の Page.downloadWillBegin(guid・frameId。エージェントのタブのものだけ扱う)と、onCreated で新しく作られた item を
  // URL で対応付ける(どちらが先に届いてもよい。間が DOWNLOAD_MATCH_MS 以内のものだけ)。完了済み・他と対応済み・古い item は使わない
  // (ユーザーの同じ URL のダウンロードを取り違えない)。chrome.downloads はダウンロードフォルダにしか保存できないので、完了後に中継が移す
  // (同名があれば連番)。配置の結果はクライアントごとに返す(置けたら completed + filePath、置けなかったら canceled)
  setDownloadBehavior(owner, emit, { behavior, downloadPath, eventsEnabled }) {
    if (!DOWNLOAD_BEHAVIORS.includes(behavior)) throw new Error(`Unrecognized download behavior: ${behavior}`);
    if (SAVES(behavior) && !downloadPath) throw new Error('downloadPath not provided');
    if (SAVES(behavior) && !isAbsolute(downloadPath)) throw new Error(`downloadPath must be absolute: ${downloadPath}`);
    if (behavior !== 'default') this.link.requireFeature('downloads');
    if (behavior === 'default' && !eventsEnabled) this.#dropDlClient(owner);
    else this.dlClients.set(owner, { emit, behavior, downloadPath, eventsEnabled: !!eventsEnabled, seq: ++this.dlSeq });
  }
  #dropDlClient(owner) {
    this.dlClients.delete(owner);
    if (!this.dlClients.size) { for (const d of this.downloads.values()) clearTimeout(d.dangerTimer); this.downloads.clear(); this.matched.clear(); this.created.clear(); }
  }
  #effective() { return [...this.dlClients.values()].reduce((a, c) => (!a || c.seq > a.seq ? c : a), null); }
  /** eventsEnabled の全クライアントへ。perClient はクライアントごとの上書き(filePath / state) */
  #emitDl(method, params, perClient) {
    for (const c of this.dlClients.values()) if (c.eventsEnabled) c.emit(method, { ...params, ...perClient?.(c) });
  }
  #onDownloadWillBegin(tabId, { guid, url, frameId, suggestedFilename }) {
    if (!this.dlClients.size) return;
    const d = { guid, url, frameId, suggestedFilename, tabId, at: Date.now() };
    this.downloads.set(guid, d);
    this.#emitDl('Browser.downloadWillBegin', { frameId, guid, url, suggestedFilename });
    this.#pruneCreated();
    const early = [...this.created.values()].find(c => c.item.url === url || c.item.finalUrl === url); // onCreated が先に届いていた
    if (early) this.#match(d, early.item);
  }
  #pruneCreated() { for (const [id, c] of this.created) if (Date.now() - c.at > DOWNLOAD_MATCH_MS) this.created.delete(id); }
  #onChromeDownload(isNew, item) {
    if (!this.dlClients.size || !Number.isInteger(item?.id)) return;
    const d = [...this.downloads.values()].find(x => x.id === item.id);
    if (d) { d.item = item; return this.#check(d); }
    if (this.created.has(item.id)) { if (item.state === 'in_progress') this.created.get(item.id).item = item; else this.created.delete(item.id); return; } // 完了・中断したものは候補から外す
    if (!isNew || this.matched.has(item.id) || item.state !== 'in_progress') return;
    const wanted = [...this.downloads.values()].find(x => x.id === undefined && Date.now() - x.at <= DOWNLOAD_MATCH_MS && (x.url === item.url || x.url === item.finalUrl));
    if (wanted) return this.#match(wanted, item);
    this.#pruneCreated();
    this.created.set(item.id, { item, at: Date.now() });
  }
  async #match(d, item) {
    this.created.delete(item.id); this.matched.add(item.id);
    d.id = item.id; d.item = item;
    if (this.#effective()?.behavior === 'deny') {
      const entry = { guid: d.guid, url: d.url, behavior: 'deny' };
      await this.link.call('ext.downloadCancel', { id: item.id }).then(() => { entry.action = 'canceled'; }, e => { entry.action = 'cancel failed'; entry.error = e.message; });
      return this.record('download', entry);
    }
    this.#check(d);
  }
  #check(d) {
    const { danger, state } = d.item;
    if (DANGER_SAFE.includes(danger)) clearTimeout(d.dangerTimer);
    else if (!DANGER_SCANNING.includes(danger) && state === 'in_progress' && !d.dangerTimer) {
      // 危険なファイルは承認しない。放置すると in_progress のまま止まるので、dialogTimeoutMs 後に cancel して canceled を送る
      const { dialogTimeoutMs } = this.policy();
      this.record('download.dangerous', { guid: d.guid, url: d.url, danger, action: `cancel after ${dialogTimeoutMs}ms unless accepted (never accepted automatically)` });
      d.dangerTimer = setTimeout(async () => {
        if (!this.downloads.has(d.guid) || DANGER_SAFE.includes(d.item.danger)) return;
        this.downloads.delete(d.guid);
        const entry = { guid: d.guid, url: d.url, danger: d.item.danger };
        await this.link.call('ext.downloadCancel', { id: d.id }).then(() => { entry.action = 'canceled'; }, e => { entry.action = 'cancel failed'; entry.error = e.message; });
        this.record('download.dangerous', entry);
        this.#emitDl('Browser.downloadProgress', { guid: d.guid, totalBytes: d.item.totalBytes, receivedBytes: d.item.bytesReceived, state: 'canceled' });
      }, dialogTimeoutMs);
    }
    if (state === 'complete' && DANGER_SAFE.includes(danger) && [...this.dlClients.values()].some(c => SAVES(c.behavior))) this.#finish(d);
  }
  #onDownloadProgress(p) {
    const d = this.downloads.get(p.guid);
    if (!d) return;
    const saving = p.state === 'completed' && [...this.dlClients.values()].some(c => SAVES(c.behavior));
    if (saving && d.id !== undefined) return; // chrome.downloads の完了を待って #finish が移し、送る
    if (p.state !== 'inProgress') { this.downloads.delete(p.guid); clearTimeout(d.dangerTimer); }
    if (saving) {
      // item と対応付かなかった: ファイルはブラウザのダウンロードフォルダのままで downloadPath には無い。保存先を期待するクライアントには canceled
      this.record('download', { guid: d.guid, url: d.url, action: 'not matched to a chrome.downloads item; left in the browser download folder' });
      return this.#emitDl('Browser.downloadProgress', p, c => SAVES(c.behavior) ? { state: 'canceled' } : {});
    }
    this.#emitDl('Browser.downloadProgress', p);
  }
  #finish(d) {
    this.downloads.delete(d.guid); clearTimeout(d.dangerTimer);
    const dests = [...this.dlClients.values()].filter(c => SAVES(c.behavior));
    const keepOriginal = !SAVES(this.#effective()?.behavior); // ブラウザとしての動作が default なら元のファイルはダウンロードフォルダに残す
    const placed = new Map(), errors = [];
    dests.forEach((c, i) => {
      try { placed.set(c, placeFile(d.item.filename, c.downloadPath, c.behavior === 'allowAndName' ? d.guid : basename(d.item.filename), !keepOriginal && i === dests.length - 1)); }
      catch (e) { errors.push(`${c.downloadPath}: ${e.message}`); }
    });
    this.record('download', { guid: d.guid, url: d.url, filePaths: [...placed.values()], ...(keepOriginal ? { kept: d.item.filename } : {}), ...(errors.length ? { errors } : {}) });
    this.#emitDl('Browser.downloadProgress', { guid: d.guid, totalBytes: d.item.totalBytes, receivedBytes: d.item.bytesReceived, state: 'completed' },
      c => !SAVES(c.behavior) ? {} : placed.has(c) ? { filePath: placed.get(c) } : { state: 'canceled' });
  }

  // --- 権限(chrome.contentSettings)。実プロファイルに永続化されるので、クライアント切断時に消してポリシーを再適用する ---
  async grantPermissions(owner, { permissions = [], origin }) {
    const types = this.#types(permissions, CDP_PERMISSION);
    await this.#addGrants(owner, originPatterns(origin).flatMap(pattern => types.map(type => ({ type, pattern, setting: 'allow' }))));
  }
  async setPermission(owner, { permission, setting, origin }) {
    if (!PERMISSION_SETTING[setting]) throw new Error(`Unknown permission setting: ${setting}`);
    const [type] = this.#types([permission?.name], WEB_PERMISSION);
    await this.#addGrants(owner, originPatterns(origin).map(pattern => ({ type, pattern, setting: PERMISSION_SETTING[setting] })));
  }
  async resetPermissions(owner) {
    const mine = this.grants.get(owner);
    if (!mine) return;
    this.grants.delete(owner);
    if (!this.link.closed) await this.#reapply([...new Set(mine.map(g => g.type))]); // 拡張が切断済みなら拡張側が自分で消している
  }
  /** facade クライアントの切断。ダウンロード設定を外し、そのクライアントが設定した権限を消してポリシーを再適用する */
  releaseClient(owner) {
    this.#dropDlClient(owner);
    return this.resetPermissions(owner);
  }
  #types(names, map) {
    this.link.requireFeature('contentSettings');
    const ok = n => Object.hasOwn(map, n) && this.link.info.contentSettingTypes.includes(map[n]);
    const bad = names.filter(n => !ok(n));
    if (bad.length) throw new Error(`Permission(s) not supported via the extension relay (chrome.contentSettings): ${bad.join(', ')}. Supported: ${Object.keys(map).filter(ok).join(', ')}`);
    return names.map(n => map[n]);
  }
  #cs(fn) { const p = this.csQueue.then(fn); this.csQueue = p.catch(() => {}); return p; }
  async #addGrants(owner, list) {
    this.grants.set(owner, [...(this.grants.get(owner) ?? []), ...list]); // 送る前に登録する(同時に走る再適用に含まれるように)
    const { errors } = await this.#cs(() => this.link.call('ext.setContentSettings', { set: list }));
    if (errors.length) { // 一部だけ効いた状態を残さない
      this.grants.set(owner, this.grants.get(owner).filter(g => !list.includes(g)));
      await this.#reapply([...new Set(list.map(g => g.type))]);
      throw new Error(`chrome.contentSettings rejected: ${errors.join('; ')}`);
    }
    this.record('permission', { action: 'set', grants: list });
  }
  #policyGrants() {
    return Object.entries(this.policy().permissions).flatMap(([origin, perms]) => {
      if (origin !== '*' && !URL.canParse(origin)) { this.log(`policy: invalid origin "${origin}" in permissions, skipped`); return []; }
      return originPatterns(origin).flatMap(pattern => Object.entries(perms).map(([type, setting]) => ({ type, pattern, setting })));
    });
  }
  /** 型ごとに「拡張が設定した規則」を消し、ポリシー → 接続中クライアントの順に設定し直す(後勝ち)。内容はキューで実行する時点の状態から作る */
  #reapply(types) {
    return this.#cs(async () => {
      const available = this.link.info.contentSettingTypes;
      const wanted = [...this.#policyGrants(), ...[...this.grants.values()].flat()].filter(g => types.includes(g.type));
      for (const g of wanted) if (!available.includes(g.type)) this.log(`policy: unknown contentSettings type "${g.type}", skipped`);
      const set = wanted.filter(g => available.includes(g.type));
      const { errors } = await this.link.call('ext.setContentSettings', { clear: types.filter(t => available.includes(t)), set });
      this.record('permission', { action: 'reset', types, applied: set, ...(errors.length ? { errors } : {}) });
    });
  }
}
