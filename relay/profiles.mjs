// 中継上のブラウザ名 → { app, profile } の対応(profiles.json)と、閉じているプロファイルの窓を開く処理。CLI の open と MCP の browser_open が使う。
// 拡張は自分のプロファイルのディレクトリを知れないので、--app/--profile で初回起動したときに新しく登録された名前を学習して保存する
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILES_PATH = fileURLToPath(new URL('../profiles.json', import.meta.url));
export const APPS = { chrome: { app: 'Google Chrome', data: 'Google/Chrome' }, edge: { app: 'Microsoft Edge', data: 'Microsoft Edge' } }; // macOS のアプリ名と User Data の場所
const LAUNCH_TIMEOUT_MS = 30_000; // プロファイル起動 → 拡張の SW 起動 → 中継登録まで
const POLL_MS = 500;

export const readProfiles = () => { try { return JSON.parse(readFileSync(PROFILES_PATH, 'utf8')); } catch { return {}; } };

/**
 * プロファイルが開いていないと拡張の SW が動かず中継に現れない。そのプロファイルのウィンドウを開いて登録を待つ。
 * 起動中のブラウザには open -n の新プロセスが引数を引き渡して終了し、既存プロセスがそのプロファイルの窓を開く。
 * listNames: 中継に接続中のブラウザ名の配列を返す async 関数。戻り値 { name, already, app, profile }
 */
export async function openProfile({ name, app, profile, front = false, timeoutMs = LAUNCH_TIMEOUT_MS }, listNames) {
  const known = readProfiles();
  let target = name && known[name];
  if (name && !target) throw new Error(`profiles.json に ${name} がありません。一度 open --app chrome|edge --profile <ディレクトリ名|表示名> で起動すると登録されます`);
  if (!target) {
    if (!APPS[app] || typeof profile !== 'string') throw new Error('open <name> か open --app chrome|edge --profile <ディレクトリ名|表示名> を指定してください');
    const cache = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support', APPS[app].data, 'Local State'), 'utf8')).profile?.info_cache ?? {};
    const dir = Object.keys(cache).find(d => d === profile || cache[d].name === profile);
    if (!dir) throw new Error(`プロファイルが見つかりません: ${profile}(候補: ${Object.entries(cache).map(([d, v]) => `${d}=${v.name}`).join(', ')})`);
    target = { app, profile: dir };
  }
  const label = `${APPS[target.app].app} / ${target.profile}`;
  const before = new Set(await listNames());
  // 対象プロファイルが既に名前と対応付いていて接続中なら何もしない
  const knownName = name ?? Object.entries(known).find(([, p]) => p.app === target.app && p.profile === target.profile)?.[0];
  if (knownName && before.has(knownName)) return { name: knownName, already: true, ...target };
  await promisify(execFile)('open', [...(front ? [] : ['-g']), '-na', APPS[target.app].app, '--args', `--profile-directory=${target.profile}`]); // -g: 前面を奪わない
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await listNames();
    const fresh = names.filter(n => !before.has(n));
    // 同時に別のブラウザも繋がった場合は、どれがこのプロファイルか分からないので学習しない
    if (!knownName && fresh.length > 1) throw new Error(`同時に複数のブラウザが接続したため、どれが ${label} か判別できません(${fresh.join(', ')})。open <name> を使うか、他の起動が落ち着いてからやり直してください`);
    const got = knownName ? names.find(n => n === knownName) : fresh[0]; // 対応付け済みならその名前だけを待つ
    if (got) {
      if (!knownName) writeFileSync(PROFILES_PATH, JSON.stringify({ ...readProfiles(), [got]: target }, null, 1) + '\n');
      return { name: got, already: false, ...target };
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`${label} の拡張が中継に繋がりませんでした(拡張が未導入・ブラウザ名が未設定・既に接続済みのいずれか。browsers で確認)`);
}
