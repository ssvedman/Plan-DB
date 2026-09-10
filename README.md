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
| `*.sql` | Backend. Kept local, not published. |

## Notes

- **Cost data never lives in this repo.** It belongs only in Supabase, behind
  RLS. Don't add a static data fallback to the site.
- Series is stored per plan in the database and can be corrected by an editor.
  `config.js` only controls display order and group headings.
- `series_origin` records how each assignment was made. Anything marked
  `inferred` is a best guess and shows a tag in the app.
- A plan's headline figure is the average across the communities that offer it;
  the smaller figure underneath is the range. Sliders filter on the average.
- Margin is sales price minus extended cost, and follows the tax toggle.
- Months coexist. The app lists every one loaded and opens on the newest.
- A change between two months is measured only over the rows present in both,
  matched on community, plan and elevation, and the count of matched rows is
  always shown. Comparing each month's own average instead would report a
  change in what was priced as a change in price.
- The community index compares each community against what the same plans cost
  elsewhere that month, so it doesn't reward a community for selling small
  homes. A plan built in only one place is excluded — it would be its own
  benchmark.
- Cost codes are never loaded up front. Per-plan detail is fetched on demand;
  the aggregates behind the variance view are computed in the database, by
  functions that run as the caller so the same access rules apply.
- Community links use `#jde=<number>` on the sibling app. Same origin and
  shared session, so the link lands inside the record.
- A row is marked unreliable by three independent signals: an impossibly low
  figure; the same plan priced far below what it costs in other communities
  that month; or the same row roughly doubling in a later month at identical
  sq ft. The last one only applies where a later month has been loaded, and it
  is why loading a new month can re-flag an older one.
