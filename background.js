// background.js — MV3 service worker. Owns every Gemini call and the cart cache.
// The popup talks to it via chrome.runtime.sendMessage({ type, ... }).
importScripts('util.js');

const DEFAULT_MODEL = 'gemini-3.8-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 20;

/* ==========================================================================
 * THE BRAIN, PART 1: cart extraction + nutrition estimation
 * One call does both: find the items actually in the cart, then estimate
 * macros for the FULL purchased amount of each one.
 * ========================================================================== */

const CART_SYSTEM_INSTRUCTION = `You are a nutrition analyst reading the visible text of an online food or grocery shopping page, or a shopping list a user pasted.

TASK 1: EXTRACT CART ITEMS
- Include ONLY items the shopper has actually placed in their cart / basket / order.
- IGNORE recommendations, "you may also like", "frequently bought together", "customers also bought", ads, promotions, recently viewed, saved-for-later / wishlist sections, navigation, and footer text.
- If the input is a pasted shopping list (source = "pasted list"), every listed food is a cart item.
- Never invent items that are not in the text. If there is no cart, or it is empty, return cartFound=false, items=[], and a short reason (e.g. "This looks like a product listing page, not a cart").
- quantity = number of packages bought (default 1). packageSize = the size as written ("500 g", "12 oz", "6 x 330 ml"), or "" if not shown.
- Skip non-food items (cleaning products, toiletries, bags, delivery fees, tips).

TASK 2: ESTIMATE NUTRITION
- Base estimates on typical nutrition labels for that product type and brand, or USDA FoodData Central values.
- All numbers (kcal, protein_g, carbs_g, fat_g, totalGrams) are for the WHOLE purchased amount = package size × quantity. NOT per 100 g, NOT per serving.
- Convert units: 1 oz = 28.35 g, 1 lb = 453.6 g; for liquids use density ≈ 1 g/ml unless clearly different (e.g. oil ≈ 0.92).
- Meat and fish: assume raw weight unless the page says cooked.
- If the size is missing, assume the most common retail size and say so in "assumption".
- confidence: "high" = brand and size are known and the values are standard; "medium" = generic estimate; "low" = size or product is ambiguous.
- assumption: one short phrase explaining the basis, e.g. "assumed 1 kg raw chicken breast", "size not shown, assumed standard 750 g tub".
- currency: ISO code if prices are visible, else "".
- Use plain numbers (no units in numeric fields). Use 0 for a macro that is genuinely zero.`;

// Gemini responseSchema (OpenAPI subset). Required fields force the model to always fill them.
const CART_SCHEMA = {
  type: 'OBJECT',
  properties: {
    cartFound: { type: 'BOOLEAN' },
    reason: { type: 'STRING', description: 'Why no cart was found, or a brief note. Empty if fine.' },
    currency: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          brand: { type: 'STRING' },
          quantity: { type: 'NUMBER', description: 'Number of packages in cart' },
          packageSize: { type: 'STRING', description: 'Size of one package as written, e.g. "500 g"' },
          totalGrams: { type: 'NUMBER', description: 'Total grams for the whole purchased amount' },
          kcal: { type: 'NUMBER', description: 'For the whole purchased amount' },
          protein_g: { type: 'NUMBER' },
          carbs_g: { type: 'NUMBER' },
          fat_g: { type: 'NUMBER' },
          confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          assumption: { type: 'STRING' },
        },
        required: ['name', 'quantity', 'packageSize', 'totalGrams', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'confidence', 'assumption'],
        propertyOrdering: ['name', 'brand', 'quantity', 'packageSize', 'totalGrams', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'confidence', 'assumption'],
      },
    },
  },
  required: ['cartFound', 'reason', 'items'],
  propertyOrdering: ['cartFound', 'reason', 'currency', 'items'],
};

/* ==========================================================================
 * THE BRAIN, PART 2: suggestions (only on explicit user click)
 * Input is goal mode + numeric targets + parsed items + gaps. No identity,
 * no body weight, no history.
 * ========================================================================== */

const SUGGEST_SYSTEM_INSTRUCTION = `You are a practical grocery coach. Given a shopper's cart (with estimated macros for the whole purchased amount), their goal mode, daily macro targets, and the daily gaps (cart per person per day minus target), suggest concrete changes to the cart that close the gaps.

RULES
- Suggest common supermarket items a shopper could find on the same kind of grocery site. No obscure specialty products.
- Prefer like-for-like swaps of items already in the cart (e.g. full-fat Greek yogurt → 0% Greek yogurt; ground beef 80/20 → 93/7; white bread → high-protein wholegrain bread; regular cola → zero-sugar cola).
- Respect the goal mode:
  • cut: favour high-protein, high-volume, low-energy-density foods (lean meats, fish, egg whites, skyr/Greek yogurt, vegetables, fruit, legumes); trim calorie-dense extras.
  • bulk: it is fine to ADD calorie-dense whole foods (oats, nut butter, whole milk, rice, olive oil, dried fruit, granola) while keeping protein adequate.
  • maintain: balance toward the targets with modest changes.
  • recomp: prioritize protein while keeping calories slightly below maintenance.
- replaceItem MUST be the item name exactly as given in the cart. removals.item MUST also be an exact cart item name.
- deltaPerPackage = (macros of ONE package of withItem) − (macros of ONE package of replaceItem). Negative numbers are allowed.
- macrosPerPackage for additions = macros for one package of the suggested size.
- At most 5 swaps, 3 additions, 3 removals. Fewer is fine if the cart is already good. Use empty arrays when there is nothing to suggest.
- NEVER recommend supplements, protein powders, fat burners, medications, fasting protocols, extreme or very-low-calorie diets, or anything medical.
- reason: one short sentence each. summary: 1–2 sentences on the biggest issues.`;

const MACRO_OBJ = {
  type: 'OBJECT',
  properties: { kcal: { type: 'NUMBER' }, protein_g: { type: 'NUMBER' }, carbs_g: { type: 'NUMBER' }, fat_g: { type: 'NUMBER' } },
  required: ['kcal', 'protein_g', 'carbs_g', 'fat_g'],
  propertyOrdering: ['kcal', 'protein_g', 'carbs_g', 'fat_g'],
};

const SUGGEST_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    swaps: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { replaceItem: { type: 'STRING' }, withItem: { type: 'STRING' }, reason: { type: 'STRING' }, deltaPerPackage: MACRO_OBJ },
        required: ['replaceItem', 'withItem', 'reason', 'deltaPerPackage'],
        propertyOrdering: ['replaceItem', 'withItem', 'reason', 'deltaPerPackage'],
      },
    },
    additions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { item: { type: 'STRING' }, packageSize: { type: 'STRING' }, reason: { type: 'STRING' }, macrosPerPackage: MACRO_OBJ },
        required: ['item', 'packageSize', 'reason', 'macrosPerPackage'],
        propertyOrdering: ['item', 'packageSize', 'reason', 'macrosPerPackage'],
      },
    },
    removals: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { item: { type: 'STRING' }, reason: { type: 'STRING' } },
        required: ['item', 'reason'],
        propertyOrdering: ['item', 'reason'],
      },
    },
  },
  required: ['summary', 'swaps', 'additions', 'removals'],
  propertyOrdering: ['summary', 'swaps', 'additions', 'removals'],
};

/* ========================================================================== */

class GeminiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function getSettings() {
  const { apiKey = '', model = '' } = await chrome.storage.local.get(['apiKey', 'model']);
  return { apiKey: apiKey.trim(), model: (model || DEFAULT_MODEL).trim() };
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

  let res;
  try {
    res = await fetch(`${API_BASE}${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new GeminiError('NETWORK', 'Could not reach the Gemini API. Check your connection.');
  }

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }

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
  const text = cand?.content?.parts?.map((p) => p.text || '').join('') || '';
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

/* ---------- Cache (chrome.storage.local so it survives worker restarts) ---------- */

async function cacheGet(key) {
  const { cartCache = {} } = await chrome.storage.local.get('cartCache');
  const hit = cartCache[key];
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.result : null;
}

async function cacheSet(key, result) {
  const { cartCache = {} } = await chrome.storage.local.get('cartCache');
  const now = Date.now();
  const kept = Object.entries(cartCache)
    .filter(([, v]) => now - v.at < CACHE_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, CACHE_MAX_ENTRIES - 1);
  await chrome.storage.local.set({ cartCache: Object.fromEntries([...kept, [key, { at: now, result }]]) });
}

/* ---------- Handlers ---------- */

async function extractCart({ text, title, url, source = 'page', force = false }) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new GeminiError('NO_KEY', 'No Gemini API key set.');
  const key = `${url}|${CartUtil.hashText(text)}|${settings.model}`;
  if (!force) {
    const cached = await cacheGet(key);
    if (cached) return { ...cached, cached: true };
  }
  const userText = [
    `SOURCE: ${source === 'paste' ? 'pasted list' : 'web page'}`,
    `PAGE TITLE: ${title || ''}`,
    `URL: ${url || ''}`,
    '--- BEGIN TEXT ---',
    text,
    '--- END TEXT ---',
  ].join('\n');
  const raw = await callGemini({ ...settings, system: CART_SYSTEM_INSTRUCTION, userText, schema: CART_SCHEMA, temperature: 0.1 });
  const result = CartUtil.validateResult(raw);
  if (!result.ok) throw new GeminiError('BAD_JSON', result.reason);
  await cacheSet(key, result);
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
