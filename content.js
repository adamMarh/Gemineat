// content.js — injected on demand via chrome.scripting.executeScript (activeTab).
// The value of the final expression is returned to the popup.
(() => {
  const MAX_CHARS = 30000;
  const clean = (s) => String(s || '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();

  let text = clean(document.body ? document.body.innerText : '');

  // Best effort: same-origin iframes (some checkouts render the cart in one).
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      const t = clean(frame.contentDocument?.body?.innerText);
      if (t) text += '\n[iframe]\n' + t;
    } catch { /* cross-origin: not readable */ }
  }

  return {
    title: document.title || '',
    url: location.href,
    text: text.slice(0, MAX_CHARS),
    truncated: text.length > MAX_CHARS,
  };
})();
