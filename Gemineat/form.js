// form.js — the Goals profile form, shared by the popup (Goals tab) and options.html.
// Profile is stored metric in chrome.storage.local under "profile"; display units under "units".
(function (root) {
  'use strict';
  const G = root.Goals;

  const DEFAULT_PROFILE = {
    mode: 'maintain', sex: 'female', activity: 'light', pacePct: null,
    people: 1, days: 7, coveragePct: 100,
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : '');

  async function loadProfile() {
    const { profile = null, units = 'metric' } = await chrome.storage.local.get(['profile', 'units']);
    return { profile: profile ? { ...DEFAULT_PROFILE, ...profile } : null, units };
  }

  function template(p, units) {
    const imp = units === 'imperial';
    const w = (kg) => (Number.isFinite(kg) ? round1(imp ? G.kgToLb(kg) : kg) : '');
    const heightIn = Number.isFinite(p.heightCm) ? G.cmToIn(p.heightCm) : NaN;
    const ft = Number.isFinite(heightIn) ? Math.floor(heightIn / 12) : '';
    const inch = Number.isFinite(heightIn) ? Math.round(heightIn - ft * 12) : '';
    const modes = [['cut', 'Cut'], ['maintain', 'Maintain'], ['bulk', 'Bulk'], ['recomp', 'Recomp']];
    const acts = [['sedentary', 'Sedentary (×1.2)'], ['light', 'Light (×1.375)'], ['moderate', 'Moderate (×1.55)'], ['very_active', 'Very active (×1.725)']];
    const pace = G.PACE[p.mode];
    const paceVal = pace ? (Number.isFinite(p.pacePct) ? Math.min(p.pacePct, pace.max) : pace.def) : 0;
    return `
      <div class="seg" role="radiogroup" aria-label="Goal mode">
        ${modes.map(([v, l]) => `<label><input type="radio" name="mode" value="${v}" ${p.mode === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
      </div>
      <div class="seg small" role="radiogroup" aria-label="Units">
        <label><input type="radio" name="units" value="metric" ${!imp ? 'checked' : ''}><span>kg / cm</span></label>
        <label><input type="radio" name="units" value="imperial" ${imp ? 'checked' : ''}><span>lb / ft</span></label>
      </div>
      <div class="grid2">
        <label>Current weight (${imp ? 'lb' : 'kg'})<input name="weight" type="number" step="0.1" min="20" value="${w(p.weightKg)}"></label>
        <label>Goal weight (${imp ? 'lb' : 'kg'})<input name="goalWeight" type="number" step="0.1" min="20" value="${w(p.goalWeightKg)}"></label>
        ${imp
          ? `<label>Height<span class="inline"><input name="heightFt" type="number" min="3" max="8" value="${ft}" aria-label="feet">ft<input name="heightIn" type="number" min="0" max="11" value="${inch}" aria-label="inches">in</span></label>`
          : `<label>Height (cm)<input name="heightCm" type="number" min="100" max="250" value="${Number.isFinite(p.heightCm) ? Math.round(p.heightCm) : ''}"></label>`}
        <label>Age<input name="age" type="number" min="18" max="100" value="${p.age ?? ''}"></label>
        <label>Sex (for BMR)<select name="sex"><option value="female" ${p.sex === 'female' ? 'selected' : ''}>Female</option><option value="male" ${p.sex === 'male' ? 'selected' : ''}>Male</option></select></label>
        <label>Activity<select name="activity">${acts.map(([v, l]) => `<option value="${v}" ${p.activity === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      ${pace ? `<label>Pace: ${p.mode === 'cut' ? 'lose' : 'gain'} <output name="paceOut">${paceVal.toFixed(2)}</output>% of bodyweight / week
        <input name="pacePct" type="range" min="0.05" max="${pace.max}" step="0.05" value="${paceVal}"></label>` : ''}
      <fieldset>
        <legend>Cart context</legend>
        <div class="grid2">
          <label>Cart feeds (people)<input name="people" type="number" min="1" max="20" value="${p.people}"></label>
          <label>for (days)<input name="days" type="number" min="1" max="60" value="${p.days}"></label>
        </div>
        <label>This cart covers <output name="covOut">${p.coveragePct}</output>% of my food
          <input name="coveragePct" type="range" min="10" max="100" step="5" value="${p.coveragePct}"></label>
      </fieldset>
      <div class="row">
        <button type="submit" class="primary">Save goals</button>
        <span class="form-status" aria-live="polite"></span>
      </div>
      <div class="targets-out"></div>`;
  }

  /** Read the form into a metric profile. */
  function readForm(form, units) {
    const f = new FormData(form);
    const num = (k) => { const v = parseFloat(f.get(k)); return Number.isFinite(v) ? v : NaN; };
    const imp = units === 'imperial';
    const toKg = (v) => (Number.isFinite(v) ? (imp ? G.lbToKg(v) : v) : NaN);
    const heightCm = imp ? G.inToCm((num('heightFt') || 0) * 12 + (num('heightIn') || 0)) : num('heightCm');
    const mode = f.get('mode') || 'maintain';
    return {
      mode,
      weightKg: toKg(num('weight')),
      goalWeightKg: toKg(num('goalWeight')),
      heightCm: heightCm > 0 ? heightCm : NaN,
      age: num('age'),
      sex: f.get('sex'),
      activity: f.get('activity'),
      pacePct: G.PACE[mode] ? num('pacePct') : null,
      people: Math.max(1, Math.round(num('people') || 1)),
      days: Math.max(1, Math.round(num('days') || 7)),
      coveragePct: num('coveragePct') || 100,
    };
  }

  function targetsHtml(profile, units) {
    const t = G.computeTargets(profile);
    if (!t) return '';
    const r = Math.round;
    const imp = units === 'imperial';
    const fmtW = (kg) => `${round1(imp ? G.kgToLb(Math.abs(kg)) : Math.abs(kg))} ${imp ? 'lb' : 'kg'}`;
    let eta = '';
    if (t.weeksToGoal === 0) eta = 'You are at your goal weight.';
    else if (t.weeksToGoal != null) eta = `≈ ${t.weeksToGoal} weeks at ${fmtW(t.calorie.weeklyChangeKg)}/week → ${t.goalDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
    else if (Number.isFinite(profile.goalWeightKg) && profile.mode !== 'cut' && profile.mode !== 'bulk') eta = 'Pick Cut or Bulk to get a time-to-goal estimate.';
    else if (Number.isFinite(profile.goalWeightKg)) eta = `Your goal weight is in the other direction from a ${profile.mode}.`;
    return `
      <div class="target-card">
        <div class="target-row"><b>${r(t.kcal)}</b> kcal · <b>${r(t.protein_g)}</b> g P · <b>${r(t.carbs_g)}</b> g C · <b>${r(t.fat_g)}</b> g F <span class="muted">per day</span></div>
        ${t.calorie.clamped ? `<div class="note warn">${esc(t.calorie.note)}</div>` : ''}
        ${eta ? `<div class="muted">${esc(eta)}</div>` : ''}
        <details><summary>How we calculated this</summary><ul class="math">${t.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>
      </div>`;
  }

  /**
   * Mount the form. onSaved(profile) is called after a successful save.
   */
  async function mount(container, { onSaved } = {}) {
    let { profile, units } = await loadProfile();
    let draft = profile || { ...DEFAULT_PROFILE };

    const form = document.createElement('form');
    form.className = 'goals-form';
    form.noValidate = true;
    container.replaceChildren(form);

    const render = () => {
      form.innerHTML = template(draft, units);
      if (profile && G.isProfileComplete(profile)) form.querySelector('.targets-out').innerHTML = targetsHtml(profile, units);
    };
    render();

    form.addEventListener('input', (e) => {
      const n = e.target.name;
      if (n === 'pacePct') form.querySelector('output[name=paceOut]').value = parseFloat(e.target.value).toFixed(2);
      if (n === 'coveragePct') form.querySelector('output[name=covOut]').value = e.target.value;
    });
    form.addEventListener('change', async (e) => {
      const n = e.target.name;
      if (n === 'mode' || n === 'units') {
        draft = readForm(form, units); // read with OLD units
        if (n === 'units') { units = e.target.value; await chrome.storage.local.set({ units }); }
        if (n === 'mode') draft.pacePct = null; // reset to the new mode's default
        render();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = readForm(form, units);
      const status = form.querySelector('.form-status');
      const missing = [];
      if (!(p.weightKg > 20)) missing.push('weight');
      if (!(p.heightCm > 90)) missing.push('height');
      if (!(p.age >= 18)) missing.push('age (18+)');
      if (missing.length) { status.textContent = `Please fill in: ${missing.join(', ')}`; status.className = 'form-status err'; return; }
      if (!Number.isFinite(p.goalWeightKg)) delete p.goalWeightKg;
      profile = p; draft = p;
      await chrome.storage.local.set({ profile: p });
      render();
      const s = form.querySelector('.form-status');
      s.textContent = 'Saved ✓'; s.className = 'form-status ok';
      onSaved?.(p);
    });
  }

  root.GoalsForm = { mount, loadProfile, DEFAULT_PROFILE };
})(globalThis);
