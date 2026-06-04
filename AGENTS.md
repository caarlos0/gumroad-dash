# AGENTS.md

> **Keep this file up to date.** Whenever you change the architecture, data model,
> metrics methodology, file layout, or workflow, update the relevant section here in
> the same change.

## What this is

**The Missing Gumroad Dashboard** — a **static, backend-free** webpage that loads a Gumroad
**sales CSV export** and shows revenue statistics. The headline feature is **forecasting
income** (weekly/monthly) from currently-active subscriptions. Everything runs in the browser;
no data ever leaves the machine and there is no server-side code.

Styling deliberately mimics Gumroad: pink (`#ff90e8`) accent, cream background, hard black
borders with offset box-shadows.

## Stack & layout

- Vanilla HTML/CSS/JS — no framework, no build step.
- Dependencies managed with **pnpm** (not vendored): `papaparse` (CSV parsing) and
  `chart.js` (charts). Loaded in the browser directly from `node_modules/` via `<script>`
  tags (UMD builds), so `pnpm install` is required before opening the page.
- `package.json` is **not** `type: module` — `app.js` is a classic browser script that also
  exposes a CommonJS test hook (`module.exports`) for Node-based verification.
- **Theming**: light/dark follows the OS via `@media (prefers-color-scheme: dark)`, which
  overrides the `--cream`/`--white`/`--black`/`--shadow` CSS vars (no toggle UI). Text on the
  pink accent must stay dark in both themes — use the constant `--ink-on-accent` token, never
  `--black`, for anything on a `--pink` background. Chart colors are set in JS by
  `applyChartTheme()` (reads `matchMedia`), called at the start of `render()`; a `matchMedia`
  `change` listener re-renders `lastMetrics` so charts retrack live OS theme switches.

```
index.html            # markup: header, dropzone (empty state), dashboard, footer
style.css             # Gumroad-like theme (CSS variables at top)
app.js                # all logic: parse -> compute -> render (charts + cards)
package.json          # deps: chart.js, papaparse; script: "dev" -> pnpm dlx serve .
pnpm-lock.yaml
sales_data.csv        # REAL data — gitignored, never commit
fake_sales_data.csv   # generated demo data — committed, safe to share
node_modules/         # gitignored
AGENTS.md
```

## Running

```sh
pnpm install
pnpm dev          # static server at http://localhost:3000, then load a CSV
```
Opening `index.html` over `file://` also works after `pnpm install` (paths are relative).

## Deploying (Cloudflare Pages)

The page references libs at `node_modules/...` for local dev, which won't deploy. So
`scripts/build.sh` (run via `pnpm build`) assembles a self-contained `dist/`: it copies the
static files, vendors the two libs into `dist/vendor/`, and rewrites the `<script>` src paths.
`wrangler.toml` sets `pages_build_output_dir = "dist"`. `pnpm deploy` runs the build then
`wrangler pages deploy`. `dist/` is gitignored. **If you add/rename a static file or a
`<script>` tag, update `scripts/build.sh` accordingly.**


## CSV data model (learned from real exports)

- One product; **each row is one charge**. The header has ~70 columns; only a handful matter.
- Gumroad appends a trailing **`Totals`** summary row (Purchase ID `Totals`, empty
  `Purchase Date`) — excluded by requiring a valid `Purchase Date`.
- Columns used: `Purchase Email` / `Buyer Email`, `Purchase Date` (YYYY-MM-DD),
  `Net Total ($)` (amount received after fees), `Recurrence` (`monthly`|`yearly`),
  `Variants` (tier, e.g. `(Business)`), `Recurring Charge?` (`1` for renewals, `0` first),
  `Cancellation Date`, `Subscription End Date`, `Fully Refunded?`, `Partial Refund ($)`,
  `Disputed?`, `Dispute Won?`, `Sale Price ($)` (per-charge price after discount; `0` for
  100%-off), `Discount Code` (empty when none).
- **No subscription-ID column exists.** Subscriptions are grouped by **email**
  (lowercased). `Order Number` changes per charge, so it can't be used. When a sub is
  cancelled, Gumroad stamps `Cancellation Date` + `Subscription End Date` on **all** its rows.

## Computation methodology (`app.js`)

`buildModel(rawRows)` → `{ rows, byEmail }`, then `computeMetrics(model)` → metrics object,
then `render(metrics)` draws cards + Chart.js charts.

Key rules — keep these consistent if you touch them:

- **Money we didn't keep is dropped:** rows that are fully refunded or lost a dispute
  (`Disputed?` set and `Dispute Won?` not set) are excluded; `Net Total` is reduced by
  `Partial Refund ($)`. (Gumroad keeps the original positive Net Total on refunded rows,
  so they MUST be excluded or revenue is overstated.)
- **Active subscription** = latest charge per email with **no** cancellation, **not** ended,
  and **not stale**. *Stale* = overdue past `lastChargeDate + interval + grace`
  (grace: 14d monthly / 30d yearly) with no renewal and no cancellation — treated as
  lapsed/involuntary-churn and **excluded** from MRR/forecast, surfaced as an audit note.
- **MRR (net)** = Σ monthly value of active subs (monthly: net; yearly: net/12). ARR = 12×MRR.
- **Forecast** ("how much will I make"): per active sub, project future charges
  (`lastCharge + interval`, repeating, strictly after today). Book the **full net on the
  renewal date** (cash-timing, not amortized). Headline cards: next 7/30/90 days, next 12mo.
- **Forecast chart window** = previous 4 months + current month + next 7 = 12 months,
  stacked: *Received* (actual revenue, incl. month-to-date) + *Projected* (future renewals).
- **Historical MRR** ("committed" view): at each completed month-end, count a sub if its last
  charge still covers that month AND it isn't cancelled by then. The **current (open) month
  is excluded** from this chart to avoid a misleading dip from not-yet-charged renewals.
- Month arithmetic uses a **clamped `addMonths`** (Jan 31 + 1mo → Feb 28/29, not Mar 3).
- **Discount metrics** use **access-based active** subs (latest charge per email, not cancelled,
  not ended) with **no staleness filter** — because 100%-off (free) subs generate **no $0
  renewal charges**, so the revenue staleness guard would wrongly hide them. Buckets:
  *free* = `Sale Price ($)` is 0; *discounted* = sale price > 0 with a `Discount Code`;
  *full* = sale price > 0 with no code. Also: customers-per-code (unique emails, all time) and
  total distinct codes / discounted customers. Surfaced in the **Discounts** panel.
- Header pill shows `"<filename> - <latest purchase date>"`. Header controls are hidden until
  data is loaded.

### Additional analytics metrics

- **Cumulative net revenue** — running total of `revSeries` over `months`; final value equals
  `lifetimeNet`.

## Verifying changes (no test framework)

There is no automated test suite. Verify manually:

1. **Logic** — Node harness using the CommonJS exports and pnpm-managed libs:
   ```sh
   node -e '
   global.Chart=class{constructor(){this.destroy=()=>{}}};
   global.Papa=require("./node_modules/papaparse/papaparse.min.js");
   const fs=require("fs");
   const {buildModel,computeMetrics}=require("./app.js");
   const res=Papa.parse(fs.readFileSync("fake_sales_data.csv","utf8"),{header:true,skipEmptyLines:true});
   const M=computeMetrics(buildModel(res.data));
   console.log(M.activeCount, M.mrr.toFixed(2), M.lifetimeNet.toFixed(2));'
   ```
   To smoke-test `render()`, stub `document.getElementById` (return objects with
   `innerHTML`, `textContent`, `hidden`, `getContext`, `addEventListener`, `classList`) and
   `global.Chart`, then call `render(M)`.
2. **Visual** — `python3 -m http.server 8753`, then headless screenshot:
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=...`.
   To screenshot with data preloaded, inject a small `<script>` that fetches a CSV and calls
   `render(computeMetrics(buildModel(...)))`. Clean up temp files and stop the server after.

Always verify against **both** `sales_data.csv` (real) and `fake_sales_data.csv` (demo).

## Demo data generator

`fake_sales_data.csv` is generated (seeded, ~190 subscribers / ~1500 rows) to exercise every
feature: growth over time, monthly/yearly, all tiers, cancellations, stale subs, refunds, and
**discount codes** (a pool of 100%-off "free" codes and partial-percent codes; free subs record
only the initial charge, mirroring real Gumroad behavior).
The generator script is not kept in-repo; regenerate via a throwaway script that writes all
header columns with `csv.DictWriter` if you need to refresh it (then convert CRLF→LF).

## Conventions

- **Conventional Commits** with scope where useful; **one logical change per commit**;
  sign off (`-s`); include the `Co-authored-by: Copilot <...>` trailer.
- Don't commit speculative work — wait for an explicit "commit".
- **Never commit `sales_data.csv`** (personal data) or `node_modules/` — both gitignored.
- Prefer simple, boring solutions; avoid defensive code without evidence of need.
