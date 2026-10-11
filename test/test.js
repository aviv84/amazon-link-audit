'use strict';

// Every case here is either a defect that reached a live page, or a false
// positive that an earlier version of this logic produced. A checker is worth
// nothing until you have watched it catch a real one and watched it stay quiet
// on a good one.

const extract = require('../lib/extract');
const parse = require('../lib/parse');
const classify = require('../lib/classify');
const ingest = require('../lib/ingest');

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass++;
    console.log('  ok   ' + label);
  } else {
    fail++;
    console.log('  FAIL ' + label);
    console.log('       want ' + JSON.stringify(want));
    console.log('       got  ' + JSON.stringify(got));
  }
}

function ok(label, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ok   ' + label);
  } else {
    fail++;
    console.log('  FAIL ' + label + (detail ? '  -- ' + detail : ''));
  }
}

// ----------------------------------------------------------------- extraction

console.log('\nASIN extraction');
eq('/dp/', extract.asinFromUrl('https://www.amazon.com/dp/B0CLB4RJ4W?tag=x-20'), 'B0CLB4RJ4W');
eq('/gp/product/', extract.asinFromUrl('https://amazon.com/gp/product/B075897YPY'), 'B075897YPY');
eq('slug before /dp/', extract.asinFromUrl('https://www.amazon.com/Ruffwear-Harness/dp/B0CLB4RJ4W/ref=sr_1_3'), 'B0CLB4RJ4W');
eq('?asin=', extract.asinFromUrl('https://www.amazon.com/x?asin=B003ZBXR4M&tag=y'), 'B003ZBXR4M');
eq('no asin', extract.asinFromUrl('https://www.amazon.com/s?k=dog+bed'), null);
eq('non-amazon host is not a product', extract.isAmazonUrl('https://notamazon.com/dp/B000000000'), false);
eq('amazon.co.uk counts', extract.isAmazonUrl('https://www.amazon.co.uk/dp/B000000000'), true);
eq('tag read', extract.tagFromUrl('https://www.amazon.com/dp/B1?tag=example-20&x=1'), 'example-20');

console.log('\nheading pairing');
const page = [
  '<h2>Our Top 5 Picks at a Glance</h2>',
  '<h2>1. Ruffwear Front Range - Best Overall</h2>',
  '<p><a href="https://www.amazon.com/dp/B0CLB4RJ4W?tag=t-20">Check Price</a></p>',
  '<h2>2. Kurgo Tru-Fit - Best for Cars</h2>',
  '<p><a href="https://www.amazon.com/dp/B003L8H8E8?tag=t-20">Check Price</a></p>',
  '<h2>Conclusion</h2>',
  '<p><a href="https://www.amazon.com/dp/B0CLB4RJ4W?tag=t-20">buy</a></p>',
].join('\n');
const rows = extract.extractFromHtml(page, 'https://example.com/harnesses/');
eq('two ASINs found', rows.length, 2);
eq('first ASIN occurrences counted', rows[0].occurrences, 2);
eq(
  'heading attached, section headings ignored',
  rows[0].headings,
  ['1. Ruffwear Front Range - Best Overall']
);
ok(
  '"Conclusion" did not become a product heading',
  rows[0].headings.indexOf('Conclusion') === -1
);
// The real trap: the conclusion re-links the Ruffwear. Attributing links to
// "the nearest heading above" hands that link to the KURGO heading and invents
// a mismatch on a page that is entirely correct.
ok(
  'a link in the conclusion is not blamed on the previous product heading',
  rows[0].headings.indexOf('2. Kurgo Tru-Fit - Best for Cars') === -1 &&
    rows[1].headings.indexOf('2. Kurgo Tru-Fit - Best for Cars') !== -1
);
eq('section heading detector', extract.isSectionHeading('Our Top 5 Picks at a Glance'), true);
eq('product heading not treated as section', extract.isSectionHeading('3. Bully Beds Orthopedic'), false);
// Found by running the scanner on a real 31-page site: these were being read
// as product headings, which would compare the first product in a comparison
// table against the words "quick" and "treadmills".
eq('"Quick Picks:" prefix', extract.isSectionHeading('Quick Picks: Best Dog Treadmills for Large Dogs'), true);
eq('"at a Glance" mid-heading', extract.isSectionHeading('Quick Picks: Best Elevated Dog Bowls at a Glance'), true);
eq('"How We Chose"', extract.isSectionHeading('How We Chose These Picks'), true);
eq('a brand called "Topaz" is still a product', extract.isSectionHeading('2. Topaz Pet Ramp'), false);

console.log('\nsitemap');
eq(
  'locs pulled',
  extract.urlsFromSitemap('<urlset><url><loc>https://a.com/x/</loc></url><url><loc>https://a.com/y/</loc></url></urlset>'),
  ['https://a.com/x/', 'https://a.com/y/']
);
eq('index detected', extract.isSitemapIndex('<sitemapindex><sitemap><loc>a</loc></sitemap></sitemapindex>'), true);

// -------------------------------------------------------------------- parsing

console.log('\nbot wall is detected BEFORE any content heuristic');
const wall = '<html><body>Sorry, we just need to make sure you are not a robot. ' +
  'To discuss automated access to Amazon data please contact api-services-support.</body></html>';
eq('wall flagged', parse.isBotWall(wall), true);
const walled = parse.parseProductPage(wall, 'B0CLB4RJ4W');
eq('wall -> blocked, not a product verdict', walled.blocked, true);
eq('wall -> availability is UNREADABLE not UNAVAILABLE', walled.availability.state, 'UNREADABLE');
ok(
  'a real page is not mistaken for a wall',
  parse.isBotWall('<span id="productTitle">A product</span>' + 'x'.repeat(200000)) === false
);

console.log('\nfield reads');
const product = [
  '<link rel="canonical" href="https://www.amazon.com/Ruffwear/dp/B0CLB4RJ4W"/>',
  '<span id="productTitle">  Ruffwear, Front Range Dog Harness, Large/X-Large, Blue  </span>',
  '<a id="bylineInfo">Visit the RUFFWEAR Store</a>',
  '<div id="variation_size_name"><span class="selection">Large/X-Large</span></div>',
  '<div id="availability"><span>In Stock</span></div>',
  'x'.repeat(50000),
].join('\n');
eq('resolved asin', parse.resolvedAsin(product), 'B0CLB4RJ4W');
eq('title tidied', parse.title(product), 'Ruffwear, Front Range Dog Harness, Large/X-Large, Blue');
eq('brand from "Visit the X Store"', parse.brand(product), 'RUFFWEAR');
eq('variant from twister', parse.selectedVariant(product), 'Large/X-Large');
eq('in stock', parse.availability(product).state, 'IN_STOCK');

console.log('\navailability: the location-independent signal wins');
const noRestock = '<span id="productTitle">x</span>' +
  '<div id="availability">Currently unavailable.</div>' +
  'We don\'t know when or if this item will be back in stock.' + 'y'.repeat(20000);
eq('discontinued beats unavailable', parse.availability(noRestock).state, 'DISCONTINUED');

console.log('\nshipping block is about YOUR address, never the product');
const shipBlocked = '<span id="productTitle">A fine product</span>' +
  '<div id="availability">In Stock</div>' +
  'This item cannot be shipped to your selected delivery location.' + 'z'.repeat(20000);
const sb = parse.parseProductPage(shipBlocked, 'B1');
eq('flagged separately', sb.shipBlocked, true);
eq('availability untouched by it', sb.availability.state, 'IN_STOCK');
ok('it is not a problem verdict', classify.classify({ asin: 'B1', headings: [] }, sb).verdict === 'OK');
ok(
  'but it IS surfaced as a note',
  classify.classify({ asin: 'B1', headings: [] }, sb).notes.length > 0
);

// ------------------------------------------------------------------ verdicts

console.log('\nREDIRECTED -- the published variant is gone (real: homepage Fi collar)');
const redirected = classify.classify(
  { asin: 'B0D4MNGLLC', page: 'https://example.com/gps/', headings: ['Fi Series 3 - Best Overall'] },
  {
    blocked: false, shipBlocked: false, resolvedAsin: 'B0FHHYLBQ9',
    title: 'Fi Series 3+ Smart Dog Collar, X-Small', brand: 'Fi',
    variant: 'X-Small', availability: { state: 'IN_STOCK' }, bytes: 500000,
  }
);
eq('verdict', redirected.verdict, 'REDIRECTED');
ok('names both ASINs', /B0D4MNGLLC/.test(redirected.reason) && /B0FHHYLBQ9/.test(redirected.reason));

console.log('\nSIZE_MISMATCH -- real: XX-Small harness on a large-dog guide');
const sizeBad = classify.classify(
  { asin: 'B08R55M4T5', headings: ['1. Ruffwear Front Range - Best for Large Dogs'], expectedSizeClass: 2 },
  {
    blocked: false, shipBlocked: false, resolvedAsin: 'B08R55M4T5',
    title: 'Ruffwear, Front Range Dog Harness, XX-Small, Blue', brand: 'RUFFWEAR',
    variant: 'XX-Small', availability: { state: 'IN_STOCK' }, bytes: 500000,
  }
);
eq('verdict', sizeBad.verdict, 'SIZE_MISMATCH');

console.log('\nminSizeClass -- the flagship case, where the heading names NO size');
// The actual defect: a guide for large dogs linking the XX-Small Ruffwear. Its
// heading was "Ruffwear Front Range Harness - Best Premium Option" -- no size
// in it at all, so there is nothing for an exact-match check to compare.
const floorBad = classify.classify(
  {
    asin: 'B08R55M4T5',
    headings: ['Ruffwear Front Range Harness - Best Premium Option'],
    minSizeClass: 2, // "this site is about large dogs"
  },
  {
    blocked: false, shipBlocked: false, resolvedAsin: 'B08R55M4T5',
    title: 'Ruffwear, Front Range Dog Harness, XX-Small, Blue Dusk',
    brand: 'RUFFWEAR', variant: 'XX-Small',
    availability: { state: 'IN_STOCK' }, bytes: 500000,
  }
);
eq('caught by the size floor', floorBad.verdict, 'SIZE_MISMATCH');
ok('explains the floor', /targets large or larger/.test(floorBad.reason), floorBad.reason);

// One-sided on purpose: bigger than the floor is fine.
const floorBigger = classify.classify(
  { asin: 'B1', headings: ['Ruffwear Front Range Harness'], minSizeClass: 2 },
  {
    blocked: false, shipBlocked: false, resolvedAsin: 'B1',
    title: 'Ruffwear Front Range Harness, XX-Large', brand: 'RUFFWEAR',
    variant: 'XX-Large', availability: { state: 'IN_STOCK' }, bytes: 500000,
  }
);
eq('a LARGER size than the floor is not a problem', floorBigger.verdict, 'OK');

console.log('\nNAME_MISMATCH -- real: heading said Bonnlo, link opened Go Pet Club');
const nameBad = classify.classify(
  { asin: 'B00DX3AR4A', headings: ['3. Bonnlo Professional Grooming Table'] },
  {
    blocked: false, shipBlocked: false, resolvedAsin: 'B00DX3AR4A',
    title: 'Go Pet Club - 30 Inch Dog Grooming Table', brand: 'Go Pet Club',
    variant: null, availability: { state: 'IN_STOCK' }, bytes: 500000,
  }
);
eq('verdict', nameBad.verdict, 'NAME_MISMATCH');

console.log('\nknown FALSE POSITIVES must stay quiet');
function nameCheck(heading, brand, title) {
  return classify.classify(
    { asin: 'B1', headings: [heading] },
    {
      blocked: false, shipBlocked: false, resolvedAsin: 'B1', title: title,
      brand: brand, variant: null, availability: { state: 'IN_STOCK' }, bytes: 500000,
    }
  ).verdict;
}
eq('PetHonesty vs Pet Honesty', nameCheck('2. PetHonesty Hip + Joint', 'Pet Honesty', 'Pet Honesty Hip and Joint Chews'), 'OK');
eq('AlphaPaw vs Alpha Paw', nameCheck('1. AlphaPaw CareRamp', 'Alpha Paw', 'Alpha Paw CareRamp for Dogs'), 'OK');
eq('ProSelect vs Pro Select', nameCheck('4. ProSelect Empire Cage', 'Pro Select', 'Pro Select Empire Dog Cage'), 'OK');
eq(
  'second word is enough: "PetSafe Solvit UltraLite" -> "Solvit 62337"',
  nameCheck('2. PetSafe Solvit UltraLite Ramp', 'Solvit', 'Solvit 62337 UltraLite Telescoping Pet Ramp'),
  'OK'
);
// Found on a real site: the heading names a PRODUCT LINE and the brand field
// holds the parent company. Matching the brand field alone flags this wrongly.
eq(
  'product line vs parent brand: "Cosequin DS Plus MSM" -> brand Nutramax',
  nameCheck('Cosequin DS Plus MSM', 'Nutramax', 'Nutramax Cosequin Joint Supplement for Dogs, Chewable Tablets, 132ct'),
  'OK'
);
// ...and the mismatch it must still catch, where the shared words are generic
// category nouns sitting AFTER the identifying ones.
eq(
  'still catches Bonnlo -> Go Pet Club (shared words are generic)',
  nameCheck('3. Bonnlo Professional Grooming Table', 'Go Pet Club', 'Go Pet Club - 30 Inch Dog Grooming Table'),
  'NAME_MISMATCH'
);
// In-card sub-headings are not product names. 20 of 31 false flags on the
// first real run came from this one shape.
eq('"Key Specifications" is a section heading', extract.isSectionHeading('Key Specifications'), true);
eq('"Specifications" is a section heading', extract.isSectionHeading('Specifications'), true);
eq('"Pros and Cons" is a section heading', extract.isSectionHeading('Pros and Cons'), true);
// The last two false positives from the real 31-page run.
eq('"Final Thoughts:" prefix', extract.isSectionHeading('Final Thoughts: Choosing the Best Joint Supplement'), true);
eq('"Side-by-Side Comparison" anywhere', extract.isSectionHeading('Side-by-Side Comparison: All 4 Orthopedic Dog Beds'), true);
// Guard against over-fitting: a brand whose name merely contains a listed word
// must still count as a product.
eq('"Summit" is not "summary"', extract.isSectionHeading('2. Summit Ridge Dog Bed'), false);
eq('"Overview Pet Co" leads with a listed word -- accepted cost', extract.isSectionHeading('Overview Pet Co Harness'), true);
// A range is not a variant. Returning any single class here would flag correct
// pages, so the honest answer is "undetermined" and the size check is skipped.
eq(
  'a listing offering Small/Medium/Large is undetermined, not "small"',
  classify.sizeClassOf('Available in Small/Medium/Large'),
  null
);
eq(
  'a combined "Large/X-Large" variant is undetermined too',
  classify.sizeClassOf('Large/X-Large'),
  null
);
eq(
  'and an undetermined variant does NOT produce a size flag',
  classify.classify(
    { asin: 'B1', headings: ['1. Ruffwear Front Range for Large Dogs'], expectedSizeClass: 2 },
    {
      blocked: false, shipBlocked: false, resolvedAsin: 'B1',
      title: 'Ruffwear Front Range Harness', brand: 'RUFFWEAR',
      variant: 'Large/X-Large', availability: { state: 'IN_STOCK' }, bytes: 500000,
    }
  ).verdict,
  'OK'
);
ok(
  '23.5lb does not read as a size class',
  classify.sizeClassOf('Dog Food 23.5lb Bag') === null,
  'got ' + classify.sizeClassOf('Dog Food 23.5lb Bag')
);
eq('xx-small is not matched as small', classify.sizeClassOf('Harness, XX-Small, Blue'), -2);
eq('x-large read correctly', classify.sizeClassOf('Life Jacket, X-Large'), 3);

console.log('\nmissing data is UNCHECKED, never OK');
eq(
  'no listing at all',
  classify.classify({ asin: 'B1', headings: ['Anything'] }, null).verdict,
  'UNCHECKED'
);
const blankTitle = classify.classify(
  { asin: 'B1', headings: ['Some Brand Widget'] },
  {
    blocked: false, shipBlocked: false, resolvedAsin: 'B1', title: null,
    brand: null, variant: null, availability: { state: 'UNKNOWN' }, bytes: 500000,
  }
);
eq('unreadable title does not produce a name flag', blankTitle.verdict, 'OK');
ok(
  'but it says the check was SKIPPED, not passed',
  blankTitle.notes.some(function (n) { return /skipped, not passed/.test(n); })
);

// ------------------------------------------------------------------- summary

console.log('\nthe report must state its denominator');
const s1 = classify.summarise([
  { verdict: 'OK' }, { verdict: 'OK' }, { verdict: 'SIZE_MISMATCH' },
]);
eq('checked count', s1.checked, 3);
eq('problem count', s1.problems, 1);
eq('trustworthy', s1.trustworthy, true);

const s2 = classify.summarise([
  { verdict: 'BLOCKED' }, { verdict: 'BLOCKED' }, { verdict: 'BLOCKED' }, { verdict: 'OK' },
]);
eq('mostly blocked -> NOT trustworthy', s2.trustworthy, false);
eq('zero problems but untrustworthy', s2.problems, 0);

const s3 = classify.summarise([]);
eq('an empty run is never trustworthy', s3.trustworthy, false);

// -------------------------------------------------------------------- ingest

console.log('\nbrowser record ingestion');
const payload = {
  deliverTo: 'Bellevue 98007',
  records: [
    {
      requested: 'B0CLB4RJ4W', status: 200, bytes: 480000,
      resolved: 'b0clb4rj4w', title: 'Ruffwear Front Range, Large/X-Large',
      byline: 'Visit the RUFFWEAR Store', variant: 'Large/X-Large',
      availability: 'In Stock', noRestock: false, shipBlocked: false,
    },
    { requested: 'B000DEAD00', status: 200, bytes: 3781, title: null },
    { requested: 'B000ERR000', error: 'NetworkError' },
  ],
};
const ing = ingest.ingest(payload);
eq('delivery location carried through', ing.deliverTo, 'Bellevue 98007');
eq('resolved asin upper-cased', ing.listings.get('B0CLB4RJ4W').resolvedAsin, 'B0CLB4RJ4W');
eq('brand parsed', ing.listings.get('B0CLB4RJ4W').brand, 'RUFFWEAR');
eq('3781-byte body -> blocked', ing.listings.get('B000DEAD00').blocked, true);
eq('network error -> blocked', ing.listings.get('B000ERR000').blocked, true);
ok(
  'a blocked record never becomes a product problem',
  classify.classify({ asin: 'B000DEAD00', headings: [] }, ing.listings.get('B000DEAD00')).verdict === 'BLOCKED'
);
eq('accepts a bare array too', ingest.ingest([{ requested: 'B1', status: 200, bytes: 400000, title: 't' }]).listings.size, 1);
eq('accepts a JSON string', ingest.ingest(JSON.stringify(payload)).listings.size, 3);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail === 0 ? 0 : 1;
