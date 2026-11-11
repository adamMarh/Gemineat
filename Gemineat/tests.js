// tests.js — console.assert tests for pure helpers. Runs in tests.html or Node (node run-tests: see README).
(function (root) {
  'use strict';
  const G = root.Goals, U = root.CartUtil, P = root.Prompts;
  const results = [];
  const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
  function test(name, cond) {
    console.assert(cond, name);
    results.push({ name, pass: !!cond });
  }

  const male = { sex: 'male', weightKg: 80, heightCm: 180, age: 30, activity: 'moderate', mode: 'maintain' };
  const female = { sex: 'female', weightKg: 60, heightCm: 165, age: 30, activity: 'light', mode: 'maintain' };

  // bmr
  test('bmr male = 1780', G.bmr(male) === 1780);                  // 800 + 1125 - 150 + 5
  test('bmr female = 1320.25', near(G.bmr(female), 1320.25, 0.01)); // 600 + 1031.25 - 150 - 161

  // tdee
  test('tdee moderate = bmr × 1.55', near(G.tdee(1780, 'moderate'), 2759));
  test('tdee unknown activity → sedentary', near(G.tdee(1000, 'nope'), 1200));

  // calorieTarget
  const m = G.calorieTarget(male);
  test('maintain = TDEE', near(m.kcal, 2759) && !m.clamped);
  const cut = G.calorieTarget({ ...male, mode: 'cut', pacePct: 0.5 });
  // 0.4 kg/wk × 7700 / 7 = 440 deficit
  test('cut 0.5%/wk → TDEE − 440', near(cut.kcal, 2319) && near(cut.weeklyChangeKg, -0.4, 1e-9));
  const cutMax = G.calorieTarget({ ...male, mode: 'cut', pacePct: 5 });
  test('cut pace capped at 1%/wk', near(cutMax.pacePct, 1, 1e-9));
  const bulk = G.calorieTarget({ ...male, mode: 'bulk' });
  test('bulk default 0.25%/wk → TDEE + 220', near(bulk.kcal, 2979) && near(bulk.weeklyChangeKg, 0.2, 1e-9));
  test('bulk pace capped at 0.5%/wk', near(G.calorieTarget({ ...male, mode: 'bulk', pacePct: 2 }).pacePct, 0.5, 1e-9));
  test('recomp = TDEE − 10%', near(G.calorieTarget({ ...male, mode: 'recomp' }).kcal, 2759 * 0.9));
  // Small sedentary woman, aggressive cut → floor clamp
  const small = { sex: 'female', weightKg: 50, heightCm: 155, age: 40, activity: 'sedentary', mode: 'cut', pacePct: 1 };
  const sc = G.calorieTarget(small);
  // bmr = 500 + 968.75 - 200 - 161 = 1107.75 ; tdee = 1329.3 ; deficit 0.5kg*1100 = 550 → 779 < floor 1200
  test('cut clamps to floor max(BMR, 1200)', sc.clamped && near(sc.kcal, 1200) && sc.note.length > 0);
  test('clamped pace is recomputed slower', sc.pacePct < 1 && sc.weeklyChangeKg < 0);
  const tinyMale = { sex: 'male', weightKg: 55, heightCm: 160, age: 60, activity: 'sedentary', mode: 'cut', pacePct: 1 };
  test('male floor is 1500', near(G.calorieTarget(tinyMale).kcal, 1500));
  const bigBmr = { sex: 'male', weightKg: 150, heightCm: 200, age: 20, activity: 'sedentary', mode: 'cut', pacePct: 1 };
  const bb = G.calorieTarget(bigBmr);
  test('floor uses BMR when BMR > 1500', bb.floor === G.bmr(bigBmr) && bb.kcal >= bb.floor);

  // proteinTarget
  test('protein cut 2.2 g/kg', near(G.proteinTarget('cut', 80).target, 176) && near(G.proteinTarget('cut', 80).min, 160));
  test('protein maintain 1.6–2.0 g/kg', near(G.proteinTarget('maintain', 80).min, 128) && near(G.proteinTarget('maintain', 80).max, 160));
  test('protein recomp 2.2 g/kg', near(G.proteinTarget('recomp', 70).target, 154));

  // macroTargets: fat ≥ 0.6 g/kg, carbs fill the rest
  const mt = G.macroTargets(2000, 150, 80);
  test('fat ≥ 0.6 g/kg', mt.fat_g >= 48);
  test('macros sum to kcal', near(mt.protein_g * 4 + mt.carbs_g * 4 + mt.fat_g * 9, 2000, 1));
  test('carbs never negative', G.macroTargets(1200, 300, 100).carbs_g === 0);

  // weeksToGoal
  test('weeksToGoal 80→72 at −0.4/wk = 20', G.weeksToGoal(80, 72, -0.4) === 20);
  test('weeksToGoal wrong direction → null', G.weeksToGoal(80, 90, -0.4) === null);
  test('weeksToGoal zero pace → null', G.weeksToGoal(80, 75, 0) === null);
  test('weeksToGoal at goal → 0', G.weeksToGoal(80, 80, -0.4) === 0);
  const ct = G.computeTargets({ ...male, mode: 'cut', pacePct: 0.5, goalWeightKg: 72 }, new Date('2026-01-01'));
  test('computeTargets returns date + explanation', ct.weeksToGoal === 20 && ct.goalDate instanceof Date && ct.lines.length >= 6);
  test('computeTargets null on incomplete profile', G.computeTargets({ mode: 'cut' }) === null);

  // perPersonPerDay
  const tot = { kcal: 14000, protein_g: 700, carbs_g: 1400, fat_g: 490 };
  const d1 = U.perPersonPerDay(tot, 1, 7, 100);
  test('perPersonPerDay 1p×7d', d1.kcal === 2000 && d1.protein_g === 100);
  test('perPersonPerDay 2p×7d', U.perPersonPerDay(tot, 2, 7, 100).kcal === 1000);
  test('perPersonPerDay 50% coverage doubles', U.perPersonPerDay(tot, 2, 7, 50).kcal === 2000);
  test('perPersonPerDay guards zero', Number.isFinite(U.perPersonPerDay(tot, 0, 0, 0).kcal));

  // macroSplit
  const sp = U.macroSplit({ protein_g: 100, carbs_g: 100, fat_g: 100 / 9 * 4 });
  test('macroSplit equal thirds', near(sp.protein, 33.33, 0.01) && near(sp.fat, 33.33, 0.01));
  test('macroSplit empty → zeros', U.macroSplit({}).protein === 0);

  // applyOverrides
  const items = [
    { name: 'Greek Yogurt 0%', quantity: 2, totalGrams: 1000, kcal: 590, protein_g: 100, carbs_g: 40, fat_g: 4 },
    { name: 'Oats', quantity: 1, totalGrams: 1000, kcal: 3800, protein_g: 130, carbs_g: 600, fat_g: 70 },
  ];
  const o1 = U.applyOverrides(items, { [U.normalizeName('Greek Yogurt 0%')]: { totalGrams: 500 } });
  test('override grams-only rescales macros', o1[0].kcal === 295 && o1[0].protein_g === 50 && o1[0].overridden);
  const o2 = U.applyOverrides(items, { oats: { kcal: 3700 } });
  test('override macro replaces value only', o2[1].kcal === 3700 && o2[1].protein_g === 130);
  test('override does not mutate input', items[0].kcal === 590);
  test('normalizeName', U.normalizeName('  Crème  Fraîche 30%!') === 'creme fraiche 30');

  // applySwapPreview
  const sugg = {
    swaps: [{ replaceItem: 'greek yogurt 0%', withItem: 'Skyr', deltaPerPackage: { kcal: -10, protein_g: 5, carbs_g: 0, fat_g: -1 } }],
    additions: [{ item: 'Chicken breast', packageSize: '1 kg', macrosPerPackage: { kcal: 1100, protein_g: 230, carbs_g: 0, fat_g: 15 } }],
    removals: [{ item: 'Oats' }],
  };
  const pv = U.applySwapPreview(items, sugg, { swaps: [0], additions: [0], removals: [0] });
  test('swap delta × quantity', pv[0].name === 'Skyr' && pv[0].kcal === 570 && pv[0].protein_g === 110);
  test('removal drops item', !pv.some((i) => i.name === 'Oats'));
  test('addition appended', pv.some((i) => i.name === 'Chicken breast' && i.protein_g === 230));
  test('preview does not mutate input', items[0].name === 'Greek Yogurt 0%' && items.length === 2);
  test('no selection → unchanged', U.applySwapPreview(items, sugg, { swaps: [], additions: [], removals: [] }).length === 2);
  const um = U.applySwapPreview(items, { swaps: [{ replaceItem: 'Bananas', withItem: 'Apples', deltaPerPackage: { kcal: -20, protein_g: 0, carbs_g: -5, fat_g: 0 } }] }, { swaps: [0] });
  test('unmatched swap → synthetic delta line', um.length === 3 && near(U.totals(um).kcal, 4390 - 20));

  // validateResult
  const good = { cartFound: true, reason: '', currency: 'USD', items: [{ name: 'Milk', brand: '', quantity: 1, packageSize: '1 L', totalGrams: 1030, kcal: 640, protein_g: 33, carbs_g: 48, fat_g: 36, confidence: 'high', assumption: 'whole milk' }] };
  const v1 = U.validateResult(good);
  test('validateResult accepts good item', v1.ok && v1.cartFound && v1.items.length === 1 && v1.warnings.length === 0);
  const v2 = U.validateResult({ ...good, items: [...good.items, { name: 'Bad', kcal: -5, protein_g: 1, carbs_g: 1, fat_g: 1 }, { name: '', kcal: 1, protein_g: 1, carbs_g: 1, fat_g: 1 }, { name: 'NaN', kcal: NaN, protein_g: 1, carbs_g: 1, fat_g: 1 }, null] });
  test('validateResult drops malformed items with warnings', v2.items.length === 1 && v2.warnings.length === 4);
  const v3 = U.validateResult({ cartFound: true, items: [{ name: 'Eggs', kcal: 900, protein_g: 75, carbs_g: 5, fat_g: 60, confidence: 'weird' }] });
  test('validateResult defaults quantity & confidence', v3.items[0].quantity === 1 && v3.items[0].confidence === 'low');
  test('validateResult bad JSON string', U.validateResult('{oops').ok === false);
  test('validateResult no cart', U.validateResult({ cartFound: false, reason: 'Product page', items: [] }).cartFound === false);
  test('validateResult parses JSON string', U.validateResult(JSON.stringify(good)).items.length === 1);

  // statedItemCount sanity check
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ ...good.items[0], name: `Item ${i}` }));
  const sc1 = U.validateResult({ statedItemCount: 2, cartFound: true, items: mk(4) });
  test('validateResult warns when more items than stated count', sc1.statedItemCount === 2 && sc1.warnings.some((w) => /says 2 items/.test(w)));
  const sc2 = U.validateResult({ statedItemCount: 5, cartFound: true, items: [{ ...good.items[0], quantity: 3 }, { ...good.items[0], name: 'Eggs', quantity: 2 }] });
  test('stated count = units (qty sum) does not warn', sc2.warnings.length === 0);

  // excludeItems
  test('excludeItems hides by normalized name', U.excludeItems(items, ['oats']).length === 1 && U.excludeItems(items, []).length === 2);

  // validateSuggestions
  const vs = U.validateSuggestions({ summary: 'x', swaps: [{ replaceItem: 'a', withItem: 'b', reason: '', deltaPerPackage: { kcal: 1, protein_g: 1, carbs_g: 1 } }], additions: [], removals: [{ item: 'c' }] });
  test('validateSuggestions drops incomplete swap', vs.swaps.length === 0 && vs.removals.length === 1);

  // hashText
  test('hashText stable', U.hashText('hello') === U.hashText('hello'));
  test('hashText differs', U.hashText('hello') !== U.hashText('hellp'));
  test('hashText format', /^[0-9a-f]{8}$/.test(U.hashText('')));
  test('hashText known FNV-1a("a")', U.hashText('a') === 'e40c292c');

  // compactText (on-device context trimming)
  const page = 'Home\nDeals\nRemove\nMilk 1 L\n2\nRemove\nEggs 12\n2\n\n\n';
  const ct1 = U.compactText(page, 1000);
  test('compactText dedupes boilerplate, keeps short qty lines', ct1 === 'Home\nDeals\nRemove\nMilk 1 L\n2\nEggs 12\n2');
  const longPage = 'nav item '.repeat(100).split(' ').join('\n') + '\nYour cart\nOats 1 kg\n' + 'footer line '.repeat(50);
  const ct2 = U.compactText(longPage, 300);
  test('compactText respects maxChars', ct2.length <= 300);
  test('compactText windows near "cart" keyword', ct2.includes('Your cart') && ct2.includes('Oats 1 kg'));

  // Prompts: schema conversion for Chrome's Prompt API
  const js = P.toJsonSchema(P.CART_SCHEMA);
  test('toJsonSchema lowercases types', js.type === 'object' && js.properties.items.type === 'array' && js.properties.items.items.properties.kcal.type === 'number');
  test('toJsonSchema drops propertyOrdering, keeps enum/required', !('propertyOrdering' in js) && js.properties.items.items.properties.confidence.enum.length === 3 && js.required.includes('items'));
  test('toJsonSchema does not mutate source', P.CART_SCHEMA.type === 'OBJECT' && Array.isArray(P.CART_SCHEMA.propertyOrdering));
  test('suggest schema converts', P.toJsonSchema(P.SUGGEST_SCHEMA).properties.swaps.items.properties.deltaPerPackage.type === 'object');
  test('buildCartUserText marks pasted lists', P.buildCartUserText({ text: 'oats', source: 'paste' }).startsWith('SOURCE: pasted list'));

  // status / verdict
  test('status green ≤10%', U.status(105, 100) === 'green');
  test('status amber ≤25%', U.status(80, 100) === 'amber');
  test('status red >25%', U.status(130, 100) === 'red');
  const vd = U.verdict({ kcal: 2000, protein_g: 82, carbs_g: 200, fat_g: 115 }, { kcal: 2000, protein_g: 100, carbs_g: 200, fat_g: 100 }, 'cut');
  test('verdict text', vd === 'This cart covers 82% of your protein target and is 15% over on fat for a cut.');

  const failed = results.filter((r) => !r.pass);
  const summary = `${results.length - failed.length}/${results.length} passed`;
  console.log(summary);
  if (typeof document !== 'undefined') {
    document.getElementById('summary').innerHTML = `<b style="color:var(${failed.length ? '--red' : '--green'})">${summary}</b>`;
    document.getElementById('results').innerHTML = results.map((r) => `<li style="color:var(${r.pass ? '--muted' : '--red'})">${r.pass ? '✓' : '✗'} ${r.name}</li>`).join('');
  }
  root.__testResults = { results, failed };
})(globalThis);
