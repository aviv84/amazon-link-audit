'use strict';

// Phase 4 — compare what your page CLAIMS against what the listing IS.
//
// Two disciplines run through this file, both learned by getting them wrong:
//
// 1. Never flag on missing data. If the listing could not be read, the row is
//    UNCHECKED, not OK and not a failure. A checker that silently treats
//    "no data" as "no problem" reports success while testing nothing -- that
//    exact bug hid four wrong-size products behind a green result.
// 2. Never cry wolf. Brand spacing variants, section headings and
//    multi-size listings produced dozens of false flags in earlier versions. A
//    checker people stop trusting is worse than no checker.

const SIZE_CLASSES = [
  { cls: -3, tokens: ['xxx-small', 'xxxsmall', '3x-small', 'xxx small'] },
  { cls: -2, tokens: ['xx-small', 'xxsmall', '2x-small', 'xx small'] },
  { cls: -1, tokens: ['x-small', 'xsmall', 'extra small', 'extra-small', 'x small'] },
  { cls: 0, tokens: ['small'] },
  { cls: 1, tokens: ['medium', 'med'] },
  { cls: 2, tokens: ['large'] },
  { cls: 3, tokens: ['x-large', 'xlarge', 'extra large', 'extra-large', 'x large', 'xl'] },
  { cls: 4, tokens: ['xx-large', 'xxlarge', '2x-large', 'xx large', 'xxl'] },
  { cls: 5, tokens: ['xxx-large', 'xxxlarge', '3x-large', 'xxx large', 'xxxl'] },
];

// Longest tokens first, so "xx-small" is never matched as "small".
const SIZE_TOKENS = (function () {
  const flat = [];
  for (const entry of SIZE_CLASSES) {
    for (const t of entry.tokens) flat.push({ token: t, cls: entry.cls });
  }
  flat.sort(function (a, b) {
    return b.token.length - a.token.length;
  });
  return flat;
})();

function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Brand comparison ignores spacing and punctuation, because "PetHonesty" and
// "Pet Honesty" are the same company and flagging that pair wastes everyone's
// time. Same for AlphaPaw/Alpha Paw and ProSelect/Pro Select.
function brandKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// A size token only counts when it stands alone as a variant value -- bounded
// by a comma, pipe, bracket, slash or string edge. Without that bound, a
// listing offering "Small/Medium/Large" trips every rule, and "23.5lb" reads as
// a size.
// Returns a single size class, or null when the text does not determine one.
//
// null is returned both when NO size token is present and when SEVERAL
// different classes are ("Available in Small/Medium/Large", "Large/X-Large").
// A listing that offers a range has not told you which variant your link
// opens, so the honest answer is "undetermined" -- and the caller then skips
// the size check instead of guessing, because guessing here means flagging a
// correct page.
function sizeClassOf(text) {
  const s = normalise(text);
  if (!s) return null;

  const found = [];
  for (const entry of SIZE_TOKENS) {
    const re = new RegExp(
      '(^|[,|(\\[/]\\s*|\\s)' + entry.token.replace(/[-]/g, '[- ]?') + '(\\s*[,|)\\]/]|$)',
      'i'
    );
    if (re.test(s) && found.indexOf(entry.cls) === -1) found.push(entry.cls);
  }

  if (found.length !== 1) return null;
  return found[0];
}

function sizeLabel(cls) {
  for (const entry of SIZE_CLASSES) {
    if (entry.cls === cls) return entry.tokens[0];
  }
  return String(cls);
}

// Words that carry no identifying power in a product heading. Without this
// list, "Best Overall" matches almost any listing and the check never fires.
const STOPWORDS = new Set([
  'best', 'top', 'review', 'reviews', 'overall', 'budget', 'premium', 'pick',
  'picks', 'runner', 'value', 'choice', 'editor', 'editors', 'also', 'great',
  'good', 'with', 'from', 'that', 'this', 'these', 'those', 'your', 'most',
  'more', 'than', 'only', 'very', 'dogs', 'dog', 'large', 'small',
  'medium', 'extra', 'size', 'sizes', 'option', 'options', 'under', 'over',
  'heavy', 'duty', 'proof', 'resistant', 'friendly',
]);

// How many leading words of a heading are treated as the product's identity.
// Two is a measured compromise, not a guess -- see the comment below.
const IDENTITY_WORDS = 2;

// Does the heading identify the listing the link opens?
//
// Only the FIRST TWO distinctive words of the heading are used as evidence,
// matched against the listing's brand and title. The reasoning, from three real
// cases that pull in opposite directions:
//
//   "3. Bonnlo Professional Grooming Table" -> Go Pet Club grooming table
//       A GENUINE mismatch. But the words "grooming" and "table" appear in the
//       wrong product's title too, so matching on any word waves it through.
//       Its first two words (bonnlo, professional) match nothing. Caught.
//
//   "Cosequin DS Plus MSM" -> brand "Nutramax", title "Nutramax Cosequin ..."
//       CORRECT. Cosequin is the product line, Nutramax the parent company, so
//       matching against the brand alone wrongly flags it. Its first word
//       (cosequin) is right there in the title. Passes.
//
//   "2. PetSafe Solvit UltraLite Ramp" -> brand "Solvit"
//       CORRECT. The heading leads with a parent brand the listing does not
//       name, so first-word-only would wrongly flag it. Its SECOND word
//       (solvit) matches. Passes.
//
// Three words would re-break the Bonnlo case, because "grooming" is third.
// Generic category nouns reliably come after the identifying ones in a product
// heading, which is exactly what makes a leading window work.
function headingMatchesListing(heading, listingBrand, listingTitle) {
  const hays = [brandKey(listingBrand), brandKey(listingTitle)].filter(Boolean);
  if (!hays.length) return true; // nothing to check against -> do not flag

  const words = normalise(heading)
    .split(/[^a-z0-9]+/)
    .filter(function (w) {
      return w.length >= 4 && !STOPWORDS.has(w);
    });
  if (!words.length) return true; // nothing distinctive in the heading

  const candidates = words.slice(0, IDENTITY_WORDS);
  for (const w of candidates) {
    const key = brandKey(w);
    for (const hay of hays) {
      if (hay.indexOf(key) !== -1) return true;
    }
  }
  return false;
}

// One row in, one verdict out.
//
//   claim  = { asin, page, headings[], occurrences, expectedSizeClass? }
//   listing = output of parse.parseProductPage()
function classify(claim, listing) {
  const problems = [];
  const notes = [];

  if (!listing) {
    return {
      asin: claim.asin,
      page: claim.page || null,
      verdict: 'UNCHECKED',
      reason: 'no listing data for this ASIN',
      problems: [],
      notes: [],
    };
  }

  if (listing.blocked) {
    return {
      asin: claim.asin,
      page: claim.page || null,
      verdict: 'BLOCKED',
      reason:
        'Amazon did not serve the page (bot wall, ' + listing.bytes +
        ' bytes). This says nothing about the product -- retry from a ' +
        'logged-in browser tab.',
      problems: [],
      notes: [],
    };
  }

  // A shipping block is about the reader's own delivery address, never about
  // the product. Surfaced so nobody mistakes it for a verdict.
  if (listing.shipBlocked) {
    notes.push(
      'page shows a shipping restriction -- that reflects YOUR delivery ' +
        'address, not the product. Set a delivery address in the target market ' +
        'before trusting availability or price.'
    );
  }

  // --- the loudest signal: your published variant no longer exists
  if (
    listing.resolvedAsin &&
    listing.resolvedAsin.toUpperCase() !== String(claim.asin).toUpperCase()
  ) {
    problems.push({
      kind: 'REDIRECTED',
      detail:
        'link points at ' + claim.asin + ' but Amazon served ' +
        listing.resolvedAsin +
        ' -- the variant you published is gone and Amazon substituted another' +
        (listing.variant ? ' (' + listing.variant + ')' : ''),
    });
  }

  // --- dead links earn nothing
  const av = listing.availability || { state: 'UNKNOWN' };
  if (av.state === 'DISCONTINUED') {
    problems.push({
      kind: 'DISCONTINUED',
      detail: 'Amazon expects no restock' + (av.detail ? ' (' + av.detail + ')' : ''),
    });
  } else if (av.state === 'UNAVAILABLE') {
    problems.push({
      kind: 'UNAVAILABLE',
      detail: av.detail || 'currently unavailable',
    });
  }

  // --- does the heading name the product the link opens?
  const canCheckName = !!(listing.title || listing.brand);
  if (!canCheckName) {
    notes.push('listing title/brand unreadable -- name check skipped, not passed');
  } else {
    for (const heading of claim.headings || []) {
      if (!headingMatchesListing(heading, listing.brand, listing.title)) {
        problems.push({
          kind: 'NAME_MISMATCH',
          detail:
            'heading says "' + heading + '" but the link opens ' +
            (listing.brand ? listing.brand : 'a listing') +
            (listing.title ? ' -- "' + listing.title.slice(0, 80) + '"' : ''),
        });
      }
    }
  }

  // --- does the variant match the size the page implies?
  const variantClass = sizeClassOf(listing.variant) !== null
    ? sizeClassOf(listing.variant)
    : sizeClassOf(listing.title);

  let expected = claim.expectedSizeClass;
  if (expected === undefined || expected === null) {
    // Infer from the heading if the page states a size itself.
    for (const heading of claim.headings || []) {
      const c = sizeClassOf(heading);
      if (c !== null) {
        expected = c;
        break;
      }
    }
  }

  const hasMin = claim.minSizeClass !== null && claim.minSizeClass !== undefined;
  const hasExpected = expected !== null && expected !== undefined;

  if (variantClass === null) {
    if (hasExpected || hasMin) {
      notes.push('no variant size readable on the listing -- size check skipped');
    }
  } else if (hasMin && variantClass < claim.minSizeClass) {
    // A site-wide floor, not an exact match. This is what catches the case the
    // whole tool was built for: a guide for large dogs linking the XX-Small
    // variant, where the heading itself names no size so there is nothing to
    // compare it against. Linking a BIGGER size than the floor is fine, so
    // this is one-sided on purpose.
    problems.push({
      kind: 'SIZE_MISMATCH',
      detail:
        'this site targets ' + sizeLabel(claim.minSizeClass) +
        ' or larger, but the link opens ' + sizeLabel(variantClass) +
        (listing.variant ? ' ("' + listing.variant + '")' : ''),
    });
  } else if (hasExpected && variantClass !== expected) {
    problems.push({
      kind: 'SIZE_MISMATCH',
      detail:
        'page implies ' + sizeLabel(expected) + ' but the link opens ' +
        sizeLabel(variantClass) +
        (listing.variant ? ' ("' + listing.variant + '")' : ''),
    });
  }

  let verdict = 'OK';
  if (problems.length) {
    const order = ['REDIRECTED', 'DISCONTINUED', 'UNAVAILABLE', 'SIZE_MISMATCH', 'NAME_MISMATCH'];
    for (const kind of order) {
      if (problems.some(function (p) { return p.kind === kind; })) {
        verdict = kind;
        break;
      }
    }
  }

  return {
    asin: claim.asin,
    page: claim.page || null,
    verdict: verdict,
    reason: problems.length ? problems[0].detail : 'no problems found',
    problems: problems,
    notes: notes,
    listing: {
      resolvedAsin: listing.resolvedAsin,
      brand: listing.brand,
      variant: listing.variant,
      availability: av.state,
      title: listing.title,
    },
  };
}

// A report must always state its denominator. "0 problems" out of 0 checked is
// not a clean bill of health, and presenting it as one is the failure this
// whole tool exists to publicise.
function summarise(rows) {
  const counts = {};
  let checked = 0;
  for (const r of rows) {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
    if (r.verdict !== 'BLOCKED' && r.verdict !== 'UNCHECKED') checked++;
  }
  const problems = rows.filter(function (r) {
    return r.verdict !== 'OK' && r.verdict !== 'BLOCKED' && r.verdict !== 'UNCHECKED';
  }).length;
  const unreadable = (counts.BLOCKED || 0) + (counts.UNCHECKED || 0);
  return {
    total: rows.length,
    checked: checked,
    unreadable: unreadable,
    problems: problems,
    counts: counts,
    trustworthy: rows.length > 0 && unreadable / rows.length <= 0.25,
  };
}

module.exports = {
  classify: classify,
  summarise: summarise,
  sizeClassOf: sizeClassOf,
  sizeLabel: sizeLabel,
  brandKey: brandKey,
  headingMatchesListing: headingMatchesListing,
};
