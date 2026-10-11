#!/usr/bin/env node
'use strict';

// amazon-link-audit -- find affiliate links that open the wrong product.
//
// Three phases, deliberately separate, because the middle one has to happen in
// a browser (see lib/snippet.js for the measurements that forced that):
//
//   1. scan     read YOUR pages, list every Amazon link and what each claims
//   2. snippet  print JS to paste into a logged-in amazon.com tab
//   3. report   read the collected records back, print verdicts
//
// Zero dependencies. Nothing is uploaded anywhere. No credentials are read.

const fs = require('fs');
const dns = require('dns');

const extract = require('./lib/extract');
const classify = require('./lib/classify');
const ingest = require('./lib/ingest');
const snippet = require('./lib/snippet');

// Node's happy-eyeballs picks IPv6 first, and plenty of hosts have a broken
// IPv6 path while curl works fine. This one line has saved hours.
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');

const USAGE = [
  'amazon-link-audit -- find affiliate links that open the wrong product',
  '',
  'Usage:',
  '  amazon-link-audit scan <url-or-file> [more...] [--out claims.json]',
  '                        [--min-size large]',
  '      Reads your pages (or a sitemap.xml URL, which is expanded) and writes',
  '      every Amazon link found plus the heading that claims it.',
  '      --min-size declares the smallest variant your audience can use, so a',
  '      link opening anything below it is flagged. This is what catches an',
  '      XX-Small harness on a guide for large dogs.',
  '',
  '  amazon-link-audit snippet [claims.json] [--concurrency 4]',
  '      Prints JavaScript to paste into the console of a logged-in',
  '      amazon.com tab. Save what it returns to records.json.',
  '',
  '  amazon-link-audit report [claims.json] [records.json] [--json]',
  '      Compares the two and prints the verdicts.',
  '',
  'Why the browser step: Amazon does not serve product pages to scripts.',
  'A session-less request returns a bot wall, so the collector runs in your',
  'own browser on the Amazon origin, using your own session.',
].join('\n');

function arg(argv, name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  return fallback;
}

function readSource(src) {
  if (/^https?:\/\//i.test(src)) {
    return fetch(src, {
      headers: {
        // Identify honestly. This fetches the USER's own pages, not Amazon.
        'user-agent': 'amazon-link-audit (+https://github.com/)',
      },
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + src);
      return r.text();
    });
  }
  return Promise.resolve(fs.readFileSync(src, 'utf8'));
}

async function expandSources(sources) {
  const out = [];
  for (const src of sources) {
    if (/sitemap[^/]*\.xml$/i.test(src)) {
      const xml = await readSource(src);
      const urls = extract.urlsFromSitemap(xml);
      if (extract.isSitemapIndex(xml)) {
        // A sitemap index lists child sitemaps, not pages. Walking only the
        // first child is how whole sections of a site get silently exempted
        // from an audit.
        for (const child of urls) {
          const childXml = await readSource(child);
          for (const u of extract.urlsFromSitemap(childXml)) out.push(u);
        }
      } else {
        for (const u of urls) out.push(u);
      }
    } else {
      out.push(src);
    }
  }
  return out;
}

async function cmdScan(argv) {
  const outFile = arg(argv, 'out', 'claims.json');
  const minSizeToken = arg(argv, 'min-size', null);

  let minSizeClass = null;
  if (minSizeToken) {
    minSizeClass = classify.sizeClassOf(minSizeToken);
    if (minSizeClass === null) {
      console.error(
        '--min-size "' + minSizeToken + '" is not a size I recognise.\n' +
          'Try one of: x-small, small, medium, large, x-large, xx-large'
      );
      process.exitCode = 2;
      return;
    }
  }

  const sources = argv.filter(function (a, i) {
    if (a.indexOf('--') === 0) return false;
    if (i > 0 && (argv[i - 1] === '--out' || argv[i - 1] === '--min-size')) return false;
    return true;
  });
  if (!sources.length) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const pages = await expandSources(sources);
  console.log('scanning ' + pages.length + ' page(s)');

  const all = [];
  let failed = 0;
  for (const page of pages) {
    try {
      const html = await readSource(page);
      const rows = extract.extractFromHtml(html, page);
      for (const r of rows) {
        if (minSizeClass !== null) r.minSizeClass = minSizeClass;
        all.push(r);
      }
      process.stdout.write('.');
    } catch (e) {
      failed++;
      process.stdout.write('!');
    }
  }
  process.stdout.write('\n');

  const asins = Array.from(new Set(all.map(function (r) { return r.asin; })));
  fs.writeFileSync(outFile, JSON.stringify({ pages: pages.length, claims: all }, null, 2));

  console.log(
    all.length + ' link group(s) across ' + asins.length + ' unique ASIN(s)' +
      (failed ? '  (' + failed + ' page(s) could not be read)' : '')
  );
  if (minSizeClass !== null) {
    console.log('minimum size for this site: ' + classify.sizeLabel(minSizeClass));
  } else {
    console.log(
      'tip: pass --min-size large to catch links that open a size your' +
        ' audience cannot use'
    );
  }
  if (!asins.length) {
    console.log('\nNo Amazon links found. If you expected some, check that the');
    console.log('pages render links server-side -- this reads HTML, not JS.');
  }
  console.log('\nwrote ' + outFile);
  console.log('next:  amazon-link-audit snippet ' + outFile);
}

function loadClaims(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.claims || [];
}

function cmdSnippet(argv) {
  const file = argv.find(function (a) { return a.indexOf('--') !== 0; }) || 'claims.json';
  const claims = loadClaims(file);
  const asins = Array.from(new Set(claims.map(function (c) { return c.asin; })));
  const concurrency = parseInt(arg(argv, 'concurrency', '4'), 10);

  console.error('# ' + asins.length + ' ASIN(s). Steps:');
  console.error('#  1. open a product page on amazon.com and sign in');
  console.error('#  2. confirm the header shows a delivery address in your');
  console.error('#     target market -- a foreign one makes most listings render');
  console.error('#     no buy box, which reads as "unavailable" when it is not');
  console.error('#  3. open the console, paste everything below, press enter');
  console.error('#  4. save the returned JSON to records.json');
  console.error('');
  console.log(snippet.buildSnippet(asins, { concurrency: concurrency }));
}

function cmdReport(argv) {
  const files = argv.filter(function (a) { return a.indexOf('--') !== 0; });
  const claimsFile = files[0] || 'claims.json';
  const recordsFile = files[1] || 'records.json';
  const asJson = argv.indexOf('--json') !== -1;

  const claims = loadClaims(claimsFile);
  const ing = ingest.ingest(fs.readFileSync(recordsFile, 'utf8'));

  const rows = claims.map(function (c) {
    return classify.classify(c, ing.listings.get(String(c.asin).toUpperCase()) || null);
  });
  const summary = classify.summarise(rows);

  if (asJson) {
    console.log(JSON.stringify({ summary: summary, deliverTo: ing.deliverTo, rows: rows }, null, 2));
    process.exitCode = summary.problems > 0 || !summary.trustworthy ? 1 : 0;
    return;
  }

  if (ing.deliverTo) console.log('delivery location seen by the collector: ' + ing.deliverTo);
  console.log('');

  const problems = rows.filter(function (r) {
    return r.verdict !== 'OK' && r.verdict !== 'BLOCKED' && r.verdict !== 'UNCHECKED';
  });

  for (const r of problems) {
    console.log(r.verdict + '  ' + r.asin + (r.page ? '  ' + r.page : ''));
    for (const p of r.problems) console.log('    - ' + p.kind + ': ' + p.detail);
    for (const n of r.notes) console.log('    note: ' + n);
    console.log('');
  }

  const unreadable = rows.filter(function (r) {
    return r.verdict === 'BLOCKED' || r.verdict === 'UNCHECKED';
  });
  if (unreadable.length) {
    console.log(
      unreadable.length + ' ASIN(s) could not be read: ' +
        unreadable.map(function (r) { return r.asin; }).join(', ')
    );
    console.log('  These are NOT clean -- they are untested. Re-run the snippet.');
    console.log('');
  }

  // State the denominator, always. "0 problems" out of 0 checked is not a
  // clean bill of health, and reporting it as one is the failure this tool
  // exists to publicise.
  console.log(
    summary.problems + ' problem(s) in ' + summary.checked + ' checked ASIN(s)' +
      ' (' + summary.total + ' found, ' + summary.unreadable + ' unreadable)'
  );
  if (!summary.trustworthy) {
    console.log(
      'RESULT NOT TRUSTWORTHY: more than a quarter of the ASINs were unreadable.'
    );
  }
  process.exitCode = summary.problems > 0 || !summary.trustworthy ? 1 : 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(USAGE);
    return;
  }
  if (cmd === 'scan') return cmdScan(rest);
  if (cmd === 'snippet') return cmdSnippet(rest);
  if (cmd === 'report') return cmdReport(rest);

  console.error('unknown command: ' + cmd + '\n');
  console.error(USAGE);
  process.exitCode = 2;
}

main().catch(function (e) {
  console.error('error: ' + (e && e.message ? e.message : e));
  // Set the code and let the loop drain. process.exit() straight after network
  // I/O races socket teardown on Windows and the status is lost -- which turns
  // a failure into a silent success.
  process.exitCode = 1;
  setTimeout(function () {}, 300).unref();
});
