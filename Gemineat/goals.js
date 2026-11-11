// goals.js — deterministic target math. Pure functions only (no DOM, no chrome.*).
// Loaded by popup.html, options.html, tests.html, and usable from Node for tests.
(function (root) {
  'use strict';

  const KCAL_PER_KG = 7700; // approx. energy in 1 kg of body weight change
  const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, very_active: 1.725 };
  const PACE = {
    cut: { def: 0.5, max: 1.0 },   // % bodyweight lost per week
    bulk: { def: 0.25, max: 0.5 }, // % bodyweight gained per week
  };
  const PROTEIN_G_PER_KG = {
    cut: { min: 2.0, max: 2.4, target: 2.2 },
    maintain: { min: 1.6, max: 2.0, target: 1.8 },
    bulk: { min: 1.6, max: 2.0, target: 1.8 },
    recomp: { min: 2.2, max: 2.2, target: 2.2 },
  };
  const FAT_MIN_G_PER_KG = 0.6;
  const FAT_PREF_PCT = 0.25; // preferred fat share of kcal, if above the 0.6 g/kg minimum

  const LB_PER_KG = 2.20462;
  const CM_PER_IN = 2.54;

  /** Mifflin-St Jeor BMR (kcal/day). sex: 'male' | 'female'. */
  function bmr({ weightKg, heightCm, age, sex }) {
    const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
    return base + (sex === 'male' ? 5 : -161);
  }

  /** TDEE = BMR × activity multiplier. */
  function tdee(bmrValue, activity) {
    return bmrValue * (ACTIVITY[activity] || ACTIVITY.sedentary);
  }

  /** Lowest calorie target we will ever recommend. */
  function calorieFloor(bmrValue, sex) {
    return Math.max(bmrValue, sex === 'male' ? 1500 : 1200);
  }

  /** Clamp the user's pace (% bodyweight/week) to the allowed range for the mode. */
  function clampPace(mode, pacePct) {
    const p = PACE[mode];
    if (!p) return 0;
    const v = Number.isFinite(pacePct) && pacePct > 0 ? pacePct : p.def;
    return Math.min(v, p.max);
  }

  /**
   * Daily calorie target.
   * Returns { kcal, bmr, tdee, floor, pacePct, weeklyChangeKg (signed), clamped, note }.
   */
  function calorieTarget(profile) {
    const b = bmr(profile);
    const t = tdee(b, profile.activity);
    const floor = calorieFloor(b, profile.sex);
    const mode = profile.mode || 'maintain';
    let kcal = t;
    let pacePct = 0;
    let weeklyChangeKg = 0;

    if (mode === 'cut' || mode === 'bulk') {
      pacePct = clampPace(mode, profile.pacePct);
      const weeklyKg = (profile.weightKg * pacePct) / 100;
      const dailyDelta = (weeklyKg * KCAL_PER_KG) / 7;
      kcal = mode === 'cut' ? t - dailyDelta : t + dailyDelta;
      weeklyChangeKg = mode === 'cut' ? -weeklyKg : weeklyKg;
    } else if (mode === 'recomp') {
      kcal = t * 0.9;
    }

    let clamped = false;
    let note = '';
    if (kcal < floor) {
      clamped = true;
      kcal = floor;
      if (mode === 'cut') {
        // Recompute the pace actually achievable at the floor.
        const deficit = Math.max(0, t - floor);
        weeklyChangeKg = -(deficit * 7) / KCAL_PER_KG;
        pacePct = (Math.abs(weeklyChangeKg) / profile.weightKg) * 100;
      }
      note = `Target raised to the safety floor (${Math.round(floor)} kcal = max(BMR, ${
        profile.sex === 'male' ? 1500 : 1200
      })). Effective pace is slower than requested.`;
    }
    return { kcal, bmr: b, tdee: t, floor, pacePct, weeklyChangeKg, clamped, note };
  }

  /** Protein target in g/day, based on current weight. */
  function proteinTarget(mode, weightKg) {
    const r = PROTEIN_G_PER_KG[mode] || PROTEIN_G_PER_KG.maintain;
    return { min: r.min * weightKg, max: r.max * weightKg, target: r.target * weightKg, perKg: r.target };
  }

  /** Fat ≥ 0.6 g/kg (prefer 25% of kcal); carbs fill the rest. */
  function macroTargets(kcal, proteinG, weightKg) {
    const fatG = Math.max(FAT_MIN_G_PER_KG * weightKg, (kcal * FAT_PREF_PCT) / 9);
    const carbsG = Math.max(0, (kcal - proteinG * 4 - fatG * 9) / 4);
    return { kcal, protein_g: proteinG, carbs_g: carbsG, fat_g: fatG };
  }

  /**
   * Weeks to reach goal weight at a signed weekly change (kg/week).
   * Returns null when the direction doesn't match or the pace is zero.
   */
  function weeksToGoal(currentKg, goalKg, weeklyChangeKg) {
    const diff = goalKg - currentKg;
    if (!Number.isFinite(diff) || Math.abs(diff) < 0.05) return 0;
    if (!weeklyChangeKg || Math.sign(diff) !== Math.sign(weeklyChangeKg)) return null;
    return Math.ceil(diff / weeklyChangeKg);
  }

  function addWeeks(date, weeks) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + weeks * 7);
    return d;
  }

  /** Is the profile complete enough to compute targets? */
  function isProfileComplete(p) {
    return !!p && ['weightKg', 'heightCm', 'age'].every((k) => Number.isFinite(p[k]) && p[k] > 0) &&
      (p.sex === 'male' || p.sex === 'female') && !!p.mode;
  }

  /** Everything the UI needs, plus human-readable explanation lines. */
  function computeTargets(profile, today = new Date()) {
    if (!isProfileComplete(profile)) return null;
    const cal = calorieTarget(profile);
    const prot = proteinTarget(profile.mode, profile.weightKg);
    const macros = macroTargets(cal.kcal, prot.target, profile.weightKg);
    const weeks = Number.isFinite(profile.goalWeightKg)
      ? weeksToGoal(profile.weightKg, profile.goalWeightKg, cal.weeklyChangeKg)
      : null;
    const r = Math.round;
    const lines = [
      `BMR (Mifflin-St Jeor) = 10×${profile.weightKg.toFixed(1)} kg + 6.25×${r(profile.heightCm)} cm − 5×${profile.age} ${
        profile.sex === 'male' ? '+ 5' : '− 161'
      } = ${r(cal.bmr)} kcal`,
      `TDEE = BMR × ${ACTIVITY[profile.activity] || 1.2} (${profile.activity || 'sedentary'}) = ${r(cal.tdee)} kcal`,
    ];
    if (profile.mode === 'cut' || profile.mode === 'bulk') {
      const wk = Math.abs(cal.weeklyChangeKg);
      lines.push(
        `Pace ${cal.pacePct.toFixed(2)}%/wk = ${wk.toFixed(2)} kg/wk → ${r((wk * KCAL_PER_KG) / 7)} kcal/day ${
          profile.mode === 'cut' ? 'deficit' : 'surplus'
        } (kg × 7700 ÷ 7)`
      );
    } else if (profile.mode === 'recomp') {
      lines.push(`Recomp = TDEE − 10%`);
    } else {
      lines.push(`Maintain = TDEE`);
    }
    lines.push(`Safety floor = max(BMR, ${profile.sex === 'male' ? 1500 : 1200}) = ${r(cal.floor)} kcal`);
    if (cal.clamped) lines.push(cal.note);
    lines.push(`Calories = ${r(macros.kcal)} kcal/day`);
    lines.push(`Protein = ${prot.perKg} g/kg × ${profile.weightKg.toFixed(1)} kg = ${r(macros.protein_g)} g (range ${r(prot.min)}–${r(prot.max)} g)`);
    lines.push(`Fat = max(0.6 g/kg, 25% of kcal ÷ 9) = ${r(macros.fat_g)} g`);
    lines.push(`Carbs = (kcal − P×4 − F×9) ÷ 4 = ${r(macros.carbs_g)} g`);
    if (weeks === 0) lines.push('You are already at your goal weight.');
    else if (weeks != null) lines.push(`Time to goal = |${(profile.goalWeightKg - profile.weightKg).toFixed(1)} kg| ÷ ${Math.abs(cal.weeklyChangeKg).toFixed(2)} kg/wk ≈ ${weeks} weeks`);

    return {
      ...macros,
      calorie: cal,
      protein: prot,
      weeksToGoal: weeks,
      goalDate: weeks ? addWeeks(today, weeks) : null,
      lines,
    };
  }

  // Unit helpers (storage is always metric).
  const kgToLb = (kg) => kg * LB_PER_KG;
  const lbToKg = (lb) => lb / LB_PER_KG;
  const cmToIn = (cm) => cm / CM_PER_IN;
  const inToCm = (inch) => inch * CM_PER_IN;

  const api = {
    ACTIVITY, PACE, PROTEIN_G_PER_KG, KCAL_PER_KG,
    bmr, tdee, calorieFloor, clampPace, calorieTarget, proteinTarget, macroTargets,
    weeksToGoal, isProfileComplete, computeTargets, kgToLb, lbToKg, cmToIn, inToCm,
  };
  root.Goals = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
