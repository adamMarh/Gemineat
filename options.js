'use strict';
const $ = (s) => document.querySelector(s);
const DEFAULT_MODEL = 'gemini-3.8-flash';

function status(el, text, ok) { el.textContent = text; el.className = `form-status ${ok ? 'ok' : 'err'}`; }

(async function init() {
  const { apiKey = '', model = '' } = await chrome.storage.local.get(['apiKey', 'model']);
  $('#apiKey').value = apiKey;
  $('#model').value = model || DEFAULT_MODEL;
  GoalsForm.mount($('#goalsMount'));
})();

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
  await chrome.storage.local.remove('overrides');
  $('#dataStatus').textContent = 'Item edits cleared.';
});
$('#clearCache').addEventListener('click', async () => {
  await chrome.storage.local.remove('cartCache');
  $('#dataStatus').textContent = 'Cache cleared.';
});
