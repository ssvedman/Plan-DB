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
  ["drop","lnDrop"].forEach(id=>{ const el=$(id); if(el){ el.style.opacity=.4; el.style.pointerEvents="none"; } });
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
  wireLineup();
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

/* ================= CORE product lineup =================
   Parsed and matched in the browser (lineup.js), previewed, and written only
   when the editor presses Apply. Roster rows go back whole — every column —
   because an upsert fills any column missing from a batch with null, and a
   partial row would wipe curated fields like homesite or matrix community. */
const ln = { parsed:null, planned:null, file:null, busy:false };

function wireLineup(){
  const drop=$("lnDrop"), pick=$("lnPick"); if(!drop) return;
  drop.onclick=()=>pick.click();
  pick.onchange=()=>{ if(pick.files[0]) readLineup(pick.files[0]); pick.value=""; };
  ["dragenter","dragover"].forEach(t=>drop.addEventListener(t,e=>{ e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave","drop"].forEach(t=>drop.addEventListener(t,e=>{ e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop",e=>{ const f=(e.dataTransfer.files||[])[0]; if(f) readLineup(f); });
}
function lnMsg(html, kind){ $("lnOut").innerHTML=`<div class="msg ${kind||"info"}" style="margin-top:14px">${html}</div>`; }

async function fetchAll(table, cols){
  let out=[];
  for(let from=0;;from+=1000){
    const { data,error } = await sb.from(table).select(cols||"*").range(from,from+999);
    if(error) throw error;
    out=out.concat(data||[]);
    if(!data || data.length<1000) break;
  }
  return out;
}

async function readLineup(file){
  if(ln.busy) return;
  if(!window.XLSX){ lnMsg("The spreadsheet library didn't load — refresh and try again.","err"); return; }
  ln.file=file; lnMsg("Reading "+esc(file.name)+"…");
  try{
    // the new columns and table have to exist before anything can be written
    const chk=await sb.from("pdb_core_lineup").select("seq").limit(1);
    if(chk.error){ lnMsg("The database isn't ready for lineups yet. Run <code>add_core_lineup.sql</code> in Supabase first, then drop the file again.<br><span class='tiny'>"+esc(chk.error.message)+"</span>","err"); return; }
    const wb=XLSX.read(await file.arrayBuffer(), { type:"array" });
    const name=wb.SheetNames.find(n=>/core/i.test(n)) || wb.SheetNames[0];
    const aoa=XLSX.utils.sheet_to_json(wb.Sheets[name], { header:1, raw:true, defval:null });
    const parsed=PdbLineup.parse(aoa, file.name);
    if(!parsed.date){ lnMsg("Couldn't find the lineup date (the “DATE: mm.dd.yyyy” line).","err"); return; }
    if(!parsed.rows.some(r=>r.kind==="plan")){ lnMsg("No plans found on sheet “"+esc(name)+"”. Is this the CORE lineup?","err"); return; }
    const roster=await fetchAll("pdb_plans");
    const planned=PdbLineup.plan(parsed, roster, {
      divisions:(CFG.DIVISIONS||[]).map(d=>d.key),
      knownSeries:Object.keys(window.PDB_SERIES||{}), email:state.email });
    ln.parsed=parsed; ln.planned=planned;
    paintLineup();
  }catch(e){ lnMsg("Couldn't read the lineup: "+esc(e&&e.message||e),"err"); }
}

function paintLineup(){
  const p=ln.parsed, R=ln.planned.report, divs=(CFG.DIVISIONS||[]);
  const dl=k=>(divs.find(d=>d.key===k)||{label:k}).label;
  const nPlans=p.rows.filter(r=>r.kind==="plan").length, nShell=p.rows.length-nPlans;
  const fams=new Set(p.rows.filter(r=>r.family).map(r=>r.family)).size;
  const realSeries=R.seriesSet.filter(s=>s.from!==s.to);
  const tbl=(head,rows)=>`<table><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
    rows.map(r=>`<tr>${r.map(c=>`<td>${esc(c==null?"":c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const sec=(title,n,body,open)=> n?`<details class="lnd"${open?" open":""}><summary>${esc(title)} (${n})</summary>${body}</details>`:"";
  $("lnOut").innerHTML=`
    <div class="lnsum">
      <div><b>${esc(p.date)}</b><span>lineup date · ${esc(ln.file.name)}</span></div>
      <div><b>${nPlans}</b><span>plans on the sheet · ${nShell} shell lines</span></div>
      <div><b>${fams}</b><span>plan families</span></div>
      <div><b>${R.matched.length}</b><span>roster plans tagged</span></div>
      <div><b>${R.added.length}</b><span>new plans added (awaiting pricing)</span></div>
      <div><b>${R.conflicts.length}</b><span>name conflicts — skipped</span></div>
    </div>
    ${sec("Name conflicts — the sheet and the database disagree; these are left untouched",R.conflicts.length,
      tbl(["Division","Plan #","In the database","On the sheet"],R.conflicts.map(c=>[dl(c.division),c.plan_no,c.roster,c.lineup])),true)}
    ${sec("Tier changes",R.tierChanges.length,
      tbl(["Division","Plan #","Plan","Tier now","Tier on the sheet"],R.tierChanges.map(c=>[dl(c.division),c.plan_no,c.name,c.from,c.to])),true)}
    ${sec("Square footage corrections — the database figure was more than 8% off the sheet",R.sqftFixes.length,
      tbl(["Division","Plan #","Plan","Sq ft now","Sq ft on the sheet"],R.sqftFixes.map(c=>[dl(c.division),c.plan_no,c.name,Math.round(c.from),c.to])),true)}
    ${sec("Series changes",realSeries.length,
      tbl(["Division","Plan #","Plan","Series now","Series from the sheet"],realSeries.map(c=>[dl(c.division),c.plan_no,c.name,c.from,c.to])),true)}
    ${sec("New plans added to the roster",R.added.length,
      tbl(["Division","Plan #","Plan","Family"],R.added.map(a=>[dl(a.division),a.plan_no,a.name,a.family.replace("|"," · ")])))}
    ${sec("Roster plans tagged with a family",R.matched.length,
      tbl(["Division","Plan #","Plan","Family"],R.matched.map(a=>[dl(a.division),a.plan_no,a.name,a.family.replace("|"," · ")])))}
    ${sec("Regional designs no division carries under that number yet — kept in the lineup table only",R.unplaced.length,
      tbl(["Plan #","Plan","Collection"],R.unplaced.map(u=>[u.L.plan_code,u.L.plan_name,u.L.collection])))}
    ${sec("Not attached to a roster plan",R.other.length,
      tbl(["Plan #","Plan","Version","Why"],R.other.map(o=>[o.L.plan_code,o.L.plan_name,o.L.version,o.why])))}
    ${p.warnings.length?`<div class="msg err" style="margin-top:12px">${p.warnings.map(esc).join("<br>")}</div>`:""}
    <div class="acts">
      <button class="btn mini solid" id="lnGo">Apply to the database</button>
      <button class="btn mini ghost" id="lnCancel">Cancel</button>
      <span class="hint">Writes ${ln.planned.rows.length} roster rows and replaces the ${esc(p.date)} lineup (${p.rows.length} lines).</span>
    </div>`;
  $("lnCancel").onclick=()=>{ ln.parsed=ln.planned=null; $("lnOut").innerHTML=""; };
  $("lnGo").onclick=applyLineup;
}

async function applyLineup(){
  if(ln.busy) return; ln.busy=true;
  const btn=$("lnGo"); btn.disabled=true; btn.textContent="Writing…";
  const p=ln.parsed, rows=ln.planned.rows;
  try{
    log(`lineup ${p.date}: writing ${rows.length} roster rows`);
    for(let i=0;i<rows.length;i+=200){
      const { error } = await sb.from("pdb_plans").upsert(rows.slice(i,i+200), { onConflict:"division,plan_no" });
      if(error) throw new Error("pdb_plans: "+error.message);
    }
    const lrows=PdbLineup.lineupRows(p, ln.file.name);
    log(`lineup ${p.date}: replacing ${lrows.length} lineup lines`);
    const del=await sb.from("pdb_core_lineup").delete().eq("lineup_date",p.date);
    if(del.error) throw new Error("clearing lineup: "+del.error.message);
    for(let i=0;i<lrows.length;i+=300){
      const { error } = await sb.from("pdb_core_lineup").insert(lrows.slice(i,i+300));
      if(error) throw new Error("pdb_core_lineup: "+error.message);
    }
    log(`  done — ${ln.planned.report.matched.length} tagged, ${ln.planned.report.added.length} added`);
    btn.textContent="Applied"; 
    $("lnOut").insertAdjacentHTML("beforeend",`<div class="msg ok" style="margin-top:12px">Applied. Open the app's Divisions tab to see plans side by side.</div>`);
  }catch(e){
    log("  FAILED lineup: "+(e&&e.message||e));
    btn.disabled=false; btn.textContent="Apply to the database";
    $("lnOut").insertAdjacentHTML("beforeend",`<div class="msg err" style="margin-top:12px">${esc(e&&e.message||e)} — nothing after this point was written. Fix it and apply again; it is safe to repeat.</div>`);
  }finally{ ln.busy=false; }
}
