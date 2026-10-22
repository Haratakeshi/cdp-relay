import { $, getStatus, renderStatus } from './status.js';

const fields = ['name', 'port', 'relayUrl', 'token'];
$('ver').textContent = `v${chrome.runtime.getManifest().version}`;
chrome.storage.local.get(fields, v => fields.forEach(f => { if (v[f]) $(f).value = v[f]; }));
$('form').onsubmit = async e => {
  e.preventDefault();
  const cfg = Object.fromEntries(fields.map(f => [f, $(f).value.trim()]));
  await chrome.storage.local.set(cfg); // background.js が storage.onChanged で再接続する
  $('saved').textContent = '保存しました';
  setTimeout(() => { $('saved').textContent = ''; refresh(); }, 1200);
};
async function refresh() {
  const s = await getStatus();
  renderStatus(s, $('status'));
  $('raw').textContent = JSON.stringify(s, null, 1);
}
refresh(); setInterval(refresh, 3000);
