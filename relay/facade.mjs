// ブラウザレベル CDP の模倣。
// chrome.debugger のセッションは Target ドメインが auto-attach 限定(getTargets / attachToTarget / createTarget 等は "Not allowed")
// なので、タブ列挙・生成・破棄は chrome.tabs で行い、CDP クライアントには Target.* イベント/応答を合成して返す。
// クライアントから見た ID: targetId は Chrome 本来の id(拡張が getTargets() / attach 後の Target.getTargetInfo で取得。Playwright は
// 「page の targetId == メインフレーム id」を前提にする)。未取得なら "tab-<tabId>" で代用。タブのセッションは "session-<tabId>"、
// iframe/worker の子セッション ID は Chrome のものをそのまま使う。
const tabSessionId = tabId => `session-${tabId}`;
const parseTabId = (s, prefix) => s?.startsWith(prefix) ? Number(s.slice(prefix.length)) : undefined;

export function serveBrowserFacade(link, ws, log, trace = false) {
  const tabs = new Map();          // tabId -> { info, attached, ready, real(attach 後の Target.getTargetInfo) }
  const byTarget = new Map();      // targetId -> tabId
  const childSessions = new Map(); // Chrome 由来の子 sessionId -> tabId
  let discover = false, autoAttach = false;
  const targetIdOf = t => t.real?.targetId ?? t.info.targetId ?? `tab-${t.info.tabId}`;
  const tabIdOf = targetId => byTarget.get(targetId) ?? parseTabId(targetId, 'tab-');
  const index = t => byTarget.set(targetIdOf(t), t.info.tabId);

  const send = obj => { if (ws.readyState !== ws.OPEN) return; const raw = JSON.stringify(obj); if (trace) log('facade <', raw.slice(0, 400)); ws.send(raw); };
  const event = (method, params, sessionId) => send({ method, params, ...(sessionId ? { sessionId } : {}) });
  // browserContextId は Playwright(crBrowser._onAttachedToTarget)が必須とする。puppeteer は未知の id を既定コンテキストに割り当てる
  const targetInfo = t => ({ targetId: targetIdOf(t), type: 'page', title: t.info.title, url: t.info.url, attached: t.attached, canAccessOpener: false, browserContextId: t.real?.browserContextId ?? 'default' });

  // 固まっている(attach 直後の Page.enable が返らない)エージェント以外のタブはクライアントに見せない。見せると puppeteer の pages() や
  // Playwright の connectOverCDP がそのタブの初期化(Page.enable 等)で止まる。中継はそのタブに触らない(遷移し直さない)
  function hide(t) {
    t.hidden = true;
    if (discover) event('Target.targetDestroyed', { targetId: targetIdOf(t) });
    return t;
  }
  async function attachTab(tabId) {
    const t = tabs.get(tabId);
    if (!t || t.attached || t.hidden) return t;
    const ap = link.autopilot;
    if (!ap.inScope(tabId) && ap.stuck.has(tabId)) return hide(t);
    try { await link.attach(tabId); } catch (e) { log(`facade: attach tab ${tabId} failed: ${e.message}`); return t; }
    if (!ap.inScope(tabId) && !(await ap.probe(tabId)) && !ap.inScope(tabId)) { await link.detach(tabId); return hide(t); } // 待つ間に adopt されたら隠さない
    t.attached = true;
    try { t.real = (await link.cdp(tabId, 'Target.getTargetInfo')).targetInfo; index(t); } catch (e) { log(`facade: getTargetInfo tab ${tabId} failed: ${e.message}`); }
    event('Target.attachedToTarget', { sessionId: tabSessionId(tabId), targetInfo: targetInfo(t), waitingForDebugger: false });
    return t;
  }
  function markDetached(tabId) {
    const t = tabs.get(tabId);
    if (!t?.attached) return;
    t.attached = false;
    for (const [sid, tid] of childSessions) if (tid === tabId) childSessions.delete(sid);
    event('Target.detachedFromTarget', { sessionId: tabSessionId(tabId), targetId: targetIdOf(t) });
  }
  async function detachTab(tabId) { if (!tabs.get(tabId)?.attached) return; markDetached(tabId); await link.detach(tabId); } // 二重 detach で他クライアントの共有 attach を落とさない
  // ext.tabCreated イベントと Target.createTarget 応答が競合しても、attachedToTarget が createTarget の応答より先に届くよう ready を待つ
  async function ensureTab(info) {
    let t = tabs.get(info.tabId);
    if (!t) {
      t = { info, attached: false };
      tabs.set(info.tabId, t); index(t);
      t.ready = (async () => { if (discover) event('Target.targetCreated', { targetInfo: targetInfo(t) }); if (autoAttach) await attachTab(info.tabId); })();
    }
    await t.ready;
    return t;
  }
  // 並列にする: autoAttach 中は ensureTab がエージェント以外のタブの probe を待つので、直列だと固まったタブの数 × unresponsiveTimeoutMs 待たされる
  async function syncTabs() { await Promise.all((await link.call('ext.listTabs')).map(ensureTab)); }

  const browserTarget = { targetId: 'browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false };
  const rootMethods = {
    'Browser.getVersion': async () => {
      const info = await link.call('ext.info');
      return { protocolVersion: '1.3', product: (info.userAgent.match(/Edg\/[\d.]+/) ?? info.userAgent.match(/Chrome\/[\d.]+/))?.[0] ?? 'Chrome', revision: '', userAgent: info.userAgent, jsVersion: '' };
    },
    // ダウンロード・権限は chrome.downloads / chrome.contentSettings で実現する(autopilot.mjs)。facade クライアントの切断で元に戻す
    // 拡張の接続直後は ext.info(機能の有無)の取得を待つ
    'Browser.setDownloadBehavior': async p => { await link.ready; link.autopilot.setDownloadBehavior(ws, event, p); return {}; },
    'Browser.grantPermissions': async p => { await link.ready; await link.autopilot.grantPermissions(ws, p); return {}; },
    'Browser.setPermission': async p => { await link.ready; await link.autopilot.setPermission(ws, p); return {}; },
    'Browser.resetPermissions': async () => { await link.ready; await link.autopilot.resetPermissions(ws); return {}; },
    'Browser.close': async () => { setTimeout(() => ws.close(1000, 'Browser.close'), 50); return {}; },
    // chrome.debugger から証明書エラーは無視できない。成功扱いにすると HTTPS エラーのページで原因が分からなくなるのでエラーにする
    'Security.setIgnoreCertificateErrors': async ({ ignore }) => { if (ignore) throw new Error('Security.setIgnoreCertificateErrors {ignore: true} is not supported via the extension relay (chrome.debugger cannot bypass certificate errors)'); return {}; },
    'Target.getBrowserContexts': async () => ({ browserContextIds: [] }),
    'Target.setDiscoverTargets': async ({ discover: d }) => {
      discover = d;
      if (d) { event('Target.targetCreated', { targetInfo: browserTarget }); await syncTabs(); }
      return {};
    },
    'Target.setAutoAttach': async ({ autoAttach: a }) => {
      autoAttach = a;
      if (a) { await syncTabs(); await Promise.all([...tabs.keys()].map(attachTab)); }
      else for (const tabId of tabs.keys()) await detachTab(tabId);
      return {};
    },
    'Target.getTargets': async () => ({ targetInfos: [...tabs.values()].filter(t => !t.hidden).map(targetInfo) }),
    'Target.getTargetInfo': async ({ targetId }) => {
      if (!targetId) return { targetInfo: browserTarget }; // Playwright は connect 直後に引数なしで呼び、ブラウザ自身の情報を期待する
      const t = tabs.get(tabIdOf(targetId));
      if (!t) throw new Error(`No target with given id found`);
      return { targetInfo: targetInfo(t) };
    },
    // about:blank で作ってエージェントのタブにしてから目的の URL へ遷移する。url 付きで作ると、adopt と Page.enable より先にページが読み込まれ、
    // 読み込み直後のダイアログや 401 を取りこぼす。旧拡張(ext.navigateTab なし)は従来どおり url 付きで作る
    'Target.createTarget': async ({ url, background }) => {
      const navigateLater = url && url !== 'about:blank' && link.hasFeature('navigateTab');
      const info = await link.call('ext.createTab', { url: navigateLater ? 'about:blank' : url || 'about:blank', active: !background });
      link.adopt(info.tabId, 'Target.createTarget');
      const t = await ensureTab(info); // autoAttach 中はここで attach と Page.enable まで済む
      if (navigateLater) await link.call('ext.navigateTab', { tabId: info.tabId, url });
      return { targetId: targetIdOf(t) };
    },
    'Target.closeTarget': async ({ targetId }) => { await link.call('ext.closeTab', { tabId: tabIdOf(targetId) }); return { success: true }; },
    'Target.activateTarget': async ({ targetId }) => { await link.call('ext.activateTab', { tabId: tabIdOf(targetId) }); return {}; },
    'Target.attachToTarget': async ({ targetId }) => {
      if (!byTarget.has(targetId)) await syncTabs();
      const tabId = tabIdOf(targetId);
      if (tabs.has(tabId)) { link.adopt(tabId, 'Target.attachToTarget'); tabs.get(tabId).hidden = false; } // 明示的に選んだタブはエージェントのタブ
      const t = await attachTab(tabId);
      if (!t?.attached) throw new Error(`No target with given id found`);
      return { sessionId: tabSessionId(tabId) };
    },
    'Target.detachFromTarget': async ({ sessionId }) => { await detachTab(parseTabId(sessionId, 'session-')); return {}; },
  };

  ws.on('message', async raw => {
    if (trace) log('facade >', String(raw).slice(0, 400));
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const reply = body => send({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), ...body });
    try {
      if (!msg.sessionId) {
        const fn = rootMethods[msg.method];
        if (!fn) throw Object.assign(new Error(`'${msg.method}' wasn't found`), { code: -32601 });
        return reply({ result: await fn(msg.params ?? {}) });
      }
      const tabId = parseTabId(msg.sessionId, 'session-') ?? childSessions.get(msg.sessionId);
      if (tabId === undefined || !tabs.get(tabId)?.attached) throw Object.assign(new Error(`Session with given id not found.`), { code: -32001 });
      const childSessionId = msg.sessionId.startsWith('session-') ? undefined : msg.sessionId;
      return reply({ result: await link.clientCdp(tabId, msg.method, msg.params, childSessionId) });
    } catch (e) { reply({ error: { code: e.code ?? e.cdp?.code ?? -32000, message: e.message } }); }
  });

  const listener = async (ev, m) => {
    if (ev === 'cdp.event') {
      const t = tabs.get(m.tabId);
      if (!t?.attached) return;
      if (m.method === 'Target.attachedToTarget') childSessions.set(m.params.sessionId, m.tabId);
      if (m.method === 'Target.detachedFromTarget') childSessions.delete(m.params.sessionId);
      return event(m.method, m.params, m.sessionId ?? tabSessionId(m.tabId));
    }
    if (ev === 'ext.detached') { log(`facade: tab ${m.tabId} detached by browser (${m.reason})`); return markDetached(m.tabId); }
    if (ev === 'ext.tabCreated') return ensureTab(m.tab);
    if (ev === 'ext.tabUpdated') {
      const t = tabs.get(m.tab.tabId); if (!t) return ensureTab(m.tab);
      byTarget.delete(targetIdOf(t)); t.info = m.tab; index(t);
      if (t.hidden) { // 遷移したら固まりは解けている(autopilot が stuck から外す)。改めて見せる
        if (link.autopilot.stuck.has(t.info.tabId)) return;
        t.hidden = false;
        if (discover) event('Target.targetCreated', { targetInfo: targetInfo(t) });
        if (autoAttach) await attachTab(t.info.tabId);
        return;
      }
      if (discover) event('Target.targetInfoChanged', { targetInfo: targetInfo(t) });
      return;
    }
    if (ev === 'ext.tabRemoved') { const t = tabs.get(m.tabId); if (!t) return; markDetached(m.tabId); tabs.delete(m.tabId); byTarget.delete(targetIdOf(t)); if (discover && !t.hidden) event('Target.targetDestroyed', { targetId: targetIdOf(t) }); return; }
    if (ev === 'link.closed') ws.close(1001, 'extension disconnected');
  };
  link.on(listener);
  ws.on('close', () => {
    link.off(listener); for (const [tabId, t] of tabs) if (t.attached) link.detach(tabId);
    link.autopilot.releaseClient(ws).catch(e => log(`facade: releasing permissions failed: ${e.message}`));
  });
}
