/* ============================================================
   Plan-DB — CONFIG
   Static site on GitHub Pages, backed by the shared Supabase project.
   Login is required; any signed-in Lennar user (viewer and up) can read.
   ============================================================ */
window.APP_CONFIG = {
  SUPABASE_URL:  "https://memhzqphludiruovuzwt.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lbWh6cXBobHVkaXJ1b3Z1end0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMTI3MjUsImV4cCI6MjA5OTc4ODcyNX0.hTJBtb3WtkgY66xqzZ22GT7V4VNllxPyb4C7qXRFFVI",

  // Invite / password-reset links land on the hub, same as the other apps.
  BLUEPRINT_URL: "https://ssvedman.github.io/Blueprint/",

  ALLOWED_DOMAIN: "@lennar.com",
  DIVISION: { key: "orlando", label: "Orlando Division", code: "OLH" },
  DEFAULT_ROLE: "viewer"
};

/* ------------------------------------------------------------------
   SERIES
   Series is stored per plan in `pdb_plans.series` and can be
   corrected by an editor. The plan-number prefix does NOT determine
   series — the same letter spans several of them — so nothing here
   derives it. This block only supplies display order and the
   one-line description under each group heading.
   ------------------------------------------------------------------ */
window.PDB_SERIES = {
  "Ascent":    { blurb: "Front-loaded towns." },
  "Ascent II": { blurb: "Front-loaded towns." },
  "Embark":    { blurb: "Front-loaded towns." },
  "Venture":   { blurb: "Alley-loaded towns." },
  "Palm":      { blurb: "" },
  "Cottage":   { blurb: "" },
  "Eventide":  { blurb: "" },
  "Lonestar":  { blurb: "Rear-loaded homesites." },
  "Coastline": { blurb: "" },
  "Vineyard":  { blurb: "" },
  "Majors":    { blurb: "" },
  "Classic":   { blurb: "" },
  "Paragon":   { blurb: "" },
  "TBD":       { blurb: "Series not yet named." },
  "LEGACY":    { blurb: "No series assigned yet." },
  "SHELL":     { blurb: "Priced per building, not per home." }
};
/* Display order. Anything not listed sorts to the end alphabetically. */
window.PDB_SERIES_ORDER = [
  "Ascent", "Ascent II", "Embark", "Venture", "TBD",
  "Palm", "Cottage", "Eventide", "Lonestar", "Coastline",
  "Vineyard", "Majors", "Classic", "Paragon",
  "LEGACY", "SHELL"
];
/* Headings for the catch-all groups. */
window.PDB_SERIES_LABEL = { LEGACY: "Legacy (unassigned)", SHELL: "Building shells", TBD: "Towns (TBD)" };

/* Dataset to show by default. The app lists every dataset present and
   defaults to the newest, so this is only a fallback for an empty database. */
window.PDB_DEFAULT_DATASET = "2026-07";

