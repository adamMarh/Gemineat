// popup.js — UI controller. All math lives in goals.js / util.js; all Gemini calls in background.js.
'use strict';
const U = globalThis.CartUtil;
const G = globalThis.Goals;
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r = Math.round;

const state = {
  apiKey: '',
  profile: null,
  overrides: {},
  loading: false,
  error: null,          // { code, message }
  scan: null,           // validated cart result + { source, title, url, cached, truncated }
  editing: null,        // normalized name of the item being edited
  sugg: null,           // validated suggestions
  suggLoading: false,
  suggError: null,
  selected: { swaps: new Set(), additions: new Set(), removals: new Set() },
};

/* ---------------- derived data ---------------- */

const baseItems = () => (state.scan ? U.applyOverrides(state.scan.items, state.overrides) : []);
const hasSelection = () => Object.values(state.selected).some((s) => s.size);
const selectedArrays = () => ({ swaps: [...state.selected.swaps], additions: [...state.selected.additions], removals: [...state.selected.removals] });
const viewItems = () => (state.sugg && hasSelection() ? U.applySwapPreview(baseItems(), state.sugg, selectedArrays()) : baseItems());
const targets = () => G.computeTargets(state.profile);
const daily = (items) => {
  const p = state.profile || {};
  return U.perPersonPerDay(U.totals(items), p.people || 1, p.days || 7, p.coveragePct || 100);
};

/* ---------------- messaging ---------------- */

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res) throw Object.assign(new Error('No response from background worker.'), { code: 'UNKNOWN' });
  if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data;
}

async function readPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw Object.assign(new Error('No active tab.'), { code: 'NO_PAGE' });
  try {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return inj?.result || { text: '', title: tab.title, url: tab.url };
  } catch {
    throw Object.assign(new Error("This page can't be read (browser or store pages are off-limits). Open your cart on a shopping site, or use Paste list."), { code: 'NO_PAGE' });
  }
}

/* ---------------- actions ---------------- */

async function scan({ force = false } = {}) {
  if (!state.apiKey) return renderCart();
  state.loading = true; state.error = null; resetSuggestions(); renderAll();
  try {
    const page = await readPage();
    if (!page.text || page.text.length < 40) {
      throw Object.assign(new Error('This page has almost no readable text (the cart may be inside an iframe). Try Paste list.'), { code: 'NO_TEXT' });
    }
    const data = await send({ type: 'extractCart', text: page.text, title: page.title, url: page.url, source: 'page', force });
    state.scan = { ...data, source: 'page', title: page.title, url: page.url, truncated: page.truncated };
  } catch (e) {
    state.error = { code: e.code, message: e.message };
  } finally {
    state.loading = false; renderAll();
  }
}

async function scanPaste(text) {
  if (!text.trim()) return;
  state.loading = true; state.error = null; resetSuggestions(); renderAll();
  try {
    const data = await send({ type: 'extractCart', text: text.slice(0, 30000), title: 'Pasted list', url: 'pasted:list', source: 'paste' });
    state.scan = { ...data, source: 'paste', title: 'Pasted list', url: '' };
    $('#pasteBox').hidden = true;
  } catch (e) {
    state.error = { code: e.code, message: e.message };
  } finally {
    state.loading = false; renderAll();
  }
}

function resetSuggestions() {
  state.sugg = null; state.suggError = null;
  Object.values(state.selected).forEach((s) => s.clear());
}

async function suggest() {
  const t = targets();
  const items = baseItems();
  if (!t || !items.length) return;
  state.suggLoading = true; state.suggError = null; resetSuggestions(); renderSuggest();
  const d = daily(items);
  const g = U.gaps(d, t);
  // PRIVACY: only goal mode, numeric targets, items+macros and gaps. No name, weight, or history.
  const payload = {
    goalMode: state.profile.mode,
    dailyTargets: { kcal: r(t.kcal), protein_g: r(t.protein_g), carbs_g: r(t.carbs_g), fat_g: r(t.fat_g) },
    cartPerPersonPerDay: { kcal: r(d.kcal), protein_g: r(d.protein_g), carbs_g: r(d.carbs_g), fat_g: r(d.fat_g) },
    gaps: U.fmtGap(g),
    cartContext: `${state.profile.people} people, ${state.profile.days} days, cart covers ${state.profile.coveragePct}% of food`,
    items: items.map((i) => ({ name: i.name, quantity: i.quantity, packageSize: i.packageSize, kcal: r(i.kcal), protein_g: r(i.protein_g), carbs_g: r(i.carbs_g), fat_g: r(i.fat_g) })),
  };
  try {
    state.sugg = await send({ type: 'suggest', payload });
  } catch (e) {
    state.suggError = { code: e.code, message: e.message };
  } finally {
    state.suggLoading = false; renderAll();
  }
}

async function saveOverride(key, ov) {
  if (ov) state.overrides[key] = ov; else delete state.overrides[key];
  await chrome.storage.local.set({ overrides: state.overrides });
  state.editing = null; renderAll();
}

/* ---------------- rendering helpers ---------------- */

function errorBanner(err) {
  const tips = {
    NO_KEY: 'Add your Gemini API key in <a href="#" data-action="options">Options</a>.',
    BAD_KEY: 'Check your key in <a href="#" data-action="options">Options</a>.',
    BAD_MODEL: 'Change the model in <a href="#" data-action="options">Options</a>.',
    QUOTA: 'Free-tier keys have per-minute limits; try again shortly.',
    NETWORK: 'You appear to be offline.',
    NO_PAGE: '', NO_TEXT: '',
  };
  return `<div class="banner err"><b>${esc(err.message)}</b>${tips[err.code] ? `<div class="small">${tips[err.code]}</div>` : ''}</div>`;
}

function progressBars(d, t) {
  const rows = [['kcal', 'Calories', ''], ['protein_g', 'Protein', ' g'], ['carbs_g', 'Carbs', ' g'], ['fat_g', 'Fat', ' g']];
  // Track spans 0–150% of target; the marker sits at 100%.
  return rows.map(([k, label, unit]) => {
    const pct = t[k] > 0 ? (d[k] / t[k]) * 100 : 0;
    const st = U.status(d[k], t[k]);
    const width = Math.min(pct, 150) / 1.5;
    return `<div class="bar"><div class="lbl"><span><span class="dot ${st}"></span>${label}</span><span>${r(d[k])}${unit} / ${r(t[k])}${unit} <span class="muted">(${r(pct)}%)</span></span></div>
      <div class="track" role="progressbar" aria-label="${label}" aria-valuenow="${r(pct)}" aria-valuemin="0" aria-valuemax="150"><div class="fill ${st}" style="width:${width}%"></div><div class="mark" style="left:${100 / 1.5}%"></div></div></div>`;
  }).join('');
}

function goalSection(items) {
  const t = targets();
  if (!t) return `<div class="banner warn"><a href="#" data-action="goals">Set your goals</a> to compare this cart.</div>`;
  const d = daily(items);
  const p = state.profile;
  return `<div class="card">
    <h2>Per person per day ${hasSelection() ? '<span class="chip preview">preview</span>' : ''}</h2>
    <div class="muted small">${p.people} ${p.people === 1 ? 'person' : 'people'} × ${p.days} days${p.coveragePct < 100 ? `, cart is ${p.coveragePct}% of food (scaled to a full day)` : ''}</div>
    ${progressBars(d, t)}
    <div class="verdict">${esc(U.verdict(d, t, p.mode))}</div>
  </div>`;
}

function totalsCard(items) {
  const t = U.totals(items);
  const s = U.macroSplit(t);
  return `<div class="card">
    <div class="row" style="justify-content:space-between"><h2>Cart totals</h2>${state.scan.cached ? '<span class="chip">cached</span>' : ''}</div>
    <div class="totals">
      <div><b>${r(t.kcal).toLocaleString()}</b><span class="muted">kcal</span></div>
      <div><b>${r(t.protein_g)}</b><span class="muted">protein g</span></div>
      <div><b>${r(t.carbs_g)}</b><span class="muted">carbs g</span></div>
      <div><b>${r(t.fat_g)}</b><span class="muted">fat g</span></div>
    </div>
    <div class="split" aria-label="Macro split by calories"><span class="p" style="width:${s.protein}%"></span><span class="c" style="width:${s.carbs}%"></span><span class="f" style="width:${s.fat}%"></span></div>
    <div class="legend"><span><span class="dot p"></span>Protein ${r(s.protein)}%</span><span><span class="dot c"></span>Carbs ${r(s.carbs)}%</span><span><span class="dot f"></span>Fat ${r(s.fat)}%</span></div>
  </div>`;
}

function itemRow(it) {
  const key = U.normalizeName(it.name);
  const qty = `${it.quantity} × ${it.packageSize || 'size?'}`;
  const editing = state.editing === key && !it.preview;
  const conf = it.confidence || 'low';
  return `<li>
    <div class="head">
      <div><span class="dot ${conf}" title="${conf} confidence"></span><span class="name">${esc(it.name)}</span>
        ${it.brand ? `<span class="muted small"> · ${esc(it.brand)}</span>` : ''}
        ${it.overridden ? ' <span class="chip">edited</span>' : ''}${it.preview ? ` <span class="chip preview">${it.preview}</span>` : ''}
        <div class="muted small">${esc(qty)}${it.totalGrams ? ` · ${r(it.totalGrams)} g` : ''}</div></div>
      <div class="macros"><b>${r(it.kcal)}</b> kcal<br><span class="muted">${r(it.protein_g)}P ${r(it.carbs_g)}C ${r(it.fat_g)}F</span>
        ${it.preview ? '' : `<br><button class="link small" data-action="edit" data-key="${esc(key)}">edit</button>`}</div>
    </div>
    ${it.assumption ? `<div class="assume">${esc(it.assumption)}</div>` : ''}
    ${editing ? editForm(it, key) : ''}
  </li>`;
}

function editForm(it, key) {
  const f = (name, label, v) => `<label>${label}<input name="${name}" type="number" min="0" step="any" value="${r(v)}"></label>`;
  return `<form class="edit-form" data-key="${esc(key)}">
    ${f('totalGrams', 'grams', it.totalGrams)}${f('kcal', 'kcal', it.kcal)}${f('protein_g', 'P g', it.protein_g)}${f('carbs_g', 'C g', it.carbs_g)}${f('fat_g', 'F g', it.fat_g)}
    <div class="row"><button type="submit" class="primary">Save</button><button type="button" data-action="cancel-edit">Cancel</button>
    ${it.overridden ? '<button type="button" data-action="reset-edit">Reset to estimate</button>' : ''}
    <span class="muted small">Change only grams to rescale macros.</span></div>
  </form>`;
}

/* ---------------- tab renderers ---------------- */

function renderCart() {
  const banners = [];
  if (!state.apiKey) {
    banners.push(`<div class="banner warn"><b>Add your Gemini API key to get started.</b><div class="small"><a href="#" data-action="options">Open Options</a> to paste a key (free from Google AI Studio).</div></div>`);
  }
  $('#cartBanners').innerHTML = banners.join('');
  ['#rescan', '#pasteToggle', '#copySummary'].forEach((s) => ($(s).disabled = !state.apiKey || state.loading));
  $('#copySummary').disabled = !state.scan?.items?.length || state.loading;

  const body = $('#cartBody');
  if (!state.apiKey) { body.innerHTML = ''; return; }
  if (state.loading) { body.innerHTML = `<div class="spinner">Reading your cart with Gemini…</div>`; return; }
  if (state.error) { body.innerHTML = errorBanner(state.error); return; }
  if (!state.scan) { body.innerHTML = ''; return; }

  const s = state.scan;
  const warn = s.warnings?.length ? `<div class="banner warn small"><b>Some items were skipped or adjusted:</b><br>${s.warnings.map(esc).join('<br>')}</div>` : '';
  if (!s.cartFound || !s.items.length) {
    body.innerHTML = `${warn}<div class="banner"><b>No cart found on this page.</b><div class="small muted">${esc(s.reason)}</div><div class="small">Open your cart/basket page and Rescan, or use Paste list.</div></div>`;
    return;
  }
  const items = viewItems();
  body.innerHTML = `${warn}
    ${s.truncated ? '<div class="banner warn small">Page text was long and got truncated at 30k characters; some items may be missing.</div>' : ''}
    ${totalsCard(items)}
    ${goalSection(items)}
    <div class="card"><h2>Items (${items.length})</h2><ul class="items">${items.map(itemRow).join('')}</ul>
    <div class="muted small">Macros are AI estimates for the full purchased amount. Dot = confidence.</div></div>`;
}

function renderSuggest() {
  const el = $('#suggestBody');
  const items = baseItems();
  if (!state.apiKey) { el.innerHTML = `<div class="banner warn"><a href="#" data-action="options">Add a Gemini API key</a> first.</div>`; return; }
  if (!items.length) { el.innerHTML = `<div class="banner">Scan a cart first, then come back for suggestions.</div>`; return; }
  if (!targets()) { el.innerHTML = `<div class="banner warn"><a href="#" data-action="goals">Set your goals</a> so suggestions can target them.</div>`; return; }

  const btn = `<button id="suggestGo" class="primary" ${state.suggLoading ? 'disabled' : ''}>${state.sugg ? 'Regenerate suggestions' : 'Suggest improvements'}</button>`;
  let html = `<div class="row" style="margin-bottom:10px">${btn}${state.sugg ? '<button id="copyChanges">Copy shopping changes</button>' : ''}</div>`;
  if (state.suggLoading) html += `<div class="spinner">Asking Gemini for better options…</div>`;
  else if (state.suggError) html += errorBanner(state.suggError);
  else if (state.sugg) {
    const s = state.sugg;
    const vi = viewItems();
    html += `<div class="card">${s.summary ? `<div>${esc(s.summary)}</div>` : ''}
      <div class="small muted" style="margin-top:4px">Toggle "Preview" to see the effect on your daily targets.</div>
      ${progressBars(daily(vi), targets())}
      <div class="verdict">${esc(U.verdict(daily(vi), targets(), state.profile.mode))}</div></div>`;
    const dl = (m) => `${fmtSigned(m.kcal)} kcal · ${fmtSigned(m.protein_g)}P ${fmtSigned(m.carbs_g)}C ${fmtSigned(m.fat_g)}F`;
    const card = (kind, i, title, reason, extra) => {
      const on = state.selected[kind].has(i);
      return `<div class="sugg ${on ? 'on' : ''}"><div class="kind">${kind.replace(/s$/, '')}</div><div><b>${title}</b></div>
        <div class="small">${esc(reason)}</div>${extra ? `<div class="delta muted">${extra}</div>` : ''}
        <label class="toggle"><input type="checkbox" data-kind="${kind}" data-i="${i}" ${on ? 'checked' : ''}> Preview</label></div>`;
    };
    s.swaps.forEach((x, i) => (html += card('swaps', i, `${esc(x.replaceItem)} → ${esc(x.withItem)}`, x.reason, `per package: ${dl(x.deltaPerPackage)}`)));
    s.additions.forEach((x, i) => (html += card('additions', i, `Add ${esc(x.item)}${x.packageSize ? ` (${esc(x.packageSize)})` : ''}`, x.reason, `per package: ${dl(x.macrosPerPackage)}`)));
    s.removals.forEach((x, i) => (html += card('removals', i, `Remove ${esc(x.item)}`, x.reason, '')));
    if (!s.swaps.length && !s.additions.length && !s.removals.length) html += `<div class="banner">No changes suggested: this cart already fits your goals well.</div>`;
  }
  el.innerHTML = html;
}

const fmtSigned = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(r(v))}`;

function renderAll() { renderCart(); renderSuggest(); }

/* ---------------- copy helpers ---------------- */

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  catch { toast('Copy failed'); }
}

function summaryText() {
  const items = viewItems();
  const t = U.totals(items);
  const s = U.macroSplit(t);
  const lines = [`Cart Macros: ${state.scan.title || 'cart'}`, `Total: ${r(t.kcal)} kcal | P ${r(t.protein_g)} g | C ${r(t.carbs_g)} g | F ${r(t.fat_g)} g (P${r(s.protein)}/C${r(s.carbs)}/F${r(s.fat)}% kcal)`];
  const tg = targets();
  if (tg) {
    const d = daily(items);
    lines.push(`Per person/day: ${r(d.kcal)}/${r(tg.kcal)} kcal, P ${r(d.protein_g)}/${r(tg.protein_g)} g, C ${r(d.carbs_g)}/${r(tg.carbs_g)} g, F ${r(d.fat_g)}/${r(tg.fat_g)} g`);
    lines.push(U.verdict(d, tg, state.profile.mode));
  }
  lines.push('', ...items.map((i) => `- ${i.quantity} × ${i.name}${i.packageSize ? ` (${i.packageSize})` : ''}: ${r(i.kcal)} kcal, ${r(i.protein_g)}P ${r(i.carbs_g)}C ${r(i.fat_g)}F`));
  lines.push('', 'Estimates by AI, not label-exact.');
  return lines.join('\n');
}

function changesText() {
  const s = state.sugg, sel = state.selected;
  // Export the previewed changes; if nothing is previewed, export all suggestions.
  const pick = (kind) => (hasSelection() ? [...sel[kind]].sort() : s[kind].map((_, i) => i)).map((i) => s[kind][i]);
  const lines = ['Shopping changes' + (hasSelection() ? ' (previewed)' : ' (all suggestions)'), ''];
  pick('swaps').forEach((x) => lines.push(`SWAP: ${x.replaceItem} → ${x.withItem}`));
  pick('additions').forEach((x) => lines.push(`ADD: ${x.item}${x.packageSize ? ` (${x.packageSize})` : ''}`));
  pick('removals').forEach((x) => lines.push(`REMOVE: ${x.item}`));
  return lines.join('\n');
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1500);
}

/* ---------------- tabs & events ---------------- */

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== `tab-${name}`));
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tabs button');
  if (tab) return showTab(tab.dataset.tab);
  const a = e.target.closest('[data-action]');
  if (!a) return;
  e.preventDefault();
  const act = a.dataset.action;
  if (act === 'options') chrome.runtime.openOptionsPage();
  else if (act === 'goals') showTab('goals');
  else if (act === 'edit') { state.editing = state.editing === a.dataset.key ? null : a.dataset.key; renderCart(); }
  else if (act === 'cancel-edit') { state.editing = null; renderCart(); }
  else if (act === 'reset-edit') saveOverride(a.closest('form').dataset.key, null);
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('.edit-form');
  if (!form) return;
  e.preventDefault();
  const key = form.dataset.key;
  const orig = state.scan.items.find((i) => U.normalizeName(i.name) === key);
  if (!orig) return;
  const fd = new FormData(form);
  const val = (k) => { const v = parseFloat(fd.get(k)); return Number.isFinite(v) && v >= 0 ? v : null; };
  const current = U.applyOverrides([orig], state.overrides)[0];
  const changed = (k) => val(k) != null && r(val(k)) !== r(current[k]);
  const macroChanged = U.MACROS.some(changed);
  let ov;
  if (changed('totalGrams') && !macroChanged) ov = { totalGrams: val('totalGrams') }; // grams-only → rescale
  else if (changed('totalGrams') || macroChanged) {
    ov = {};
    for (const k of ['totalGrams', ...U.MACROS]) if (val(k) != null) ov[k] = val(k);
  } else { state.editing = null; return renderCart(); }
  saveOverride(key, ov);
});

document.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-kind]');
  if (!cb) return;
  const set = state.selected[cb.dataset.kind];
  const i = Number(cb.dataset.i);
  cb.checked ? set.add(i) : set.delete(i);
  renderAll();
});

$('#suggestBody').addEventListener('click', (e) => {
  if (e.target.id === 'suggestGo') suggest();
  if (e.target.id === 'copyChanges') copy(changesText());
});
$('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#rescan').addEventListener('click', () => (state.scan?.source === 'paste' ? scanPaste($('#pasteText').value) : scan({ force: true })));
$('#pasteToggle').addEventListener('click', () => { $('#pasteBox').hidden = !$('#pasteBox').hidden; if (!$('#pasteBox').hidden) $('#pasteText').focus(); });
$('#pasteCancel').addEventListener('click', () => ($('#pasteBox').hidden = true));
$('#pasteGo').addEventListener('click', () => scanPaste($('#pasteText').value));
$('#copySummary').addEventListener('click', () => state.scan && copy(summaryText()));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.profile) { state.profile = changes.profile.newValue || null; renderAll(); }
  if (changes.apiKey) { const had = state.apiKey; state.apiKey = (changes.apiKey.newValue || '').trim(); if (!had && state.apiKey) scan(); else renderAll(); }
});

/* ---------------- init ---------------- */

(async function init() {
  const st = await chrome.storage.local.get(['apiKey', 'profile', 'overrides']);
  state.apiKey = (st.apiKey || '').trim();
  state.profile = st.profile || null;
  state.overrides = st.overrides || {};
  GoalsForm.mount($('#goalsMount'));
  renderAll();
  if (state.apiKey) scan();
})();
