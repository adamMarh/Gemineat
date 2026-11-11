// background.js — MV3 service worker. Owns every Gemini *API* call (cloud engine, user's own key).
// The on-device engine (Chrome's built-in Gemini Nano) runs in the popup instead, because the
// Prompt API isn't available in workers. Prompts/schemas live in prompts.js.
// The popup talks to this worker via chrome.runtime.sendMessage({ type, ... }).
importScripts('util.js', 'prompts.js', 'cache.js');
const { CART_SYSTEM_INSTRUCTION, CART_SCHEMA, SUGGEST_SYSTEM_INSTRUCTION, SUGGEST_SCHEMA } = Prompts;

const DEFAULT_MODEL = 'gemini-3.8-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

class GeminiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function getSettings() {
  const { apiKey = '', model = '' } = await chrome.storage.local.get(['apiKey', 'model']);
  return { apiKey: apiKey.trim(), model: (model || DEFAULT_MODEL).trim() };
}

// SPEED: thinking is the biggest latency cost on Flash models, and extraction/estimation doesn't
// need deep reasoning. Ask for the lowest level every current Flash model accepts ("low").
// If a model rejects thinkingConfig, remember that and retry without it.
const THINKING = { thinkingLevel: 'low' };
const noThinkingModels = new Set();

async function post(model, apiKey, body) {
  try {
    const res = await fetch(`${API_BASE}${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    return { res, data };
  } catch {
    throw new GeminiError('NETWORK', 'Could not reach the Gemini API. Check your connection.');
  }
}

/** Low-level structured-output call. Returns the parsed JSON object. */
async function callGemini({ apiKey, model, system, userText, schema, temperature = 0.15, maxOutputTokens = 16384 }) {
  if (!apiKey) throw new GeminiError('NO_KEY', 'No Gemini API key set.');
  const body = {
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature, maxOutputTokens },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (schema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = schema;
  }
  if (!noThinkingModels.has(model)) body.generationConfig.thinkingConfig = THINKING;

  let { res, data } = await post(model, apiKey, body);
  if (res.status === 400 && body.generationConfig.thinkingConfig && /think/i.test(data?.error?.message || '')) {
    noThinkingModels.add(model);
    delete body.generationConfig.thinkingConfig;
    ({ res, data } = await post(model, apiKey, body));
  }

  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429) throw new GeminiError('QUOTA', 'Gemini quota or rate limit exceeded. Wait a minute or check your plan.');
    if (res.status === 400 && /api key/i.test(msg)) throw new GeminiError('BAD_KEY', 'Your Gemini API key was rejected. Check it in Options.');
    if (res.status === 401 || res.status === 403) throw new GeminiError('BAD_KEY', `Gemini refused the key: ${msg}`);
    if (res.status === 404) throw new GeminiError('BAD_MODEL', `Model "${model}" not found. Change it in Options.`);
    throw new GeminiError('API', `Gemini error: ${msg}`);
  }

  if (data?.promptFeedback?.blockReason) throw new GeminiError('BLOCKED', `Request blocked by Gemini (${data.promptFeedback.blockReason}).`);
  const cand = data?.candidates?.[0];
  const text = cand?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('') || '';
  if (!text) throw new GeminiError('EMPTY', `Gemini returned no content${cand?.finishReason ? ` (${cand.finishReason})` : ''}.`);
  if (!schema) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError('BAD_JSON', cand?.finishReason === 'MAX_TOKENS'
      ? 'The cart is too large for one response. Try the paste-list mode with fewer items.'
      : 'Gemini returned malformed JSON. Try Rescan.');
  }
}

/* ---------- Handlers ---------- */

async function extractCart({ text, title, url, source = 'page', force = false }) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new GeminiError('NO_KEY', 'No Gemini API key set.');
  const key = CartCache.key(url, text, `gemini:${settings.model}`);
  if (!force) {
    const cached = await CartCache.get(key);
    if (cached) return { ...cached, cached: true };
  }
  // SPEED: fewer input tokens. Drops blank lines and repeated boilerplate ("Remove", "Save for later"…).
  const compact = source === 'paste' ? text : CartUtil.compactText(text, 30000);
  const userText = Prompts.buildCartUserText({ text: compact, title, url, source });
  const raw = await callGemini({ ...settings, system: CART_SYSTEM_INSTRUCTION, userText, schema: CART_SCHEMA, temperature: 0.1 });
  const result = CartUtil.validateResult(raw);
  if (!result.ok) throw new GeminiError('BAD_JSON', result.reason);
  await CartCache.set(key, result);
  return { ...result, cached: false };
}

async function suggest(payload) {
  const settings = await getSettings();
  // Payload is built by the popup and contains ONLY: mode, targets, items+macros, gaps.
  const userText = JSON.stringify(payload, null, 1);
  const raw = await callGemini({ ...settings, system: SUGGEST_SYSTEM_INSTRUCTION, userText, schema: SUGGEST_SCHEMA, temperature: 0.2 });
  const s = CartUtil.validateSuggestions(raw);
  if (!s) throw new GeminiError('BAD_JSON', 'Suggestions came back malformed. Try again.');
  return s;
}

async function testKey({ apiKey, model }) {
  try {
    const text = await callGemini({
      apiKey: (apiKey || '').trim(),
      model: (model || DEFAULT_MODEL).trim(),
      userText: 'Reply with the single word OK.',
      maxOutputTokens: 1024,
    });
    return { reply: String(text).trim().slice(0, 50) };
  } catch (e) {
    // A 200 response with no text (e.g. thinking used the whole budget) still proves the key works.
    if (e.code === 'EMPTY') return { reply: '(empty reply, but the key was accepted)' };
    throw e;
  }
}

const HANDLERS = { extractCart, suggest, testKey };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = HANDLERS[msg?.type];
  if (!fn) return false;
  fn(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: { code: e.code || 'UNKNOWN', message: e.message || String(e) } }));
  return true; // keep the channel open for the async response
});
