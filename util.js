// util.js — pure cart helpers shared by background.js (via importScripts), popup, and tests.
(function (root) {
  'use strict';

  const MACROS = ['kcal', 'protein_g', 'carbs_g', 'fat_g'];
  const CONFIDENCE = ['high', 'medium', 'low'];

  /** FNV-1a 32-bit hash → 8-char hex. Fast, stable, good enough for cache keys. */
  function hashText(str) {
    let h = 0x811c9dc5;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /** Normalized key for an item name (used for overrides and fuzzy matching). */
  function normalizeName(name) {
    return String(name ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  const isNonNegNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  /**
   * Validate Gemini's cart-extraction JSON. Never throws.
   * Returns { ok, cartFound, reason, currency, items, warnings }.
   */
  function validateResult(raw) {
    const warnings = [];
    let data = raw;
    if (typeof raw === 'string') {
      try { data = JSON.parse(raw); } catch { return { ok: false, cartFound: false, reason: 'Model returned invalid JSON.', currency: '', items: [], warnings: ['Invalid JSON from model.'] }; }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, cartFound: false, reason: 'Model returned an unexpected shape.', currency: '', items: [], warnings: ['Unexpected response shape.'] };
    }
    const items = [];
    const rawItems = Array.isArray(data.items) ? data.items : [];
    if (!Array.isArray(data.items)) warnings.push('Response had no items array.');
    rawItems.forEach((it, i) => {
      if (!it || typeof it !== 'object') { warnings.push(`Item ${i + 1} dropped: not an object.`); return; }
      const name = str(it.name);
      if (!name) { warnings.push(`Item ${i + 1} dropped: missing name.`); return; }
      const bad = MACROS.filter((k) => !isNonNegNumber(it[k]));
      if (bad.length) { warnings.push(`"${name}" dropped: invalid ${bad.join(', ')}.`); return; }
      let quantity = it.quantity;
      if (!isNonNegNumber(quantity) || quantity === 0) { quantity = 1; warnings.push(`"${name}": quantity missing, assumed 1.`); }
      items.push({
        name,
        brand: str(it.brand),
        quantity,
        packageSize: str(it.packageSize),
        totalGrams: isNonNegNumber(it.totalGrams) ? it.totalGrams : 0,
        kcal: it.kcal, protein_g: it.protein_g, carbs_g: it.carbs_g, fat_g: it.fat_g,
        confidence: CONFIDENCE.includes(it.confidence) ? it.confidence : 'low',
        assumption: str(it.assumption),
      });
    });
    const cartFound = data.cartFound === true && items.length > 0;
    return {
      ok: true,
      cartFound,
      reason: str(data.reason) || (cartFound ? '' : 'No cart items found on this page.'),
      currency: str(data.currency),
      items,
      warnings,
    };
  }

  function validMacros(m) {
    return !!m && typeof m === 'object' && MACROS.every((k) => typeof m[k] === 'number' && Number.isFinite(m[k]));
  }

  /** Validate the suggestions JSON. Deltas may be negative; additions must be non-negative. */
  function validateSuggestions(raw) {
    let d = raw;
    if (typeof raw === 'string') { try { d = JSON.parse(raw); } catch { return null; } }
    if (!d || typeof d !== 'object') return null;
    const arr = (v) => (Array.isArray(v) ? v : []);
    return {
      summary: str(d.summary),
      swaps: arr(d.swaps).filter((s) => s && str(s.replaceItem) && str(s.withItem) && validMacros(s.deltaPerPackage)).slice(0, 5),
      additions: arr(d.additions).filter((a) => a && str(a.item) && validMacros(a.macrosPerPackage) && MACROS.every((k) => a.macrosPerPackage[k] >= 0)).slice(0, 3),
      removals: arr(d.removals).filter((r) => r && str(r.item)).slice(0, 3),
    };
  }

  /** Sum macros over items. */
  function totals(items) {
    const t = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    for (const it of items || []) for (const k of MACROS) t[k] += Number(it[k]) || 0;
    return t;
  }

  /**
   * Per-person-per-day "full-day equivalent": total ÷ (people × days) ÷ (coveragePct ÷ 100).
   * If the cart is only meant to cover 50% of your food, 1000 kcal/day from it is "on track" for a
   * 2000 kcal target, so we scale it to 2000 before comparing with full-day targets.
   */
  function perPersonPerDay(t, people = 1, days = 7, coveragePct = 100) {
    const p = people > 0 ? people : 1;
    const d = days > 0 ? days : 1;
    const c = coveragePct > 0 ? coveragePct : 100;
    const scale = 100 / c;
    const out = {};
    for (const k of MACROS) out[k] = ((t[k] || 0) / (p * d)) * scale;
    return out;
  }

  /** % of calories from protein / carbs / fat using 4/4/9. */
  function macroSplit(t) {
    const p = (t.protein_g || 0) * 4, c = (t.carbs_g || 0) * 4, f = (t.fat_g || 0) * 9;
    const sum = p + c + f;
    if (!sum) return { protein: 0, carbs: 0, fat: 0 };
    return { protein: (p / sum) * 100, carbs: (c / sum) * 100, fat: (f / sum) * 100 };
  }

  /**
   * Apply user overrides keyed by normalizeName(item.name).
   * Override fields: totalGrams, kcal, protein_g, carbs_g, fat_g (any subset).
   * If only totalGrams is overridden (and the original has grams), macros scale proportionally.
   */
  function applyOverrides(items, overrides) {
    if (!overrides) return items.map((i) => ({ ...i }));
    return items.map((it) => {
      const o = overrides[normalizeName(it.name)];
      if (!o) return { ...it };
      const out = { ...it, overridden: true };
      const hasMacroOverride = MACROS.some((k) => isNonNegNumber(o[k]));
      if (isNonNegNumber(o.totalGrams)) {
        if (!hasMacroOverride && it.totalGrams > 0) {
          const ratio = o.totalGrams / it.totalGrams;
          for (const k of MACROS) out[k] = it[k] * ratio;
        }
        out.totalGrams = o.totalGrams;
      }
      for (const k of MACROS) if (isNonNegNumber(o[k])) out[k] = o[k];
      return out;
    });
  }

  /** Find an item by fuzzy name: exact normalized, then containment, then best token overlap (≥50%). */
  function findItemIndex(items, name) {
    const n = normalizeName(name);
    if (!n) return -1;
    const norms = items.map((i) => normalizeName(i.name));
    let idx = norms.indexOf(n);
    if (idx >= 0) return idx;
    idx = norms.findIndex((x) => x && (x.includes(n) || n.includes(x)));
    if (idx >= 0) return idx;
    const tokens = new Set(n.split(' ').filter((t) => t.length > 2));
    let best = -1, bestScore = 0;
    norms.forEach((x, i) => {
      const xt = x.split(' ').filter((t) => t.length > 2);
      if (!xt.length || !tokens.size) return;
      const hits = xt.filter((t) => tokens.has(t)).length;
      const score = hits / Math.min(xt.length, tokens.size);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return bestScore >= 0.5 ? best : -1;
  }

  /**
   * Return a new item list as if the selected suggestions were applied.
   * selected = { swaps: number[], additions: number[], removals: number[] } (indices into suggestions).
   * Swap deltas are per package, so they're multiplied by the matched item's quantity.
   * Unmatched swaps still count: their delta is added as a synthetic line.
   */
  function applySwapPreview(items, suggestions, selected) {
    let out = items.map((i) => ({ ...i }));
    if (!suggestions || !selected) return out;
    const removeIdx = new Set();
    for (const si of selected.swaps || []) {
      const s = suggestions.swaps?.[si];
      if (!s) continue;
      const idx = findItemIndex(out, s.replaceItem);
      if (idx >= 0) {
        const it = out[idx];
        const q = it.quantity || 1;
        for (const k of MACROS) it[k] = Math.max(0, it[k] + s.deltaPerPackage[k] * q);
        it.name = s.withItem;
        it.preview = 'swap';
      } else {
        const line = { name: `${s.withItem} (swap)`, quantity: 1, packageSize: '', totalGrams: 0, confidence: 'low', assumption: `Delta vs. ${s.replaceItem}`, preview: 'swap' };
        for (const k of MACROS) line[k] = s.deltaPerPackage[k];
        out.push(line);
      }
    }
    for (const ri of selected.removals || []) {
      const r = suggestions.removals?.[ri];
      if (!r) continue;
      const idx = findItemIndex(out, r.item);
      if (idx >= 0) removeIdx.add(idx);
    }
    out = out.filter((_, i) => !removeIdx.has(i));
    for (const ai of selected.additions || []) {
      const a = suggestions.additions?.[ai];
      if (!a) continue;
      out.push({ name: a.item, brand: '', quantity: 1, packageSize: a.packageSize || '', totalGrams: 0, ...pick(a.macrosPerPackage), confidence: 'medium', assumption: 'Suggested addition', preview: 'add' });
    }
    return out;
  }

  function pick(m) { const o = {}; for (const k of MACROS) o[k] = m[k]; return o; }

  /** green within ±10%, amber within ±25%, red beyond. */
  function status(actual, target) {
    if (!(target > 0)) return 'none';
    const dev = Math.abs(actual - target) / target;
    return dev <= 0.10 ? 'green' : dev <= 0.25 ? 'amber' : 'red';
  }

  /** Signed daily gaps (actual − target). */
  function gaps(daily, targets) {
    const g = {};
    for (const k of MACROS) g[k] = (daily[k] || 0) - (targets[k] || 0);
    return g;
  }

  /** One-sentence headline verdict. */
  function verdict(daily, targets, mode) {
    const name = { kcal: 'calories', protein_g: 'protein', carbs_g: 'carbs', fat_g: 'fat' };
    const pct = (k) => Math.round(((daily[k] || 0) / targets[k]) * 100);
    const parts = [`This cart covers ${pct('protein_g')}% of your protein target`];
    const devs = ['kcal', 'carbs_g', 'fat_g']
      .map((k) => ({ k, d: pct(k) - 100 }))
      .filter((x) => Math.abs(x.d) > 10)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    if (devs.length) {
      const x = devs[0];
      parts.push(`is ${Math.abs(x.d)}% ${x.d > 0 ? 'over' : 'under'} on ${name[x.k]}`);
    } else {
      parts.push('is within 10% on calories, carbs and fat');
    }
    return `${parts.join(' and ')} for a ${mode}.`;
  }

  function fmtGap(g) {
    const s = (v, u, label) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))}${u} ${label}/day`;
    return [s(g.kcal, '', 'kcal'), s(g.protein_g, ' g', 'protein'), s(g.carbs_g, ' g', 'carbs'), s(g.fat_g, ' g', 'fat')].join(', ');
  }

  const api = {
    MACROS, hashText, normalizeName, validateResult, validateSuggestions, totals, perPersonPerDay,
    macroSplit, applyOverrides, findItemIndex, applySwapPreview, status, gaps, verdict, fmtGap,
  };
  root.CartUtil = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
