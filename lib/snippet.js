'use strict';

// Phase 2 — generate the browser-side collector.
//
// WHY THIS EXISTS AT ALL, and why it is the primary path rather than a
// fallback: Amazon does not serve product pages to scripts. Measured, on a
// real site, in 2026:
//
//   node fetch, no session ............ a stub, no product data
//   curl, no session .................. a 3,781-byte bot wall, every ASIN
//   curl + cookie jar + browser UA .... real page, but one burst earns a
//                                       penalty box that outlasts a 90s gap
//   same-origin fetch from a logged-in
//   amazon.com tab .................... 76 ASINs, 44 seconds, 0 blocked
//
// So the collector runs inside the reader's own browser, on the Amazon origin,
// using their own session. No credentials are handled, nothing is sent
// anywhere, and the output is pasted back to the CLI by hand.

// Concurrency 4 was stable across two full 76-ASIN runs with zero blocks.
// Raising it is the fastest way to get the reader rate-limited.
const DEFAULT_CONCURRENCY = 4;

function buildSnippet(asins, options) {
  const opts = options || {};
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const list = JSON.stringify(asins || []);

  // Written as a string rather than a real function so it can be printed for
  // copy-paste. Kept deliberately plain: no optional chaining, no modules.
  return [
    '(async () => {',
    '  const ASINS = ' + list + ';',
    '  const CONCURRENCY = ' + concurrency + ';',
    '',
    '  // Guard: if this tab is not on the Amazon origin the fetches are',
    '  // cross-origin and every one of them fails.',
    '  if (!/(^|\\.)amazon\\./i.test(location.hostname)) {',
    '    return "STOP: run this on an amazon.com product page tab, not " + location.hostname;',
    '  }',
    '',
    '  // Report the delivery location. Availability and price both change with',
    '  // it, and a foreign address makes most listings render no buy box at',
    '  // all -- which reads as "unavailable" when it is nothing of the kind.',
    '  const glow = document.querySelector("#glow-ingress-line2");',
    '  const deliverTo = glow ? glow.textContent.trim() : "(unknown)";',
    '',
    '  const out = [];',
    '  let i = 0;',
    '',
    '  async function one(asin) {',
    '    try {',
    '      const r = await fetch("/dp/" + asin, { credentials: "include" });',
    '      const html = await r.text();',
    '      const doc = new DOMParser().parseFromString(html, "text/html");',
    '',
    '      const pick = (sel) => {',
    '        const el = doc.querySelector(sel);',
    '        return el ? el.textContent.replace(/\\s+/g, " ").trim() : null;',
    '      };',
    '',
    '      const canonical = doc.querySelector("link[rel=canonical]");',
    '      const canonHref = canonical ? canonical.getAttribute("href") || "" : "";',
    '      const canonMatch = canonHref.match(/\\/dp\\/([A-Z0-9]{10})/i);',
    '      const asinInput = doc.querySelector("#ASIN, input[name=ASIN]");',
    '',
    '      let byline = pick("#bylineInfo");',
    '      const sizeSel = doc.querySelector(',
    '        "#variation_size_name .selection, #variation_style_name .selection, .selection"',
    '      );',
    '',
    '      out.push({',
    '        requested: asin,',
    '        status: r.status,',
    '        bytes: html.length,',
    '        resolved: canonMatch ? canonMatch[1].toUpperCase()',
    '          : (asinInput ? (asinInput.value || "").toUpperCase() || null : null),',
    '        // NEVER truncate the title. Shortening it to fit an output limit',
    '        // produced four false mismatch failures on correct pages, because',
    '        // Amazon often puts the brand and the capacity at the END.',
    '        title: pick("#productTitle"),',
    '        byline: byline,',
    '        variant: sizeSel ? sizeSel.textContent.replace(/\\s+/g, " ").trim() : null,',
    '        availability: pick("#availability"),',
    '        noRestock: /don.t know when or if this item will be back in stock/i.test(html),',
    '        shipBlocked: /cannot be shipped to|not eligible for shipping to/i.test(html),',
    '      });',
    '    } catch (e) {',
    '      out.push({ requested: asin, error: String(e && e.message || e) });',
    '    }',
    '  }',
    '',
    '  async function worker() {',
    '    while (i < ASINS.length) {',
    '      const asin = ASINS[i++];',
    '      await one(asin);',
    '      await new Promise((res) => setTimeout(res, 150));',
    '    }',
    '  }',
    '',
    '  const workers = [];',
    '  for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());',
    '  await Promise.all(workers);',
    '',
    '  const blocked = out.filter((r) => (r.bytes || 0) < 10000 || r.error).length;',
    '  return JSON.stringify({',
    '    deliverTo: deliverTo,',
    '    requested: ASINS.length,',
    '    returned: out.length,',
    '    blocked: blocked,',
    '    records: out,',
    '  });',
    '})()',
  ].join('\n');
}

module.exports = { buildSnippet: buildSnippet, DEFAULT_CONCURRENCY: DEFAULT_CONCURRENCY };
