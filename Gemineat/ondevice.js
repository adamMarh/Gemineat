// ondevice.js — Chrome's built-in Gemini Nano via the Prompt API (global `LanguageModel`).
// No API key, no network after the one-time model download; cart text never leaves the device.
// Runs in window contexts only (popup / options): the Prompt API isn't exposed in workers.
(function (root) {
  'use strict';

  const LANG = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
  const OUTPUT_RESERVE_TOKENS = 2500; // keep room in the context window for the JSON answer
  const CART_TEXT_SIZES = [14000, 9000, 6000, 3500]; // chars of page text to try, largest first

  class NanoError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  const supported = () => typeof root.LanguageModel !== 'undefined';

  /** 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available' */
  async function availability() {
    if (!supported()) return 'unsupported';
    try {
      // Guard against availability() never settling (seen in some headless/unsupported setups).
      const timeout = new Promise((resolve) => setTimeout(() => resolve('unavailable'), 5000));
      return await Promise.race([root.LanguageModel.availability(LANG), timeout]);
    } catch { return 'unavailable'; }
  }

  async function createSession({ system = '', temperature = 0.1, onProgress } = {}) {
    const opts = {
      ...LANG,
      initialPrompts: system ? [{ role: 'system', content: system }] : [],
      monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded)); },
    };
    // Extensions may set temperature + topK (both or neither). Low values → steadier JSON.
    try {
      const p = await root.LanguageModel.params();
      if (p?.maxTopK) {
        opts.temperature = Math.min(temperature, p.maxTemperature ?? temperature);
        opts.topK = Math.min(3, p.maxTopK);
      }
    } catch { /* params() missing: use defaults */ }
    try {
      return await root.LanguageModel.create(opts);
    } catch (e) {
      if (e?.name === 'NotAllowedError') throw new NanoError('NANO_ACTIVATION', 'Click "Download on-device model" to start the one-time download.');
      if (e?.name === 'NotSupportedError') throw new NanoError('NANO_UNAVAILABLE', "Chrome's on-device AI isn't supported on this device.");
      throw new NanoError('NANO_ERROR', `On-device AI failed to start: ${e?.message || e}`);
    }
  }

  // SPEED: start creating a session (loading the model into memory) while the page is still being read.
  let warm = null; // { system, temperature, promise }
  function prewarm({ system = '', temperature = 0.1 } = {}) {
    if (!supported()) return;
    const promise = createSession({ system, temperature });
    promise.catch(() => {});
    warm = { system, temperature, promise };
  }
  async function takeSession(system, temperature) {
    if (warm && warm.system === system && warm.temperature === temperature) {
      const w = warm; warm = null;
      try { return await w.promise; } catch { /* fall through to a fresh session */ }
    }
    return createSession({ system, temperature });
  }

  /** Trigger/continue the one-time model download. Must be called from a user click. */
  async function download(onProgress) {
    const s = await createSession({ onProgress });
    s.destroy();
  }

  // Property names changed across Chrome versions; support both.
  const ctxWindow = (s) => s.contextWindow ?? s.inputQuota ?? Infinity;
  const ctxUsage = (s) => s.contextUsage ?? s.inputUsage ?? 0;
  async function measure(s, text, opts) {
    const fn = s.measureContextUsage || s.measureInputUsage;
    try { return fn ? await fn.call(s, text, opts) : 0; } catch { return 0; }
  }

  /**
   * Prompt with a JSON-schema responseConstraint and return parsed JSON.
   * makeUserText(maxChars) builds the user turn; we try progressively smaller text until it fits.
   */
  async function promptJSON({ system, schema, temperature = 0.1, makeUserText, sizes = [Infinity] }) {
    const session = await takeSession(system, temperature);
    try {
      const opts = { responseConstraint: schema };
      for (let i = 0; i < sizes.length; i++) {
        const userText = makeUserText(sizes[i]);
        const need = await measure(session, userText, opts);
        const room = ctxWindow(session) - ctxUsage(session) - OUTPUT_RESERVE_TOKENS;
        if (need > room && i < sizes.length - 1) continue;
        let out;
        try {
          out = await session.prompt(userText, opts);
        } catch (e) {
          if (e?.name === 'QuotaExceededError' && i < sizes.length - 1) continue;
          if (e?.name === 'QuotaExceededError') throw new NanoError('TOO_LARGE', 'This page is too long for the on-device model. Use Paste list, or add a Gemini API key in Options.');
          throw new NanoError('NANO_ERROR', `On-device AI error: ${e?.message || e}`);
        }
        try { return JSON.parse(out); } catch { throw new NanoError('BAD_JSON', 'The on-device model returned malformed JSON. Try Rescan.'); }
      }
      throw new NanoError('TOO_LARGE', 'This page is too long for the on-device model. Use Paste list, or add a Gemini API key in Options.');
    } finally {
      session.destroy();
    }
  }

  root.OnDevice = { availability, download, prewarm, promptJSON, NanoError, CART_TEXT_SIZES };
})(globalThis);
