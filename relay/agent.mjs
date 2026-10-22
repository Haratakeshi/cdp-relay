// エージェント向けの操作面(MCP シム plugin/cdp-relay/mcp/server.mjs の相手)。
// 中継の Unix ドメインソケット(0600 = ファイル権限がローカルの認証)で 1 接続 = 1 セッション。改行区切り JSON {id, method, params} → {id, result} | {id, error:{message, hint, data}}。
// セッションは自分のタブを "t1" 等のハンドルで持ち、接続が切れたら(エージェントの終了)後始末する: 残すタブは人に引き渡し(エージェントのタブから外して detach =
// インフォバーが消え、自動処理の対象からも外れる)、閉じるかどうかはエージェントが session_end / tab_close で決める。
// 操作は puppeteer を通さず CDP を直接使う。ref はアクセシビリティツリーの backendDOMNodeId に、取得時の文書(frame の loaderId)を結び付けて持ち、
// 文書が変わった・要素が消えた ref では操作しない(別の要素を押さない)。クリック・キー入力は Input.* の信頼されたイベントで送る
import { getPolicy } from './policy.mjs';
import { readProfiles, openProfile } from './profiles.mjs';

const CDP_TIMEOUT_MS = 10_000;     // 1 コマンドの上限(ダイアログで固まったタブに CALL_TIMEOUT 60 秒も待たせない)
const NAV_TIMEOUT_MS = 20_000;     // goto / クリック後の読み込み完了待ちの上限
const WAKE_TIMEOUT_MS = 2_000;     // 撮影前にスクリーンキャストの最初のフレームを待つ上限(wakeRenderer)
const WAIT_TIMEOUT_MS = 10_000;    // wait_for の既定
const SETTLE_MS = 150;             // クリック・キー入力の後、遷移が始まるかを見る時間
const POLL_MS = 200;               // wait_for の確認間隔
const SNAPSHOT_CHARS = 12_000;     // snapshot の既定の上限(トークン節約)
const READ_CHARS = 8_000;          // read の既定の上限
const EVAL_CHARS = 4_000;          // eval の結果の上限
const NAME_CHARS = 80;             // snapshot の 1 要素の名前の上限
const TEXT_CHARS = 200;            // full モードの文字列 1 つの上限(全文は read で読む)
const VALUE_CHARS = 40;            // snapshot の入力値の上限
const TAB_LIST_MAX = 60;           // tab_list で返すタブ数の上限
const RESTORE_WAIT_MS = 10_000;    // 中継の再起動直後、拡張が繋ぎ直すのを待つ上限(拡張の再接続は 1, 2, 4… 秒のバックオフ)
const OBJECT_GROUP = 'cdp-relay-agent';
// 操作できる要素とみなすロール(focusable な要素も含める)
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'textField', 'TextField', 'PopUpButton', 'ListBoxOption', 'MenuListPopup', 'MenuListOption', 'DisclosureTriangle']);
// 構造として見せる(interactive モードでも出す)ロール
const CONTEXT = new Set(['heading', 'dialog', 'alertdialog', 'alert', 'status']);
// full モードで名前があれば出すロール
const NAMED = new Set([...CONTEXT, 'img', 'image', 'cell', 'columnheader', 'rowheader', 'navigation', 'main', 'form', 'region', 'tabpanel', 'list', 'table', 'row', 'paragraph', 'banner', 'contentinfo', 'complementary', 'article', 'group']);
const STATES = ['disabled', 'checked', 'pressed', 'expanded', 'selected', 'required', 'focused', 'readonly', 'invalid'];
// press で使うキー(key, code, keyCode, text)
const KEYS = {
  Enter: ['Enter', 'Enter', 13, '\r'], Tab: ['Tab', 'Tab', 9], Escape: ['Escape', 'Escape', 27], Backspace: ['Backspace', 'Backspace', 8], Delete: ['Delete', 'Delete', 46],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowRight: ['ArrowRight', 'ArrowRight', 39], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  Home: ['Home', 'Home', 36], End: ['End', 'End', 35], PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34], Space: [' ', 'Space', 32, ' '],
};
const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** エージェントに返すエラー。hint は次の一手、data は途中経過(act の実行済みステップ等) */
export class AgentError extends Error {
  constructor(message, hint, data) { super(message); this.hint = hint; this.data = data; }
}
const stale = (ref, why) => new AgentError(`ref ${ref} is stale (${why})`, 'take a new snapshot and use the refs from it; never reuse refs after navigation');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new AgentError(`${what} timed out after ${ms}ms`,
  'the page may be blocked by a dialog or heavy script; check events, then retry or take a new snapshot')), ms))]);
const flattenFrames = (ft, parentId) => [{ id: ft.frame.id, loaderId: ft.frame.loaderId, url: ft.frame.url, parentId }, ...(ft.childFrames ?? []).flatMap(c => flattenFrames(c, ft.frame.id))];
const center = q => [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4];

let nextSessionId = 0;

/**
 * 1 接続 = 1 セッション。conn は改行区切り JSON の双方向ストリーム(net.Socket)。ctx = { links: Map<name, ExtensionLink>, log }
 */
export function serveAgent(conn, ctx) {
  const session = new Session(++nextSessionId, ctx);
  let buf = '';
  conn.setEncoding('utf8');
  const send = obj => { if (!conn.destroyed) conn.write(JSON.stringify(obj) + '\n'); };
  conn.on('data', chunk => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      session.dispatch(msg.method, msg.params ?? {})
        .then(result => send({ id: msg.id, result }))
        .catch(e => {
          if (!(e instanceof AgentError)) ctx.log(`agent session ${session.id}: ${msg.method} failed: ${e.stack}`);
          send({ id: msg.id, error: { message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.data ? { data: e.data } : {}) } });
        });
    }
  });
  conn.on('close', () => session.end({ closeTabs: false, reason: 'agent disconnected' }).catch(e => ctx.log(`agent session ${session.id}: cleanup failed: ${e.message}`)));
  conn.on('error', () => {});
}

class Session {
  constructor(id, ctx) {
    this.id = id; this.ctx = ctx; this.agent = 'agent'; this.ended = false;
    this.tabs = new Map(); // handle -> TabRec
    this.nextHandle = 0;
    this.listening = new Set(); // detach / タブ削除を見ている ExtensionLink
  }
  log(msg) { this.ctx.log(`agent session ${this.id} (${this.agent}): ${msg}`); }

  async dispatch(method, p) {
    if (this.ended && method !== 'session_end') throw new AgentError('session already ended', 'restart the MCP server (or call any tool again to start a new session)');
    const fn = this.methods[method];
    if (!fn) throw new AgentError(`unknown method: ${method}`);
    return fn.call(this, p);
  }

  // ---------- タブの保持 ----------
  link(browser) {
    const link = this.ctx.links.get(browser);
    if (!link) throw new AgentError(`browser "${browser}" is not connected`, 'call browser_list; if it shows offline, call browser_open');
    return link;
  }
  tab(handle) {
    const t = this.tabs.get(handle);
    if (!t) throw new AgentError(`unknown tab handle "${handle}"`, `this session's tabs: ${[...this.tabs.keys()].join(', ') || 'none'} (use tab_open or tab_adopt)`);
    if (t.closed) throw new AgentError(`tab ${handle} has been closed`, 'use tab_open to open a new tab');
    return t;
  }
  /** タブを attach 済み・エージェントのタブにしておく(拡張の再接続やブラウザ側からの detach の後は付け直す) */
  async ensure(t) {
    const link = this.link(t.browser);
    if (t.link !== link || !t.held) {
      this.listen(link);
      link.adopt(t.tabId, `agent session ${this.id}`);
      await link.attach(t.tabId);
      t.link = link; t.held = true;
      // 背面のタブ(visibilityState: hidden)には Input.dispatchMouseEvent / dispatchKeyEvent が届かない(実ブラウザ Chrome 152 で実測。ヘッドレスでは再現しない)。
      // フォーカスのエミュレーションを有効にすると、タブを前面に出さずにページが visible になり、信頼されたイベントが届く(同実測)。detach で元に戻る
      await withTimeout(link.cdp(t.tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }), CDP_TIMEOUT_MS, 'Emulation.setFocusEmulationEnabled');
    }
    return link;
  }
  listen(link) {
    if (this.listening.has(link)) return;
    this.listening.add(link);
    link.on((ev, m) => {
      if (ev !== 'ext.detached' && ev !== 'ext.tabRemoved') return;
      for (const t of this.tabs.values()) if (t.link === link && t.tabId === m.tabId) { t.held = false; if (ev === 'ext.tabRemoved') t.closed = true; }
    });
  }
  /** 自分の attach の参照を返す(リンクが入れ替わっていたら、新しいリンクには参照を持っていない) */
  async release(t) {
    if (t.held && t.link === this.ctx.links.get(t.browser)) await t.link.detach(t.tabId);
    t.held = false;
  }
  /** 人に引き渡す: このセッションがエージェントのタブにしたものは外し(自動処理の対象外・detach)、開いたまま残す */
  async handoff(t) {
    const link = this.ctx.links.get(t.browser);
    if (link && !t.wasAgent && !t.closed) link.unadopt(t.tabId);
    await this.release(t);
    this.tabs.delete(t.handle);
  }
  async close(t) {
    const link = this.ctx.links.get(t.browser);
    if (link && !t.closed) await link.call('ext.closeTab', { tabId: t.tabId }).catch(e => { if (!/No tab with id/i.test(e.message)) throw e; });
    t.closed = true; t.held = false;
    this.tabs.delete(t.handle);
  }
  addTab(browser, tabId, created, wasAgent) {
    const t = { handle: `t${++this.nextHandle}`, browser, tabId, created, wasAgent, link: null, held: false, closed: false, refs: new Map(), refKeys: new Map(), nextRef: 0, lastLines: null, lastLoader: null };
    this.tabs.set(t.handle, t);
    return t;
  }
  tabSummary(t) { return { tab: t.handle, browser: t.browser, tab_id: t.tabId }; }

  async end({ closeTabs, reason }) {
    if (this.ended) return { closed: [], left_open: [] };
    this.ended = true;
    const closed = [], left = [];
    for (const t of [...this.tabs.values()]) {
      const close = closeTabs === true || (Array.isArray(closeTabs) && closeTabs.includes(t.handle));
      try {
        if (close) { await this.close(t); closed.push(t.handle); }
        else { const info = await this.info(t).catch(() => ({})); await this.handoff(t); if (!t.closed) left.push({ tab: t.handle, ...info }); }
      } catch (e) { this.log(`cleanup ${t.handle} failed: ${e.message}`); }
    }
    this.log(`ended (${reason}); closed ${closed.length}, left open ${left.length}`);
    return { closed, left_open: left };
  }

  // ---------- CDP の下回り ----------
  cdp(t, method, params = {}, timeout = CDP_TIMEOUT_MS) { return withTimeout(t.link.cdp(t.tabId, method, params), timeout, method); }
  async frames(t) { return flattenFrames((await this.cdp(t, 'Page.getFrameTree')).frameTree); }
  async info(t) {
    const link = this.ctx.links.get(t.browser);
    const tab = link && (await link.call('ext.listTabs')).find(x => x.tabId === t.tabId);
    return tab ? { title: tab.title, url: tab.url } : {};
  }
  callOn(t, objectId, fn, args = []) {
    return this.cdp(t, 'Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args, returnByValue: true, awaitPromise: true })
      .then(r => { if (r.exceptionDetails) throw new AgentError(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; });
  }
  /** ref → 生きている要素(取得時と同じ文書で、まだ DOM に繋がっている)の objectId */
  async resolve(t, ref) {
    const r = t.refs.get(ref);
    if (!r) throw stale(ref, 'not in the latest snapshot of this tab');
    const frame = (await this.frames(t)).find(f => f.id === r.frameId);
    if (!frame || frame.loaderId !== r.loaderId) throw stale(ref, 'the page has navigated since the snapshot');
    let objectId;
    try { objectId = (await this.cdp(t, 'DOM.resolveNode', { backendNodeId: r.backendNodeId, objectGroup: OBJECT_GROUP })).object.objectId; }
    catch { throw stale(ref, 'the element no longer exists'); }
    if (!await this.callOn(t, objectId, 'function(){return this.isConnected}')) throw stale(ref, 'the element was removed from the page');
    return { ...r, ref, objectId };
  }
  /** 見えている中心点。別の要素(オーバーレイ等)に覆われていたらクリックしない */
  async point(t, el) {
    await this.cdp(t, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendNodeId }).catch(() => {});
    const { quads } = await this.cdp(t, 'DOM.getContentQuads', { backendNodeId: el.backendNodeId }).catch(() => ({ quads: [] }));
    if (!quads.length) throw new AgentError(`${el.ref} has no visible box (hidden or zero-size)`, 'take a new snapshot; the element may need a menu or section to be opened first');
    const [x, y] = center(quads[0]);
    const hit = await this.cdp(t, 'DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), ignorePointerEventsNone: true }).catch(() => null);
    if (hit && hit.backendNodeId !== el.backendNodeId) {
      const hitObj = (await this.cdp(t, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId, objectGroup: OBJECT_GROUP })).object.objectId;
      // shadow DOM をまたいで、当たった要素が目的の要素の中(子孫)かを見る
      const inside = await this.callOn(t, el.objectId, 'function(o){let n=o;while(n){if(n===this)return true;n=n.parentNode||n.host}return false}', [{ objectId: hitObj }]);
      if (!inside) {
        const what = await this.callOn(t, hitObj, 'function(){const e=this.nodeType===1?this:this.parentElement;return e?(e.tagName.toLowerCase()+(e.id?"#"+e.id:"")+(e.className&&typeof e.className==="string"?"."+e.className.trim().split(/\\s+/).slice(0,2).join("."):"")+" \\""+(e.innerText||"").trim().slice(0,40)+"\\""):"?"}');
        throw new AgentError(`${el.ref} (${el.role} "${el.name}") is covered by ${what}`, 'close the dialog/overlay covering it (snapshot shows it), then retry');
      }
    }
    return { x, y };
  }
  /** HumanGate: 不可逆に見える操作は、エージェントが人の確認を取った印(confirmed: true)が無ければ実行しない */
  gate(el, step) {
    const pattern = getPolicy(this.ctx.log).humanGatePattern;
    if (!pattern || step.confirmed === true) return;
    if (new RegExp(pattern, 'i').test(el.name ?? '')) {
      throw new AgentError(`HumanGate: ${el.ref} (${el.role} "${el.name}") looks irreversible (send/delete/purchase/publish…); not clicked`,
        'stop and ask the user to approve this exact action; only after they approve, retry this step with "confirmed": true');
    }
  }
  async mouse(t, x, y, type, extra = {}) { await this.cdp(t, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra }); }
  async key(t, spec) {
    const parts = spec.split('+'); const name = parts.pop();
    const modifiers = parts.reduce((m, p) => m | (MODIFIERS[p] ?? (() => { throw new AgentError(`unknown modifier ${p}`, `use ${Object.keys(MODIFIERS).join(', ')}`); })()), 0);
    let def = KEYS[name];
    if (!def && [...name].length === 1) def = [name, /[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : '', name.toUpperCase().charCodeAt(0), name];
    if (!def) throw new AgentError(`unknown key ${name}`, `use one character or ${Object.keys(KEYS).join(', ')}`);
    const [key, code, keyCode, text] = def;
    const typed = text !== undefined && !(modifiers & (MODIFIERS.Control | MODIFIERS.Meta)); // ショートカットでは文字を入力しない
    await this.cdp(t, 'Input.dispatchKeyEvent', { type: typed ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(typed ? { text, unmodifiedText: text } : {}) });
    await this.cdp(t, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  }
  /**
   * 撮影の前に描画を起こす。Windows では背面タブの Page.captureScreenshot がフレームを待ったまま止まり、直前の撮影や遷移の直後には
   * 20 秒でタイムアウトする(CI の windows-latest で実測。前面タブと macOS では起きない)。スクリーンキャストを始めて最初のフレームを受け取ってから
   * 撮ると、表示範囲・要素の範囲・ページ全体のどれも約 50ms で撮れた(test/exp-screenshot-background.mjs)。フレームが来なくても撮影は試す
   */
  async wakeRenderer(t) {
    let fn;
    const frame = new Promise(res => { fn = (ev, m) => { if (ev === 'cdp.event' && m.tabId === t.tabId && !m.sessionId && m.method === 'Page.screencastFrame') res(m.params.sessionId); }; });
    t.link.on(fn);
    try {
      await this.cdp(t, 'Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 });
      const sessionId = await withTimeout(frame, WAKE_TIMEOUT_MS, 'Page.screencastFrame').catch(() => null);
      if (sessionId !== null) await this.cdp(t, 'Page.screencastFrameAck', { sessionId }).catch(() => {});
    } finally { t.link.off(fn); }
  }
  /** メインフレームの読み込みを見張る(act / goto の間だけ) */
  watchNav(t) {
    const st = { started: false, done: false, url: null };
    let main;
    const fn = (ev, m) => {
      if (ev !== 'cdp.event' || m.tabId !== t.tabId || m.sessionId) return;
      const fid = m.params?.frameId ?? m.params?.frame?.id;
      if (m.method === 'Page.frameStartedLoading' && (!main || fid === main)) { st.started = true; st.done = false; }
      else if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) { main = m.params.frame.id; st.url = m.params.frame.url; }
      else if ((m.method === 'Page.frameStoppedLoading' && (!main || fid === main)) || m.method === 'Page.loadEventFired') st.done = true;
    };
    t.link.on(fn);
    this.frames(t).then(fs => { main ??= fs[0]?.id; }).catch(() => {});
    return { st, stop: () => t.link.off(fn) };
  }
  async settle(nav, timeout = NAV_TIMEOUT_MS) {
    await sleep(SETTLE_MS);
    const deadline = Date.now() + timeout;
    while (nav.st.started && !nav.st.done && Date.now() < deadline) await sleep(50);
    return nav.st.started ? (nav.st.done ? 'loaded' : 'still loading') : 'no navigation';
  }

  // ---------- snapshot ----------
  async snapshot(t, { mode = 'interactive', query, max_chars = SNAPSHOT_CHARS } = {}) {
    const frames = await this.frames(t);
    const loaders = new Set(frames.map(f => f.loaderId));
    const navigated = t.lastLoader !== frames[0].loaderId;
    const lines = [];
    let title = '';
    for (const f of frames) {
      let nodes;
      try { nodes = (await this.cdp(t, 'Accessibility.getFullAXTree', f.parentId ? { frameId: f.id } : {})).nodes; }
      catch (e) { if (!f.parentId) throw e; lines.push(`- iframe ${clip(f.url, NAME_CHARS)} (not accessible: ${clip(e.message, 60)})`); continue; } // 別プロセスの iframe 等
      if (!f.parentId) title = nodes[0]?.name?.value ?? '';
      lines.push(...this.render(t, nodes, f, mode === 'full', f.parentId ? 1 : 0, f.parentId ? `iframe ${clip(f.url, NAME_CHARS)}` : null));
    }
    for (const [ref, r] of t.refs) if (!loaders.has(r.loaderId)) { t.refs.delete(ref); t.refKeys.delete(`${r.loaderId}:${r.backendNodeId}`); } // 消えた文書の ref は捨てる
    const header = `[${t.handle}] "${clip(title, NAME_CHARS)}" ${frames[0].url}`;
    const prev = t.lastLines;
    if (mode !== 'full') { t.lastLines = lines; t.lastLoader = frames[0].loaderId; }
    let body = lines;
    let note = '';
    if (mode === 'diff') {
      if (!prev || navigated) note = navigated && prev ? '(navigated: full interactive snapshot)' : '(no previous snapshot: full interactive snapshot)';
      else {
        const count = ls => ls.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
        const a = count(prev), b = count(lines);
        const removed = prev.filter(l => { const n = b.get(l); if (n) { b.set(l, n - 1); return false; } return true; });
        const added = lines.filter(l => { const n = a.get(l); if (n) { a.set(l, n - 1); return false; } return true; });
        body = [...removed.map(l => `- ${l.trim()}`), ...added.map(l => `+ ${l.trim()}`)];
        note = body.length ? `(diff since previous snapshot: ${added.length} added, ${removed.length} removed)` : '(no changes since previous snapshot)';
      }
    }
    if (query) { const q = query.toLowerCase(); body = body.filter(l => l.toLowerCase().includes(q)); note += ` (filtered by "${query}")`; }
    let text = [header + (note ? ` ${note}` : ''), ...body].join('\n');
    if (text.length > max_chars) {
      const cut = text.lastIndexOf('\n', max_chars);
      const rest = text.slice(cut + 1).split('\n').length;
      text = `${text.slice(0, cut)}\n… ${rest} more lines truncated (use query to filter, mode "diff", or read for text)`;
    }
    return text;
  }
  /** AX ノード → 1 行ずつ。操作できる要素には ref を振る(同じ文書の同じ要素には同じ ref) */
  render(t, nodes, frame, full, baseDepth, label) {
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const out = label ? [`- ${label}:`] : [];
    const prop = (n, k) => n.properties?.find(p => p.name === k)?.value?.value;
    const walk = (n, depth, quiet) => {
      if (!n) return;
      const role = n.role?.value ?? '';
      const name = clip(n.name?.value, NAME_CHARS);
      const interactive = !n.ignored && n.backendDOMNodeId !== undefined && (INTERACTIVE.has(role) || (prop(n, 'focusable') && !['RootWebArea', 'WebArea', 'Iframe', 'IframePresentational'].includes(role)));
      let emitted = false;
      if (!n.ignored && role !== 'RootWebArea') {
        if (interactive) {
          const key = `${frame.loaderId}:${n.backendDOMNodeId}`;
          let ref = t.refKeys.get(key);
          if (!ref) { ref = `e${++t.nextRef}`; t.refKeys.set(key, ref); }
          t.refs.set(ref, { backendNodeId: n.backendDOMNodeId, frameId: frame.id, loaderId: frame.loaderId, role, name });
          const states = STATES.filter(s => { const v = prop(n, s); return v === true || v === 'true' || v === 'mixed'; });
          const value = n.value?.value;
          out.push(`${'  '.repeat(depth)}- ${role} "${name}" [${ref}]${value !== undefined && value !== '' && value !== name ? ` value="${clip(value, VALUE_CHARS)}"` : ''}${states.length ? ` (${states.join(', ')})` : ''}`);
          emitted = true;
        } else if (CONTEXT.has(role) || (full && NAMED.has(role) && name)) {
          const level = prop(n, 'level');
          out.push(`${'  '.repeat(depth)}- ${role}${level ? ` ${level}` : ''}${name ? ` "${name}"` : ''}`);
          emitted = true;
        } else if (full && role === 'StaticText' && name && !quiet) {
          out.push(`${'  '.repeat(depth)}- text: ${clip(n.name.value, TEXT_CHARS)}`);
        }
      }
      // 名前を出した要素の中の文字列は名前と重複するので出さない
      const childQuiet = quiet || (emitted && !!name);
      for (const c of n.childIds ?? []) walk(byId.get(c), depth + (emitted && full ? 1 : 0), childQuiet);
    };
    walk(nodes[0], baseDepth, false);
    return out;
  }

  // ---------- act ----------
  async step(t, s, nav) {
    if (s.goto !== undefined) {
      const r = await this.cdp(t, 'Page.navigate', { url: s.goto });
      if (r.errorText) throw new AgentError(`navigation to ${s.goto} failed: ${r.errorText}`, /data:/.test(s.goto) ? 'data: URLs cannot be opened through the extension; use http(s)' : 'check the URL');
      if (r.loaderId && !nav.st.started) { nav.st.started = true; nav.st.done = false; } // 通常は応答より先に frameStartedLoading が届いている
      return { goto: s.goto, load: await this.settle(nav) };
    }
    if (s.click !== undefined) {
      const el = await this.resolve(t, s.click);
      this.gate(el, s);
      const { x, y } = await this.point(t, el);
      await this.mouse(t, x, y, 'mouseMoved');
      await this.mouse(t, x, y, 'mousePressed', { clickCount: 1 });
      await this.mouse(t, x, y, 'mouseReleased', { clickCount: 1 });
      return { click: s.click, target: `${el.role} "${el.name}"`, load: await this.settle(nav) };
    }
    if (s.fill !== undefined) {
      const el = await this.resolve(t, s.fill);
      if (typeof s.value !== 'string') throw new AgentError('fill needs "value" (string)');
      const kind = await this.callOn(t, el.objectId, `function(){
        if (this.tagName === 'SELECT') return 'select';
        this.focus();
        if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        else if (typeof this.select === 'function') this.select();
        return 'text';
      }`);
      if (kind === 'select') throw new AgentError(`${el.ref} is a <select>`, 'use {"select": ref, "value": "<option value or label>"}');
      if (s.value === '') await this.key(t, 'Delete'); else await this.cdp(t, 'Input.insertText', { text: s.value });
      const value = await this.callOn(t, el.objectId, 'function(){return this.type==="password"?"(hidden)":("value" in this?this.value:this.innerText)}');
      return { fill: s.fill, value: clip(value, VALUE_CHARS) };
    }
    if (s.select !== undefined) {
      const el = await this.resolve(t, s.select);
      const picked = await this.callOn(t, el.objectId, `function(v){
        if (this.tagName !== 'SELECT') throw new Error('not a <select>; click it and choose an option instead');
        const o = [...this.options].find(o => o.value === v) ?? [...this.options].find(o => o.label.trim() === v);
        if (!o) throw new Error('no option ' + JSON.stringify(v) + '; options: ' + [...this.options].map(o => o.label.trim()).slice(0, 20).join(' | '));
        this.value = o.value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true }));
        return o.label.trim();
      }`, [{ value: String(s.value ?? '') }]);
      return { select: s.select, selected: picked, load: await this.settle(nav) };
    }
    if (s.press !== undefined) {
      if (s.ref) { const el = await this.resolve(t, s.ref); await this.callOn(t, el.objectId, 'function(){this.focus()}'); }
      for (const k of String(s.press).split(' ').filter(Boolean)) await this.key(t, k);
      return { press: s.press, load: await this.settle(nav) };
    }
    if (s.type !== undefined) { // フォーカス中の要素へ文字列を入力(fill と違って既存の値を消さない)
      if (s.ref) { const el = await this.resolve(t, s.ref); await this.callOn(t, el.objectId, 'function(){this.focus()}'); }
      await this.cdp(t, 'Input.insertText', { text: String(s.type) });
      return { type: clip(s.type, VALUE_CHARS) };
    }
    if (s.hover !== undefined) {
      const el = await this.resolve(t, s.hover);
      const { x, y } = await this.point(t, el);
      await this.mouse(t, x, y, 'mouseMoved');
      return { hover: s.hover };
    }
    if (s.scroll !== undefined) {
      if (s.scroll === 'up' || s.scroll === 'down') {
        const { cssLayoutViewport: v } = await this.cdp(t, 'Page.getLayoutMetrics');
        await this.mouse(t, v.clientWidth / 2, v.clientHeight / 2, 'mouseWheel', { deltaX: 0, deltaY: (s.scroll === 'down' ? 1 : -1) * v.clientHeight * 0.8 });
      } else {
        const el = await this.resolve(t, s.scroll);
        await this.cdp(t, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendNodeId });
      }
      await sleep(SETTLE_MS);
      return { scroll: s.scroll };
    }
    if (s.wait_for !== undefined) return { wait_for: s.wait_for, ...(await this.waitFor(t, s.wait_for)) };
    throw new AgentError(`unknown step ${JSON.stringify(s).slice(0, 80)}`, 'each step is one of goto, click, fill, select, press, type, hover, scroll, wait_for');
  }
  async waitFor(t, w) {
    const timeout = w.timeout_ms ?? WAIT_TIMEOUT_MS;
    if (w.ms !== undefined) { await sleep(Math.min(w.ms, timeout)); return { waited_ms: w.ms }; }
    const deadline = Date.now() + timeout;
    const expr = `(() => { const tx = document.body ? document.body.innerText : ''; return {
      text: ${JSON.stringify(w.text ?? null)} === null || tx.includes(${JSON.stringify(w.text ?? '')}),
      gone: ${JSON.stringify(w.text_gone ?? null)} === null || !tx.includes(${JSON.stringify(w.text_gone ?? '')}),
      url: ${JSON.stringify(w.url_includes ?? null)} === null || location.href.includes(${JSON.stringify(w.url_includes ?? '')}) }; })()`;
    while (Date.now() < deadline) {
      const r = await this.cdp(t, 'Runtime.evaluate', { expression: expr, returnByValue: true }, Math.max(1, deadline - Date.now())).catch(() => null);
      const v = r?.result?.value;
      if (v && v.text && v.gone && v.url) return { met: true };
      await sleep(POLL_MS);
    }
    throw new AgentError(`wait_for ${JSON.stringify(w)} not met within ${timeout}ms`, 'take a snapshot to see the current state');
  }

  // ---------- 公開メソッド(MCP ツールと 1 対 1) ----------
  methods = {
    async 'session.hello'({ agent, restore = [] }) {
      this.agent = clip(agent || 'agent', 40);
      // MCP シムが中継の再起動を挟んで繋ぎ直したとき、前のセッションのタブを引き継ぐ(まだ存在するものだけ)
      const restored = [];
      const deadline = Date.now() + RESTORE_WAIT_MS;
      while (restore.some(r => !this.ctx.links.get(r.browser)?.info) && Date.now() < deadline) await sleep(POLL_MS);
      for (const r of restore) {
        const link = this.ctx.links.get(r.browser);
        if (!link || !(await link.call('ext.listTabs').catch(() => [])).some(x => x.tabId === r.tab_id)) continue;
        const t = this.addTab(r.browser, r.tab_id, !!r.created, !!r.was_agent);
        this.tabs.delete(t.handle); t.handle = r.tab; this.tabs.set(t.handle, t);
        this.nextHandle = Math.max(this.nextHandle, Number(r.tab.slice(1)) || 0);
        restored.push(t.handle);
      }
      this.log(`started${restored.length ? ` (restored ${restored.join(', ')})` : ''}`);
      return { session: this.id, restored };
    },
    async browser_list() {
      const browsers = [...this.ctx.links.values()].map(l => ({ name: l.name, status: 'online', agent_tabs: l.agentTabs.size }));
      for (const [name, p] of Object.entries(readProfiles())) if (!this.ctx.links.has(name)) browsers.push({ name, status: 'offline', open_with: `browser_open {"name":"${name}"}`, app: p.app });
      return { browsers, scope: getPolicy(this.ctx.log).scope };
    },
    async browser_open({ name, app, profile }) {
      return openProfile({ name, app, profile }, async () => [...this.ctx.links.keys()]);
    },
    async tab_list({ browser, query }) {
      const link = this.link(browser);
      const mine = new Map([...this.tabs.values()].filter(t => t.browser === browser).map(t => [t.tabId, t.handle]));
      let tabs = (await link.call('ext.listTabs')).map(x => ({ tab_id: x.tabId, ...(mine.has(x.tabId) ? { tab: mine.get(x.tabId) } : {}), title: clip(x.title, NAME_CHARS), url: x.url, active: x.active, agent_tab: link.agentTabs.has(x.tabId) }));
      if (query) { const q = query.toLowerCase(); tabs = tabs.filter(x => `${x.title} ${x.url}`.toLowerCase().includes(q)); }
      return { count: tabs.length, tabs: tabs.slice(0, TAB_LIST_MAX), ...(tabs.length > TAB_LIST_MAX ? { note: `showing ${TAB_LIST_MAX}; pass query to narrow` } : {}) };
    },
    async tab_open({ browser, url, active = false, snapshot = true }) {
      const link = this.link(browser);
      // about:blank で作ってエージェントのタブにしてから遷移する(読み込み直後のダイアログや 401 を自動処理の対象にするため。facade の createTarget と同じ)
      const info = await link.call('ext.createTab', { url: 'about:blank', active });
      const t = this.addTab(browser, info.tabId, true, false);
      await this.ensure(t);
      const out = { ...this.tabSummary(t) };
      if (url) Object.assign(out, await this.methods.act.call(this, { tab: t.handle, steps: [{ goto: url }], snapshot: snapshot ? 'interactive' : 'none' }));
      this.log(`opened ${t.handle} (tab ${t.tabId}) ${url ?? ''}`);
      return out;
    },
    async tab_adopt({ browser, tab_id, query }) {
      const link = this.link(browser);
      const tabs = await link.call('ext.listTabs');
      const x = tab_id !== undefined ? tabs.find(y => y.tabId === tab_id) : query ? tabs.find(y => `${y.title} ${y.url}`.toLowerCase().includes(String(query).toLowerCase())) : null;
      if (!x) throw new AgentError(`no tab matches ${tab_id ?? query ?? '(nothing given)'}`, 'pass tab_id or query from tab_list');
      const existing = [...this.tabs.values()].find(t => t.browser === browser && t.tabId === x.tabId);
      if (existing) return { ...this.tabSummary(existing), title: x.title, url: x.url };
      const t = this.addTab(browser, x.tabId, false, link.agentTabs.has(x.tabId));
      await this.ensure(t);
      this.log(`adopted ${t.handle} (tab ${t.tabId})`);
      return { ...this.tabSummary(t), was_agent: t.wasAgent, title: x.title, url: x.url };
    },
    async tab_close({ tab }) {
      const t = this.tab(tab);
      await this.close(t);
      return { closed: tab };
    },
    async tab_handoff({ tab }) {
      const t = this.tab(tab);
      const info = await this.info(t);
      await this.handoff(t);
      return { handed_off: tab, ...info, tell_user: `I left the tab "${info.title ?? ''}" (${info.url ?? ''}) open in ${t.browser} for you to review.` };
    },
    async snapshot({ tab, mode, query, max_chars }) {
      const t = this.tab(tab);
      await this.ensure(t);
      return { text: await this.snapshot(t, { mode, query, max_chars }) };
    },
    async act({ tab, steps, snapshot = 'diff', max_chars }) {
      const t = this.tab(tab);
      const link = await this.ensure(t);
      if (!Array.isArray(steps) || !steps.length) throw new AgentError('steps must be a non-empty array', 'e.g. [{"click":"e3"}] or [{"fill":"e5","value":"text"},{"press":"Enter"}]');
      const seq0 = link.autopilot.seq;
      const nav = this.watchNav(t);
      const done = [];
      let failure;
      try {
        for (const s of steps) done.push(await this.step(t, s, nav));
      } catch (e) { failure = e; }
      finally { nav.stop(); this.cdp(t, 'Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {}); }
      const events = link.autopilot.events.filter(e => e.seq > seq0 && (e.tabId === undefined || e.tabId === t.tabId)).map(({ seq, at, ...e }) => e);
      const out = { ...this.tabSummary(t), steps: done, ...(await this.info(t)), ...(events.length ? { events } : {}) };
      if (failure) {
        if (!(failure instanceof AgentError)) throw failure;
        failure.data = { ...out, failed_step: done.length, ...(failure.data ?? {}) };
        throw failure;
      }
      if (snapshot !== 'none') out.snapshot = await this.snapshot(t, { mode: snapshot === 'full' ? 'full' : snapshot, max_chars }).catch(e => `(snapshot failed: ${e.message})`);
      return out;
    },
    async read({ tab, ref, offset = 0, max_chars = READ_CHARS }) {
      const t = this.tab(tab);
      await this.ensure(t);
      let text;
      if (ref) { const el = await this.resolve(t, ref); text = await this.callOn(t, el.objectId, 'function(){return this.innerText ?? this.textContent}'); }
      else text = (await this.cdp(t, 'Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true })).result.value;
      const slice = text.slice(offset, offset + max_chars);
      return { text: slice, offset, total_chars: text.length, ...(offset + max_chars < text.length ? { next_offset: offset + max_chars } : {}) };
    },
    async screenshot({ tab, ref, full_page = false, format = 'jpeg', quality = 70 }) {
      const t = this.tab(tab);
      await this.ensure(t);
      const params = { format, ...(format === 'jpeg' ? { quality } : {}) };
      if (ref) {
        const el = await this.resolve(t, ref);
        await this.cdp(t, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendNodeId }).catch(() => {});
        const { model } = await this.cdp(t, 'DOM.getBoxModel', { backendNodeId: el.backendNodeId });
        const xs = model.border.filter((_, i) => i % 2 === 0), ys = model.border.filter((_, i) => i % 2 === 1);
        const { cssVisualViewport: v } = await this.cdp(t, 'Page.getLayoutMetrics');
        params.clip = { x: Math.min(...xs) + v.pageX, y: Math.min(...ys) + v.pageY, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), scale: 1 };
      } else if (full_page) {
        const { cssContentSize: c } = await this.cdp(t, 'Page.getLayoutMetrics');
        Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: c.width, height: c.height, scale: 1 } });
      }
      await this.wakeRenderer(t);
      try {
        const { data } = await this.cdp(t, 'Page.captureScreenshot', params, NAV_TIMEOUT_MS);
        return { image: { data, mimeType: `image/${format}` }, ...(await this.info(t)) };
      } finally { await this.cdp(t, 'Page.stopScreencast').catch(() => {}); }
    },
    async eval({ tab, expression, max_chars = EVAL_CHARS }) {
      const t = this.tab(tab);
      await this.ensure(t);
      const r = await this.cdp(t, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.exceptionDetails) throw new AgentError(`evaluation threw: ${clip(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text, 400)}`);
      const json = JSON.stringify(r.result.value) ?? String(r.result.description ?? r.result.type);
      return { value: json.length > max_chars ? `${json.slice(0, max_chars)}… (${json.length} chars, truncated)` : json };
    },
    async events({ browser, tab, since = 0 }) {
      const t = tab && this.tab(tab);
      const link = this.link(t ? t.browser : browser);
      return { events: link.autopilot.events.filter(e => e.seq > since && (!t || e.tabId === undefined || e.tabId === t.tabId)) };
    },
    async session_end({ close_tabs }) {
      if (close_tabs === undefined) throw new AgentError('close_tabs is required', 'true = close all your tabs (recommended when done); false = leave them open for the user (HumanGate); or an array of handles to close');
      const r = await this.end({ closeTabs: close_tabs, reason: 'session_end' });
      return { ...r, ...(r.left_open.length ? { tell_user: `Left open for your review: ${r.left_open.map(x => `"${x.title ?? ''}" ${x.url ?? ''}`).join('; ')}` } : {}) };
    },
  };
}
