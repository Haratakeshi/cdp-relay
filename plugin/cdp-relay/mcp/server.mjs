#!/usr/bin/env node
// cdp-relay MCP サーバー(stdio)。依存なし(Node 22 の標準モジュールだけ)なので、プラグインのディレクトリだけをコピーしても動く。
// 役割は薄いシム: MCP の tools/call を、中継のエージェント用ソケット(~/.cdp-relay/relay-<port>.sock、0600。Windows は同じパスを名前に含む名前付きパイプ)上のセッションへ渡す。
// - 中継への接続は最初のツール呼び出しまで遅らせる(プラグインを有効にしただけでは何もしない)
// - この MCP プロセス 1 つ = 中継のセッション 1 つ。エージェントが終了して stdin が閉じると接続が切れ、中継がタブを人に引き渡して detach する
// - session_end の後は接続を閉じ、次のツール呼び出しで新しいセッションを始める
// - 中継が再起動したら繋ぎ直し、開いていたタブのハンドルを引き継ぐ(restore)
// - 中継が動いていなければ起こす(launchd の常駐なら kickstart、それ以外は前回と同じ node・同じ CDP_RELAY_* の設定で起動。情報は中継が relay-<port>.json に残す。
//   一度も起動していなければ、このシムが clone の中(plugin/cdp-relay/mcp/)にあるときに限り、隣の relay/server.mjs を起動する)
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.4.0';
const PORT = Number(process.env.CDP_RELAY_PORT || 9333);
// パスの規則は relay/paths.mjs と同じ(このシムは依存なしで動かすため複製している)
const SOCKET_FILE = resolve(process.env.CDP_RELAY_SOCKET || join(homedir(), '.cdp-relay', `relay-${PORT}.sock`));
const SOCKET = process.platform === 'win32' ? `\\\\?\\pipe\\${SOCKET_FILE}` : SOCKET_FILE;
const statePath = ext => `${SOCKET_FILE.replace(/\.sock$/, '')}${ext}`;
const REPO_SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '../../../relay/server.mjs'); // clone から直接使っているときの中継
const START_TIMEOUT_MS = 15_000; // 中継を起こしてからソケットが開くまで
const CALL_TIMEOUT_MS = 120_000; // 1 回のツール呼び出しの上限(act の待機を含む)
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const log = (...a) => process.stderr.write(`[cdp-relay-mcp] ${a.join(' ')}\n`); // stdout は JSON-RPC 専用

const INSTRUCTIONS = `cdp-relay operates the user's REAL, logged-in Chrome/Edge profiles on this computer (one "browser" per profile).

Workflow: browser_list → browser_open if the one you need is offline → tab_open (your own new tab) → snapshot → act → read / screenshot to check the result.
- Work in your own tabs. Use tab_adopt only when the user points you at an existing tab; never touch other tabs.
- Refs (e12…) come from the latest snapshot of that tab and are valid only for that page. If act says a ref is stale, take a new snapshot. Never guess refs.
- act runs several steps in one call (goto, click, fill, select, press, type, hover, scroll, wait_for) and returns what changed (snapshot diff) plus any dialogs/downloads the relay auto-handled. If a confirm() was auto-dismissed, the action probably did NOT happen.

HumanGate — stop and ask the user before anything irreversible or outward-facing: sending/posting/publishing, deleting, purchasing/paying, submitting forms with personal data, changing account settings. act refuses clicks on targets that look irreversible unless the step has "confirmed": true; set it only after the user approved that exact action. Never enter passwords, payment or government ID data.

When you are done:
- Recommended: close the tabs you opened (tab_close, or session_end with close_tabs: true).
- If the user should see the result (a draft awaiting their approval, a filled form, a report page), keep that tab open with tab_handoff (or session_end with close_tabs: false), and tell the user its title and URL — that is a HumanGate: the user takes over from there.
- Always finish with session_end so the relay detaches (the browser's "debugging this browser" bar disappears). If the user asks you to close tabs, use tab_close.`;

const TAB = { type: 'string', description: 'Tab handle from tab_open / tab_adopt, e.g. "t1"' };
const BROWSER = { type: 'string', description: 'Browser (profile) name from browser_list' };
const TOOLS = [
  { name: 'browser_list', description: 'List browser profiles: online ones can be used; offline ones can be started with browser_open.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'browser_open', description: 'Open the window of an offline profile (in the background) and wait until it connects. Use the name shown as offline by browser_list.',
    inputSchema: { type: 'object', properties: { name: BROWSER, app: { type: 'string', enum: ['chrome', 'edge'], description: 'Only for a profile not yet in browser_list' }, profile: { type: 'string', description: 'Profile directory or display name (with app)' } } } },
  { name: 'tab_list', description: 'List tabs of a browser (metadata only, does not attach). Your tabs have a "tab" handle.', inputSchema: { type: 'object', properties: { browser: BROWSER, query: { type: 'string', description: 'Filter by title/URL substring' } }, required: ['browser'] }, annotations: { readOnlyHint: true } },
  { name: 'tab_open', description: 'Open a new background tab for your work (does not steal the user\'s current tab) and optionally navigate. Returns the handle and an interactive snapshot.',
    inputSchema: { type: 'object', properties: { browser: BROWSER, url: { type: 'string' }, active: { type: 'boolean', description: 'Make it the selected tab in its window (default false)' }, snapshot: { type: 'boolean', description: 'Include a snapshot (default true)' } }, required: ['browser'] } },
  { name: 'tab_adopt', description: 'Borrow an existing tab the user pointed you at (by tab_id or title/URL query). On session end it is handed back untouched.',
    inputSchema: { type: 'object', properties: { browser: BROWSER, tab_id: { type: 'number' }, query: { type: 'string' } }, required: ['browser'] } },
  { name: 'snapshot', description: 'Accessibility snapshot of the page: interactive elements with refs (e.g. [e12]), headings and dialogs. mode "full" adds text; "diff" shows only changes since the previous snapshot. Includes same-process iframes and shadow DOM.',
    inputSchema: { type: 'object', properties: { tab: TAB, mode: { type: 'string', enum: ['interactive', 'full', 'diff'] }, query: { type: 'string', description: 'Only lines containing this text' }, max_chars: { type: 'number' } }, required: ['tab'] }, annotations: { readOnlyHint: true } },
  { name: 'act', description: 'Run steps in order with real (trusted) input, waiting for navigation after clicks/keys. Steps: {"goto":url} {"click":ref,"confirmed"?:true} {"fill":ref,"value":text} {"select":ref,"value":option} {"press":"Enter"|"Control+a"|"Tab Tab"…,"ref"?} {"type":text,"ref"?} {"hover":ref} {"scroll":"down"|"up"|ref} {"wait_for":{"text"?,"text_gone"?,"url_includes"?,"ms"?,"timeout_ms"?}}. Stops at the first failing step and reports what was done. Returns a snapshot diff (snapshot: "diff" default, "interactive", "full", "none") and auto-handled events.',
    inputSchema: { type: 'object', properties: { tab: TAB, steps: { type: 'array', items: { type: 'object' } }, snapshot: { type: 'string', enum: ['diff', 'interactive', 'full', 'none'] }, max_chars: { type: 'number' } }, required: ['tab', 'steps'] } },
  { name: 'read', description: 'Visible text of the page (or of one element by ref), paged with offset / max_chars.',
    inputSchema: { type: 'object', properties: { tab: TAB, ref: { type: 'string' }, offset: { type: 'number' }, max_chars: { type: 'number' } }, required: ['tab'] }, annotations: { readOnlyHint: true } },
  { name: 'screenshot', description: 'Screenshot of the viewport, the full page, or one element (ref). Returned as an image unless "path" is given (then saved there).',
    inputSchema: { type: 'object', properties: { tab: TAB, ref: { type: 'string' }, full_page: { type: 'boolean' }, format: { type: 'string', enum: ['jpeg', 'png'] }, quality: { type: 'number' }, path: { type: 'string', description: 'Save to this file instead of returning the image' } }, required: ['tab'] }, annotations: { readOnlyHint: true } },
  { name: 'eval', description: 'Evaluate a JavaScript expression in the page (escape hatch; prefer snapshot/act). Promises are awaited; the JSON result is truncated.',
    inputSchema: { type: 'object', properties: { tab: TAB, expression: { type: 'string' }, max_chars: { type: 'number' } }, required: ['tab', 'expression'] } },
  { name: 'events', description: 'What the relay auto-handled (dialogs, auth, downloads, frozen tabs) for a tab or browser. act already includes the events of its own steps.',
    inputSchema: { type: 'object', properties: { tab: TAB, browser: BROWSER, since: { type: 'number' } } }, annotations: { readOnlyHint: true } },
  { name: 'tab_close', description: 'Close one of your tabs (recommended when you no longer need it, or when the user asks).', inputSchema: { type: 'object', properties: { tab: TAB }, required: ['tab'] } },
  { name: 'tab_handoff', description: 'HumanGate: leave one of your tabs open for the user to review/take over. It stops being yours (detached, no more auto-handling). Tell the user its title and URL.',
    inputSchema: { type: 'object', properties: { tab: TAB }, required: ['tab'] } },
  { name: 'session_end', description: 'End your session when the task is done. close_tabs: true closes all your remaining tabs (recommended), false hands them to the user (HumanGate: tell them), or an array of handles to close. The relay detaches everything either way.',
    inputSchema: { type: 'object', properties: { close_tabs: { oneOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }] } }, required: ['close_tabs'] } },
];

// ---------- 中継との接続(改行区切り JSON) ----------
let conn = null, connecting = null, seq = 0, agentName = 'agent';
const pending = new Map();
const myTabs = new Map(); // handle -> { tab, browser, tab_id, created, was_agent }(中継の再起動後に引き継ぐため)

const tryConnect = () => new Promise((res, rej) => { const s = net.connect(SOCKET); s.once('connect', () => res(s)); s.once('error', rej); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 中継を起こす。launchd の常駐ならそのジョブを kickstart、それ以外は前回の中継と同じ node / server.mjs で起動する */
async function startRelay() {
  let info = null;
  try { info = JSON.parse(readFileSync(statePath('.json'), 'utf8')); } catch {}
  if (!info && existsSync(REPO_SERVER)) info = { node: process.execPath, server: REPO_SERVER }; // 一度も起動していない(Windows は常駐しないのでここが入口)
  if (!info) throw new Error(`cdp-relay is not running and has never been started on port ${PORT} (no ${statePath('.json')}). Set it up once: run "pnpm run setup" in your clone of https://github.com/Haratakeshi/cdp-relay (see INSTALL.md)`);
  if (info.launchdLabel && process.platform === 'darwin') {
    log(`relay not reachable; launchctl kickstart ${info.launchdLabel}`);
    await new Promise(r => execFile('launchctl', ['kickstart', `gui/${process.getuid()}/${info.launchdLabel}`], () => r()));
  } else {
    log(`relay not reachable; starting ${info.server}`);
    const logFile = statePath('.log'); mkdirSync(dirname(logFile), { recursive: true });
    const out = openSync(logFile, 'a');
    // 前回の中継の CDP_RELAY_* をそのまま使う(このプロセスの CDP_RELAY_* は混ぜない。ソケットの場所だけはこのシムに合わせる)
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CDP_RELAY_')));
    const env = { ...base, ...info.env, CDP_RELAY_PORT: String(PORT), ...(process.env.CDP_RELAY_SOCKET ? { CDP_RELAY_SOCKET: process.env.CDP_RELAY_SOCKET } : {}) };
    spawn(info.node, [info.server], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env }).unref();
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) { try { return await tryConnect(); } catch { await sleep(300); } }
  throw new Error(`cdp-relay did not come up within ${START_TIMEOUT_MS}ms (socket ${SOCKET}; log ${statePath('.log')}). Run "pnpm run setup" in the cdp-relay clone`);
}

async function ensureConn() {
  if (conn) return conn;
  connecting ??= (async () => {
    let s;
    try { s = await tryConnect(); } catch { s = await startRelay(); }
    s.setEncoding('utf8');
    let buf = '';
    s.on('data', chunk => {
      buf += chunk;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        const p = pending.get(m.id); if (!p) continue;
        pending.delete(m.id); clearTimeout(p.timer);
        m.error ? p.reject(Object.assign(new Error(m.error.message), { hint: m.error.hint, data: m.error.data })) : p.resolve(m.result);
      }
    });
    s.on('close', () => {
      if (conn === s) conn = null;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('connection to cdp-relay was lost'), { hint: 'retry the call; tab handles are restored if the tabs still exist' })); }
      pending.clear();
    });
    s.on('error', () => {});
    conn = s;
    const hello = await call('session.hello', { agent: agentName, restore: [...myTabs.values()] });
    for (const h of myTabs.keys()) if (!hello.restored.includes(h)) myTabs.delete(h);
    return s;
  })().finally(() => { connecting = null; });
  return connecting;
}

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${CALL_TIMEOUT_MS}ms`)); }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    conn.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

// ---------- ツール呼び出し ----------
async function callTool(name, args) {
  if (!TOOLS.some(t => t.name === name)) throw Object.assign(new Error(`unknown tool ${name}`), { rpc: -32602 });
  const { path, ...params } = args ?? {};
  await ensureConn();
  const r = await call(name, params);
  // 中継の再起動に備えてハンドルを覚える / 忘れる
  if ((name === 'tab_open' || name === 'tab_adopt') && r.tab) myTabs.set(r.tab, { tab: r.tab, browser: r.browser, tab_id: r.tab_id, created: name === 'tab_open', was_agent: !!r.was_agent });
  if (name === 'tab_close' || name === 'tab_handoff') myTabs.delete(params.tab);
  if (name === 'session_end') { myTabs.clear(); conn?.end(); conn = null; } // 次の呼び出しは新しいセッション
  const content = [];
  if (r.image) {
    if (path) {
      const file = isAbsolute(path) ? path : resolve(path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(r.image.data, 'base64'));
      r.saved = file;
    } else content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
    delete r.image;
  }
  // 読み物(snapshot / read の本文)は JSON に埋めず、そのままの改行で後ろに付ける
  const { text, snapshot, ...rest } = r;
  const parts = [];
  if (Object.keys(rest).length) parts.push(JSON.stringify(rest, null, 1));
  if (typeof text === 'string') parts.push(text);
  if (typeof snapshot === 'string') parts.push(snapshot);
  content.push({ type: 'text', text: parts.join('\n\n') || '{}' });
  return { content };
}

// ---------- MCP(JSON-RPC 2.0、改行区切り)----------
const reply = obj => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // 通知(notifications/initialized 等)
  try {
    if (method === 'initialize') {
      agentName = params?.clientInfo?.name ?? agentName;
      const v = PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
      return reply({ id, result: { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cdp-relay', version: VERSION }, instructions: INSTRUCTIONS } });
    }
    if (method === 'ping') return reply({ id, result: {} });
    if (method === 'tools/list') return reply({ id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try { return reply({ id, result: await callTool(params?.name, params?.arguments) }); }
      catch (e) {
        if (e.rpc) throw e;
        const text = [`Error: ${e.message}`, e.hint && `Hint: ${e.hint}`, e.data && JSON.stringify(e.data, null, 1)].filter(Boolean).join('\n');
        return reply({ id, result: { content: [{ type: 'text', text }], isError: true } });
      }
    }
    reply({ id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) { reply({ id, error: { code: e.rpc ?? -32603, message: e.message } }); }
}

let inbuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inbuf += chunk;
  for (let i; (i = inbuf.indexOf('\n')) >= 0;) {
    const line = inbuf.slice(0, i).trim(); inbuf = inbuf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { reply({ id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    handle(msg);
  }
});
// エージェントの終了 = stdin が閉じる。中継への接続を閉じれば、中継がタブを人に引き渡して detach する
const shutdown = () => { conn?.end(); setTimeout(() => process.exit(0), 100); };
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
