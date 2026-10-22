#!/usr/bin/env node
// cdp-relay CLI: 常駐中継サーバー経由で、起動中のブラウザ(拡張機能を入れたプロファイル)を操作する。
//   browsers                                    登録中のブラウザ一覧
//   pages   --browser <name>                    タブ一覧(attach しない)
//   goto <url> --browser <name> [--tab new|<n>|<部分一致>]
//   text    --browser <name> [--tab ...]        body.innerText
//   snap    --browser <name> [--tab ...] [--json] アクセシビリティ・対話可能要素スナップショット(@1, @2...)
//   eval <expr> --browser <name> [--tab ...] [--json] JavaScript 式の評価結果を表示 (Fast Path: ~10ms)
//   click <sel|@n> --browser <name> [--tab ...] [--json] セレクタまたは参照番号の要素をクリック (Fast Path)
//   fill <sel|@n> <val> --browser <name> [--tab ...] [--json] 入力欄に文字列を入力 (Fast Path, 仮想DOM対応)
//   shot <out.png> --browser <name> [--tab ...] [--full] 画面キャプチャを保存 (Fast Path: ~30ms)
//   run <script.mjs> --browser <name> [--tab ...] [--args '<json>'] [--timeout ms]
//   close   --browser <name> --tab ...          タブを閉じる
//   events  --browser <name>                    中継が自動処理したダイアログ・認証・ダウンロード・権限の記録
//   open <name> | open --app chrome|edge --profile <ディレクトリ名|表示名> [--front]
//                                               プロファイルのウィンドウを開き、拡張が中継に繋がるまで待つ
// run に渡すのは default export が async (browser, page, puppeteer, args) => result の .mjs(絶対パス)。
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APPS, openProfile, readProfiles as profiles } from './relay/profiles.mjs';
import { clientAuthHeaders } from './relay/client-token.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CDP_RELAY_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = clientAuthHeaders(PORT); // 中継がクライアント認証(CDP_RELAY_CLIENT_AUTH=1)なら必要。無ければ空
const STATE = join(DIR, 'tmp/last-tab.json'); // ブラウザごとの直近操作タブ(--tab 省略時に使う)

const argv = process.argv.slice(2);
const cmd = argv.shift();
const opts = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) opts[k] = true; else { opts[k] = v; i++; } }
  else pos.push(argv[i]);
}
const state = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
const remember = (name, id) => { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify({ ...state(), [name]: id })); };
const api = path => fetch(`${BASE}${path}`, { headers: AUTH }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
const apiPost = (path, body = {}) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...AUTH },
  body: JSON.stringify(body)
}).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });

async function browserName() {
  if (opts.browser) return opts.browser;
  const list = await api('/browsers');
  if (list.length === 1) return list[0].name;
  throw new Error(`--browser を指定してください(接続中: ${list.map(b => b.name).join(', ') || 'なし'})`);
}

/** 既存タブを特定して tabId を返す (Fast Path 用) */
async function resolveTab(name) {
  const tabs = await api(`/b/${encodeURIComponent(name)}/json/list`);
  const sel = opts.tab;
  let wanted = null;
  if (sel !== 'new') {
    if (sel === undefined) wanted = tabs.find(t => t.id === state()[name]);              // 直近に操作したタブ
    else if (/^\d+$/.test(sel)) wanted = tabs[Number(sel)];                              // pages の [n]
    else wanted = tabs.find(t => t.id === sel)                                           // targetId 完全一致
      ?? tabs.find(t => `${t.url} ${t.title}`.toLowerCase().includes(sel.toLowerCase())); // URL/タイトル部分一致
    if (!wanted) throw new Error(`タブが見つかりません: ${sel ?? '直近のタブは閉じられています。--tab <番号|部分一致> を渡してください'}`);
  } else {
    throw new Error('--tab new は goto でのみ使用できます');
  }
  remember(name, wanted.id);
  return wanted;
}

/** 選んだタブだけを attach した状態で fn を実行する */
async function withTab(name, fn) {
  const tabs = await api(`/b/${encodeURIComponent(name)}/json/list`);
  const sel = opts.tab;
  let wanted = null;
  if (sel !== 'new') {
    if (sel === undefined) wanted = tabs.find(t => t.id === state()[name]);              // 直近に操作したタブ
    else if (/^\d+$/.test(sel)) wanted = tabs[Number(sel)];                              // pages の [n]
    else wanted = tabs.find(t => t.id === sel)                                           // targetId 完全一致
      ?? tabs.find(t => `${t.url} ${t.title}`.toLowerCase().includes(sel.toLowerCase())); // URL/タイトル部分一致
    if (!wanted) throw new Error(`タブが見つかりません: ${sel ?? '直近のタブは閉じられています。--tab new か --tab <部分一致> を渡してください'}`);
  }
  // 既存タブを選んだら、コマンドの実行中だけ中継の「エージェントのタブ」にする(scope: agentTabs の自動処理の対象)。
  // 元々エージェントのタブでなかったら終了時に外す(ユーザーのタブを自動処理の対象に残さない)。新規タブは中継が自動で登録する
  const adoptUrl = wanted && `${BASE}/b/${encodeURIComponent(name)}/tabs/${wanted.tabId}/adopt`;
  const adopted = wanted && await fetch(adoptUrl, { method: 'POST', headers: AUTH }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
  try { return await attachAndRun(name, wanted, fn); }
  finally { if (adopted && !adopted.wasAgent) await fetch(adoptUrl, { method: 'DELETE', headers: AUTH }).catch(() => {}); }
}
async function attachAndRun(name, wanted, fn) {
  const browser = await puppeteer.connect({ browserWSEndpoint: `${BASE.replace('http', 'ws')}/b/${encodeURIComponent(name)}/devtools/browser`, headers: AUTH, defaultViewport: null, protocolTimeout: Number(opts.timeout || 120_000) });
  try {
    const page = wanted ? (await browser.pages()).find(p => p.target()._targetId === wanted.id) : await browser.newPage();
    if (!page) throw new Error(`タブに接続できません: ${wanted.id}`);
    remember(name, page.target()._targetId);
    return await fn(browser, page);
  } finally { browser.disconnect(); }
}

const commands = {
  async browsers() {
    const list = await api('/browsers');
    for (const b of list) console.log(`${b.name}\tport=${b.port ?? '-'}\tattached=${b.attachedTabs.length}${b.portError ? `\tportError=${b.portError}` : ''}`);
    for (const [name, p] of Object.entries(profiles())) if (!list.some(b => b.name === name)) console.log(`${name}\toffline\t(open ${name} で起動できる: ${p.app} / ${p.profile})`);
  },
  // プロファイルの窓を開いて拡張が中継に登録するまで待つ(relay/profiles.mjs。MCP の browser_open と共通)
  async open() {
    const r = await openProfile({ name: pos[0], app: opts.app, profile: opts.profile, front: !!opts.front, ...(opts.timeout ? { timeoutMs: Number(opts.timeout) } : {}) }, async () => (await api('/browsers')).map(b => b.name));
    console.log(r.already ? `${r.name} は接続済み` : `${r.name} が接続しました(${APPS[r.app].app} / ${r.profile})`);
  },
  async pages() {
    const name = await browserName();
    const last = state()[name];
    (await api(`/b/${encodeURIComponent(name)}/json/list`)).forEach((t, i) => console.log(`${t.id === last ? '*' : ' '} [${i}] ${t.title.slice(0, 50)} | ${t.url.slice(0, 110)}`));
  },
  async goto() {
    const name = await browserName();
    if (!opts.tab) opts.tab = 'new'; // 既定は新規タブ(ユーザーの作業中タブを奪わない)
    console.log(await withTab(name, async (_b, page) => { await page.goto(pos[0], { waitUntil: 'networkidle2' }); return page.url(); }));
  },
  async events() { for (const e of await api(`/b/${encodeURIComponent(await browserName())}/events`)) console.log(JSON.stringify(e)); },
  async text() { console.log(await withTab(await browserName(), (_b, page) => page.evaluate(() => document.body.innerText))); },
  async shot() {
    const out = resolve(pos[0]);
    const name = await browserName();
    const tab = await resolveTab(name);
    const res = await fetch(`${BASE}/b/${encodeURIComponent(name)}/tabs/${tab.tabId}/shot.png${opts.full ? '?full=1' : ''}`, { headers: AUTH });
    if (!res.ok) throw new Error(`shot failed: ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(out, buf);
    console.log(out);
  },
  async snap() {
    const name = await browserName();
    const tab = await resolveTab(name);
    const res = await fetch(`${BASE}/b/${encodeURIComponent(name)}/tabs/${tab.tabId}/snapshot${opts.json ? '?format=json' : ''}`, { headers: AUTH });
    if (!res.ok) throw new Error(`snapshot failed: ${res.statusText}`);
    const text = await res.text();
    console.log(text);
  },
  async run() {
    const mod = await import(`${pathToFileURL(resolve(pos[0])).href}?t=${Date.now()}`); // 同名ファイルの書き換えを拾う
    const result = await withTab(await browserName(), (browser, page) => mod.default(browser, page, puppeteer, opts.args ? JSON.parse(opts.args) : {}));
    console.log(typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 1));
  },
  async eval() {
    const expr = pos[0];
    if (!expr) throw new Error('eval <expression> を指定してください');
    const name = await browserName();
    const tab = await resolveTab(name);
    const res = await apiPost(`/b/${encodeURIComponent(name)}/tabs/${tab.tabId}/eval`, { expression: expr, timeout: Number(opts.timeout || 15_000) });
    const val = res.result?.value ?? res.result;
    if (opts.json) console.log(JSON.stringify(val, null, 2));
    else console.log(typeof val === 'string' ? val : JSON.stringify(val ?? null, null, 2));
  },
  async click() {
    const selOrRef = pos[0];
    if (!selOrRef) throw new Error('click <selector|@ref> を指定してください');
    const name = await browserName();
    const tab = await resolveTab(name);
    const isRef = selOrRef.startsWith('@') || /^\d+$/.test(selOrRef);
    const body = isRef ? { ref: Number(selOrRef.replace('@', '')) } : { selector: selOrRef };
    if (opts.timeout) body.timeout = Number(opts.timeout);
    const res = await apiPost(`/b/${encodeURIComponent(name)}/tabs/${tab.tabId}/click`, body);
    if (opts.json) console.log(JSON.stringify(res, null, 2));
    else console.log(`clicked: [${res.tag}] "${res.label}"`);
  },
  async fill() {
    const selOrRef = pos[0];
    const val = pos[1] ?? '';
    if (!selOrRef) throw new Error('fill <selector|@ref> <value> を指定してください');
    const name = await browserName();
    const tab = await resolveTab(name);
    const isRef = selOrRef.startsWith('@') || /^\d+$/.test(selOrRef);
    const body = isRef ? { ref: Number(selOrRef.replace('@', '')), value: val } : { selector: selOrRef, value: val };
    if (opts.timeout) body.timeout = Number(opts.timeout);
    const res = await apiPost(`/b/${encodeURIComponent(name)}/tabs/${tab.tabId}/fill`, body);
    if (opts.json) console.log(JSON.stringify(res, null, 2));
    else console.log(`filled: [${res.tag}] = ${res.value}`);
  },
  async close() { await withTab(await browserName(), (_b, page) => page.close()); console.log('closed'); },
};

if (!commands[cmd]) { console.error('usage: cdp-relay browsers|open <name>|events|pages|goto <url>|text|snap|eval <expr>|click <sel|@n>|fill <sel|@n> <val>|shot <out.png>|run <script.mjs>|close  --browser <name> [--tab new|<n>|<match>] [--full] [--json] [--args json] [--timeout ms]'); process.exit(2); }
commands[cmd]().catch(e => { console.error('cdp-relay error:', e.message); process.exit(1); });
