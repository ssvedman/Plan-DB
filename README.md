# Plan-DB

Floor plans grouped by series, with cost per square foot and extended cost.

Static site backed by the shared Supabase project, same as the other apps.
Sign-in required; viewer access is enough to read, editors and admins can write.

## Files

| File | Role |
|---|---|
| `index.html` | Shell and auth screen |
| `app.js` | Auth, load, rollup, filters, views, export |
| `config.js` | Connection settings, series display order |
| `styles.css` | Shared design language plus this app's components |
| `load.html` / `load.js` | Importer. Editors drop a month's data files in, and the CORE product lineup workbook. |
| `lineup.js` | Reads the CORE lineup sheet and works out what it changes in the roster. No DOM, so it runs under Node too. |
| `*.sql` | Backend. Kept local, not published. |

## Notes

- **Cost data never lives in this repo.** It belongs only in Supabase, behind
  RLS. Don't add a static data fallback to the site.
- Every table carries a division. Adding one is a `config.js` entry plus that
  division's data; the picker and the queries follow. The choice is remembered
  per person.
- `load.html` is reachable by anyone, and that is fine: it can do nothing
  without a signed-in editor, and the database enforces that independently of
  the page. The row-level policies are the boundary, not the UI gate.
- **Loading a month goes through `load.html`, not SQL.** Editors drop the
  `.ndjson` files in and the page writes them over their own session. A month
  replaces the same month wholesale rather than merging, so a plan that stopped
  being offered disappears instead of lingering.
- Plan numbers are division-specific but plan names are not — the same home is
  a different number in each division. Never copy a name or a series across on
  the strength of a matching number; match on the name instead.
- Series is stored per plan in the database and can be corrected by an editor.
  `config.js` only controls display order and group headings.
- `series_origin` records how each assignment was made. Anything marked
  `inferred` is a best guess and shows a tag in the app.
- A plan's headline figure is the average across the communities that offer it;
  the smaller figure underneath is the range. Sliders filter on the average.
- Margin is sales price minus extended cost, and follows the tax toggle.
- Months coexist. The app opens on the newest; the month strip under the tabs
  changes it, as does clicking a month on the trend chart. Choosing an older
  one turns the strip amber and offers a way back — reading a stale month as
  current is the failure worth designing against.
- The charts always draw every month loaded, whichever one the tables are
  showing. The trend column always compares the shown month with the one
  immediately before it, so the oldest month loaded has no trend column.
- A change between two months is measured only over the rows present in both,
  matched on community, plan and elevation, and the count of matched rows is
  always shown. Comparing each month's own average instead would report a
  change in what was priced as a change in price.
- The community index compares each community against what the same plans cost
  elsewhere that month, so it doesn't reward a community for selling small
  homes. A plan built in only one place is excluded — it would be its own
  benchmark.
- The cost-code breakdown is one JSON map per priced home, not one row per
  code. A row per code repeated the division, month, community, plan, elevation
  and a description on each one; across four months and three divisions that is
  900k rows carrying 238 distinct descriptions. The maps hold the same numbers
  in 11k rows. Descriptions live once, in `pdb_cost_code_names`.
- Anything that lists what exists — the months in the picker, the history
  behind the charts — must page. A plain select stops at 1000 rows, which on a
  division with thousands of cost rows silently hid the newest months.
- Cost codes are never loaded up front. Per-plan detail is fetched on demand
  and unrolled into one entry per code in the browser; the aggregates behind the
  variance view are computed in the database, by functions that run as the
  caller so the same access rules apply.
- That breakdown totals the base home **plus every option**, while a plan's
  headline cost per sq ft is the base alone. The two reconcile against
  `1BASE + options`, not against the headline figure.
- The Communities tab filters by tier. Tier belongs to the plan, so the filter
  drops priced rows whose plan is in another tier and rebuilds the index from
  the rest; a plan's benchmark doesn't change, only which plans count.
- The Communities export writes the tab as shown. Its JDE column is the full
  community number — the short JDE with `0000` appended (2631472 → 26314720000).
- **The CORE product lineup is the cross-division plan mapping.** Plan numbers
  are division-specific, so the join is the plan's family: collection + name as
  the lineup prints it (`COTTAGE|KITSON` is L056 in Orlando, L076 in Tampa,
  2520 as the regional design), stored in `pdb_plans.core_family`. The whole
  sheet is also kept in `pdb_core_lineup`, one row per line, per sheet date.
  Load it through `load.html` after running `add_core_lineup.sql` once.
- Loading a lineup: a versioned plan ("(ORLANDO VERSION)") belongs to the
  division it names and is added to the roster if missing. A plan with no
  version line is the regional design and only attaches where a division
  already carries that number under a name that agrees. A name disagreement is
  reported and skipped, never overwritten. Tier comes from the sheet; series
  only replaces a Legacy, inferred or unassigned one; other roster fields are
  filled only where blank. Rows are upserted whole so no curated column is
  nulled.
- The Divisions tab lines each family up across divisions, each at its own
  newest month (shown, since they can differ). A plan the lineup hasn't tagged
  joins by name and is marked as a name match — but only when its square
  footage agrees within 8%, because legacy plans reuse names for different
  homes (Meridian is 1,664 sq ft in Orlando and 2,396 in Tampa).
- Clicking a family on the Divisions tab opens a cost-code comparison, fetched
  on demand from `pdb_cost_codes` for each division's newest month. Only the
  homes behind the row's headline figure count (unreliable rows stay out unless
  shown), and each code is averaged over every home in the division with a
  missing code as zero, so a division's codes add up to its average home and a
  code only one division pays shows as a real difference. Untaxed only — the
  cost-code maps carry no tax.
- A plan's square footage comes from the rows that priced it (the largest
  among reliable rows), not the roster. The roster once took the largest figure
  any workbook gave, and a stray block in Cypress Point 50's (rows with no
  elevation, all 3,041 sq ft) doubled Tampa's Frey, Nash, Springsteen and
  Santana. A lineup import corrects roster sizes more than 8% off the sheet.
- An old plan number with `core_alias` (Orlando 1508 "Frey II" -> N108) sits
  with the plan it became on the Divisions tab, tagged "old #".
- Community links use `#jde=<number>` on the sibling app. Same origin and
  shared session, so the link lands inside the record.
- A row is marked unreliable by four independent signals: an impossibly low
  figure; a figure too high to be a cost per sq ft, which means the square
  footage is wrong rather than the cost; the same plan priced far below what it
  costs in other communities that month; or the same home roughly doubling in a
  later month at identical sq ft. The last only applies where a later month has
  been loaded, and it is why loading a new month can re-flag an older one.
- Column positions in the source workbooks are not stable — some carry an extra
  "Plan Name" column. Read them by heading, never by index: reading by index
  mistook the plan name for the elevation and silently collapsed three
  elevations into one.
