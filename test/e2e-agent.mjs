// E2E-15: MCP(plugin/cdp-relay/mcp/server.mjs)→ 中継のエージェント用ソケット → 拡張。エージェント操作の契約を確かめる
// 確かめる失敗の形:
//  F1 セッション終了後も attach が残る(インフォバーが消えない)/ F2 残したタブがエージェントのタブのまま(人のダイアログを自動処理してしまう)
//  F3 MCP プロセスが異常終了すると後始末されない / F4 古い ref で別の要素を押す / F5 覆われた要素の代わりにオーバーレイを押す
//  F6 クリック・入力が信頼されたイベントでない / F7 クリックによる遷移を待たずに返る / F8 自動処理したダイアログが応答に出ない
//  F9 HumanGate を確認なしで通す / F10 iframe・shadow DOM の要素を操作できない / F11 他のセッションのハンドルを使える
//  F12 session_end で自分以外のタブを閉じる / F13 出力が上限を超える / F14 MCP の初期化で HumanGate の指針が伝わらない
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import http from 'node:http';
import { startRelay, launchChromeWithExtension, waitForBrowser, RELAY, RELAY_PORT, sleep, assert, artifactsDir } from './harness.mjs';

const ART = artifactsDir('e2e-agent');
const SOCKET = resolve(`tmp/agent-${RELAY_PORT}.sock`);
const policyPath = join(ART, 'policy.json');
writeFileSync(policyPath, JSON.stringify({ dialogTimeoutMs: 500 }), { mode: 0o600 });

const page = body => `<!doctype html><meta charset="utf-8">${body}`;
const srv = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/frame') return res.end(page('<button onclick="window.clicked=event.isTrusted">in-frame</button>'));
  if (req.url === '/next') return res.end(page('<title>next</title><h1>Next page</h1><a href="/form">back</a>'));
  res.end(page(`<title>form</title><h1>Form</h1>
<form onsubmit="event.preventDefault(); window.submitted = true"><input id="name" aria-label="Name"></form>
<button id="save" onclick="window.saved = event.isTrusted">Save</button>
<button onclick="window.deleted = true">削除</button>
<button onclick="window.asked = confirm('really?')">Ask</button>
<select aria-label="Color"><option value="r">Red</option><option value="g">Green</option></select>
<a href="/next">go next</a>
<div id="list"><button>Item A</button><button>Item B</button></div>
<button onclick="document.getElementById('list').innerHTML='<button>Item C</button>'">Shuffle</button>
<button onclick="document.getElementById('ov').style.display='block'">Show overlay</button>
<div id="ov" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.3)">overlay</div>
<div id="host"></div><script>
  document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button onclick="window.shadowClicked=true">shadow-btn</button>';
  window.log = []; document.getElementById('name').addEventListener('input', e => log.push(e.isTrusted));
</script>
<iframe src="/frame" style="width:300px;height:60px"></iframe>
<p>${'lorem ipsum '.repeat(400)}</p>`));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${srv.address().port}`;

/** MCP クライアント(stdio、改行区切り JSON-RPC) */
function mcp() {
  const child = spawn(process.execPath, [resolve('plugin/cdp-relay/mcp/server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, CDP_RELAY_PORT: String(RELAY_PORT), CDP_RELAY_SOCKET: SOCKET } });
  let buf = '', id = 0; const pend = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pend.get(m.id)?.(m); pend.delete(m.id); } });
  const rpc = (method, params) => new Promise(r => { pend.set(++id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name, args = {}) => {
    const m = await rpc('tools/call', { name, arguments: args });
    const text = m.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const json = (() => { try { return JSON.parse(text.split('\n\n')[0]); } catch { return null; } })();
    return { ...m.result, text, json };
  };
  return { child, rpc, tool };
}
const browsers = () => fetch(`${RELAY}/browsers`).then(r => r.json());
const tabState = async tabId => { const b = (await browsers()).find(x => x.name === 'ag'); return { attached: b.attachedTabs.includes(tabId), agent: b.agentTabs.includes(tabId) }; };
const ref = (text, re) => text.split('\n').find(l => re.test(l))?.match(/\[(e\d+)\]/)?.[1];

rmSync(SOCKET, { force: true });
const relay = await startRelay({ CDP_RELAY_POLICY: policyPath, CDP_RELAY_SOCKET: SOCKET });
const { browser } = await launchChromeWithExtension({ name: 'ag' });
const clients = [];
try {
  await waitForBrowser('ag');
  const a = mcp(); clients.push(a);
  const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  assert(/HumanGate/.test(init.result.instructions) && /tab_handoff/.test(init.result.instructions), 'F14 initialize の instructions に HumanGate とタブの後始末の指針');
  const tools = (await a.rpc('tools/list')).result.tools.map(t => t.name);
  assert(['browser_list', 'tab_open', 'snapshot', 'act', 'read', 'screenshot', 'eval', 'tab_close', 'tab_handoff', 'session_end'].every(n => tools.includes(n)), `tools/list (${tools.length} tools)`);
  assert((await a.tool('browser_list')).json.browsers.some(b => b.name === 'ag' && b.status === 'online'), 'browser_list に接続中のブラウザ');

  const t0 = Date.now();
  const opened = await a.tool('tab_open', { browser: 'ag', url: `${SITE}/form` });
  const t1 = opened.json.tab, tab1 = opened.json.tab_id;
  writeFileSync(join(ART, 'snapshot-form.txt'), opened.text);
  assert(t1 === 't1' && /textbox "Name" \[e\d+\]/.test(opened.text) && /button "Save"/.test(opened.text), `tab_open で遷移とスナップショット(${Date.now() - t0}ms)`);
  assert(/button "shadow-btn"/.test(opened.text) && /button "in-frame"/.test(opened.text), 'F10 shadow DOM と iframe の要素もスナップショットに出る');
  assert((await tabState(tab1)).attached && (await tabState(tab1)).agent, 'セッションのタブは attach 済みのエージェントのタブ');
  let snap = opened.text;

  let r = await a.tool('act', { tab: t1, steps: [{ fill: ref(snap, /textbox "Name"/), value: 'Alice' }, { click: ref(snap, /button "Save"/) }, { press: 'Enter', ref: ref(snap, /textbox "Name"/) }] });
  const ev = async expr => { const v = (await a.tool('eval', { tab: t1, expression: expr })).json.value; return v === 'undefined' ? undefined : JSON.parse(v); };
  assert(!r.isError && (await ev('document.getElementById("name").value')) === 'Alice' && (await ev('window.log.every(Boolean) && window.log.length > 0')), 'F6 fill は信頼された input イベントで入る');
  assert((await ev('window.saved')) === true && (await ev('window.submitted')) === true, 'F6 クリックと Enter が信頼されたイベントで届く(isTrusted / form submit)');

  r = await a.tool('act', { tab: t1, steps: [{ click: ref(snap, /button "削除"/) }] });
  assert(r.isError && /HumanGate/.test(r.text) && (await ev('window.deleted')) === undefined, 'F9 不可逆に見える要素は confirmed なしでは押さない');
  r = await a.tool('act', { tab: t1, steps: [{ click: ref(snap, /button "削除"/), confirmed: true }] });
  assert(!r.isError && (await ev('window.deleted')) === true, 'F9 confirmed: true なら押す');

  r = await a.tool('act', { tab: t1, steps: [{ click: ref(snap, /button "Ask"/) }] });
  assert(!r.isError && r.json.events?.some(e => e.type === 'dialog' && e.dialogType === 'confirm') && (await ev('window.asked')) === false, 'F8 中継が閉じた confirm が act の応答に出る(dismiss)');

  r = await a.tool('act', { tab: t1, steps: [{ select: ref(snap, /combobox "Color"/), value: 'Green' }, { click: ref(snap, /button "shadow-btn"/) }, { click: ref(snap, /button "in-frame"/) }] });
  assert(!r.isError && (await ev('document.querySelector("select").value')) === 'g', 'select で選択肢を選ぶ');
  assert((await ev('window.shadowClicked')) === true && (await ev('document.querySelector("iframe").contentWindow.clicked')) === true, 'F10 shadow DOM と iframe の要素を信頼されたクリックで押せる');

  const items = ref(snap, /button "Item A"/);
  await a.tool('act', { tab: t1, steps: [{ click: ref(snap, /button "Shuffle"/) }], snapshot: 'none' });
  r = await a.tool('act', { tab: t1, steps: [{ click: items }] });
  assert(r.isError && /stale/.test(r.text), `F4 消えた要素の ref は stale で押さない(${r.text.split('\n')[0]})`);

  await a.tool('act', { tab: t1, steps: [{ click: ref(snap, /button "Show overlay"/) }], snapshot: 'none' });
  r = await a.tool('act', { tab: t1, steps: [{ click: ref(snap, /button "Save"/) }] });
  assert(r.isError && /covered by div#ov/.test(r.text), `F5 オーバーレイに覆われた要素は押さない(${r.text.split('\n')[0]})`);
  await ev('document.getElementById("ov").style.display = "none"');

  r = await a.tool('act', { tab: t1, steps: [{ click: ref(snap, /link "go next"/) }] });
  assert(!r.isError && r.json.url === `${SITE}/next` && /navigated/.test(r.text) && /heading 1 "Next page"/.test(r.text), 'F7 クリックによる遷移を待ってから、遷移後のスナップショットを返す');
  r = await a.tool('act', { tab: t1, steps: [{ click: ref(snap, /button "Save"/) }] });
  assert(r.isError && /stale/.test(r.text), `F4 遷移前の ref は使えない(${r.text.split('\n')[0]})`);

  await a.tool('act', { tab: t1, steps: [{ goto: `${SITE}/form` }], snapshot: 'none' });
  const read = await a.tool('read', { tab: t1, max_chars: 500 });
  assert(read.json.next_offset === 500 && read.json.total_chars > 4000, `F13 read はページ単位(total ${read.json.total_chars})`);
  const big = await a.tool('snapshot', { tab: t1, mode: 'full', max_chars: 300 });
  assert(big.text.length < 450 && /truncated/.test(big.text), 'F13 snapshot は max_chars で切る');
  const shot = await a.rpc('tools/call', { name: 'screenshot', arguments: { tab: t1 } });
  assert(shot.result.content.some(c => c.type === 'image' && c.mimeType === 'image/jpeg' && c.data.length > 1000), 'screenshot は MCP の画像で返る');
  const shotPath = join(ART, 'shot.png');
  await a.tool('screenshot', { tab: t1, format: 'png', path: shotPath });
  assert(existsSync(shotPath), 'screenshot の path 指定でファイルに保存');

  // 別セッション: ハンドルは共有されない
  const b = mcp(); clients.push(b);
  await b.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-b', version: '0' } });
  r = await b.tool('snapshot', { tab: t1 });
  assert(r.isError && /unknown tab handle/.test(r.text), 'F11 他のセッションのハンドルは使えない');
  const bOpened = await b.tool('tab_open', { browser: 'ag', url: `${SITE}/next`, snapshot: false });
  const bTab = bOpened.json.tab_id;

  // ユーザーのタブを借りる → session_end(close_tabs:false)で、作ったタブも借りたタブも開いたまま人に戻る
  const userPage = await browser.newPage();
  await userPage.goto(`${SITE}/next?user`);
  const adopted = await a.tool('tab_adopt', { browser: 'ag', query: 'user' });
  const userTab = adopted.json.tab_id;
  assert(adopted.json.tab === 't2' && adopted.json.was_agent === false && (await tabState(userTab)).agent, 'tab_adopt でユーザーのタブを借りる');
  const end = await a.tool('session_end', { close_tabs: false });
  await sleep(300);
  const tabsNow = await fetch(`${RELAY}/b/ag/json/list`).then(x => x.json());
  assert(end.json.left_open.length === 2 && /review/.test(end.json.tell_user) && [tab1, userTab].every(id => tabsNow.some(x => x.tabId === id)), 'F12 close_tabs:false はタブを閉じず、人に伝える文を返す');
  const s1 = await tabState(tab1), su = await tabState(userTab);
  assert(!s1.attached && !s1.agent && !su.attached && !su.agent, 'F1/F2 残したタブは detach され、エージェントのタブから外れる');
  assert((await tabState(bTab)).attached, 'F12 他のセッションのタブには影響しない');

  // session_end の後の呼び出しは新しいセッション
  const again = await a.tool('tab_open', { browser: 'ag', snapshot: false });
  assert(again.json.tab === 't1' && again.json.tab_id !== tab1, 'session_end の後は新しいセッションでハンドルが振り直される');
  const end2 = await a.tool('session_end', { close_tabs: true });
  await sleep(300);
  assert(end2.json.closed.length === 1 && !(await fetch(`${RELAY}/b/ag/json/list`).then(x => x.json())).some(x => x.tabId === again.json.tab_id) && (await tabState(bTab)).attached, 'F12 close_tabs:true は自分のタブだけ閉じる');

  // MCP プロセスの異常終了: 中継が後始末する
  b.child.kill('SIGKILL');
  await sleep(500);
  const sb = await tabState(bTab);
  assert(!sb.attached && !sb.agent && (await fetch(`${RELAY}/b/ag/json/list`).then(x => x.json())).some(x => x.tabId === bTab), 'F3 MCP プロセスが落ちたら、タブは開いたまま detach されエージェントのタブから外れる');
} finally {
  for (const c of clients) c.child.kill();
  await browser.close(); relay.stop(); srv.close();
}
console.log('E2E-15 agent (MCP): PASS');
process.exit(0);
