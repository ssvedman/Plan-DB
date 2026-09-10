# Plan-DB

Floor plans grouped by series, with cost per square foot and extended cost.

Static site backed by the shared Supabase project, same as the other apps.
Sign-in required; viewer access is enough to read, editors and admins can write.

## Setup

Run in the Supabase SQL editor, in order:

1. `supabase_setup.sql` — tables, RLS, grants. Safe to re-run. Assumes the
   shared roles table and helper functions already exist.
2. `seed_<month>.sql` — plan roster, that month's costs, and per-plan options.
   Re-runnable; replaces only that month.
3. `seed_<month>_costcodes_1..N.sql` — the cost-code breakdown, split into parts
   because it is tens of thousands of rows. Run the parts in order; part 1
   clears the month first.

The app shows an empty state until step 2 runs.

## Files

| File | Role |
|---|---|
| `index.html` | Shell and auth screen |
| `app.js` | Auth, load, rollup, filters, views, export |
| `config.js` | Connection settings, series display order |
| `styles.css` | Shared design language plus this app's components |
| `supabase_setup.sql` | Tables, RLS, grants |
| `register_blueprint.sql` | Registers the app on the hub with the shared sign-in |

## Notes

- **Cost data never lives in this repo.** It belongs only in Supabase, behind
  RLS. Seed files are kept in `_scratch/plan-db-seed/` in the master folder,
  outside any repo; `.gitignore` also blocks `*.sql` here as a backstop. Don't
  add a static data fallback to the site.
- Series is stored per plan in the database and can be corrected by an editor.
  `config.js` only controls display order and group headings.
- `series_origin` records how each assignment was made. Anything marked
  `inferred` is a best guess and shows a tag in the app.
- A plan's headline figure is the average across the communities that offer it;
  the smaller figure underneath is the range. Sliders filter on the average.
- Cost codes are large, so the app never loads them up front — it fetches them
  for one plan when someone opens that plan's breakdown, and caches per plan.
- Margin is sales price minus extended cost, and follows the tax toggle, so the
  default view is margin against taxed cost.
- To load a new month: re-run the extraction over the new source folder, emit a
  seed with a new `dataset` value, and run it. Months coexist and the app gains
  a picker and opens on the newest.
- A row is marked unreliable by three independent signals: an impossibly low
  figure; the same plan priced far below what it costs in other communities
  that month; or the same row roughly doubling in a later month at identical
  sq ft. The last one only applies where a later month has been loaded, and it
  is why loading a new month can re-flag an older one — re-run the older seed
  after adding a newer one.
