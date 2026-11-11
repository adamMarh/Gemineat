// prompts.js — THE BRAIN. Prompts + schemas shared by both engines:
//   • Gemini API (background.js, via importScripts) — uses the schemas as-is (OpenAPI subset, UPPERCASE types)
//   • Chrome on-device Gemini Nano (popup, via ondevice.js) — uses toJsonSchema(schema) as responseConstraint
(function (root) {
  'use strict';

  // Bump when prompts/schemas change, so cached results from older prompts aren't reused.
  const PROMPT_VERSION = 2;

  /* ==========================================================================
   * THE BRAIN, PART 1: cart extraction + nutrition estimation
   * One call does both: find the items actually in the cart, then estimate
   * macros for the FULL purchased amount of each one.
   * ========================================================================== */

  const CART_SYSTEM_INSTRUCTION = `You are a nutrition analyst reading the visible text of an online food or grocery shopping page, or a shopping list a user pasted.

TASK 1: EXTRACT CART ITEMS
- Include ONLY items the shopper has actually placed in their cart / basket / order.
- IGNORE recommendations, "you may also like", "frequently bought together", "customers also bought", "don't forget", "complete your basket", ads, sponsored products, promotions, recently viewed, saved-for-later / wishlist sections, navigation, and footer text.
- How to tell a real cart line: it usually sits in the cart/basket list and has cart-line signals such as a quantity selector or "Qty", a "Remove"/"Delete" link, or a line total. A product shown next to an "Add", "+ Add" or "Add to cart" button is NOT in the cart: it is a recommendation.
- statedItemCount: if the page states how many items the cart holds (e.g. "Cart (3)", "Basket · 5 items", "Subtotal (4 items)"), copy that number; otherwise 0. Your items list must be consistent with it. If you see more candidate products than that, keep only the ones with cart-line signals.
- When unsure whether a product is in the cart, LEAVE IT OUT. A missing item is better than a recommended one.
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
- assumption: a short phrase (max ~8 words) explaining the basis, e.g. "assumed 1 kg raw chicken breast", "size not shown, assumed standard 750 g tub".
- currency: ISO code if prices are visible, else "".
- Use plain numbers (no units in numeric fields). Use 0 for a macro that is genuinely zero.`;

  // Gemini responseSchema (OpenAPI subset). Required fields force the model to always fill them.
  const CART_SCHEMA = {
    type: 'OBJECT',
    properties: {
      statedItemCount: { type: 'NUMBER', description: 'Item count the page states for the cart, or 0 if none shown' },
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
    required: ['statedItemCount', 'cartFound', 'reason', 'items'],
    propertyOrdering: ['statedItemCount', 'cartFound', 'reason', 'currency', 'items'],
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

  /** Build the user turn for cart extraction. */
  function buildCartUserText({ text, title, url, source }) {
    return [
      `SOURCE: ${source === 'paste' ? 'pasted list' : 'web page'}`,
      `PAGE TITLE: ${title || ''}`,
      `URL: ${url || ''}`,
      '--- BEGIN TEXT ---',
      text,
      '--- END TEXT ---',
    ].join('\n');
  }

  /**
   * Convert a Gemini responseSchema (OpenAPI subset) into standard JSON Schema for
   * Chrome's Prompt API responseConstraint: lowercase types, drop Gemini-only keys.
   */
  function toJsonSchema(s) {
    if (Array.isArray(s)) return s.map(toJsonSchema);
    if (!s || typeof s !== 'object') return s;
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === 'propertyOrdering') continue;
      if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
      else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
      else if (k === 'items') out.items = toJsonSchema(v);
      else out[k] = v;
    }
    if (out.type === 'object') out.additionalProperties = false;
    return out;
  }

  const api = { PROMPT_VERSION, CART_SYSTEM_INSTRUCTION, CART_SCHEMA, SUGGEST_SYSTEM_INSTRUCTION, SUGGEST_SCHEMA, buildCartUserText, toJsonSchema };
  root.Prompts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
