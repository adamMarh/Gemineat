'use strict';
const $ = (s) => document.querySelector(s);
const DEFAULT_MODEL = 'gemini-3.8-flash';

function status(el, text, ok) { el.textContent = text; el.className = `form-status ${ok ? 'ok' : 'err'}`; }

(async function init() {
  const { apiKey = '', model = '', engine = 'auto' } = await chrome.storage.local.get(['apiKey', 'model', 'engine']);
  $('#apiKey').value = apiKey;
  $('#model').value = model || DEFAULT_MODEL;
  setEngineUI(engine);
  GoalsForm.mount($('#goalsMount'));
  refreshNano();
})();

/* ---------- engine ---------- */

const ENGINE_HELP = {
  auto: 'Uses the on-device model, or the Gemini API if you add a key below (more accurate).',
  ondevice: 'Always uses Chrome\'s on-device model. Nothing is sent to any server.',
  gemini: 'Always uses the Gemini API with your own key.',
};

function setEngineUI(engine) {
  document.querySelectorAll('input[name=engine]').forEach((r) => (r.checked = r.value === engine));
  $('#engineHelp').textContent = ENGINE_HELP[engine];
}

$('#engineSeg').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ engine: e.target.value });
  setEngineUI(e.target.value);
});

const NANO_LABEL = {
  available: 'Ready ✓',
  downloadable: 'Not downloaded yet',
  downloading: 'Downloading…',
  unavailable: 'Not supported on this device',
  unsupported: 'Not available in this Chrome version',
};

async function refreshNano() {
  const a = await OnDevice.availability();
  $('#nanoStatus').textContent = NANO_LABEL[a] || a;
  const btn = $('#nanoDownload');
  btn.hidden = !(a === 'downloadable' || a === 'downloading');
  btn.textContent = a === 'downloading' ? 'Show progress' : 'Download model';
}

$('#nanoDownload').addEventListener('click', async () => {
  const btn = $('#nanoDownload');
  btn.disabled = true;
  try {
    await OnDevice.download((p) => ($('#nanoStatus').textContent = `Downloading… ${Math.round(p * 100)}%`));
  } catch (e) {
    $('#nanoStatus').textContent = e.message;
  }
  btn.disabled = false;
  refreshNano();
});

$('#saveKey').addEventListener('click', async () => {
  await chrome.storage.local.set({ apiKey: $('#apiKey').value.trim(), model: $('#model').value.trim() || DEFAULT_MODEL });
  status($('#keyStatus'), 'Saved ✓', true);
});

$('#showKey').addEventListener('click', () => {
  const i = $('#apiKey');
  i.type = i.type === 'password' ? 'text' : 'password';
  $('#showKey').textContent = i.type === 'password' ? 'show' : 'hide';
});

$('#testKey').addEventListener('click', async () => {
  const el = $('#keyStatus');
  if (!$('#apiKey').value.trim()) return status(el, 'Enter a key first.', false);
  status(el, 'Testing…', true);
  const res = await chrome.runtime.sendMessage({ type: 'testKey', apiKey: $('#apiKey').value, model: $('#model').value });
  if (res?.ok) status(el, `Key works ✓ (${$('#model').value.trim() || DEFAULT_MODEL} replied: ${res.data.reply})`, true);
  else status(el, res?.error?.message || 'Test failed.', false);
});

$('#clearOverrides').addEventListener('click', async () => {
  await chrome.storage.local.remove(['overrides', 'excluded']);
  $('#dataStatus').textContent = 'Item edits and hidden items cleared.';
});
$('#clearCache').addEventListener('click', async () => {
  await chrome.storage.local.remove('cartCache');
  $('#dataStatus').textContent = 'Cache cleared.';
});
