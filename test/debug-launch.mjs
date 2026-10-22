// Chrome 152(ブランド版)で Extensions.loadUnpacked により未パック拡張を読み込めるかの検証
import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
const userDataDir = mkdtempSync(join(resolve('tmp'), 'profile-'));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, userDataDir, enableExtensions: true, defaultViewport: null,
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=900,700'],
});
console.log('version:', await browser.version());
const id = await browser.installExtension(resolve('extension'));
console.log('installed extension id:', id);
await new Promise(r => setTimeout(r, 1500));
console.log('targets:', (await browser.targets()).map(t => `${t.type()} ${t.url().slice(0, 80)}`));
await browser.close();
console.log('closed');
