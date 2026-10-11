'use strict';

// Phase 3 — turn one product page's HTML into facts.
//
// Order matters in this file. The bot wall and the shipping-block notice are
// both NETWORK/ACCOUNT conditions that look like product facts if you test for
// content first. Getting that order wrong is how a sweep once classified 72 of
// 76 products as "thin" when the real answer was "Amazon did not serve us the
// page", and two checks downstream then passed while comparing nothing.

// ---------------------------------------------------------------- bot wall

const WALL_MARKERS = [
  'not a robot',
  'validateCaptcha',
  'errors/validateCaptcha',
  'Enter the characters you see below',
  'Type the characters you see in this image',
  'To discuss automated access to Amazon data please contact',
  'Sorry, we just need to make sure',
];

// A served product page is hundreds of KB. The wall is a few KB. Size alone is
// a weak signal, so it only counts when the body is ALSO missing the title
// element -- otherwise a genuinely terse page would be misread as a wall.
function isBotWall(html) {
  const s = String(html || '');
  for (const marker of WALL_MARKERS) {
    if (s.indexOf(marker) !== -1) return true;
  }
  if (s.length < 10000 && s.indexOf('productTitle') === -1) return true;
  return false;
}

// ------------------------------------------------- shipping-block (NOT a fact
// ------------------------------------------------- about the product)

// "cannot be shipped to <country>" is produced by the delivery address on the
// browsing session, not by availability. Treating it as a product verdict
// condemned 37 perfectly buyable products in one sweep here. It is surfaced as
// a WARNING about the reader's own session, never as a product state.
function isShipBlocked(html) {
  const s = String(html || '');
  return (
    /cannot be shipped to/i.test(s) ||
    /not eligible for shipping to/i.test(s) ||
    /This item cannot be shipped to your selected delivery location/i.test(s)
  );
}

// ---------------------------------------------------------------- field reads

function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = String(html || '').match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return null;
}

function tidy(s) {
  if (s === null || s === undefined) return null;
  const out = String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return out || null;
}

// The ASIN Amazon actually served. If this differs from the ASIN in your link,
// your link was redirected -- which is the loudest wrong-variant signal there
// is, because it means the variant you published no longer exists.
function resolvedAsin(html) {
  return firstMatch(html, [
    /"currentAsin"\s*:\s*"([A-Z0-9]{10})"/i,
    /<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*\/dp\/([A-Z0-9]{10})/i,
    /<input[^>]+id=["']ASIN["'][^>]+value=["']([A-Z0-9]{10})["']/i,
    /name=["']ASIN["'][^>]+value=["']([A-Z0-9]{10})["']/i,
    /"asin"\s*:\s*"([A-Z0-9]{10})"/i,
  ]);
}

function title(html) {
  return tidy(
    firstMatch(html, [
      /<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i,
      /<h1[^>]+id=["']title["'][^>]*>([\s\S]*?)<\/h1>/i,
    ])
  );
}

// Brand is the most reliable token for a name check: Amazon titles run 140-196
// characters and often put the brand LAST, so matching on the title start is
// unreliable.
function brand(html) {
  const byline = tidy(
    firstMatch(html, [
      /<a[^>]+id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/a>/i,
      /<span[^>]+id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/span>/i,
    ])
  );
  if (byline) {
    const store = byline.match(/^Visit the (.+?) Store$/i);
    if (store) return store[1].trim();
    const brandLabel = byline.match(/^Brand:\s*(.+)$/i);
    if (brandLabel) return brandLabel[1].trim();
    return byline;
  }
  return tidy(
    firstMatch(html, [
      /"brand"\s*:\s*"([^"]{1,60})"/i,
      /<tr[^>]*>\s*<t[hd][^>]*>\s*Brand\s*<\/t[hd]>\s*<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/i,
    ])
  );
}

// Which variant is selected. Two independent sources, because the twister is
// absent on single-variant listings while the title suffix is absent on many
// multi-variant ones.
const SIZE_LABEL = /(?:size|size_name|style|style_name|item_package_quantity|colour_name|color_name)/i;

function selectedVariant(html) {
  const s = String(html || '');

  const twister = s.match(
    /<span[^>]+class=["'][^"']*selection[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
  );
  const labelled = s.match(
    /id=["']variation_(size_name|style_name)["'][\s\S]{0,400}?class=["'][^"']*selection[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
  );
  if (labelled) return tidy(labelled[2]);
  if (twister) return tidy(twister[1]);

  // Fall back to a trailing ", X-Large" / " | Large" style suffix on the title.
  const t = title(s);
  if (t) {
    const suffix = t.match(
      /[,|]\s*((?:XX?X?-?\s?(?:Small|Large)|Small|Medium|Large|One Size|[0-9.]+\s?(?:lb|lbs|oz|kg|inch|in|cm|mm|ft)))\s*(?:[,|)]|$)/i
    );
    if (suffix) return suffix[1].trim();
  }
  return null;
}

// --------------------------------------------------------------- availability

// "We don't know when or if this item will be back in stock" is the decisive,
// location-INDEPENDENT signal. A missing buy box is not: with a foreign
// delivery address set, buyable products render no buy box at all, so "no buy
// box" cannot discriminate availability. Verified here on three products where
// a session-less fetch showed no buy box for all three and only one was
// genuinely dead.
function availability(html) {
  const s = String(html || '');
  const block = firstMatch(s, [
    /<div[^>]+id=["']availability["'][^>]*>([\s\S]*?)<\/div>/i,
  ]);
  const text = tidy(block) || '';

  if (/don'?t know when or if this item will be back in stock/i.test(s)) {
    return { state: 'DISCONTINUED', detail: tidy(text) || 'no restock expected' };
  }
  if (/currently unavailable/i.test(text) || /currently unavailable/i.test(s)) {
    return { state: 'UNAVAILABLE', detail: tidy(text) || 'currently unavailable' };
  }
  if (/in stock/i.test(text)) {
    return { state: 'IN_STOCK', detail: tidy(text) };
  }
  if (text) return { state: 'UNKNOWN', detail: tidy(text) };
  return { state: 'UNKNOWN', detail: null };
}

// ------------------------------------------------------------------- parse

// Returns a flat record. `blocked` and `shipBlocked` describe OUR REQUEST;
// every other field describes the product. Keeping those separate is the whole
// point of this module.
function parseProductPage(html, requestedAsin) {
  if (isBotWall(html)) {
    return {
      requestedAsin: requestedAsin || null,
      blocked: true,
      shipBlocked: false,
      resolvedAsin: null,
      title: null,
      brand: null,
      variant: null,
      availability: { state: 'UNREADABLE', detail: 'bot wall' },
      bytes: String(html || '').length,
    };
  }

  return {
    requestedAsin: requestedAsin || null,
    blocked: false,
    shipBlocked: isShipBlocked(html),
    resolvedAsin: resolvedAsin(html),
    title: title(html),
    brand: brand(html),
    variant: selectedVariant(html),
    availability: availability(html),
    bytes: String(html || '').length,
  };
}

module.exports = {
  isBotWall: isBotWall,
  isShipBlocked: isShipBlocked,
  resolvedAsin: resolvedAsin,
  title: title,
  brand: brand,
  selectedVariant: selectedVariant,
  availability: availability,
  parseProductPage: parseProductPage,
  tidy: tidy,
};
