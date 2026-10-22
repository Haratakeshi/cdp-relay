// CDP Relay Server
// 拡張機能(chrome.debugger)からの WebSocket を受け、CDP クライアント(puppeteer / Playwright / MCP 等)へ
// 「普通の Chrome の DevTools エンドポイント」に見える HTTP/WebSocket を提供する。
//   拡張        : ws://HOST:PORT/extension?name=<browser>&token=<TOKEN>[&port=<専用ポート>]
//   専用ポート  : 拡張が port を申告すると、そのポートで /json/version, /json/list, /devtools/browser, /devtools/page/<tabId> を
//                 そのブラウザ固定で提供する(puppeteer の browserURL / chrome-devtools-mcp の --browserUrl は
//                 /json/version をルートに解決するので、複数ブラウザの選択にはポート分離が必要)
//   一覧        : GET  /browsers
//   version     : GET  /b/<browser>/json/version   (ブラウザが1つだけなら /json/version でも可)
//   タブ一覧    : GET  /b/<browser>/json/list
//   ブラウザ WS : ws://HOST:PORT/b/<browser>/devtools/browser        (Target ドメインを facade.mjs が模倣)
//   ページ WS   : ws://HOST:PORT/b/<browser>/devtools/page/<tabId>   (chrome.debugger への素通し)
//   自動処理記録: GET  /b/<browser>/events[?since=<seq>]            (ダイアログ・認証・ダウンロード等を中継が処理した記録。autopilot.mjs)
//   拡張の更新  : POST /b/<browser>/reload-extension                 (chrome.runtime.reload。未パック拡張はディスクから読み直す。/b/<name> 必須)
//   タブの指定  : POST|DELETE /b/<browser>/tabs/<tabId>/adopt       (既存タブをエージェントのタブにする / 外す = 自動処理の対象。autopilot.mjs の scope)
// 要求の検査: Host は 127.0.0.1 / localhost / [::1](+ CDP_RELAY_ALLOWED_HOSTS)だけ(DNS rebinding 対策)。Origin ヘッダ付き
// (= ブラウザのページからの)要求は拒否する。/extension だけは Origin が chrome-extension:// のものを受ける
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { watchFile, mkdirSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { serveBrowserFacade } from './facade.mjs';
import { Autopilot } from './autopilot.mjs';
import { getPolicy, POLICY_PATH } from './policy.mjs';
import { serveAgent } from './agent.mjs';
import { agentSocketPath, clientTokenPath, ensureClientToken, statePath } from './paths.mjs';

const PORT = Number(process.env.CDP_RELAY_PORT || 9333);
const HOST = process.env.CDP_RELAY_HOST || '127.0.0.1';
const TOKEN = process.env.CDP_RELAY_TOKEN || '';
const CALL_TIMEOUT = Number(process.env.CDP_RELAY_CALL_TIMEOUT || 60_000);
const PING_INTERVAL = Number(process.env.CDP_RELAY_PING_INTERVAL ?? 20_000); // 0 で無効(SW アイドル終了の実験用)
const TRACE = !!process.env.CDP_RELAY_TRACE; // 1 でクライアント⇔facade の全メッセージをログ
const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB

const normalizeHost = h => {
  const s = (h ?? '').trim().toLowerCase();
  return s.startsWith('[') ? s.slice(0, s.indexOf(']') + 1) : s.split(':')[0];
};
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', ...(process.env.CDP_RELAY_ALLOWED_HOSTS ?? '').split(',').map(normalizeHost).filter(Boolean)]);
// エージェント(MCP シム)用の Unix ドメインソケット。ファイル権限(ディレクトリ 700 / ソケット 600)がローカルの認証になる。中継ポートごとに別のパス
const WINDOWS = process.platform === 'win32';
const AGENT_SOCKET = agentSocketPath(PORT);
// TCP 側のクライアント認証(任意)。有効なら HTTP / WS / 専用ポートに Authorization: Bearer <トークン> を求める。/extension は CDP_RELAY_TOKEN で別に検証する
const CLIENT_TOKEN = process.env.CDP_RELAY_CLIENT_AUTH === '1' ? ensureClientToken(PORT) : null;
const POLICY_WATCH_MS = 1000; // policy.json の permissions 変更を接続中のブラウザへ反映する間隔
export const log = (...a) => console.log(new Date().toISOString(), ...a);

/** タイミング攻撃を防ぐ定数時間トークン検証 */
function safeCompareToken(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(input).digest();
  const hashB = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/** 拡張機能1接続 = ブラウザ1つ */
export class ExtensionLink {
  constructor(name, ws, agentTabs) {
    this.name = name; this.ws = ws; this.connectedAt = new Date().toISOString();
    this.agentTabs = agentTabs; // エージェントのタブ tabId -> targetId(拡張の再接続でも消えないよう名前ごとに中継が持つ)
    this.tokenSet = !!TOKEN; this.closed = false;
    this.seq = 0; this.pending = new Map(); this.listeners = new Set(); this.tabRefs = new Map(); this.attaching = new Map();
    this.watched = new Map(); // 中継自身が参照を 1 つ持って attach しているエージェントのタブ(watch)。tabId -> その watch の印(古い watch の参照を見分ける)
    this.info = null; // 接続直後の ext.info(version / features / contentSettingTypes)。ready で取得完了を待てる
    this.autopilot = new Autopilot(this, log);
    this.on((ev, m) => this.autopilot.onEvent(ev, m));
    ws.on('message', raw => this.#onMessage(raw));
    if (PING_INTERVAL) this.pingTimer = setInterval(() => this.call('ping').catch(() => {}), PING_INTERVAL); // 未 attach 時の SW 延命(Chrome 116+)
  }
  call(method, params = {}) {
    const id = ++this.seq;
    if (this.closed) return Promise.reject(new Error('extension disconnected')); // 切断後に呼んでもタイマーを残さない
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`extension call timed out: ${method}`)); }, CALL_TIMEOUT);
      // ext.closeTab は応答より先に ext.tabRemoved が届くことがある(閉じたこと自体が成功)ので、タブの消滅で中断する対象にしない
      this.pending.set(id, { resolve, reject, timer, tabId: method === 'ext.closeTab' ? undefined : params?.tabId });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }
  /** タブが切断・消滅した際、そのタブ宛てで保留中の呼び出しを即座にアボートする */
  abortTabRequests(tabId, reason) {
    for (const [id, p] of this.pending) {
      if (p.tabId === tabId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error(`extension call aborted: tab ${tabId} ${reason}`));
      }
    }
  }
  /** CDP を tab(+flatten 子セッション)へ送る */
  cdp(tabId, method, params, sessionId) { return this.call('cdp', { tabId, method, params, sessionId }); }
  /** クライアント由来の CDP。中継の自動処理を壊すコマンド(Page.disable 等)は autopilot が肩代わりする */
  async clientCdp(tabId, method, params, sessionId) { return this.autopilot.beforeClientCommand(tabId, method, params, sessionId) ?? this.cdp(tabId, method, params, sessionId); }
  hasFeature(f) { return !!this.info?.features?.includes(f); }
  /** 旧バージョンの拡張(新メソッドなし)では、使おうとした機能を未対応エラーにする(ログは接続時に 1 回だけ) */
  requireFeature(f) { if (!this.hasFeature(f)) throw new Error(`extension ${this.info?.version ?? '(unknown version)'} does not support ${f}; update extension/ to 0.2.0+ and reload it`); }
  /** エージェントのタブにする(中継経由で作った・明示的に接続した・adopt されたタブ、そのポップアップ) */
  adopt(tabId, reason) {
    if (this.agentTabs.has(tabId)) return true; // 既にエージェントのタブだった
    this.agentTabs.set(tabId, undefined);
    log(`${this.name}: agent tab ${tabId} (${reason})`);
    this.autopilot.onAdopted(tabId);
    this.watch(tabId);
    this.call('ext.listTabs').then(ts => { const t = ts.find(x => x.tabId === tabId); if (t && this.agentTabs.has(tabId)) this.agentTabs.set(tabId, t.targetId); }).catch(() => {});
    return false;
  }
  /** エージェントのタブから外す(DELETE …/adopt。CLI は既存タブをコマンドの実行中だけ adopt する) */
  unadopt(tabId) {
    if (!this.agentTabs.delete(tabId)) return false;
    log(`${this.name}: tab ${tabId} is no longer an agent tab`);
    this.autopilot.onUnadopted(tabId);
    if (this.watched.delete(tabId)) this.detach(tabId);
    return true;
  }
  /**
   * エージェントのタブは、クライアントが繋いでいない間(CLI のコマンドの合間など)も中継が attach しておく。detach していると、その間に開いた
   * ダイアログはイベントが来ないので自動処理できず、次の attach で Page.enable が返らない → 遷移し直してページの状態を失う(実測)。
   * ブラウザ側から detach された(インフォバーの「キャンセル」、タブのクラッシュ等)ら付け直さない。次にクライアントが attach した時点で監視を再開する
   */
  watch(tabId) {
    if (this.watched.has(tabId) || !this.agentTabs.has(tabId) || this.closed) return;
    const mark = {};
    this.watched.set(tabId, mark);
    // attach の往復中に unadopt(→ 再 adopt)されたら、この watch の参照は誰のものでもないので返す
    this.attach(tabId).then(() => { if (this.watched.get(tabId) !== mark) this.detach(tabId); },
      e => { if (this.watched.get(tabId) === mark) this.watched.delete(tabId); log(`${this.name}: watch tab ${tabId} failed: ${e.message}`); });
  }
  on(fn) { this.listeners.add(fn); }
  off(fn) { this.listeners.delete(fn); }
  /** 参照カウント付き attach/detach(複数クライアントで同じタブを共有できる)。失敗した attach は数えず、同時 attach は 1 回にまとめる */
  async attach(tabId) {
    if (!this.tabRefs.get(tabId)) {
      const p = this.attaching.get(tabId) ?? this.call('ext.attach', { tabId })
        .then(() => {
          try { this.autopilot.onAttached(tabId); }
          catch (e) { log(`${this.name}: onAttached tab ${tabId} failed: ${e.message}`); }
        })
        .finally(() => this.attaching.delete(tabId));
      this.attaching.set(tabId, p);
      await p;
    }
    this.tabRefs.set(tabId, (this.tabRefs.get(tabId) ?? 0) + 1);
    this.watch(tabId); // ブラウザ側から detach されて監視が切れていたエージェントのタブ
  }
  async detach(tabId) {
    const n = this.tabRefs.get(tabId);
    if (!n) return;
    if (n === 2 && this.watched.has(tabId)) return this.#rewatch(tabId);
    if (n > 1) return this.tabRefs.set(tabId, n - 1);
    this.tabRefs.delete(tabId);
    this.autopilot.onDetached(tabId);
    await this.call('ext.detach', { tabId }).catch(() => {});
  }
  /**
   * 最後のクライアントが離れ、残りが watch だけになったタブを付け直す。クライアントが有効にしたドメインや傍受(Runtime.enable、Fetch.enable 等)を
   * 持ち越さないため。持ち越すと次のクライアントの Runtime.enable が実行コンテキストを通知せず、puppeteer がページの初期化で止まる(実測)。
   * ダイアログが開いたまま付け直すと Page.enable が返らない(実測)ので、先にポリシーどおり閉じる
   */
  async #rewatch(tabId) {
    this.tabRefs.set(tabId, 1);
    await this.autopilot.flushDialogs(tabId);
    if (this.tabRefs.get(tabId) !== 1 || !this.watched.delete(tabId)) return; // 待つ間にクライアントが繋いだ / unadopt された
    await this.detach(tabId);
    this.watch(tabId);
  }
  close() { this.closed = true; clearInterval(this.pingTimer); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('extension disconnected')); } this.pending.clear(); this.#emit('link.closed', {}); }
  /** 不正なイベント(拡張の不具合・偽の拡張)でリスナーが例外を出しても中継を落とさない */
  #emit(ev, m) {
    for (const fn of this.listeners) {
      try { const r = fn(ev, m); if (r?.catch) r.catch(e => log(`${this.name}: ${ev} listener failed: ${e.message}`)); }
      catch (e) { log(`${this.name}: ${ev} listener failed: ${e.message}`); }
    }
  }
  #onMessage(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (typeof m !== 'object' || m === null) return;
    if (m.id !== undefined) {
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      m.error ? p.reject(Object.assign(new Error(String(m.error.message)), { cdp: m.error })) : p.resolve(m.result);
    } else if (m.event) {
      if (m.event === 'ext.detached' || m.event === 'ext.tabRemoved') {
        this.tabRefs.delete(m.tabId);
        this.watched.delete(m.tabId);
        this.abortTabRequests(m.tabId, m.event === 'ext.tabRemoved' ? 'closed' : 'detached');
      }
      if (m.event === 'ext.tabRemoved') this.agentTabs.delete(m.tabId);
      this.#emit(m.event, m);
    }
  }
}

const links = new Map(); // name -> ExtensionLink
const agentTabsByName = new Map(); // name -> Map(tabId -> targetId)。拡張が再接続しても引き継ぐ
const hostAllowed = req => { const h = (req.headers.host ?? '').toLowerCase(); return ALLOWED_HOSTS.has(h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]); };
/** 要求元の検査。拒否理由を返す(問題なければ undefined) */
function refuse(req, extension = false) {
  if (!hostAllowed(req)) return `host not allowed: ${req.headers.host} (add it to CDP_RELAY_ALLOWED_HOSTS for a tunnel)`;
  const origin = req.headers.origin;
  if (extension) {
    if (!origin?.startsWith('chrome-extension://')) return `origin not allowed: ${origin ?? '(none)'}`;
  } else {
    if (origin !== undefined) return `origin not allowed: ${origin}`;
    const sfs = req.headers['sec-fetch-site'];
    if (sfs && sfs !== 'none') return `sec-fetch-site not allowed: ${sfs}`;
    const referer = req.headers.referer;
    if (referer) return `referer not allowed: ${referer}`;
  }
}

function clientAuthorized(req) {
  if (!CLIENT_TOKEN) return true;
  const m = /^bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  return !!m && safeCompareToken(m[1], CLIENT_TOKEN);
}
const CLIENT_AUTH_ERROR = `client token required: send "Authorization: Bearer <token>" (token file: ${clientTokenPath(PORT)})`;

function resolveLink(name) {
  if (name) return links.get(name);
  return links.size === 1 ? [...links.values()][0] : undefined;
}
/** ブラウザの WS エンドポイント URL。専用ポート経由なら /b/<name> プレフィックスを付けない */
const endpointBase = (req, link, fixed) => `ws://${req.headers.host ?? `${HOST}:${PORT}`}${fixed ? '' : `/b/${encodeURIComponent(link.name)}`}`;

/** HTTP ハンドラ。fixedLink があればそのブラウザ固定(専用ポート)、なければ /b/<name> または単一ブラウザに解決 */
/** 安全なリクエストボディ読み込み */
const readJsonBody = req => new Promise((resolve, reject) => {
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > MAX_BODY_SIZE) {
    return reject(Object.assign(new Error('payload too large (max 1MB)'), { status: 413 }));
  }
  const ctype = req.headers['content-type'] || '';
  if (req.method === 'POST' && !ctype.toLowerCase().includes('application/json')) {
    return reject(Object.assign(new Error('Content-Type must be application/json'), { status: 415 }));
  }

  let data = '';
  let received = 0;
  let done = false;
  const timer = setTimeout(() => {
    if (!done) { done = true; reject(Object.assign(new Error('body read timeout'), { status: 408 })); }
  }, 10_000);

  req.on('data', chunk => {
    if (done) return;
    received += chunk.length;
    if (received > MAX_BODY_SIZE) {
      done = true; clearTimeout(timer);
      reject(Object.assign(new Error('payload too large (max 1MB)'), { status: 413 }));
      return;
    }
    data += chunk;
  });

  req.on('end', () => {
    if (done) return;
    done = true; clearTimeout(timer);
    if (!data.trim()) return resolve({});
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return reject(Object.assign(new Error('JSON body must be an object'), { status: 400 }));
      }
      resolve(parsed);
    } catch {
      reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
    }
  });

  req.on('error', err => {
    if (!done) { done = true; clearTimeout(timer); reject(Object.assign(err, { status: 400 })); }
  });
});

const httpHandler = fixedLink => async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const json = (code, body) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 1));
  };
  const why = refuse(req);
  if (why) { log(`refused http ${req.method} ${url.pathname}: ${why}`); return json(403, { error: why }); }
  if (!clientAuthorized(req)) { log(`refused http ${req.method} ${url.pathname}: no valid client token`); return json(401, { error: CLIENT_AUTH_ERROR }); }

  try {
    if (!fixedLink && url.pathname === '/browsers') {
      return json(200, [...links.values()].map(l => ({ name: l.name, port: l.port || undefined, portError: l.portError, connectedAt: l.connectedAt, extVersion: l.info?.version, attachedTabs: [...l.tabRefs.keys()], agentTabs: [...l.agentTabs.keys()] })));
    }
    const m = url.pathname.match(/^(?:\/b\/([^/]+))?\/(?:json(?:\/(version|list))?|(events|reload-extension)|tabs\/(?:resolve|(\d+)\/(adopt|eval|cdp|shot\.png|shot|snapshot|click|fill)))\/?$/);
    if (!m) return json(404, { error: 'not found' });
    const link = fixedLink ?? resolveLink(m[1] && decodeURIComponent(m[1]));
    if (!link) return json(404, { error: m[1] ? `browser not connected: ${m[1]}` : `specify browser: /b/<name>/json/version or its dedicated port (connected: ${[...links.values()].map(l => `${l.name}${l.port ? `:${l.port}` : ''}`).join(', ') || 'none'})` });

    // 一発タブ解決・検索 (GET /tabs/resolve?q=<keyword>&adopt=1)
    if (url.pathname.endsWith('/tabs/resolve')) {
      const q = url.searchParams.get('q')?.toLowerCase();
      const tabs = await link.call('ext.listTabs');
      const match = q ? tabs.find(t => (t.title + ' ' + t.url).toLowerCase().includes(q)) : tabs[0];
      if (!match) return json(404, { error: `no tab matching '${q}'` });
      if (url.searchParams.get('adopt') === '1') link.adopt(match.tabId, 'resolve adopt');
      return json(200, { tabId: match.tabId, id: match.targetId ?? `tab-${match.tabId}`, title: match.title, url: match.url });
    }

    if (m[3] === 'events') return json(200, link.autopilot.events.filter(e => e.seq > Number(url.searchParams.get('since') ?? 0)));

    if (m[4]) {
      const tabId = Number(m[4]);
      const action = m[5];

      // 事前のタブ存在確認
      const tabs = await link.call('ext.listTabs');
      if (!tabs.some(t => t.tabId === tabId)) return json(404, { error: `no such tab: ${tabId}` });

      if (action === 'adopt') {
        if (req.method === 'DELETE') return json(200, { tabId, wasAgent: link.unadopt(tabId) });
        if (req.method !== 'POST') return json(405, { error: 'use POST (adopt) or DELETE (unadopt)' });
        return json(200, { tabId, wasAgent: link.adopt(tabId, 'POST adopt') });
      }

      // 参照アンダーフローを防ぐ保護リスナー
      let held = false;
      const onDetach = (ev, evMsg) => {
        if ((ev === 'ext.detached' || ev === 'ext.tabRemoved') && evMsg.tabId === tabId) held = false;
      };
      link.on(onDetach);
      await link.attach(tabId);
      held = true;

      try {
        // バイナリ スクリーンショット (GET /tabs/:tabId/shot.png)
        if (action === 'shot.png' || action === 'shot') {
          if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'use GET or HEAD' });
          const full = url.searchParams.get('full') === '1' || url.searchParams.get('full') === 'true';
          const resCdp = await link.cdp(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
          const buf = Buffer.from(resCdp.data, 'base64');
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store' });
          return req.method === 'HEAD' ? res.end() : res.end(buf);
        }

        // Accessibility & Interactive Elements スナップショット (GET /tabs/:tabId/snapshot)
        if (action === 'snapshot') {
          if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'use GET or HEAD' });
          const format = url.searchParams.get('format') ?? 'text';
          const expr = `(() => {
            const isVisible = el => {
              if (!el || el.nodeType !== 1) return false;
              const s = window.getComputedStyle(el);
              return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.getBoundingClientRect().width > 0;
            };
            const getLabel = el => (el.getAttribute('aria-label') || el.innerText || el.placeholder || el.value || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
            const getSel = el => el.id ? '#' + CSS.escape(el.id) : (el.name ? el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]' : '');
            const sels = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';
            const elements = Array.from(document.querySelectorAll(sels)).filter(isVisible);
            const items = elements.map((el, i) => {
              const tag = el.tagName.toLowerCase();
              const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? el.type || 'text' : tag);
              const state = [];
              if (el.disabled || el.getAttribute('aria-disabled') === 'true') state.push('disabled');
              if (el.checked) state.push('checked');
              if (el.value && !['button','submit'].includes(el.type)) state.push('val="' + String(el.value).slice(0, 20) + '"');
              return { ref: i + 1, role, label: getLabel(el) || '(no label)', selector: getSel(el), state: state.join(', ') };
            });
            return { title: document.title, url: location.href, readyState: document.readyState, items };
          })()`;
          const evalRes = await link.cdp(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
          const data = evalRes.result?.value;
          if (!data) return json(500, { error: 'snapshot failed' });
          if (format === 'json') return json(200, data);
          const text = [`[HUD] "${data.title}" | ${data.url} | ready: ${data.readyState}`, `--- Interactive Elements (${data.items.length}) ---`, ...data.items.map(e => `@${e.ref} [${e.role}] "${e.label}"${e.selector ? ' ' + e.selector : ''}${e.state ? ' [' + e.state + ']' : ''}`)].join('\\n');
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          return req.method === 'HEAD' ? res.end() : res.end(text);
        }

        // 高速クリック (POST /tabs/:tabId/click)
        if (action === 'click') {
          if (req.method !== 'POST') return json(405, { error: 'use POST' });
          const { selector, ref, timeout = 5000 } = await readJsonBody(req);
          const expr = `(async () => {
            const deadline = Date.now() + ${Number(timeout)};
            let el = null;
            while (Date.now() < deadline) {
              if (${JSON.stringify(selector ?? null)}) el = document.querySelector(${JSON.stringify(selector ?? '')});
              else {
                const sels = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';
                const all = Array.from(document.querySelectorAll(sels)).filter(e => { const s = window.getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && e.getBoundingClientRect().width > 0; });
                el = all[${Number(ref) - 1}];
              }
              if (el) break;
              await new Promise(r => setTimeout(r, 100));
            }
            if (!el) throw new Error('element not found: ' + (${JSON.stringify(selector ?? '')} || '@' + ${Number(ref)}));
            el.scrollIntoView({ block: 'center', inline: 'center' });
            el.click();
            return { ok: true, tag: el.tagName, label: (el.innerText || el.value || '').slice(0, 30) };
          })()`;
          const evalRes = await link.cdp(tabId, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
          if (evalRes.exceptionDetails) return json(400, { error: evalRes.exceptionDetails.exception?.description || 'click failed' });
          return json(200, evalRes.result.value);
        }

        // 高速入力 (POST /tabs/:tabId/fill)
        if (action === 'fill') {
          if (req.method !== 'POST') return json(405, { error: 'use POST' });
          const { selector, ref, value = '', timeout = 5000 } = await readJsonBody(req);
          const expr = `(async () => {
            const deadline = Date.now() + ${Number(timeout)};
            let el = null;
            while (Date.now() < deadline) {
              if (${JSON.stringify(selector ?? null)}) el = document.querySelector(${JSON.stringify(selector ?? '')});
              else {
                const sels = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';
                const all = Array.from(document.querySelectorAll(sels)).filter(e => { const s = window.getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && e.getBoundingClientRect().width > 0; });
                el = all[${Number(ref) - 1}];
              }
              if (el) break;
              await new Promise(r => setTimeout(r, 100));
            }
            if (!el) throw new Error('element not found: ' + (${JSON.stringify(selector ?? '')} || '@' + ${Number(ref)}));
            el.scrollIntoView({ block: 'center', inline: 'center' });
            el.focus();
            const val = ${JSON.stringify(value)};
            if ('value' in el) {
              let proto = el;
              let desc = null;
              while (proto) {
                desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc?.set) break;
                proto = Object.getPrototypeOf(proto);
              }
              if (desc?.set) desc.set.call(el, val); else el.value = val;
            } else if (el.isContentEditable) {
              el.innerText = val;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, tag: el.tagName, value: el.value ?? el.innerText };
          })()`;
          const evalRes = await link.cdp(tabId, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
          if (evalRes.exceptionDetails) return json(400, { error: evalRes.exceptionDetails.exception?.description || 'fill failed' });
          return json(200, evalRes.result.value);
        }

        // JS式評価 (POST /tabs/:tabId/eval)
        if (action === 'eval') {
          if (req.method !== 'POST') return json(405, { error: 'use POST' });
          const body = await readJsonBody(req);
          if (typeof body.expression !== 'string') return json(400, { error: 'expression (string) is required' });
          const timeout = Number(body.timeout || 15_000);
          const evalPromise = link.cdp(tabId, 'Runtime.evaluate', {
            expression: body.expression,
            returnByValue: body.returnByValue ?? true,
            awaitPromise: body.awaitPromise ?? true
          });
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`evaluate timed out after ${timeout}ms`)), timeout));
          const result = await Promise.race([evalPromise, timeoutPromise]);
          return json(200, result);
        }

        // 生CDP送信 (POST /tabs/:tabId/cdp)
        if (action === 'cdp') {
          if (req.method !== 'POST') return json(405, { error: 'use POST' });
          const body = await readJsonBody(req);
          if (typeof body.method !== 'string') return json(400, { error: 'method (string) is required' });
          if (body.params !== undefined && (typeof body.params !== 'object' || body.params === null || Array.isArray(body.params))) {
            return json(400, { error: 'params must be an object' });
          }
          const result = await link.clientCdp(tabId, body.method, body.params ?? {});
          return json(200, result);
        }
      } finally {
        link.off(onDetach);
        if (held) { held = false; await link.detach(tabId); }
      }
    }
    if (m[3] === 'reload-extension') {
      if (req.method !== 'POST') return json(405, { error: 'use POST' });
      if (fixedLink || !m[1]) return json(400, { error: 'use POST /b/<name>/reload-extension (the browser name is required)' });
      if (!link.hasFeature('reload')) return json(501, { error: `extension ${link.info?.version ?? '(unknown version)'} has no ext.reload; reload it once by hand from chrome://extensions` });
      await link.call('ext.reload');
      log(`extension reload requested: ${link.name} (was ${link.info.version})`);
      return json(200, { reloading: link.name, previousVersion: link.info.version });
    }
    const base = endpointBase(req, link, !!fixedLink);
    if (m[2] === 'version') {
      const info = await link.call('ext.info');
      const product = (info.userAgent.match(/Edg\/[\d.]+/) ?? info.userAgent.match(/Chrome\/[\d.]+/))?.[0] ?? 'Chrome';
      return json(200, { Browser: product, 'Protocol-Version': '1.3', 'User-Agent': info.userAgent, 'CDP-Relay-Browser': link.name, webSocketDebuggerUrl: `${base}/devtools/browser` });
    }
    const tabs = await link.call('ext.listTabs');
    const q = url.searchParams.get('q')?.toLowerCase();
    const filtered = q ? tabs.filter(t => (t.title + ' ' + t.url).toLowerCase().includes(q)) : tabs;
    return json(200, filtered.map(t => ({ id: t.targetId ?? `tab-${t.tabId}`, tabId: t.tabId, type: 'page', title: t.title, url: t.url, attached: t.attached, webSocketDebuggerUrl: `${base}/devtools/page/${t.tabId}`, devtoolsFrontendUrl: '' })));
  } catch (e) {
    const status = e.status ?? 500;
    log('http error', req.url, e.message);
    return json(status, { error: e.message });
  }
};

const wss = new WebSocketServer({ noServer: true });
const rejectUpgrade = (socket, code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nContent-Length: ${msg.length}\r\n\r\n${msg}`); socket.destroy(); };
const serveClient = (link, kind, tabId, ws) => {
  if (kind === 'browser') serveBrowserFacade(link, ws, log, TRACE);
  else servePage(link, tabId, ws).catch(e => { log('page error', e.message); ws.close(1011, e.message.slice(0, 120)); });
};

const server = http.createServer(httpHandler(null));
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const why = refuse(req, url.pathname === '/extension');
  if (why) { log(`refused upgrade ${url.pathname}: ${why}`); return rejectUpgrade(socket, 403, why); }
  if (url.pathname === '/extension') {
    if (TOKEN && !safeCompareToken(url.searchParams.get('token'), TOKEN)) return rejectUpgrade(socket, 403, 'bad token');
    const name = url.searchParams.get('name');
    const port = Number(url.searchParams.get('port')) || 0;
    if (!name) return rejectUpgrade(socket, 400, 'name required');
    return wss.handleUpgrade(req, socket, head, ws => registerExtension(name, port, ws));
  }
  if (!clientAuthorized(req)) { log(`refused upgrade ${url.pathname}: no valid client token`); return rejectUpgrade(socket, 401, 'client token required'); }
  const m = url.pathname.match(/^\/b\/([^/]+)\/devtools\/(browser|page\/(\d+))$/);
  const link = m && links.get(decodeURIComponent(m[1]));
  if (!link) return rejectUpgrade(socket, 404, 'browser not connected');
  wss.handleUpgrade(req, socket, head, ws => serveClient(link, m[2], Number(m[3]), ws));
});

function registerExtension(name, port, ws) {
  const prev = links.get(name);
  prev?.server?.close(); prev?.ws.close(4000, 'replaced by new connection');
  if (!agentTabsByName.has(name)) agentTabsByName.set(name, new Map());
  const link = new ExtensionLink(name, ws, agentTabsByName.get(name));
  link.port = port;
  links.set(name, link);
  log(`extension connected: ${name}${port ? ` (dedicated port ${port})` : ''}`);
  ws.on('close', () => { if (links.get(name) === link) links.delete(name); link.close(); link.server?.close(); log(`extension disconnected: ${name}`); });
  link.ready = link.call('ext.info').then(async info => {
    link.info = info;
    const missing = ['auth', 'downloads', 'contentSettings', 'reload', 'navigateTab'].filter(f => !link.hasFeature(f));
    log(`extension ${name}: version ${info.version}${missing.length ? `, unsupported: ${missing.join(', ')} (update extension/ and reload it)` : ''}`);
    // ブラウザを再起動すると tabId が振り直されるので、targetId が一致しなくなったエージェントのタブは忘れる
    const tabs = await link.call('ext.listTabs');
    for (const [tabId, targetId] of link.agentTabs) if (!tabs.some(t => t.tabId === tabId && (targetId === undefined || t.targetId === targetId))) link.agentTabs.delete(tabId);
    for (const tabId of link.agentTabs.keys()) link.watch(tabId); // 拡張の SW が再起動すると attach は外れている(起動時に孤児を detach する)
    await link.autopilot.onConnected();
  }).catch(e => log(`extension ${name}: setup failed: ${e.stack}`));
  if (!port) return;
  // ブラウザ専用ポート: /json/version 等をこのブラウザ固定で提供する。
  // 開けなくても /b/<name> 経由では使えるので、接続は切らずに理由だけ残す(切ると再接続ループになって何も使えない)
  const failPort = why => { link.server = null; link.portError = why; log(`dedicated port ${port} for ${name} unavailable: ${why}`); };
  if (port === PORT) return failPort(`same as the relay port ${PORT}`);
  const dedicated = http.createServer(httpHandler(link));
  dedicated.on('upgrade', (req, socket, head) => {
    const why = refuse(req);
    if (why) { log(`refused upgrade on port ${port}: ${why}`); return rejectUpgrade(socket, 403, why); }
    if (!clientAuthorized(req)) { log(`refused upgrade on port ${port}: no valid client token`); return rejectUpgrade(socket, 401, 'client token required'); }
    const m = new URL(req.url, `http://${HOST}:${port}`).pathname.match(/^\/devtools\/(browser|page\/(\d+))$/);
    if (!m) return rejectUpgrade(socket, 404, 'not found');
    wss.handleUpgrade(req, socket, head, ws2 => serveClient(link, m[1], Number(m[2]), ws2));
  });
  dedicated.on('error', e => failPort(e.code ?? e.message));
  dedicated.listen(port, HOST);
  link.server = dedicated;
}

/** ページ WS: chrome.debugger への素通し(sessionId は flatten 子セッション用にそのまま渡す) */
async function servePage(link, tabId, ws) {
  link.adopt(tabId, 'page WebSocket'); // 明示的に接続したタブはエージェントのタブ
  // 自分の参照を持っている間だけ close で返す。attach に失敗した・ブラウザ側から detach された後に返すと、他のクライアントや watch の参照を減らしてしまう
  // (close は相手の応答を最大 30 秒待つので、その間に同じタブへ別のクライアントが繋ぐことがある)
  let held = false, closed = false;
  const attached = link.attach(tabId).then(() => { if (closed) link.detach(tabId); else held = true; }); // attach 完了前に届いたコマンドも取りこぼさないよう、先にハンドラを登録して待たせる
  const listener = (ev, m) => {
    if (ev === 'cdp.event' && m.tabId === tabId) ws.send(JSON.stringify({ method: m.method, params: m.params, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    else if ((ev === 'ext.detached' || ev === 'ext.tabRemoved') && m.tabId === tabId) { held = false; ws.close(1001, `tab ${ev}`); }
    else if (ev === 'link.closed') ws.close(1001, 'extension disconnected');
  };
  link.on(listener);
  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const reply = body => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), ...body }));
    try { await attached; reply({ result: await link.clientCdp(tabId, msg.method, msg.params, msg.sessionId) }); }
    catch (e) { reply({ error: { code: -32000, message: e.message } }); }
  });
  ws.on('close', () => { closed = true; link.off(listener); if (held) { held = false; link.detach(tabId); } });
  await attached;
}

server.listen(PORT, HOST, () => {
  log(`cdp-relay listening on http://${HOST}:${PORT} (extension token ${TOKEN ? 'required' : 'not set'}, client auth ${CLIENT_TOKEN ? `required, token file ${clientTokenPath(PORT)}` : 'off'})`); getPolicy(log);
  // TCP のポートを取れた(= 同じポートの中継は他にいない)ので、前回の中継が残したソケットファイルは消してよい
  // (Windows の名前付きパイプはファイルとして残らず、所有プロセスの終了で消える。権限は既定の ACL: Microsoft の CreateNamedPipe の説明では作成者・管理者がフル、Everyone は読み取りのみ)
  const INFO = statePath('.json', PORT);
  mkdirSync(dirname(INFO), { recursive: true, mode: 0o700 });
  if (!WINDOWS) rmSync(AGENT_SOCKET, { force: true });
  const agentServer = net.createServer(conn => serveAgent(conn, { links, log }));
  agentServer.listen(AGENT_SOCKET, () => { if (!WINDOWS) chmodSync(AGENT_SOCKET, 0o600); log(`agent socket ${AGENT_SOCKET}`); });
  // MCP シムが、中継が落ちているときに起こし直すための情報(launchd の常駐なら kickstart、それ以外は同じ node・同じ CDP_RELAY_* の設定で起動し直す。
  // 設定を引き継がないと、クライアント認証やトークン付きで起動した中継が、起こし直したときに認証なしに戻る)。
  // launchd は起動したジョブの環境変数 XPC_SERVICE_NAME にラベルを入れる(手で起動したシェルでは "0" か未設定)
  const label = process.env.XPC_SERVICE_NAME;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CDP_RELAY_')));
  writeFileSync(INFO, JSON.stringify({ port: PORT, pid: process.pid, node: process.execPath, server: fileURLToPath(import.meta.url), env, ...(label && label !== '0' ? { launchdLabel: label } : {}) }, null, 1) + '\n', { mode: 0o600 });
  agentServer.on('error', e => log(`agent socket ${AGENT_SOCKET} unavailable: ${e.message}`));
});
// policy.json の permissions が変わったら、接続中のブラウザへ適用し直す(他の項目は参照のたびに読み直している)
let lastPermissions = JSON.stringify(getPolicy(log).permissions);
watchFile(POLICY_PATH, { interval: POLICY_WATCH_MS }, () => {
  const now = JSON.stringify(getPolicy(log).permissions);
  if (now === lastPermissions) return;
  lastPermissions = now;
  for (const l of links.values()) if (l.info) l.autopilot.onConnected().catch(e => log(`${l.name}: reapplying permissions failed: ${e.message}`));
});
