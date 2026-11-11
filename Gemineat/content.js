// content.js — injected on demand via chrome.scripting.executeScript (activeTab).
// Returns the page's visible text with recommendation blocks stripped out, so the model
// never sees "You may also like" products. The value of the final expression is returned.
(() => {
  const MAX_CHARS = 30000;
  const norm = (s) => String(s || '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();

  // Headings / labels that introduce non-cart product lists.
  const REC_TEXT = /(recommend|you (may|might) (also )?(like|need)|also (bought|viewed|like)|frequently bought|bought together|similar (items|products)|sponsored|recently viewed|saved for later|save for later|wish ?list|suggested|inspired by|top picks|related (items|products)|complete your (cart|basket|order)|don.?t forget|people also|customers (also|who)|offers for you|deals for you|before you (go|check ?out)|picked for you|more to (consider|explore))/i;
  // Attribute hints commonly used for recommendation widgets.
  const REC_ATTR = ['recommend', 'upsell', 'cross-sell', 'crosssell', 'carousel', 'sponsored', 'also-bought', 'alsobought', 'saved-for-later', 'savedforlater', 'save-for-later', 'similar-items', 'related-products'];
  const ADD_BTN = /^\s*(\+\s*)?(add|add to (cart|basket|bag|trolley)|add item|ajouter( au panier)?|añadir( al carrito)?|in den warenkorb|aggiungi( al carrello)?)\s*$/i;
  const CART_LINE = /^\s*(remove|delete|supprimer|entfernen|eliminar|rimuovi|qty|quantity)\b/i;

  const body = document.body;
  if (!body) return { title: document.title || '', url: location.href, text: '', truncated: false, removedBlocks: 0 };
  const fullText = norm(body.innerText);
  const bodyLen = fullText.length || 1;

  const controls = () => body.querySelectorAll('button, a, [role="button"], input[type="submit"], select, label');
  const ctrlText = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
  const allControls = [...controls()].slice(0, 3000);
  const cartLineCtrls = allControls.filter((el) => CART_LINE.test(ctrlText(el)) || el.matches('select, input[type=number]'));
  const addCtrls = allControls.filter((el) => ADD_BTN.test(ctrlText(el)));
  const countIn = (root, list) => list.reduce((n, el) => n + (root.contains(el) ? 1 : 0), 0);

  const remove = new Set();
  const textLen = (el) => (el.innerText || '').length;

  // 1) Sections introduced by a recommendation heading: climb while we don't swallow cart lines.
  const headings = [
    ...[...body.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].slice(0, 400).map((h) => [h, h.innerText]),
    ...[...body.querySelectorAll('section[aria-label],aside[aria-label],[role="region"][aria-label]')].slice(0, 100).map((h) => [h, h.getAttribute('aria-label')]),
  ];
  for (const [h, label] of headings) {
    if (!label || label.length > 80 || !REC_TEXT.test(label)) continue;
    let el = h;
    while (el.parentElement && el.parentElement !== body) {
      const p = el.parentElement;
      if (textLen(p) > bodyLen * 0.6) break;                              // never take most of the page
      if (countIn(p, cartLineCtrls) > countIn(el, cartLineCtrls)) break;   // parent also holds cart lines
      el = p;
    }
    if (textLen(el) > label.length + 20) remove.add(el);
  }

  // 2) Widgets whose id/class/test-id says "recommendation", "carousel", etc.
  const sel = REC_ATTR.flatMap((k) => [`[class*="${k}" i]`, `[id*="${k}" i]`, `[data-testid*="${k}" i]`]).join(',');
  for (const el of [...body.querySelectorAll(sel)].slice(0, 300)) {
    if (textLen(el) > bodyLen * 0.6) continue;
    if (countIn(el, cartLineCtrls) > 0 && countIn(el, addCtrls) === 0) continue; // looks like real cart lines
    remove.add(el);
  }

  // 3) Product tiles with an "Add to cart" button are, by definition, not in the cart.
  for (const btn of addCtrls.slice(0, 300)) {
    let el = btn;
    while (el.parentElement && el.parentElement !== body) {
      const p = el.parentElement;
      if (countIn(p, addCtrls) > 1 || textLen(p) > 600) break;   // one product per tile
      el = p;
    }
    if (el !== btn) remove.add(el);
  }

  // Keep only outermost blocks, then cut their text out of the page text.
  const blocks = [...remove].filter((el) => ![...remove].some((o) => o !== el && o.contains(el)));
  let text = fullText;
  let removedBlocks = 0;
  for (const el of blocks) {
    const t = norm(el.innerText);
    if (t.length < 3) continue;
    const i = text.indexOf(t);
    if (i >= 0) {
      text = text.slice(0, i) + '\n' + text.slice(i + t.length);
      removedBlocks++;
    }
  }
  text = norm(text);
  if (text.length < 40) { text = fullText; removedBlocks = 0; } // filtering went too far: fall back

  // Best effort: same-origin iframes (some checkouts render the cart in one).
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      const t = norm(frame.contentDocument?.body?.innerText);
      if (t) text += '\n[iframe]\n' + t;
    } catch { /* cross-origin: not readable */ }
  }

  return {
    title: document.title || '',
    url: location.href,
    text: text.slice(0, MAX_CHARS),
    truncated: text.length > MAX_CHARS,
    removedBlocks,
  };
})();
