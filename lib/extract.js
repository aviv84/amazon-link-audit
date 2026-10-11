'use strict';

// Phase 1 — read YOUR pages and work out what each Amazon link claims to be.
// Pure string work, no network. Everything here is testable offline.

// Amazon encodes the product in the path. /dp/ and /gp/product/ are the common
// shapes; /product-reviews/ and ?asin= turn up in older hand-built links.
const ASIN_PATTERNS = [
  /\/dp\/([A-Z0-9]{10})/i,
  /\/gp\/product\/([A-Z0-9]{10})/i,
  /\/gp\/aw\/d\/([A-Z0-9]{10})/i,
  /\/product-reviews\/([A-Z0-9]{10})/i,
  /[?&]asin=([A-Z0-9]{10})/i,
];

function asinFromUrl(url) {
  if (!url) return null;
  for (const re of ASIN_PATTERNS) {
    const m = url.match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// Amazon domains only. A link to example.com/dp/B000000000 is not a product.
function isAmazonUrl(url) {
  return /^https?:\/\/(?:[a-z0-9-]+\.)*amazon\.[a-z.]{2,6}(?:[/?#]|$)/i.test(
    url || ''
  );
}

function tagFromUrl(url) {
  const m = (url || '').match(/[?&]tag=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Strip tags and decode the handful of entities that actually show up in
// product headings. Deliberately small -- a full HTML entity table is not
// needed to compare a brand token.
const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&#39;': "'",
  '&#x27;': "'",
  '&ndash;': '-',
  '&mdash;': '-',
};

function decodeEntities(s) {
  let out = (s || '').replace(/&#x([0-9a-f]+);/gi, function (_, h) {
    return String.fromCodePoint(parseInt(h, 16));
  });
  out = out.replace(/&#(\d+);/g, function (_, d) {
    return String.fromCodePoint(parseInt(d, 10));
  });
  for (const k of Object.keys(ENTITIES)) {
    out = out.split(k).join(ENTITIES[k]);
  }
  return out;
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Every <a href> in the document, in source order, with its character offset.
function findLinks(html) {
  const out = [];
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    out.push({ href: decodeEntities(href), index: m.index });
  }
  return out;
}

// Every heading, in source order, with its offset. The nearest heading ABOVE a
// link is what the reader believes that link points to -- which is the whole
// basis of the mismatch check.
function findHeadings(html) {
  const out = [];
  const re = /<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[2]);
    if (text) out.push({ level: m[1].toLowerCase(), text: text, index: m.index });
  }
  return out;
}

// Headings that organise the page rather than name a product. Without this the
// checker pairs "Conclusion" or "Our Top 5 Picks" with the next link and
// reports a mismatch on a perfectly good page. Learned the hard way: a looser
// rule flagged 40+ legitimate headings.
// Two different things end up in <h2>/<h3>: headings that NAME A PRODUCT, and
// headings that label a part of the page. Only the first kind makes a claim
// about what a link opens.
//
// The second group includes sub-headings INSIDE a product's own review card --
// "Specifications", "Pros and Cons", "Who It Is For". Those were the single
// biggest source of false positives when this was first run on a real 31-page
// site: 20 of 31 flags came from an <h3>Key Specifications</h3> inside a card
// being treated as the product's name.
const SECTION_HEADING = /^(conclusion|final (verdict|thought|word|take|pick)|verdict|our top|the top|top \d|quick pick|our pick|what to look|buying guide|how to choose|how we (chose|test|pick)|frequently asked|faq|related|methodology|why trust|table of contents|contents|comparison|at a glance|introduction|summary|disclosure|affiliate|key spec|specification|spec[s]?$|pros|cons|the good|the bad|what we (like|liked)|who it|best for|bottom line|our verdict|key feature|highlights|overview|at a price)/i;

// "… at a Glance" marks a summary table wherever it appears in the heading, not
// only at the start -- real example: "Quick Picks: Best Dog Treadmills for
// Large Dogs at a Glance". Treating that as a product heading compares the
// first product in the comparison table against the words "quick" and
// "treadmills" and reports a mismatch on a perfectly good page.
// These phrases mark a summary or comparison block wherever they sit in the
// heading, not only at the start. Real examples that needed each one:
//   "Quick Picks: Best Dog Treadmills for Large Dogs at a Glance"
//   "Side-by-Side Comparison: All 4 Orthopedic Dog Beds"
// No plausible product heading contains them, so matching anywhere is safe.
const SECTION_ANYWHERE = /(at a glance|comparison|quick pick|side.by.side|head.to.head)/i;

function isSectionHeading(text) {
  const t = (text || '').trim();
  return SECTION_HEADING.test(t) || SECTION_ANYWHERE.test(t);
}

// Phase 1 output: one row per ASIN, carrying every link instance (so a fix can
// count occurrences) and the product headings that CLAIM it.
//
// A heading claims the FIRST Amazon link inside its own section -- between it
// and the next heading of any level. The obvious alternative, "attribute each
// link to the nearest heading above it", is wrong: a Final Verdict or
// Conclusion section legitimately re-links products, and that rule hands those
// links to whichever product heading happened to come last, inventing a
// mismatch on a correct page.
function extractFromHtml(html, pageUrl) {
  const links = findLinks(html).filter(function (l) {
    return isAmazonUrl(l.href) && asinFromUrl(l.href);
  });
  const headings = findHeadings(html);
  const byAsin = new Map();

  function rowFor(asin) {
    if (!byAsin.has(asin)) {
      byAsin.set(asin, {
        asin: asin,
        page: pageUrl || null,
        occurrences: 0,
        tags: [],
        headings: [],
      });
    }
    return byAsin.get(asin);
  }

  // Every link instance, for counting and tag checks.
  for (const link of links) {
    const row = rowFor(asinFromUrl(link.href));
    row.occurrences++;
    const tag = tagFromUrl(link.href);
    if (tag && row.tags.indexOf(tag) === -1) row.tags.push(tag);
  }

  // Claims: one per product heading, from the first link in its section.
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (isSectionHeading(h.text)) continue;
    const end = i + 1 < headings.length ? headings[i + 1].index : Infinity;

    for (const link of links) {
      if (link.index > h.index && link.index < end) {
        const row = rowFor(asinFromUrl(link.href));
        if (row.headings.indexOf(h.text) === -1) row.headings.push(h.text);
        break; // first link in the section only
      }
    }
  }

  return Array.from(byAsin.values());
}

// Pull page URLs out of a sitemap (or sitemap index) so the tool can audit a
// whole site from one address.
function urlsFromSitemap(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(decodeEntities(m[1]));
  return out;
}

function isSitemapIndex(xml) {
  return /<sitemapindex/i.test(xml || '');
}

module.exports = {
  asinFromUrl: asinFromUrl,
  isAmazonUrl: isAmazonUrl,
  tagFromUrl: tagFromUrl,
  stripTags: stripTags,
  decodeEntities: decodeEntities,
  findLinks: findLinks,
  findHeadings: findHeadings,
  isSectionHeading: isSectionHeading,
  extractFromHtml: extractFromHtml,
  urlsFromSitemap: urlsFromSitemap,
  isSitemapIndex: isSitemapIndex,
};
