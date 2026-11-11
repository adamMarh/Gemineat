# Cart Macros

A Chrome extension (Manifest V3) that reads your cart on **any** online food or grocery site, totals the macronutrients, compares them to your goals (cut / maintain / bulk / recomp), and suggests better swaps. An AI model reads the page and estimates nutrition, so there is no site-specific scraping code.

**Nobody needs an API key.** By default the extension uses **Chrome's built-in Gemini Nano**, which runs on your computer. It is free and needs no account, and cart text never leaves the machine. Anyone can optionally add their **own** Gemini API key for better accuracy, or if their computer can't run the on-device model. The extension never ships with a key.

No build step. Plain HTML, CSS and JS.

## Load it unpacked

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Pin **Cart Macros** from the puzzle-piece menu.
5. The options page opens from the ⚙ in the popup, or by right-clicking the icon and choosing **Options**.

## AI engines

| Engine | Needs | Accuracy | Privacy |
| --- | --- | --- | --- |
| **On-device: Chrome's Gemini Nano** (default) | Desktop Chrome 138+, about 22 GB free disk, 16 GB RAM or a GPU with more than 4 GB VRAM. One-time model download. | Good for clear carts; weaker on long or messy pages | Nothing leaves your computer |
| **Gemini API** (optional) | Your own free key | Better | Page text and targets are sent to Google |

**Options → AI engine** has three settings:
- **Auto** (default): uses the Gemini API if you've added a key, and the on-device model otherwise.
- **On-device only**
- **Gemini API**

The first time you use the on-device model, the popup shows a **Download on-device model** button. Chrome only allows the download after a click. The download keeps going if you close the popup.

On-device calls run in the popup, because Chrome's Prompt API isn't available in service workers. They use the same prompts, converted to a JSON Schema `responseConstraint`. Page text is compacted (duplicate boilerplate lines removed, text windowed near the word "cart"), then shrunk step by step until it fits Nano's context window.

## Optional: get a Gemini API key

1. Go to <https://aistudio.google.com/apikey> and create a key. The free tier works.
2. Paste it into **Options → Gemini API → API key**, then click **Save** and **Test key**.
3. The model defaults to `gemini-3.8-flash`. You can change it to any model that supports `generateContent` with structured output.

The key is stored in `chrome.storage.local` only. It is never synced and never hardcoded. It is sent in the `x-goog-api-key` header, never in the URL.

## How it works

| File | Role |
| --- | --- |
| `content.js` | Injected on demand (`activeTab` + `scripting`) to collect `document.body.innerText`, with whitespace collapsed and capped at 30k chars, plus the title and URL. |
| `prompts.js` | **The brain:** system instructions and response schemas, shared by both engines. |
| `background.js` | Service worker that makes the Gemini API calls (cloud engine). |
| `ondevice.js` | The Chrome built-in Gemini Nano engine: availability check, download, and JSON-constrained prompts that are trimmed to fit. |
| `cache.js` | 10-minute cart cache per URL + page-text hash + engine/model. |
| `goals.js` | Deterministic target math as pure functions. Gemini never does this math. |
| `util.js` | Pure cart helpers: validation, totals, overrides, swap preview and hashing. |
| `form.js` | Goals form, shared by the popup and options page. |
| `popup.*` | The Cart, Goals and Suggestions tabs. |
| `options.*` | API key, model, units and the full goals profile. |
| `tests.html` / `tests.js` | Console-assert tests for the pure helpers. |

**Keeping recommendations out (three layers):**
1. **`content.js`, before anything is sent.** It cuts these out of the page text:
   - sections under headings like "You may also like", "Don't forget" or "Saved for later"
   - widgets whose class or id says recommend, carousel, upsell or sponsored
   - any product tile with an "Add" or "Add to cart" button, since items already in the cart don't have one

   The popup shows how many sections were skipped.
2. **The prompt** tells the model to look for cart-line signals (a quantity selector, "Remove", a line total). It also has the model copy the item count the page states, and to leave out anything it's unsure of.
3. **Validation and the UI.** If more items come back than the page says the cart holds, the popup shows a warning. **not in cart** hides an item for that page.

**Speed:**
- Gemini thinking is set to `thinkingLevel: "low"`, which is the biggest latency win. If a model rejects that setting, the call is retried without it.
- Input is compacted and recommendation sections are stripped, so fewer tokens go in.
- The `assumption` text is kept short, so fewer tokens come out.
- The on-device Nano session starts loading while the page is still being read.
- Results are cached for 10 minutes.
- A chip in the totals card shows how long each scan took.

For the fastest cloud scans, set the model to `gemini-3.5-flash-lite` in Options. It is quicker, but its estimates are a little rougher.

There are two AI calls. Both are schema-constrained (`responseSchema` for the API, `responseConstraint` on-device) at temperature 0.1–0.2:

1. **Cart extraction.** Runs every time you scan, unless the result is cached. It extracts only the items actually in the cart and estimates kcal, protein, carbs and fat for the **whole purchased amount**. Each item also gets a confidence level and an assumption.
2. **Suggestions.** Runs only when you click **Suggest improvements**. It returns like-for-like swaps, additions and removals, with macro deltas for each.

All model output is validated in code. Malformed items are dropped and a warning is shown.

### Formulas (goals.js)

- **BMR (Mifflin-St Jeor):** 10·kg + 6.25·cm − 5·age + 5 (men) or − 161 (women)
- **TDEE:** BMR × 1.2 / 1.375 / 1.55 / 1.725 (sedentary / light / moderate / very active)
- **Calories:**
  - Cut: TDEE − (weekly kg × 7700 / 7). Pace is % of bodyweight per week, default 0.5%, max 1%.
  - Bulk: TDEE + (weekly kg × 7700 / 7). Default +0.25%, max +0.5%.
  - Maintain: TDEE.
  - Recomp: TDEE × 0.9.
- **Safety floor:** never below max(BMR, 1200 kcal for women / 1500 kcal for men). If the target would go lower, it is clamped to the floor, the achievable pace is recomputed, and a note is shown.
- **Protein** (based on current weight):
  - Cut: 2.2 g/kg (range 2.0–2.4)
  - Maintain or bulk: 1.8 g/kg (range 1.6–2.0)
  - Recomp: 2.2 g/kg
- **Fat:** max(0.6 g/kg, 25% of kcal ÷ 9)
- **Carbs:** (kcal − P·4 − F·9) ÷ 4, never below 0
- **Time to goal:** |goal − current| ÷ weekly change, rounded up to whole weeks, then turned into a date
- **Cart vs. goals:** cart total ÷ (people × days) ÷ (coverage% ÷ 100). The coverage slider covers the case where the cart is only part of your food.
- **Progress bar colours:** green within ±10% of target, amber within ±25%, red beyond that

## Test it on two grocery sites

1. Set your profile in **Options**, or in the popup's **Goals** tab. With no key set, the popup uses the on-device model. Click **Download on-device model** the first time. The totals card shows an **on-device** or **Gemini API** chip so you can tell which engine ran.
2. **Site A (e.g. Walmart, Instacart, Tesco, Amazon Fresh):** add 4–6 foods to the cart and open the cart or basket page. Click the extension icon. The popup scans automatically. Check that:
   - Recommended or "you may also like" items are **not** listed.
   - Totals, the macro split bar, progress bars and the verdict all show.
   - Reopening the popup shows a **cached** chip, meaning no new API call was made.
3. **Site B (a different store, e.g. Kroger, Sainsbury's, Loblaws, Ocado):** do the same. Then:
   - Click **edit** on an item, change only the grams, and **Save**. The macros rescale and an **edited** chip appears. Rescan and the edit is reapplied.
   - Open **Suggestions**, click **Suggest improvements**, and toggle **Preview** on a few cards. The bars update live. Then click **Copy shopping changes**.
4. **Negative checks:**
   - A product page (not a cart) should show "No cart found" with a reason.
   - `chrome://extensions` should show a "can't be read" message.
   - Engines: with no key, scans run on-device. Add a key and the engine switches to Gemini API under Auto. Set **On-device only** to force Nano even with a key.
   - **Paste list:** enter `2x Greek yogurt 750g, 1kg chicken breast, oats 1kg`.
5. **Unit tests:** open `chrome-extension://<id>/tests.html`, or open `tests.html` straight from disk. You should see "68/68 passed". Or run them in Node:

   ```sh
   node -e 'const vm=require("vm"),fs=require("fs");const c={console};c.globalThis=c;vm.createContext(c);for(const f of ["goals.js","util.js","prompts.js","tests.js"])vm.runInContext(fs.readFileSync(f,"utf8"),c);process.exit(c.__testResults.failed.length?1:0)'
   ```

## Privacy

- **On-device engine (default):** nothing is sent anywhere. Chrome runs the model locally.
- **Gemini API engine (only if you add your own key), sent to Google:**
  - When you scan: the visible text, title and URL of the current page, or your pasted list.
  - When you ask for suggestions: your goal mode, your numeric daily targets, the parsed cart items with their macros, and the daily gaps.
- **Never sent:** your name, your body weight or goal weight, your height, age or sex, or any history. Targets are computed locally.
- Everything is stored in `chrome.storage.local` on this device: the key, profile, item edits and a 10-minute cache.
- No `<all_urls>` permission. The page is read only when you open the popup on that tab.

Note that the page text can include whatever the site shows on the cart page, such as a delivery address. With the Gemini API engine, use **Paste list** if you'd rather not send the page.

## Limitations

- Macros are **AI estimates** from typical labels and USDA values, not label-exact. The confidence dot and assumption text show how sure each estimate is. Use **edit** to correct an item.
- Carts rendered in cross-origin iframes, canvas, or behind shadow DOM may not appear in `innerText`. Use **Paste list** for these.
- Recommendation filtering is heuristic. If a "you may also like" item still slips through, click **not in cart** on it. That hides it for this page and is remembered.
- Very long pages are truncated at 30k characters, and a warning is shown. The on-device model sees much less text than that, so long carts are more reliable with the Gemini API.
- The on-device model is smaller than Gemini Flash, so its estimates are rougher. Check the confidence dots.
- Suggestions are generic supermarket items, not live products from the store you're on.

## Disclaimer

Targets are general estimates for healthy adults. They are **not medical or dietary advice**. If you have a medical condition, are pregnant or breastfeeding, have a history of disordered eating, or are under 18, consult a doctor or registered dietitian before changing your diet. The goals form requires age 18+.
