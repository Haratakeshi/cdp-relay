import { $, getStatus, renderStatus } from './status.js';

$('ver').textContent = `v${chrome.runtime.getManifest().version}`;
$('options').onclick = () => chrome.runtime.openOptionsPage();

async function refresh() {
  const s = await getStatus();
  renderStatus(s, $('status'));
  $('setup').hidden = !!s.configured || !!s.error;
}
$('save').onclick = async () => {
  const name = $('name').value.trim();
  if (!name) return $('name').focus();
  await chrome.storage.local.set({ name }); // background.js が storage.onChanged で接続する
  setTimeout(refresh, 800);
};
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') $('save').click(); });
refresh(); setInterval(refresh, 2000);
