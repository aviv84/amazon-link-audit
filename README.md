# amazon-link-audit

Finds Amazon affiliate links that open **the wrong product**.

Not dead links — a link checker already finds those. This finds the failure
mode checkers are structurally blind to:

> The URL returns **200**. The affiliate tag is **correct**. The disclosure is
> **present**. And the link opens an XX-Small harness on a guide about large
> dogs.

I found 15 of these in 76 links on my own site. Nothing in my toolchain had
flagged a single one, because nothing in my toolchain was asking whether the
link opened the product the article actually recommends.

MIT licensed, zero dependencies, nothing is uploaded anywhere.

> **Background:** I wrote up the original audit — all fifteen, and the four
> structural causes — at
> [largedoglab.com/wrong-size-product-links-audit](https://largedoglab.com/wrong-size-product-links-audit/).
> This tool is that check, generalised so you can run it on your own site.

---

## The four ways a correct link becomes a wrong one

1. **One listing spans XS to XXL, and the URL encodes one variant.** You pick
   the right size once; the URL is a different product from its neighbours
   forever after.
2. **The title describes the product line, not the variant.** A real listing:
   *"Dog Shoes for Large Dogs, 360 Anti Slip **Medium** Dog Boots"*. Reading the
   title tells you almost nothing about what the link opens.
3. **Titles mislead in both directions.** A stroller titled "for Large Dogs"
   rated to **66 lb**. A treadmill titled "for Small & Medium Dogs" rated to
   **130 lb**. A model literally *named* "Medium" rated to **330 lb**. Read the
   capacity, never the adjective.
4. **Discontinued variants redirect silently.** The size you linked stops being
   sold, and Amazon serves whatever size is left — so a link that was right the
   day you published it is wrong a year later, with nothing on your page
   changing.

Cause 4 is the nasty one: your content rots without you touching it.

---

## Install

```bash
git clone <this repo> && cd amazon-link-audit
npm test            # 62 assertions, no network needed
```

Requires Node 18+. There are no dependencies to install.

---

## Use

### 1. Scan your own pages

```bash
node cli.js scan https://example.com/sitemap.xml --min-size large --out claims.json
# or individual pages, or local HTML files:
node cli.js scan https://example.com/best-dog-beds/ ./build/page.html
```

**`--min-size` is the option that matters.** It declares the smallest variant
your audience can actually use, and anything below it is flagged. Larger is
never a problem, so the rule is one-sided on purpose.

Without it, the size check only fires when one of your own headings states a
size — and the worst real case does not. The XX-Small harness that started all
this sat under the heading *"Ruffwear Front Range Harness — Best Premium
Option"*: no size in the heading, nothing to compare, defect invisible. One flag
on the command line is the difference between catching it and not.

A `sitemap.xml` URL is expanded, including a sitemap **index** — every child
sitemap is walked, because reading only the first one silently exempts whole
sections of a site from the audit.

This records every Amazon link, how many times each ASIN appears, its affiliate
tag, and **the heading that claims it**.

### 2. Collect listing data from your browser

```bash
node cli.js snippet claims.json
```

This prints JavaScript. Open a product page on amazon.com, make sure you are
signed in, then paste it into the browser console and save what it returns to
`records.json`.

**Why a browser, and not the tool itself?** Because Amazon does not serve
product pages to scripts. Measured on a real site:

| Method | Result |
|---|---|
| `node fetch`, no session | a stub, no product data |
| `curl`, no session | a **3,781-byte bot wall**, every single ASIN |
| `curl` + cookie jar + browser headers | real page — but one burst earns a penalty box that outlasts a 90-second gap |
| **same-origin `fetch` from a logged-in tab** | **76 ASINs, 44 seconds, 0 blocked** |

So the collector runs in your browser, on the Amazon origin, with your own
session. It handles no credentials and sends nothing anywhere; you paste the
result back yourself.

If you have Product Advertising API access, that is a cleaner route — but it
requires 10 qualifying sales in the trailing 30 days, which most small sites do
not have.

### 3. Report

```bash
node cli.js report claims.json records.json
```

```
delivery location seen by the collector: Bellevue 98007

SIZE_MISMATCH  B08R55M4T5  https://example.com/best-no-pull-harness/
    - SIZE_MISMATCH: page implies large but the link opens xx-small ("XX-Small")

REDIRECTED  B0D4MNGLLC  https://example.com/best-gps-trackers/
    - REDIRECTED: link points at B0D4MNGLLC but Amazon served B0FHHYLBQ9 --
      the variant you published is gone and Amazon substituted another (X-Small)

2 problem(s) in 76 checked ASIN(s) (76 found, 0 unreadable)
```

Exit code is 1 if there are problems **or if the run was not trustworthy**.

---

## Verdicts

| Verdict | Meaning |
|---|---|
| `REDIRECTED` | Amazon served a different ASIN than you linked. The variant you published no longer exists. The loudest wrong-variant signal there is. |
| `DISCONTINUED` | *"We don't know when or if this item will be back in stock."* |
| `UNAVAILABLE` | Currently unavailable. |
| `SIZE_MISMATCH` | Your page implies one size class, the link opens another. |
| `NAME_MISMATCH` | Your heading names one brand, the link opens another. |
| `BLOCKED` | **Amazon did not serve the page.** Says nothing about the product. |
| `UNCHECKED` | No listing data for this ASIN. Not a pass. |
| `OK` | No problems found in what could be checked. |

---

## Three things this tool refuses to do

These are the mistakes that cost me the most, so they are designed out rather
than documented around.

**It never reports a network condition as a fact about a product.** A bot wall
is `BLOCKED`, never "unavailable". I once shipped a sweep that tested
`length < 5000 → THIN` *before* checking for the wall, so 72 of 76 products
were classified from a page Amazon never sent. Two checks downstream then
passed while comparing empty strings, and four wrong-size products sat live
underneath a green result.

**It never reports a price.** Prices are the single most dangerous field to
scrape: a geolocated request returns the local currency with nothing in the
markup saying so. I published shekel figures as dollars on five live pages,
roughly 3x inflated, and only noticed because two unrelated products both
"cost" 121.21. Variant correctness does not need prices, so prices are out of
scope entirely.

**It never treats a shipping restriction as a product problem.** *"Cannot be
shipped to \<country\>"* is produced by **your** delivery address, not by
availability. Treating it as a verdict once condemned 37 perfectly buyable
products. It is surfaced as a note about your session instead.

---

## And one thing it insists on doing

**Every report states its denominator.** `0 problems` is meaningless without
`of how many`, and if more than a quarter of ASINs were unreadable the report
says so in capitals and exits non-zero.

This is not pedantry. A test suite of mine once printed eleven `PASS` lines
against **zero pages** after an auth failure, and only the two checks that
printed a count caught it. A check that cannot show its denominator cannot
distinguish "clean" from "nothing to look at".

---

## False positives it deliberately suppresses

Earlier versions of this logic produced all of these. Each one is now a test.

- **Brand spacing.** `PetHonesty` / `Pet Honesty`, `AlphaPaw` / `Alpha Paw`,
  `ProSelect` / `Pro Select` are the same companies.
- **Any brand word is enough.** A heading reading *"PetSafe Solvit UltraLite"*
  legitimately links a listing whose brand is *"Solvit"*.
- **Generic category nouns are not evidence.** The name check compares against
  the listing's **brand**, not its title, when the brand is known — otherwise
  *"Bonnlo Professional Grooming Table"* "matches" a Go Pet Club grooming table
  on the words *grooming* and *table*, and a genuine mismatch is waved through.
- **Section headings are not products.** *Conclusion*, *Our Top 5 Picks at a
  Glance*, *Buying Guide* and friends are skipped. A looser rule flagged 40+
  legitimate headings.
- **A size range is not a variant.** `Small/Medium/Large` and `Large/X-Large`
  return *undetermined*, and the size check is skipped rather than guessed.
- **`23.5lb` is not a size class**, and `XX-Small` is never matched as `Small`.
- **Links in the conclusion are not blamed on the last product heading.** Each
  heading claims the *first* link in its own section. The obvious alternative —
  "attribute each link to the nearest heading above it" — hands a Final Verdict
  link to whichever product came last and invents a mismatch on a correct page.

---

## Limits, stated plainly

- It reads **server-rendered HTML**. Links injected by JavaScript are invisible
  to the scan step.
- The browser step is **manual**. That is a deliberate consequence of Amazon's
  bot wall, not an oversight.
- `SIZE_MISMATCH` needs your page to state a size somewhere, or an explicit
  `expectedSizeClass` on the claim. It cannot infer that a guide is about large
  dogs from its title alone.
- It checks whether a link opens the product you named. It cannot tell you
  whether that product is any **good**.

---

## Validated against a real site, not just unit tests

`npm test` is 78 assertions and needs no network. But a checker is only
believable once you have watched it do both jobs on real input, so:

**It catches the real defect.** Run against the pre-fix backup of the page that
started this — a guide for large dogs linking the XX-Small Ruffwear harness:

```
SIZE_MISMATCH  B08R55M4T5
    - this site targets large or larger, but the link opens xx-small ("XX-Small")

1 problem(s) in 1 checked ASIN(s) (5 found, 4 unreadable)
RESULT NOT TRUSTWORTHY: more than a quarter of the ASINs were unreadable.
```

Note the second half. I deliberately supplied listing data for only one of the
five ASINs, and the tool refused to present the run as a clean result. That
refusal is the feature.

**It stays quiet on a clean site.** Run across all 31 pages of the live site:
**81 link groups, 75 unique ASINs, 0 problems** — matching, from a completely
separate implementation, the ASIN count that site's own test suite reports.

Getting to that zero took three rounds of fixing **false positives**, all found
by running on real pages rather than fixtures:

| Round | False flags | Cause |
|---|---|---|
| 1 | 31 | `<h3>Key Specifications</h3>` *inside* a review card read as the product's name (20 of the 31), plus "Quick Picks:" table headings |
| 2 | 2 | "Final Thoughts:" and "Side-by-Side Comparison:" not recognised as section headings |
| 3 | **0** | — |

Every one of those is now a test. The section-heading list is a heuristic and
will not know about your page's own furniture — if it flags something it should
not, that is the bug to report first.

## Contributing

Bug reports are most useful with the page HTML and the ASIN. If you find a
false positive, that is a higher-priority bug than a miss: a checker people
stop trusting is worse than no checker.
