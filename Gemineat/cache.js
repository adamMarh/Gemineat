// cache.js — 10-minute cart-result cache in chrome.storage.local (shared by background + popup).
(function (root) {
  'use strict';
  const TTL_MS = 10 * 60 * 1000;
  const MAX_ENTRIES = 20;

  /** Cache key = URL + page-text hash + engine/model + prompt version, so switching engines doesn't serve stale results. */
  const key = (url, text, engine) => `${url}|${root.CartUtil.hashText(text)}|${engine}|p${root.Prompts?.PROMPT_VERSION ?? 0}`;

  async function get(k) {
    const { cartCache = {} } = await chrome.storage.local.get('cartCache');
    const hit = cartCache[k];
    return hit && Date.now() - hit.at < TTL_MS ? hit.result : null;
  }

  async function set(k, result) {
    const { cartCache = {} } = await chrome.storage.local.get('cartCache');
    const now = Date.now();
    const kept = Object.entries(cartCache)
      .filter(([, v]) => now - v.at < TTL_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES - 1);
    await chrome.storage.local.set({ cartCache: Object.fromEntries([...kept, [k, { at: now, result }]]) });
  }

  root.CartCache = { key, get, set, TTL_MS };
})(globalThis);
