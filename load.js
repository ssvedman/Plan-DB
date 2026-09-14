/* ============================================================
   Plan-DB — importer

   Reads NDJSON files the user picks from their own machine and writes them to
   Supabase over the session they already hold. The data never passes through
   the repo, a CDN, or anywhere else — which is the whole point, since it is
   cost data.

   Editors and admins only; the database enforces that too, but failing here
   gives a readable reason instead of a wall of row-level errors.
   ============================================================ */
"use strict";
const CFG = window.APP_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true,
          storageKey:"lennar-vendor-portal-auth" }
});
const $ = id => document.getElementById(id);
const esc = s => String(s==null?"":s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* Which table each file loads, how to write it, and in what order. Order
   matters: the roster and the code list are referenced by the rest, so they go
   first, and cost codes go last because they are much the largest. */
const SPEC = {
  "plans.ndjson":      { table:"pdb_plans",           mode:"upsert", onConflict:"division,plan_no", batch:500,  order:1 },
  "codenames.ndjson":  { table:"pdb_cost_code_names", mode:"upsert", onConflict:"code",             batch:500,  order:2 },
  "costs.ndjson":      { table:"pdb_plan_costs",      mode:"replace", batch:1000, order:3 },
  "options.ndjson":    { table:"pdb_plan_options",    mode:"replace", batch:1000, order:4 },
  "costcodes.ndjson":  { table:"pdb_cost_codes",      mode:"replace", batch:300,  order:5 }
};

const state = { files:[], running:false, role:null, email:null };

/* ---------------- who is this ---------------- */
(async function gate(){
  try{
    const { data } = await sb.auth.getSession();
    const u = data && data.session && data.session.user;
    if(!u){ deny("You are not signed in. Open the app, sign in, then come back to this page."); return; }
    state.email = String(u.email||"").toLowerCase();
    let role = CFG.DEFAULT_ROLE || "viewer";
    try{
      const { data:r } = await sb.from("cdb_app_roles").select("role").eq("email",state.email).maybeSingle();
      if(r && r.role) role = r.role;
    }catch(e){}
    state.role = role;
    $("userChip").innerHTML = esc(state.email)+` <span class="role-tag">${esc(role)}</span>`;
    if(role!=="editor" && role!=="admin"){
      deny("Importing needs editor or admin access. Yours is “"+role+"”.");
      return;
    }
    wire();
  }catch(e){ deny("Could not check your access: "+(e&&e.message||e)); }
})();
function deny(msg){
  $("userChip").textContent = state.email || "not signed in";
  const g=$("gate"); g.textContent=msg; g.classList.remove("hidden");
  $("drop").style.opacity=.4; $("drop").style.pointerEvents="none";
}

/* ---------------- picking files ---------------- */
function wire(){
  const drop=$("drop"), pick=$("pick");
  drop.onclick=()=>pick.click();
  pick.onchange=()=>add([...pick.files]);
  ["dragenter","dragover"].forEach(t=>drop.addEventListener(t,e=>{
    e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave","drop"].forEach(t=>drop.addEventListener(t,e=>{
    e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop",e=>{
    e.preventDefault();
    add([...(e.dataTransfer.files||[])]);
  });
  $("clear").onclick=()=>{ state.files=[]; paint(); };
  $("go").onclick=run;
}
function add(list){
  list.forEach(f=>{
    const spec=SPEC[f.name];
    if(!spec){ log(`skipped ${f.name} — not one of: ${Object.keys(SPEC).join(", ")}`); return; }
    state.files=state.files.filter(x=>x.file.name!==f.name);
    state.files.push({ file:f, spec, rows:null, done:0, state:"ready", note:"" });
  });
  state.files.sort((a,b)=>a.spec.order-b.spec.order);
  paint();
}
function paint(){
  const q=$("queue");
  q.classList.toggle("hidden", !state.files.length);
  $("go").classList.toggle("hidden", !state.files.length || state.running);
  $("clear").classList.toggle("hidden", !state.files.length || state.running);
  const ww=$("wipeWrap");
  ww.style.display = state.files.length && !state.running ? "inline-flex" : "none";
  q.innerHTML = state.files.map((f,i)=>{
    const pct = f.rows ? Math.round(100*f.done/f.rows) : 0;
    return `<div class="qrow">
      <span class="qname">${esc(f.spec.table)}</span>
      <span class="qmeta">${esc(f.file.name)} · ${(f.file.size/1048576).toFixed(1)} MB${
        f.rows?` · ${f.rows.toLocaleString()} rows`:""}${f.note?" · "+esc(f.note):""}</span>
      <span class="qbar"><i style="width:${pct}%"></i></span>
      <span class="qstate ${f.state==="done"?"ok":f.state==="failed"?"err":""}">${esc(
        f.state==="ready"?"ready":f.state==="done"?"loaded":f.state==="failed"?"failed":pct+"%")}</span>
    </div>`;
  }).join("");
}
function log(s){
  const el=$("log"); el.classList.remove("hidden");
  el.textContent += (el.textContent?"\n":"") + s;
  el.scrollTop = el.scrollHeight;
}

/* ---------------- reading ----------------
   The files run to tens of megabytes, so they are read as text once and split
   rather than held as one parsed array plus the raw string. */
function parseNdjson(text){
  const out=[];
  let bad=0;
  for(const line of text.split("\n")){
    const t=line.trim();
    if(!t) continue;
    try{ out.push(JSON.parse(t)); }catch(e){ bad++; }
  }
  if(bad) throw new Error(bad+" line(s) were not valid JSON");
  return out;
}

/* ---------------- writing ---------------- */
async function insertBatches(f, rows){
  const { table, batch } = f.spec;
  for(let i=0;i<rows.length;i+=batch){
    const slice=rows.slice(i,i+batch);
    const { error } = await sb.from(table).insert(slice);
    if(error) throw new Error(`rows ${i}-${i+slice.length}: ${error.message}`);
    f.done = i+slice.length; paint();
  }
}
async function upsertBatches(f, rows){
  const { table, batch, onConflict } = f.spec;
  for(let i=0;i<rows.length;i+=batch){
    const slice=rows.slice(i,i+batch);
    const { error } = await sb.from(table).upsert(slice,{ onConflict });
    if(error) throw new Error(`rows ${i}-${i+slice.length}: ${error.message}`);
    f.done = i+slice.length; paint();
  }
}
/* A month is replaced wholesale rather than merged: a plan that stopped being
   offered has to disappear, and an upsert would leave it behind. */
async function clearScope(table, pairs){
  for(const [div,ds] of pairs){
    const { error } = await sb.from(table).delete().eq("division",div).eq("dataset",ds);
    if(error) throw new Error(`clearing ${div} ${ds}: ${error.message}`);
  }
}
/* Months the database holds that these files do not mention. Only removed when
   asked, because an older month is usually worth keeping. */
async function dropOtherMonths(table, keep){
  const { data, error } = await sb.from(table).select("division,dataset");
  if(error) throw new Error(`reading ${table}: ${error.message}`);
  const have=new Set((data||[]).map(r=>r.division+"|"+r.dataset));
  const kept=new Set(keep.map(p=>p[0]+"|"+p[1]));
  const gone=[...have].filter(k=>!kept.has(k));
  for(const k of gone){
    const [div,ds]=k.split("|");
    const { error:e2 } = await sb.from(table).delete().eq("division",div).eq("dataset",ds);
    if(e2) throw new Error(`removing ${div} ${ds}: ${e2.message}`);
    log(`  removed ${table} ${div} ${ds}`);
  }
  return gone.length;
}

async function run(){
  state.running=true; paint();
  const t0=Date.now();
  const wipe=$("wipe").checked;
  log(`starting — ${state.files.length} file(s), signed in as ${state.email}`);
  for(const f of state.files){
    try{
      f.state="reading"; f.note="reading"; paint();
      const text=await f.file.text();
      const rows=parseNdjson(text);
      f.rows=rows.length; f.done=0; f.note=""; f.state="writing"; paint();
      if(!rows.length){ f.state="done"; f.note="empty"; paint(); continue; }

      if(f.spec.mode==="replace"){
        const pairs=[...new Set(rows.map(r=>r.division+"|"+r.dataset))].map(s=>s.split("|"));
        log(`${f.spec.table}: replacing ${pairs.map(p=>p.join(" ")).join(", ")}`);
        await clearScope(f.spec.table, pairs);
        if(wipe) await dropOtherMonths(f.spec.table, pairs);
        await insertBatches(f, rows);
      } else {
        log(`${f.spec.table}: upserting ${rows.length.toLocaleString()} rows`);
        await upsertBatches(f, rows);
      }
      f.state="done"; paint();
      log(`  ${f.spec.table}: ${f.rows.toLocaleString()} rows loaded`);
    }catch(e){
      f.state="failed"; f.note=(e&&e.message)||String(e); paint();
      log(`  FAILED ${f.spec.table}: ${f.note}`);
      log(`  stopping — fix this and re-run; files already loaded do not need repeating`);
      state.running=false; paint();
      return;
    }
  }
  state.running=false; paint();
  log(`done in ${Math.round((Date.now()-t0)/1000)}s`);
}
