// pnpm test:e2e: E2E を順に実行し、最初の失敗で止まる(OS を問わず動くよう、シェルの for 文ではなく node で回す)。
//   node test/run.mjs [e2e-relay e2e-agent …]   引数を渡すとそのテストだけ
import { spawnSync } from 'node:child_process';

const ALL = ['e2e-relay', 'e2e-page', 'e2e-puppeteer', 'e2e-playwright', 'e2e-multi', 'e2e-mixed', 'e2e-refcount', 'e2e-reconnect', 'e2e-dialogs', 'e2e-downloads', 'e2e-permissions', 'e2e-hardening', 'e2e-unattended', 'e2e-agent'];
const names = process.argv.length > 2 ? process.argv.slice(2) : ALL;
for (const name of names) {
  const { status } = spawnSync(process.execPath, [`test/${name}.mjs`], { stdio: 'inherit' });
  if (status !== 0) { console.error(`${name} failed (exit ${status})`); process.exit(status ?? 1); }
}
