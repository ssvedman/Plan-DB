/* ============================================================
   Plan-DB — app
   Login-gated; viewer access and up can read.
   Floor plans grouped by series, with cost per sq ft and extended cost.
   ============================================================ */
"use strict";
const CFG = window.APP_CONFIG;
const SERIES = window.PDB_SERIES || {};
const SERIES_ORDER = window.PDB_SERIES_ORDER || [];
const SERIES_LABEL = window.PDB_SERIES_LABEL || {};
/* Chip facets and sliders are declared once. Everything that filters, counts,
   labels or clears them walks these lists, so adding a dimension is one entry
   rather than a branch in six places. */
/* `noun` is [singular, plural] for the dropdown label ("All statuses",
   "1 status selected"). Spelled out rather than derived: appending "s" to the
   heading gives "bedss", "statuss" and other nonsense. */
const FACETS = [
  { key:"site",   label:"Homesite", noun:["homesite","homesites"], get:p=>p.site },
  { key:"tier",   label:"Tier",     noun:["tier","tiers"],         get:p=>p.tier,   fmt:v=>"Tier "+v },
  { key:"beds",   label:"Beds",     noun:["bed count","bed counts"],   get:p=>p.beds,   fmt:v=>v+" bed" },
  { key:"baths",  label:"Baths",    noun:["bath count","bath counts"], get:p=>p.baths,  fmt:v=>v+" bath" },
  { key:"sty",    label:"Stories",  noun:["storey count","storey counts"], get:p=>p.sty, fmt:v=>v+" level"+(v==="1"?"":"s") },
  { key:"status", label:"Status",   noun:["status","statuses"],     get:p=>p.status, fmt:v=>(STATUS[v]||v) }
];
/* Plan Master status codes, spelled out. Unknown codes fall through as-is. */
const STATUS = { ACT:"Active", COM:"Coming", DFW:"Deferred", DSL:"Discontinued sale",
                 SHL:"Shell", DIS:"Discontinued", TMP:"Temporary", MDL:"Model" };
const SLIDERS = [
  { key:"cpsf",  label:"Cost per sq ft",  step:0.5,  get:p=>p.cpsf,  fmt:v=>money2(v) },
  { key:"ext",   label:"Extended cost",   step:500,  get:p=>p.ext,   fmt:v=>money(v) },
  { key:"price", label:"Sales price",     step:5000, get:p=>p.price, fmt:v=>money(v) },
  { key:"sqft",  label:"Square feet",     step:25,   get:p=>p.sqft,  fmt:v=>sqftF(v)+" sf" }
];
const DEMO = !CFG.SUPABASE_URL || CFG.SUPABASE_URL.startsWith("YOUR_");
let sb = null;
if (!DEMO && window.supabase) sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, storageKey:"lennar-vendor-portal-auth" }
});
/* Sign out in one app signs out of all of them — same shared storageKey and
   origin, so clearing the session raises a storage event here. */
if (!DEMO && window.supabase) {
  window.addEventListener("storage", e => { if (e.key === "lennar-vendor-portal-auth" && !e.newValue) location.reload(); });
}

const DIVISIONS = (CFG.DIVISIONS && CFG.DIVISIONS.length)
  ? CFG.DIVISIONS : [{ key:"orlando", label:"Orlando", code:"OLH" }];
function divOf(k){ return DIVISIONS.find(d=>d.key===k) || DIVISIONS[0]; }
/* The chosen division is remembered per person, not per browser profile, so
   two people sharing a machine don't inherit each other's. */
function divKey(){ return "pdb_div:"+lc(state.email||"anon"); }
function loadDiv(){
  try{ const v=localStorage.getItem(divKey());
    if(v && DIVISIONS.some(d=>d.key===v)) return v; }catch(e){}
  return DIVISIONS[0].key;
}

const state = {
  email:null, role:"viewer", view:"plans",
  division:DIVISIONS[0].key,
  rows:[], plans:{}, datasets:[], dataset:null,
  cisJde:null,                       // JDEs Community-DB actually holds
  cmp:null,                          // dataset the current one is measured against
  hist:[],                           // every dataset, few columns — drives deltas and trends
  basis:"tax",                       // "tax" = with tax, "net" = untaxed
  q:"", sort:"name", sortDir:1,
  series:{},                         // series key -> included? (empty = all)
  site:{}, tier:{}, beds:{}, baths:{}, sty:{}, status:{},   // chip facets, see FACETS
  options:[],                        // per-plan options (small, loaded up front)
  cc:{}, ccBusy:{},                  // cost codes per plan — fetched on demand
  ccv:null, ccvBusy:false, ccvErr:null,   // cost-code variance (server-aggregated)
  ccd:{}, ccdBusy:{},                // one code's plan-by-plan detail, on demand
  ccSort:"spread", ccq:"",
  showShells:false,
  showAwaiting:true,                 // roster plans with no cost yet — shown by default
  showIncomplete:false,              // rows whose figures look unreliable
  rng:{},                            // key -> {min,max,lo,hi} live slider state
  open:{},                           // plan_no -> drill-down expanded?
  openComm:{}, openCode:{},          // community / cost-code drill-downs
  trendSeries:{}, trendTouched:false,// series key -> line shown on the trend chart?
  trendLFL:true                      // chart only homes priced in every month
};
const $  = id => document.getElementById(id);
const esc = s => String(s==null?"":s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lc  = s => String(s==null?"":s).toLowerCase();
const num = v => (typeof v==="number" && isFinite(v)) ? v : (v==null||v===""?null:(isFinite(+v)?+v:null));
const money = v => v==null?"—":"$"+Math.round(v).toLocaleString();
const money2= v => v==null?"—":"$"+v.toFixed(2);
const sqftF = v => v==null?"—":Math.round(v).toLocaleString();
const pctF = v => v==null?"—":(v*100).toFixed(1)+"%";
const signPct = v => v==null?"—":(v>0?"+":v<0?"−":"")+Math.abs(v*100).toFixed(1)+"%";
const signMoney2 = v => v==null?"—":(v>0?"+":v<0?"−":"")+"$"+Math.abs(v).toFixed(2);
const signMoney = v => v==null?"—":(v>0?"+":v<0?"−":"")+"$"+Math.round(Math.abs(v)).toLocaleString();
/* Search is matched twice: once literally, and once with every separator
   stripped, so "h-006", "h 006" and "H006" are the same query — and an old
   plan number typed the old way still finds the plan that carries it as an
   alias. */
const norm = s => lc(s).replace(/[^a-z0-9]+/g,"");
const mean = v => v.length ? v.reduce((a,b)=>a+b,0)/v.length : null;

/* ---------------- modal dialogs (shared pattern with the other apps) ------- */
function openModal({title, body, buttons}){
  return new Promise(resolve=>{
    const scrim=document.createElement("div"); scrim.className="modal-scrim";
    const card=document.createElement("div"); card.className="modal-card";
    card.innerHTML=`<div class="modal-h">${esc(title||"")}</div><div class="modal-b">${body||""}</div><div class="modal-f"></div>`;
    const foot=card.querySelector(".modal-f");
    const close=v=>{ document.removeEventListener("keydown",onKey); scrim.remove(); resolve(v); };
    (buttons||[]).forEach(b=>{ const btn=document.createElement("button");
      btn.className="modal-btn"+(b.primary?" primary":"")+(b.danger?" danger":"");
      btn.textContent=b.label; btn.onclick=()=>close(typeof b.value==="function"?b.value(card):b.value);
      foot.appendChild(btn); });
    scrim.appendChild(card); document.body.appendChild(scrim);
    scrim.addEventListener("mousedown",e=>{ if(e.target===scrim) close(undefined); });
    const onKey=e=>{ if(e.key==="Escape") close(undefined); };
    document.addEventListener("keydown",onKey);
  });
}
function uiAlert(message,title){ return openModal({title:title||"Plan-DB",body:`<p>${esc(message)}</p>`,buttons:[{label:"OK",value:true,primary:true}]}); }

/* theme */
(function(){ try{ const t=localStorage.getItem("cdb_theme"); if(t) document.documentElement.setAttribute("data-theme",t); }catch(e){} })();
function toggleTheme(){ const d=document.documentElement.getAttribute("data-theme")==="dark"; const n=d?"light":"dark";
  document.documentElement.setAttribute("data-theme",n); try{localStorage.setItem("cdb_theme",n);}catch(e){}
  const b=$("themeBtn"); if(b) b.textContent=n==="dark"?"Light":"Dark"; }

/* ---------------- AUTH ---------------- */
function authMsg(t,k){ const m=$("authMsg"); m.className="msg "+(k||"info"); m.textContent=t; }
function clearAuth(){ const m=$("authMsg"); m.className="msg"; m.textContent=""; }
$("signinBtn").addEventListener("click", signIn);
$("email").addEventListener("keydown", e=>{ if(e.key==="Enter") $("password").focus(); });
$("password").addEventListener("keydown", e=>{ if(e.key==="Enter") signIn(); });

async function signIn(){
  const email=lc($("email").value.trim()), password=$("password").value; clearAuth();
  if(!email||!email.includes("@")) return authMsg("Please enter your email address.","err");
  if(!email.endsWith(CFG.ALLOWED_DOMAIN)) return authMsg("Access is limited to "+CFG.ALLOWED_DOMAIN+" addresses.","err");
  if(!password) return authMsg("Please enter your password.","err");
  $("signinBtn").disabled=true; $("signinBtn").textContent="Signing in…";
  try{
    if(DEMO){ await new Promise(r=>setTimeout(r,200)); return enterApp(email); }
    const {error}=await sb.auth.signInWithPassword({email,password}); if(error) throw error;
    enterApp(email);
  }catch(e){ const m=(e&&e.message)||"";
    authMsg(/invalid login credentials/i.test(m)?"Incorrect email or password.":
      /email not confirmed/i.test(m)?"Your account isn't activated yet — contact the admin.":(m||"Sign-in failed."),"err");
  }finally{ $("signinBtn").disabled=false; $("signinBtn").textContent="Sign in"; }
}
async function checkSession(){ if(DEMO||!sb) return;
  const {data}=await sb.auth.getSession();
  if(data&&data.session&&data.session.user) enterApp(data.session.user.email);
  sb.auth.onAuthStateChange((_e,s)=>{ if(s&&s.user) enterApp(s.user.email); });
}
async function logout(){ if(!DEMO&&sb){ try{ await sb.auth.signOut({scope:"global"}); }catch(e){}
  try{ localStorage.removeItem("lennar-vendor-portal-auth"); }catch(e){} } location.reload(); }

/* Recovery links are issued by the hub and land there. If someone arrives
   with a token anyway, send them to the hub to redeem it. */
function initRecovery(){
  const m=(location.hash||"").match(/[#&]recover=([^&]+)/);
  if(!m) return false;
  location.replace((CFG.BLUEPRINT_URL||"/")+"#recover="+m[1]+"&pool=cdb");
  return true;
}

let entered=false;
async function enterApp(email){
  if(entered) return; entered=true;
  state.email=lc(email);
  state.role=CFG.DEFAULT_ROLE||"viewer";
  if(!DEMO&&sb){ try{ const {data}=await sb.from("cdb_app_roles").select("role").eq("email",state.email).maybeSingle();
    if(data&&data.role) state.role=data.role; }catch(e){} }
  $("auth").classList.add("hidden"); $("app").classList.remove("hidden");
  $("userChip").innerHTML=esc(state.email)+` <span class="role-tag">${esc(state.role)}</span>`;
  $("themeBtn").textContent=document.documentElement.getAttribute("data-theme")==="dark"?"Light":"Dark";
  state.division=loadDiv();
  wireChrome();
  await loadCisIndex();
  await loadAll();
  render();
}
/* Which communities the sibling app actually holds. Plan-DB covers divisions
   Community-DB does not, so linking on the strength of a JDE alone would put a
   button on rows that lead nowhere. One small query settles it; if it fails,
   no buttons rather than broken ones. */
async function loadCisIndex(){
  state.cisJde=new Set();
  if(DEMO||!sb||!CFG.COMMUNITY_DB_URL) return;
  try{
    const { data,error } = await sb.from("cdb_cis").select("jde").not("jde","is",null);
    if(error) throw error;
    (data||[]).forEach(r=>{ const j=String(r.jde||"").trim(); if(j) state.cisJde.add(j); });
  }catch(e){ console.error(e); }
}
/* Switching division reloads everything that is scoped to one: the roster, the
   months, the costs and every cached aggregate. Nothing from the old division
   may survive into the new one. */
async function setDivision(k){
  if(!k || k===state.division || !DIVISIONS.some(d=>d.key===k)) return;
  state.division=k;
  try{ localStorage.setItem(divKey(), k); }catch(e){}
  state.dataset=null; state.cmp=null; state.datasets=[]; state.hist=[]; histIndex=null;
  state.rng={}; state.open={}; state.openComm={}; state.openCode={};
  state.cc={}; state.ccBusy={}; state.ccv=null; state.ccd={}; state.ccvErr=null;
  state.trendSeries={}; state.trendTouched=false;
  clearAllFilters(true);
  await loadAll();
  render();
}
function wireChrome(){
  $("logoutBtn").onclick=logout; $("themeBtn").onclick=toggleTheme;
  $("homeLogo").onclick=()=>{ state.view="plans"; setTab(); render(); };
  $("tabs").querySelectorAll(".tab").forEach(t=>t.onclick=()=>{ state.view=t.dataset.view; setTab(); render(); });
  $("basisToggle").querySelectorAll(".mode").forEach(b=>b.onclick=()=>{
    if(state.basis===b.dataset.basis) return;
    state.basis=b.dataset.basis;
    $("basisToggle").querySelectorAll(".mode").forEach(x=>x.classList.toggle("on",x===b));
    state.rng={};                       // cost ranges are basis-specific — recompute
    render();
  });
}
function setTab(){ $("tabs").querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===state.view)); }
/* The filter rail must never extend past the bottom of the window, or its last
   filters are unreachable. Its top offset is NOT constant: at the top of the
   page the rail starts below the toolbar row, and only rises to the sticky
   offset once you scroll. Sizing it from the sticky offset alone left it
   hanging off-screen at scroll-top. So measure the live top and cap the height
   from that, on scroll as well as resize.

   No feedback loop: a sticky element's top is min(natural, stickyOffset) and
   does not depend on its own height. */
function syncRailTop(){
  const tb=document.querySelector(".topbar");
  if(tb) document.documentElement.style.setProperty("--railtop", Math.round(tb.getBoundingClientRect().height)+"px");
  const el=document.getElementById("filters");
  if(!el) return;
  const top=el.getBoundingClientRect().top;
  el.style.maxHeight=Math.max(240, Math.round(window.innerHeight - top - 16))+"px";
}
window.addEventListener("resize", syncRailTop);
window.addEventListener("scroll", syncRailTop, {passive:true});
/* One global listener rather than one per dropdown, since the rail is rebuilt
   on every render and per-instance listeners would accumulate. */
(function(){
  document.addEventListener("click", ()=>closeAllMsel(null));
  document.addEventListener("keydown", e=>{ if(e.key==="Escape") closeAllMsel(null); });
})();

/* ---------------- DATA ---------------- */
async function loadAll(){
  if(DEMO||!sb){ state.rows=[]; state.names={}; return; }
  try{
    const { data:pl } = await sb.from("pdb_plans").select("*").eq("division",state.division);
    state.plans={}; (pl||[]).forEach(r=>{ state.plans[r.plan_no]=r; });
  }catch(e){ console.error(e); state.plans={}; }
  try{
    const { data:ds } = await sb.from("pdb_plan_costs").select("dataset").eq("division",state.division);
    state.datasets=[...new Set((ds||[]).map(r=>r.dataset))].sort().reverse();
  }catch(e){ state.datasets=[]; }
  /* Opens on the newest month. An older one can be chosen, but the app says so
     loudly while it is — the failure mode worth designing against is reading a
     stale month as if it were current, not the inconvenience of switching. */
  state.dataset = state.datasets[0] || window.PDB_DEFAULT_DATASET || null;
  state.cmp     = priorTo(state.dataset);
  await loadHist();
  await loadCosts();
}
/* `datasets` runs newest first, so the month before any given one is the next
   entry along. The oldest month loaded has nothing before it and shows no
   trend rather than borrowing a later month and inverting the sign. */
function priorTo(ds){
  const i=state.datasets.indexOf(ds);
  return i<0 ? null : (state.datasets[i+1] || null);
}
function isCurrent(){ return !state.datasets.length || state.dataset===state.datasets[0]; }
/* Every route into a different month goes through here — the picker, the
   "back to current" button, and clicking a month on the chart — so none of
   them can forget to drop the caches that belong to the month being left. */
async function setDataset(ds){
  if(!ds || ds===state.dataset) return;
  state.dataset = ds;
  state.cmp     = priorTo(ds);
  state.rng     = {};                 // cost bounds are per month
  state.ccv=null; state.ccd={}; state.ccvErr=null; state.openCode={};
  state.cc={}; state.ccBusy={};
  await loadCosts();
  render();
}
/* The month strip, under the tabs rather than in the toolbar: it scopes every
   view, so it belongs to the page, not to one table. */
function renderScope(){
  const el=$("scope"); if(!el) return;
  const manyDivs=DIVISIONS.length>1, manyMonths=state.datasets.length>1;
  if(!manyDivs && !manyMonths){ el.classList.add("hidden"); el.innerHTML=""; return; }
  el.classList.remove("hidden");
  const stale=manyMonths && !isCurrent();
  el.classList.toggle("stale", stale);
  const note = stale
    ? `This is not the current month — ${esc(dsLabel(state.datasets[0]))} is.`
    : !state.datasets.length ? `No cost data loaded for ${esc(divOf(state.division).label)} yet.`
    : state.cmp ? `Current month. Trend compares it with ${esc(dsLabel(state.cmp))}.`
                : `${esc(dsLabel(state.dataset))} — the only month loaded, so there is no trend yet.`;
  el.innerHTML=`<div class="scope-in">
      ${manyDivs?`<label class="scope-l" for="divPick">Division</label>
      <select class="scope-sel" id="divPick">${DIVISIONS.map(d=>
        `<option value="${esc(d.key)}"${d.key===state.division?" selected":""}>${esc(d.label)}</option>`).join("")}</select>`:""}
      ${manyMonths?`<label class="scope-l" for="dsPick">Month</label>
      <select class="scope-sel" id="dsPick">${state.datasets.map((d,i)=>
        `<option value="${esc(d)}"${d===state.dataset?" selected":""}>${esc(dsLabel(d))}${i===0?" (current)":""}</option>`).join("")}</select>`:""}
      <span class="scope-note">${note}</span>
      ${stale?`<button class="btn mini ghost" id="dsNow">Back to ${esc(dsLabel(state.datasets[0]))}</button>`:""}
    </div>`;
  if($("divPick")) $("divPick").onchange=e=>setDivision(e.target.value);
  if($("dsPick"))  $("dsPick").onchange=e=>setDataset(e.target.value);
  if($("dsNow"))   $("dsNow").onclick=()=>setDataset(state.datasets[0]);
}
/* Deltas and the trend chart need every month at once, but only a handful of
   columns. Asking for those columns keeps the whole history smaller than one
   month of the full table, so it loads up front and nothing else has to go
   back to the network to compare two periods. */
async function loadHist(){
  state.hist=[];
  if(DEMO||!sb) return;
  const COLS="dataset,comm_num,community,jde,plan_no,elev,sqft,cpsf,cpsf_tax,ext_price,ext_price_tax,base_price,incomplete,kind";
  try{
    const PAGE=1000;
    for(let from=0;;from+=PAGE){
      const { data,error } = await sb.from("pdb_plan_costs").select(COLS)
        .eq("division",state.division).range(from, from+PAGE-1);
      if(error) throw error;
      state.hist=state.hist.concat(data||[]);
      if(!data || data.length<PAGE) break;
    }
  }catch(e){ console.error(e); state.hist=[]; }
}
/* Supabase caps a select at 1000 rows by default; page through so a year of
   datasets doesn't silently truncate. */
/* Cost codes are tens of thousands of rows, so they are never loaded up front —
   only for a plan the user actually opens, and cached per plan. */
async function loadCostCodes(plan){
  if(state.cc[plan] || state.ccBusy[plan]) return;
  if(DEMO||!sb||!state.dataset){ state.cc[plan]=[]; return; }
  state.ccBusy[plan]=true;
  try{
    const { data,error } = await sb.from("pdb_cost_codes").select("*")
      .eq("division",state.division).eq("dataset",state.dataset).eq("plan_no",plan);
    if(error) throw error;
    state.cc[plan]=data||[];
  }catch(e){ console.error(e); state.cc[plan]=[]; }
  finally{ state.ccBusy[plan]=false; }
}
async function loadOptions(){
  state.options=[];
  if(DEMO||!sb||!state.dataset) return;
  try{
    const PAGE=1000;
    for(let from=0;;from+=PAGE){
      const { data,error } = await sb.from("pdb_plan_options").select("*")
        .eq("division",state.division).eq("dataset",state.dataset).range(from,from+PAGE-1);
      if(error) throw error;
      state.options=state.options.concat(data||[]);
      if(!data || data.length<PAGE) break;
    }
  }catch(e){ console.error(e); state.options=[]; }
}
async function loadCosts(){
  state.rows=[]; state.cc={};
  if(DEMO||!sb||!state.dataset) return;
  try{
    const PAGE=1000;
    for(let from=0;;from+=PAGE){
      const { data,error } = await sb.from("pdb_plan_costs").select("*")
        .eq("division",state.division).eq("dataset",state.dataset)
        .range(from, from+PAGE-1);
      if(error) throw error;
      state.rows=state.rows.concat(data||[]);
      if(!data || data.length<PAGE) break;
    }
  }catch(e){ console.error(e); state.rows=[]; }
  await loadOptions();
}
const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
function dsLabel(d){
  const m=String(d||"").match(/^(\d{4})-(\d{2})$/); if(!m) return d;
  return MONTHS[+m[2]-1]+" "+m[1];
}
function dsShort(d){
  const m=String(d||"").match(/^(\d{4})-(\d{2})$/); if(!m) return d;
  return MONTHS[+m[2]-1].slice(0,3)+" "+m[1].slice(2);
}

/* ---------------- ROLLUP ----------------
   One row per plan number. The source has a row per community x elevation, so
   a plan carries a cost RANGE across the communities that offer it; the
   headline figure is the average of those, which is what sorting and the
   sliders use. Unpriced rows (status DFW, or a plan not yet bid in that
   community) contribute nothing but still count toward "offered in N". */
function costOf(r){ return state.basis==="tax" ? num(r.ext_price_tax) : num(r.ext_price); }
function cpsfOf(r){ return state.basis==="tax" ? num(r.cpsf_tax)      : num(r.cpsf); }

/* ---------------- MONTH OVER MONTH ----------------
   Two months rarely price the same set of homes: communities open, plans are
   added, others stop being offered. Comparing each month's own average would
   read that churn as a price movement. So a delta is computed only over the
   rows present in BOTH months, matched on community + plan + elevation, and
   the count of matched rows is reported alongside so a thin comparison is
   visible as one. */
function histKey(r){ return (r.comm_num||"")+"|"+(r.plan_no||"")+"|"+(r.elev||""); }
function histUsable(r){
  if(r.incomplete && !state.showIncomplete) return false;
  return cpsfOf(r)!=null && costOf(r)!=null;
}
/* dataset -> plan_no -> Map(key -> row), built once per render pass. */
let histIndex=null, histStamp="";
function histBy(){
  const stamp=state.basis+"|"+state.showIncomplete+"|"+state.hist.length;
  if(histIndex && histStamp===stamp) return histIndex;
  const idx=new Map();
  state.hist.forEach(r=>{
    if(!histUsable(r)) return;
    let d=idx.get(r.dataset); if(!d){ d=new Map(); idx.set(r.dataset,d); }
    let p=d.get(r.plan_no); if(!p){ p=new Map(); d.set(r.plan_no,p); }
    p.set(histKey(r), r);
  });
  histIndex=idx; histStamp=stamp;
  return idx;
}
/* Like-for-like movement for one plan between two datasets. */
function planDelta(plan, from, to){
  if(!from || !to || from===to) return null;
  const idx=histBy();
  const A=(idx.get(from)||new Map()).get(plan), B=(idx.get(to)||new Map()).get(plan);
  if(!A||!B) return null;
  const cpA=[],cpB=[],exA=[],exB=[];
  A.forEach((ra,k)=>{ const rb=B.get(k); if(!rb) return;
    cpA.push(cpsfOf(ra)); cpB.push(cpsfOf(rb)); exA.push(costOf(ra)); exB.push(costOf(rb)); });
  if(!cpA.length) return null;
  const a=mean(cpA), b=mean(cpB), xa=mean(exA), xb=mean(exB);
  return { n:cpA.length, from:a, to:b, d:b-a, pct:a?(b-a)/a:null,
           extFrom:xa, extTo:xb, extD:xb-xa, extPct:xa?(xb-xa)/xa:null,
           basketFrom:A.size, basketTo:B.size };
}
/* Every dataset's average cost per sq ft for one plan — the line the chart
   draws. Unlike the delta this is each month on its own terms, since a line
   with a hole in it is worse than one whose basket shifts slightly. */
function planSeriesOverTime(plan){
  const idx=histBy();
  return state.datasets.slice().sort().map(ds=>{
    const p=(idx.get(ds)||new Map()).get(plan);
    if(!p||!p.size) return { ds, cpsf:null, ext:null, n:0 };
    const cp=[],ex=[]; p.forEach(r=>{ cp.push(cpsfOf(r)); ex.push(costOf(r)); });
    return { ds, cpsf:mean(cp), ext:mean(ex), n:p.size };
  });
}
function seriesOf(plan){ const p=state.plans[plan]; return (p&&p.series)||"LEGACY"; }
function seriesLabel(k){ return SERIES_LABEL[k] || k; }

/* Every plan on the roster appears, whether or not this dataset priced it.
   A roster-only plan shows its roster sq ft and "awaiting pricing". */
function planList(){
  const by=new Map();
  const seed=p=>{
    const m=state.plans[p]||{};
    return { plan:p, name:m.name||"", series:m.series||"LEGACY", site:m.homesite||"", tier:m.tier||"",
             origin:m.series_origin||"unassigned", pending:!!m.plan_pending,
             kind:(m.series==="SHELL")?"shell":"home", rows:[], comms:new Set(),
             alias:m.core_alias||"",
             sqft:num(m.sqft), beds:m.beds||"", baths:m.baths||"", sty:m.levels||"",
             footprint:m.footprint||"", permit:m.permit_ready||"", matrixComm:m.matrix_community||"" };
  };
  Object.keys(state.plans).forEach(p=>by.set(p,seed(p)));
  state.rows.forEach(r=>{
    const p=r.plan_no; let e=by.get(p);
    if(!e){ e=seed(p); if(!e.name) e.name=r.plan_name||""; by.set(p,e); }
    e.rows.push(r);
    if(r.comm_num) e.comms.add(r.comm_num);
    const s=num(r.sqft); if(s && (e.sqft==null || s>e.sqft)) e.sqft=s;
    if(!e.beds)  e.beds=r.beds||"";
    if(!e.baths) e.baths=r.baths||"";
    if(!e.sty)   e.sty=r.sty||"";
    if(r.kind==="shell") e.kind="shell";
  });
  const out=[];
  by.forEach(e=>{
    const priced=e.rows.filter(r=>costOf(r)!=null && cpsfOf(r)!=null && !(r.incomplete && !state.showIncomplete));
    const cp=priced.map(cpsfOf), ex=priced.map(costOf);
    e.n=e.rows.length; e.nComm=e.comms.size; e.nPriced=priced.length;
    e.cpsf = cp.length ? cp.reduce((a,b)=>a+b,0)/cp.length : null;
    e.cpsfLo = cp.length ? Math.min(...cp) : null;
    e.cpsfHi = cp.length ? Math.max(...cp) : null;
    e.ext  = ex.length ? ex.reduce((a,b)=>a+b,0)/ex.length : null;
    e.extLo= ex.length ? Math.min(...ex) : null;
    e.extHi= ex.length ? Math.max(...ex) : null;
    // Sales price comes from the same rows as cost, so margin is like-for-like.
    // It follows the tax toggle: margin against taxed cost is the stricter view.
    const pr=e.rows.map(r=>num(r.base_price)).filter(v=>v&&v>0);
    e.price  = pr.length ? pr.reduce((a,b)=>a+b,0)/pr.length : null;
    e.priceLo= pr.length ? Math.min(...pr) : null;
    e.priceHi= pr.length ? Math.max(...pr) : null;
    e.gm     = (e.price!=null && e.ext!=null) ? e.price-e.ext : null;
    e.gmPct  = (e.gm!=null && e.price) ? e.gm/e.price : null;
    const st=new Map();
    e.rows.forEach(r=>{ if(r.status) st.set(r.status,(st.get(r.status)||0)+1); });
    e.status = st.size ? [...st.entries()].sort((a,b)=>b[1]-a[1])[0][0] : "";
    e.incomplete = e.rows.some(r=>r.incomplete);
    e.awaiting = e.rows.length===0;      // on the roster, not in this dataset
    e.delta = planDelta(e.plan, state.cmp, state.dataset);
    out.push(e);
  });
  return out;
}

/* ---------------- FILTERING ---------------- */
/* The population the sliders describe: everything the kind toggles admit,
   before any facet or slider narrowing. */
function inScope(all){
  return all.filter(p=>(state.showShells||p.kind!=="shell") && (state.showAwaiting||!p.awaiting));
}
function rangeDefs(all){
  const out={};
  SLIDERS.forEach(s=>{ const v=all.map(s.get).filter(x=>x!=null);
    out[s.key]=v.length?{min:Math.min(...v),max:Math.max(...v)}:{min:0,max:0}; });
  return out;
}
/* Slider bounds come from the data and shift whenever the basis, dataset or a
   checkbox changes what's in scope. `touched` records whether the USER moved a
   thumb — without it there's no way to tell a deliberately narrowed window from
   one that only looks narrow because the bounds moved underneath it, and an
   untouched slider silently starts excluding rows. */
function syncRanges(all){
  const d=rangeDefs(all);
  SLIDERS.forEach(({key:k,step})=>{
    const min=Math.floor(d[k].min/step)*step, max=Math.ceil(d[k].max/step)*step;
    const cur=state.rng[k];
    if(!cur){ state.rng[k]={min,max,lo:min,hi:max,step,touched:false}; return; }
    if(cur.min===min && cur.max===max) return;
    cur.min=min; cur.max=max; cur.step=step;
    if(cur.touched){ cur.lo=Math.min(Math.max(cur.lo,min),max); cur.hi=Math.min(Math.max(cur.hi,min),max); }
    else { cur.lo=min; cur.hi=max; }
  });
}
/* Only a slider the user actually moved may exclude a plan that has no value
   for it — otherwise enabling "unpriced" would show nothing. */
function rngActive(k){ const r=state.rng[k]; return !!(r && r.touched && (r.lo>r.min || r.hi<r.max)); }
function chipsOn(o){ return Object.values(o).some(Boolean); }
function seriesFilterOn(){ return chipsOn(state.series); }

/* `except` names one facet to ignore, so a chip can be labelled with the number
   of plans it would actually reveal — every other filter still applied. Without
   that, a chip advertises plans the list then refuses to show. */
function filtered(all, except){
  const q=lc(state.q).trim();
  const on=seriesFilterOn();
  return all.filter(p=>{
    if(p.kind==="shell" && !state.showShells) return false;
    if(p.awaiting && !state.showAwaiting) return false;
    if(on && except!=="series" && !state.series[p.series]) return false;
    for(const f of FACETS){
      if(except===f.key || !chipsOn(state[f.key])) continue;
      if(!state[f.key][f.get(p)||"—"]) return false;
    }
    for(const s of SLIDERS){
      const r=state.rng[s.key]; if(!r) continue;
      const v=s.get(p);
      if(v==null){ if(rngActive(s.key)) return false; continue; }
      if(v<r.lo-1e-9 || v>r.hi+1e-9) return false;
    }
    if(q && !matchesQuery(p,q)) return false;
    return true;
  });
}
/* A plan is searchable by its own number, its name, the older number it
   replaced (`core_alias`), its series, homesite, and every community that
   prices it. Matched literally and again with separators stripped, so the way
   someone types a plan number doesn't decide whether they find it. */
function planHay(p){
  return [p.plan,p.name,p.alias,seriesLabel(p.series),p.site,p.matrixComm,
          ...p.rows.map(r=>r.community), ...p.rows.map(r=>r.jde),
          ...p.rows.map(r=>r.plan_name)].filter(Boolean).join(" ");
}
function matchesQuery(p,q){
  const hay=planHay(p);
  if(lc(hay).includes(lc(q))) return true;
  const nq=norm(q);
  return !!nq && norm(hay).includes(nq);
}
/* True when the query only found this plan through the number it used to
   carry — worth saying out loud, since the row shows the new number. */
function aliasHit(p,q){
  if(!q||!p.alias) return false;
  const nq=norm(q);
  if(!nq || norm(p.plan).includes(nq) || norm(p.name||"").includes(nq)) return false;
  return norm(p.alias).includes(nq);
}
function sortPlans(list){
  const d=state.sortDir;
  const key={ name:p=>lc(p.name||p.plan), plan:p=>p.plan, cpsf:p=>p.cpsf, ext:p=>p.ext,
              price:p=>p.price, gm:p=>p.gmPct, sqft:p=>p.sqft, comms:p=>p.nComm,
              delta:p=>p.delta?p.delta.pct:null
            }[state.sort] || (p=>lc(p.name||p.plan));
  return list.slice().sort((a,b)=>{
    const x=key(a), y=key(b);
    if(x==null && y==null) return 0;
    if(x==null) return 1;            // unpriced always sinks, regardless of direction
    if(y==null) return -1;
    if(typeof x==="string") return d*x.localeCompare(y);
    return d*(x-y);
  });
}

/* ---------------- RENDER ---------------- */
function render(){
  syncRailTop();
  const all=planList();
  syncRanges(inScope(all));
  const list=sortPlans(filtered(all));
  $("cPlans").textContent  = filtered(all).length;
  $("cSeries").textContent = new Set(filtered(all,"series").map(p=>p.series)).size;
  $("cComms").textContent  = new Set(state.rows.map(r=>r.comm_num).filter(Boolean)).size;
  /* With no month picker in the header this is the only thing that says which
     month is on screen and what the trend is measured against, so it says
     both. */
  $("footMeta").textContent = state.rows.length
    ? [divOf(state.division).label, dsLabel(state.dataset),
       state.cmp?"trend vs "+dsLabel(state.cmp):null,
       state.rows.length.toLocaleString()+" rows",
       state.basis==="tax"?"with tax":"untaxed"].filter(Boolean).join(" · ")
    : "";
  const sub=document.querySelector(".title .sub");
  if(sub) sub.textContent=divOf(state.division).label+" Division";
  const tt=$("tTrend"); if(tt) tt.classList.toggle("hidden", state.datasets.length<2);
  renderScope();
  const a=$("viewArea");
  if(!state.rows.length && !Object.keys(state.plans).length) return renderEmpty(a);
  if(state.view==="series") return renderSeries(a, all);
  if(state.view==="communities") return renderComms(a);
  if(state.view==="trends") return renderTrends(a, all);
  if(state.view==="codes") return renderCodes(a);
  renderPlans(a, all, list);
}
function renderEmpty(a){
  const other=DIVISIONS.filter(d=>d.key!==state.division).map(d=>d.label).join(" or ");
  a.innerHTML=`<div class="panel"><div class="empty" style="padding:40px 24px;text-align:center">
    <h3 style="margin:0 0 8px;color:var(--navy)">Nothing loaded for ${esc(divOf(state.division).label)} yet</h3>
    <p class="tiny" style="max-width:520px;margin:0 auto 4px">
      Run this division's seed file in the Supabase SQL editor. Cost data is deliberately not
      bundled into the site, so the app shows nothing until the tables are populated.</p>
    ${other?`<p class="tiny" style="margin-top:10px">${esc(other)} may still have data — switch division above.</p>`:""}
  </div></div>`;
}

/* ---- the plans view: filter rail + grouped list ---- */
function renderPlans(a, all, list){
  const seriesKeys=[...new Set(all.map(p=>p.series))]
    .sort((x,y)=>{ const i=SERIES_ORDER.indexOf(x), j=SERIES_ORDER.indexOf(y);
      return (i<0?99:i)-(j<0?99:j) || String(x).localeCompare(y); });
  a.innerHTML=`
    <div class="bar">
      <input type="search" id="q" placeholder="Search plan number, name, series or community…" value="${esc(state.q)}">
      <span class="hint" id="resCount"></span>
      <span class="spacer"></span>
      <label class="hint chk"><input type="checkbox" id="chkShell" ${state.showShells?"checked":""}> Building shells</label>
      <label class="hint chk" title="Plans on the roster that this dataset hasn't priced"><input type="checkbox" id="chkAwait" ${state.showAwaiting?"checked":""}> Awaiting pricing</label>
      <label class="hint chk" title="Rows whose figures look unreliable"><input type="checkbox" id="chkIncomplete" ${state.showIncomplete?"checked":""}> Unreliable figures</label>
      <button class="btn mini ghost" id="btnXlsx">&#8681; Export</button>
    </div>
    <div class="plansplit">
      <aside class="filters" id="filters">
        <button class="btn mini ghost fresetter" id="btnReset">Reset all filters</button>
        ${SLIDERS.map(sl=>`<div class="fgroup">
          <div class="fgh">${esc(sl.label)}${(sl.key==="cpsf"||sl.key==="ext")
            ?`<span class="fgh-note">${state.basis==="tax"?"with tax":"untaxed"}</span>`:""}</div>
          <div id="rs_${sl.key}"></div>
        </div>`).join("")}
        <div class="fgroup">
          <div class="fgh">Series</div>
          ${(()=>{ const pool=filtered(all,"series");
            const opts=seriesKeys.map(k=>({k,n:pool.filter(p=>p.series===k).length}))
              .filter(o=>o.n).map(o=>({value:o.k, label:seriesLabel(o.k)+"  ("+o.n+")"}));
            return mselHTML("dd_series",["series","series"],opts,Object.keys(state.series)); })()}
        </div>
        ${FACETS.map(f=>facetDropdown(f,all)).join("")}
      </aside>
      <div class="planmain">
        <div class="sortbar">
          <span class="hint">Sort</span>
          ${[["name","Plan"],["cpsf","Cost / sq ft"],["ext","Extended cost"],["price","Sales price"],["gm","Margin"],["sqft","Sq ft"],["comms","Communities"]]
            .concat(state.cmp?[["delta","Trend"]]:[])
            .map(([k,l])=>`<button class="sortb${state.sort===k?" on":""}" data-sort="${k}">${l}${state.sort===k?`<i>${state.sortDir>0?"▲":"▼"}</i>`:""}</button>`).join("")}
        </div>
        <div id="planList"></div>
      </div>
    </div>`;

  $("q").addEventListener("input",e=>{ state.q=e.target.value; repaint(); });
  $("chkShell").onchange=e=>{ state.showShells=e.target.checked; state.rng={}; render(); };
  $("chkAwait").onchange=e=>{ state.showAwaiting=e.target.checked; render(); };
  $("chkIncomplete").onchange=e=>{ state.showIncomplete=e.target.checked; state.rng={}; render(); };
  $("btnXlsx").onclick=()=>exportPlans(sortPlans(filtered(planList())));
  $("btnReset").onclick=clearAllFilters;
  const applyMsel=(bagKey,vals)=>{ const bag={}; vals.forEach(v=>{ bag[v]=true; }); state[bagKey]=bag; render(); };
  bindMsel("dd_series",["series","series"],v=>applyMsel("series",v));
  FACETS.forEach(f=>bindMsel("dd_"+f.key, f.noun, v=>applyMsel(f.key,v)));
  a.querySelectorAll("[data-sort]").forEach(b=>b.onclick=()=>{
    const k=b.dataset.sort;
    if(state.sort===k) state.sortDir=-state.sortDir;
    else { state.sort=k; state.sortDir = (k==="name"||k==="plan") ? 1 : 1; }
    render();
  });

  SLIDERS.forEach(sl=>rangeSlider("rs_"+sl.key, sl.key, sl.fmt));
  syncRailTop();                       // the rail exists now — cap it to the window

  // hand the list painter to the slider, which repaints only this region while
  // dragging (a full render() would rebuild the slider under the user's finger)
  repaintList = () => drawList(sortPlans(filtered(planList())));
  const repaint = repaintList;
  drawList(list);

  function drawList(rows){
    const host=$("planList"); const total=inScope(planList()).length;
    $("resCount").textContent=`${rows.length} of ${total} plans`;
    if(!rows.length){
      // "nothing matched" and "everything that matched is hidden by a checkbox"
      // are different problems; only the second one has a one-click fix.
      const wasA=state.showAwaiting, wasS=state.showShells;
      state.showAwaiting=true; state.showShells=true;
      const relaxed=filtered(planList()).length;
      state.showAwaiting=wasA; state.showShells=wasS;
      host.innerHTML=`<div class="empty" style="padding:26px;text-align:center">
        <div>No plans match these filters.</div>
        ${relaxed>0?`<div class="tiny" style="margin-top:8px">${relaxed} plan${relaxed===1?"":"s"} would match if hidden groups were shown.</div>
          <button class="btn mini ghost" id="btnRelax" style="margin-top:10px">Show awaiting pricing and building shells</button>`:""}
      </div>`;
      if($("btnRelax")) $("btnRelax").onclick=()=>{ state.showAwaiting=true; state.showShells=true; state.rng={}; render(); };
      return; }
    // group by series, in configured order
    const groups=new Map();
    rows.forEach(p=>{ if(!groups.has(p.series)) groups.set(p.series,[]); groups.get(p.series).push(p); });
    const keys=[...groups.keys()].sort((x,y)=>{ const i=SERIES_ORDER.indexOf(x), j=SERIES_ORDER.indexOf(y);
      return (i<0?99:i)-(j<0?99:j) || String(x).localeCompare(y); });
    host.innerHTML=keys.map(k=>{
      const g=groups.get(k);
      const cp=g.map(p=>p.cpsf).filter(v=>v!=null);
      const avg=cp.length?cp.reduce((a,b)=>a+b,0)/cp.length:null;
      return `<section class="sergroup">
        <div class="serhead">
          <span class="sertitle">${esc(seriesLabel(k))}</span>
          <span class="pill">${g.length} plan${g.length===1?"":"s"}</span>
          ${avg!=null?`<span class="hint">avg ${money2(avg)} / sq ft</span>`:""}
          <span class="spacer"></span>
          <span class="hint sershow">${esc((SERIES[k]&&SERIES[k].blurb)||"")}</span>
        </div>
        <table class="pt">
          <thead><tr><th class="c-plan">Plan</th><th class="c-sq">Sq ft</th><th class="c-bb">Bd / Ba</th>
            <th class="c-cp">Cost / sq ft</th><th class="c-ex">Extended cost</th>
            <th class="c-pr">Sales price</th><th class="c-gm">Margin</th>
            ${state.cmp?`<th class="c-dl" title="Like-for-like change from ${esc(dsLabel(state.cmp))} to ${esc(dsLabel(state.dataset))}">Trend</th>`:""}
            <th class="c-cm">Comms</th><th class="c-ch"></th></tr></thead>
          <tbody>${g.map(planRowHTML).join("")}</tbody>
        </table></section>`;
    }).join("");
    host.querySelectorAll("[data-plan]").forEach(tr=>tr.onclick=()=>{
      const p=tr.dataset.plan; state.open[p]=!state.open[p]; drawList(rows); });
    host.querySelectorAll("[data-cc]").forEach(b=>b.onclick=async ev=>{
      ev.stopPropagation();                     // the row toggle would close the panel
      const plan=b.dataset.cc;
      // loadCostCodes flips ccBusy synchronously before its first await, so
      // redrawing right after the call shows the loading state. Setting the
      // flag here instead would trip the loader's own re-entry guard.
      const pending=loadCostCodes(plan);
      drawList(rows);
      await pending;
      drawList(rows);
    });
  }
}
/* ---- multi-select dropdown, ported from Takeoff-Flow so the two tools behave
   the same way (same markup, classes and keyboard behaviour). `noun` is
   [singular, plural] so the button reads "1 series selected". ---- */
function mselLabel(n, noun){ return n ? `${n} ${n===1?noun[0]:noun[1]} selected` : `All ${noun[1]}`; }
function mselHTML(id, noun, options, selected){
  const sel=new Set(selected||[]);
  return `<div class="pl-dd" id="${id}">
      <button type="button" class="btn mini ghost pl-dd-btn" data-msel-btn>${esc(mselLabel(sel.size,noun))} &#9662;</button>
      <div class="pl-dd-panel hidden">
        <input type="text" class="pl-dd-search" placeholder="Search ${esc(noun[1])}…">
        <button type="button" class="linkbtn pl-dd-master">Select all</button>
        <div class="pl-dd-list">${
          options.map(o=>`<label class="msel-opt pl-dd-opt"><input type="checkbox" value="${esc(o.value)}"${sel.has(o.value)?" checked":""}> ${esc(o.label)}</label>`).join("")
          || `<div class="empty" style="padding:12px">Nothing to filter on.</div>`}</div>
        <button type="button" class="linkbtn pl-dd-clearall">Clear selection</button>
      </div>
    </div>`;
}
function bindMsel(id, noun, onChange){
  const root=$(id); if(!root) return;
  const panel=root.querySelector(".pl-dd-panel"), btn=root.querySelector("[data-msel-btn]"),
        search=root.querySelector(".pl-dd-search"), list=root.querySelector(".pl-dd-list");
  const boxes=()=>[...list.querySelectorAll("input[type=checkbox]")];
  const vis=()=>boxes().filter(b=>b.closest(".pl-dd-opt").style.display!=="none");
  const emit=()=>{ const on=boxes().filter(b=>b.checked).map(b=>b.value);
    btn.innerHTML=esc(mselLabel(on.length,noun))+" &#9662;";
    onChange(on); };
  /* The filter rail scrolls, so an absolutely-positioned panel would be clipped
     by its overflow. Anchor the panel to the button in viewport coordinates
     instead, and keep it there while the rail or page scrolls. */
  const place=()=>{
    const r=btn.getBoundingClientRect();
    const below=window.innerHeight-r.bottom-16, above=r.top-16;
    // A dropdown near the foot of the rail has no room beneath it, which left
    // the last few filters opening into a sliver. Flip above the button when
    // that side has more space.
    const up = below < 200 && above > below;
    const h  = Math.max(160, Math.min(320, up?above:below));
    panel.style.position="fixed";
    panel.style.left=Math.max(8, Math.min(r.left, window.innerWidth-328))+"px";
    panel.style.width=Math.max(r.width,240)+"px";
    panel.style.maxHeight=h+"px";
    panel.style.overflowY="auto";
    if(up){ panel.style.top="auto"; panel.style.bottom=(window.innerHeight-r.top+4)+"px"; }
    else  { panel.style.bottom="auto"; panel.style.top=(r.bottom+4)+"px"; }
  };
  const onScroll=()=>{ if(!panel.classList.contains("hidden")) place(); };
  btn.onclick=e=>{ e.stopPropagation();
    closeAllMsel(panel);                       // one open at a time
    const hid=panel.classList.toggle("hidden");
    if(!hid){ place(); search.focus();
      window.addEventListener("scroll",onScroll,true);
      window.addEventListener("resize",onScroll);
    } else {
      window.removeEventListener("scroll",onScroll,true);
      window.removeEventListener("resize",onScroll);
    }
  };
  panel.onclick=e=>e.stopPropagation();
  search.oninput=()=>{ const q=lc(search.value);
    boxes().forEach(b=>{ const o=b.closest(".pl-dd-opt"); o.style.display=(!q||lc(o.textContent).includes(q))?"":"none"; }); };
  search.onkeydown=e=>{ if(e.key==="Enter"){ e.preventDefault(); panel.classList.add("hidden"); } };
  root.querySelector(".pl-dd-master").onclick=()=>{ const v=vis(); const allOn=v.length&&v.every(b=>b.checked); v.forEach(b=>b.checked=!allOn); emit(); };
  root.querySelector(".pl-dd-clearall").onclick=()=>{ boxes().forEach(b=>b.checked=false); search.value="";
    boxes().forEach(b=>b.closest(".pl-dd-opt").style.display=""); emit(); };
  list.onchange=emit;
}
function closeAllMsel(except){
  document.querySelectorAll(".pl-dd-panel").forEach(p=>{ if(p!==except) p.classList.add("hidden"); });
}

/* One dropdown per facet. Option counts are computed with every OTHER filter
   applied, so a count never promises rows the list won't show. */
function facetDropdown(f, all){
  const {key,label,get}=f;
  const pool=filtered(all, key);
  const counts=new Map();
  pool.forEach(p=>{ const v=get(p)||"—"; counts.set(v,(counts.get(v)||0)+1); });
  if(counts.size<2) return "";
  const vals=[...counts.keys()].sort((a,b)=>{
    if(a==="—") return 1; if(b==="—") return -1;
    const na=parseFloat(a), nb=parseFloat(b);
    if(isFinite(na)&&isFinite(nb)&&na!==nb) return na-nb;
    return String(a).localeCompare(String(b));
  });
  const opts=vals.map(v=>({ value:v,
    label:(v==="—"?"Unlisted":(f.fmt?f.fmt(v):v))+"  ("+counts.get(v)+")" }));
  return `<div class="fgroup"><div class="fgh">${esc(label)}</div>
    ${mselHTML("dd_"+key, f.noun, opts, Object.keys(state[key]))}</div>`;
}
function planRowHTML(p){
  const rangeCp = (p.cpsfLo!=null && p.cpsfHi!=null && p.cpsfHi-p.cpsfLo>0.01)
    ? `<span class="rng">${money2(p.cpsfLo)}–${money2(p.cpsfHi)}</span>` : "";
  const rangeEx = (p.extLo!=null && p.extHi!=null && p.extHi-p.extLo>1)
    ? `<span class="rng">${money(p.extLo)}–${money(p.extHi)}</span>` : "";
  const open=!!state.open[p.plan];
  const tags=[
    p.incomplete?`<span class="pill warn" title="At least one community's figure looks unreliable">check</span>`:"",
    p.kind==="shell"?`<span class="pill">shell</span>`:"",
    p.origin==="inferred"?`<span class="pill inf" title="Series is a best guess, inferred from a neighbouring plan number — confirm before relying on it.">inferred</span>`:"",
    p.pending?`<span class="pill" title="Plan number not yet final">plan # TBD</span>`:"",
    p.alias?`<span class="pill${aliasHit(p,state.q)?" hit":""}" title="Same home as plan ${esc(p.alias)}${
      aliasHit(p,state.q)?" — which is what you searched for":""}">= ${esc(p.alias)}</span>`:""
  ].filter(Boolean).join(" ");
  const bb=[p.beds,p.baths].filter(Boolean).join(" / ")||"—";
  const st=p.status?`<span class="pill st-${esc(lc(p.status))}" title="${esc(STATUS[p.status]||p.status)}">${esc(p.status)}</span>`:"";
  const NCOL=state.cmp?10:9;
  if(p.awaiting){
    return `<tr class="prow await${open?" open":""}" data-plan="${esc(p.plan)}">
      <td class="c-plan"><span class="pno">${esc(p.plan)}</span>
        <span class="pnm">${esc(p.name||"—")}</span> ${tags}</td>
      <td class="c-sq">${sqftF(p.sqft)}</td>
      <td class="c-bb">${esc(bb)}</td>
      <td class="c-cp await-t" colspan="${state.cmp?6:5}">awaiting pricing<span class="rng">${
        esc([p.matrixComm&&("earmarked for "+p.matrixComm), p.permit&&("permit: "+p.permit)].filter(Boolean).join(" · "))}</span></td>
      <td class="c-ch"><span class="chev">${open?"▾":"▸"}</span></td>
    </tr>` + (open?`<tr class="pdet"><td colspan="${NCOL}">${planDetailHTML(p)}</td></tr>`:"");
  }
  return `<tr class="prow${open?" open":""}" data-plan="${esc(p.plan)}">
      <td class="c-plan"><span class="pno">${esc(p.plan)}</span>
        <span class="pnm">${esc(p.name||"—")}</span> ${st} ${tags}</td>
      <td class="c-sq">${sqftF(p.sqft)}</td>
      <td class="c-bb">${esc(bb)}</td>
      <td class="c-cp"><b>${money2(p.cpsf)}</b>${rangeCp}</td>
      <td class="c-ex"><b>${money(p.ext)}</b>${rangeEx}</td>
      <td class="c-pr">${money(p.price)}</td>
      <td class="c-gm ${p.gmPct!=null&&p.gmPct<0.6?"gm-low":""}">${pctF(p.gmPct)}${
        p.gm!=null?`<span class="rng">${money(p.gm)}</span>`:""}</td>
      ${state.cmp?`<td class="c-dl">${deltaCellHTML(p.delta)}</td>`:""}
      <td class="c-cm">${p.nComm}</td>
      <td class="c-ch"><span class="chev">${open?"▾":"▸"}</span></td>
    </tr>` + (open?`<tr class="pdet"><td colspan="${NCOL}">${planDetailHTML(p)}</td></tr>`:"");
}
/* A movement is only meaningful next to the number of homes it was measured
   over, so the count rides along in the tooltip and, where the basket is thin,
   on the face of the cell. */
function deltaCellHTML(d){
  if(!d) return `<span class="mute" title="No home priced in both months">—</span>`;
  const dir=d.pct>0.0005?"up":d.pct<-0.0005?"down":"flat";
  const tip=`${d.n} of ${d.basketTo} priced in both months · ${money2(d.from)} → ${money2(d.to)} / sq ft`;
  return `<span class="dl ${dir}" title="${esc(tip)}">${signPct(d.pct)}
      <span class="rng">${signMoney2(d.d)} / sf</span></span>`;
}
function planDetailHTML(p){
  const rows=p.rows.slice().sort((a,b)=>String(a.community).localeCompare(b.community)||String(a.elev).localeCompare(b.elev));
  const meta=[ seriesLabel(p.series), p.site&&`${p.site} homesite`, p.tier&&`tier ${p.tier}`,
    p.sty?`${p.sty} level${p.sty==="1"?"":"s"}`:"", p.beds?`${p.beds} bed`:"", p.baths?`${p.baths} bath`:"",
    p.footprint&&`footprint ${p.footprint}`, p.permit&&`permit ${p.permit}` ].filter(Boolean).join(" · ");
  if(!rows.length) return `<div class="det">
    ${meta?`<div class="detmeta">${esc(meta)}</div>`:""}
    <div class="empty" style="padding:14px">On the roster, but not priced in ${esc(dsLabel(state.dataset))}${
      p.matrixComm?` — earmarked for ${esc(p.matrixComm)}`:""}.</div></div>`;
  return `<div class="det">
    ${meta?`<div class="detmeta">${esc(meta)}</div>`:""}
    ${planTrendHTML(p)}
    <table class="dt"><thead><tr><th>Community</th><th>JDE</th><th>Elev</th><th>Sq ft</th>
      <th>Cost / sq ft</th><th>Extended cost</th><th>Sales price</th><th>Margin</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(r=>{
        const cp=cpsfOf(r), ex=costOf(r), pr=num(r.base_price);
        const gm=(pr&&ex)?(pr-ex)/pr:null;
        return `<tr${r.incomplete?' class="warnrow"':""}>
          <td>${esc(r.community||"—")}</td><td class="mono">${esc(r.jde||"")}</td>
          <td>${esc(r.elev||"—")}</td><td>${sqftF(num(r.sqft))}</td>
          <td>${money2(cp)}</td><td>${money(ex)}</td><td>${money(pr)}</td><td>${pctF(gm)}</td>
          <td>${esc(r.status||"—")}${r.incomplete?` <span class="pill warn">incomplete</span>`:""}</td>
          <td class="c-cis">${cisBtnHTML(r.jde, r.community)}</td></tr>`;
      }).join("")}</tbody></table>
    ${optionsHTML(p)}
    ${costCodeHTML(p)}
    </div>`;
}

/* ---- link out to the community's CIS ----
   Same origin and the same shared session as this app, so the link lands
   inside the record rather than on a sign-in screen. The JDE number is what
   both apps key a community on. Hidden entirely when no sibling app is
   configured, rather than rendering a button that goes nowhere. */
function cisHref(jde){
  const base=CFG.COMMUNITY_DB_URL;
  if(!base || !jde) return "";
  return base + (base.endsWith("/")?"":"/") + "#jde=" + encodeURIComponent(String(jde).trim());
}
function cisBtnHTML(jde, name){
  const href=cisHref(jde);
  if(!href) return "";
  // Plan-DB covers divisions Community-DB doesn't. A button that lands on
  // "no match" is worse than no button, so only offer it for a community the
  // other app actually holds.
  if(state.cisJde && !state.cisJde.has(String(jde).trim())) return "";
  return `<a class="cisbtn" href="${esc(href)}" target="_blank" rel="noopener"
    title="Open ${esc(name||"this community")} in Community-DB">View CIS</a>`;
}

/* ---- how this plan has moved, month by month ---- */
function planTrendHTML(p){
  if(state.datasets.length<2) return "";
  const pts=planSeriesOverTime(p.plan);
  if(pts.filter(x=>x.cpsf!=null).length<2) return "";
  const d=p.delta;
  const head=d
    ? `<span class="hint">${signPct(d.pct)} · ${signMoney2(d.d)} / sq ft vs ${esc(dsLabel(state.cmp))}
        <span class="tiny">(${d.n} home${d.n===1?"":"s"} priced in both)</span></span>`
    : `<span class="hint">no home priced in both months</span>`;
  return `<div class="detsec">
    <div class="detsec-h">Cost per sq ft over time ${head}</div>
    ${lineChart({
      labels: pts.map(x=>dsShort(x.ds)),
      lines: [{ label:p.name||p.plan, color:"var(--blue-600)", points:pts.map(x=>x.cpsf) }],
      fmtY: money2, height:150, legend:false
    })}
  </div>`;
}

/* Options priced against this plan. '1BASE' is the base package, not an add, so
   it is excluded from the list and shown as the baseline instead. Figures are
   untaxed — that is how the source carries them. */
function optionsHTML(p){
  const mine=state.options.filter(o=>o.plan_no===p.plan);
  if(!mine.length) return "";
  const adds=mine.filter(o=>String(o.opt_code).toUpperCase()!=="1BASE");
  if(!adds.length) return "";
  const by=new Map();
  adds.forEach(o=>{ const k=o.opt_code;
    if(!by.has(k)) by.set(k,{code:k,name:o.opt_name||"",v:[],comms:new Set()});
    const e=by.get(k); const a=num(o.amount); if(a!=null) e.v.push(a);
    if(o.community) e.comms.add(o.community); });
  const list=[...by.values()].map(e=>({...e,
    avg:e.v.length?e.v.reduce((a,b)=>a+b,0)/e.v.length:null,
    lo:e.v.length?Math.min(...e.v):null, hi:e.v.length?Math.max(...e.v):null }))
    .sort((a,b)=>(b.avg||0)-(a.avg||0));
  return `<div class="detsec"><div class="detsec-h">Options <span class="hint">${list.length} priced against this plan · untaxed</span></div>
    <table class="dt"><thead><tr><th>Code</th><th>Option</th><th>Avg cost</th><th>Range</th><th>Communities</th></tr></thead>
    <tbody>${list.map(e=>`<tr><td class="mono">${esc(e.code)}</td><td>${esc(e.name||"—")}</td>
      <td>${money(e.avg)}</td><td>${e.lo!=null&&e.hi!=null&&e.hi-e.lo>1?esc(money(e.lo)+"–"+money(e.hi)):"—"}</td>
      <td>${e.comms.size}</td></tr>`).join("")}</tbody></table></div>`;
}

/* Cost codes are fetched per plan on demand — there are far too many to hold
   for every plan at once. Averaged across the communities and elevations that
   priced this plan, biggest first. */
function costCodeHTML(p){
  const rows=state.cc[p.plan];
  if(state.ccBusy[p.plan]) return `<div class="detsec"><div class="hint" style="padding:10px 0">Loading cost breakdown…</div></div>`;
  if(!rows) return `<div class="detsec"><button class="btn mini ghost" data-cc="${esc(p.plan)}">Show cost breakdown by cost code</button></div>`;
  if(!rows.length) return `<div class="detsec"><div class="hint" style="padding:10px 0">No cost-code detail for this plan in ${esc(dsLabel(state.dataset))}.</div></div>`;
  const by=new Map();
  rows.forEach(r=>{ const k=r.code;
    if(!by.has(k)) by.set(k,{code:k,desc:r.description||"",v:[]});
    const v=num(r.cpsf); if(v!=null) by.get(k).v.push(v); });
  const list=[...by.values()].map(e=>({...e, avg:e.v.length?e.v.reduce((a,b)=>a+b,0)/e.v.length:0}))
    .filter(e=>e.avg>0).sort((a,b)=>b.avg-a.avg);
  const total=list.reduce((a,b)=>a+b.avg,0);
  const top=list.slice(0,20), rest=list.length-top.length;
  return `<div class="detsec"><div class="detsec-h">Cost breakdown
      <span class="hint">${list.length} cost codes · ${money2(total)} / sq ft total · untaxed · includes options</span></div>
    <table class="dt cct"><thead><tr><th>Code</th><th>Description</th><th>Cost / sq ft</th><th>Share</th></tr></thead>
    <tbody>${top.map(e=>{
      const share=total?e.avg/total:0;
      return `<tr><td class="mono">${esc(e.code)}</td><td>${esc(e.desc||"—")}</td>
        <td>${money2(e.avg)}</td>
        <td class="ccbar"><span style="width:${(share*100).toFixed(1)}%"></span><i>${pctF(share)}</i></td></tr>`;
    }).join("")}</tbody></table>
    ${rest>0?`<div class="hint" style="padding:8px 0 0">+ ${rest} smaller cost codes</div>`:""}</div>`;
}

/* ---- series overview ---- */
function renderSeries(a, all){
  const keys=[...new Set(all.map(p=>p.series))].sort((x,y)=>{
    const i=SERIES_ORDER.indexOf(x), j=SERIES_ORDER.indexOf(y);
    return (i<0?99:i)-(j<0?99:j) || String(x).localeCompare(y); });
  const shown=filtered(all,"series");
  a.innerHTML=`${filterNote(all.length, shown.length)}<div class="sercards">${keys.map(k=>{
    const g=shown.filter(p=>p.series===k);
    if(!g.length) return "";
    const cp=g.map(p=>p.cpsf).filter(v=>v!=null), sq=g.map(p=>p.sqft).filter(v=>v!=null);
    const ex=g.map(p=>p.ext).filter(v=>v!=null);
    const avg=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
    const aw=g.filter(p=>p.awaiting).length;
    return `<button class="sercard" data-go="${esc(k)}">
      <div class="sc-h">${esc(seriesLabel(k))}</div>
      <div class="sc-b">${esc((SERIES[k]&&SERIES[k].blurb)||"")}</div>
      <div class="sc-g">
        <div><span>${g.length}</span>plans${aw?` · ${aw} unpriced`:""}</div>
        <div><span>${cp.length?money2(avg(cp)):"—"}</span>avg / sq ft</div>
        <div><span>${ex.length?money(avg(ex)):"—"}</span>avg extended</div>
        <div><span>${sq.length?sqftF(Math.min(...sq))+"–"+sqftF(Math.max(...sq)):"—"}</span>sq ft range</div>
      </div></button>`;
  }).join("")}</div>`;
  wireFilterNote();
  a.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{
    state.series={}; state.series[b.dataset.go]=true; state.view="plans"; setTab(); render(); });
}

/* Filters live on the Plans tab, but they keep applying on the other tabs where
   the controls aren't visible. Without this, clicking a community and then
   opening By series looks like the series data vanished. */
function anyFilterOn(){
  return !!(lc(state.q).trim() || FACETS.some(f=>chipsOn(state[f.key])) ||
            !state.showAwaiting || state.showShells || state.showIncomplete ||
            SLIDERS.some(s=>rngActive(s.key)));
}
function clearAllFilters(quiet){
  state.q=""; state.series={}; state.rng={};
  FACETS.forEach(f=>{ state[f.key]={}; });
  state.showShells=false; state.showAwaiting=true; state.showIncomplete=false;
  if(!quiet) render();          // the division switch renders once, after loading
}
function filterNote(total, shownN){
  if(!anyFilterOn()) return "";
  const bits=[];
  if(lc(state.q).trim()) bits.push(`matching “${esc(state.q.trim())}”`);
  FACETS.forEach(f=>{ if(chipsOn(state[f.key]))
    bits.push(lc(f.label)+" "+Object.keys(state[f.key]).map(esc).join(", ")); });
  if(SLIDERS.some(s=>rngActive(s.key))) bits.push("a cost or size range");
  if(!state.showAwaiting) bits.push("excluding awaiting pricing");
  return `<div class="filternote">
      <span>Showing <b>${shownN}</b> of ${total} plans${bits.length?" — "+bits.join(" · "):""}.</span>
      <button class="btn mini ghost" id="btnClearFilters">Clear filters</button></div>`;
}
function wireFilterNote(){
  const b=$("btnClearFilters"); if(!b) return;
  b.onclick=clearAllFilters;
}

/* ---------------- COMMUNITY COST INDEX ----------------
   A community's raw average cost per sq ft says more about which plans it
   happens to sell than about the community: a place that only builds large
   two-storey homes will look cheap per foot whatever it pays its trades.

   The index removes that. Each home is compared against what the SAME plan
   costs averaged across every community offering it that month, and the
   community's index is the average of those ratios, expressed as 100 = par.
   106 means this community pays about 6% over the division for the same
   houses. A plan built in only one community tells us nothing — it would be
   its own benchmark — so it is left out, and the number of plans that did
   count is shown so a thin index reads as one. */
const IDX_MIN_PLANS=3;
function communityIndex(){
  const usable=state.rows.filter(r=>
    cpsfOf(r)!=null && !r.incomplete && r.kind!=="shell" && (r.comm_num||r.community));
  // benchmark: mean cost per sq ft for each plan across the communities offering it
  const planComm=new Map();          // plan -> Map(comm -> [cpsf])
  usable.forEach(r=>{
    let m=planComm.get(r.plan_no); if(!m){ m=new Map(); planComm.set(r.plan_no,m); }
    const k=r.comm_num||r.community;
    (m.get(k)||m.set(k,[]).get(k)).push(cpsfOf(r));
  });
  const bench=new Map();             // plan -> {mean, nComm}
  planComm.forEach((m,plan)=>{
    const per=[...m.values()].map(mean);
    if(per.length<2) return;         // single-community plan is its own benchmark
    bench.set(plan,{ mean:mean(per), nComm:per.length });
  });
  const by=new Map();
  usable.forEach(r=>{
    const k=r.comm_num||r.community;
    let e=by.get(k);
    if(!e){ e={ key:k, num:r.comm_num, jde:r.jde, name:r.community,
                plans:new Set(), cp:[], ex:[], ratios:[], detail:[] }; by.set(k,e); }
    e.plans.add(r.plan_no);
    e.cp.push(cpsfOf(r)); const x=costOf(r); if(x!=null) e.ex.push(x);
  });
  // one ratio per plan per community, so a plan with six elevations doesn't
  // outvote a plan with one
  by.forEach(e=>{
    const perPlan=new Map();
    usable.filter(r=>(r.comm_num||r.community)===e.key)
      .forEach(r=>{ (perPlan.get(r.plan_no)||perPlan.set(r.plan_no,[]).get(r.plan_no)).push(cpsfOf(r)); });
    perPlan.forEach((v,plan)=>{
      const b=bench.get(plan); if(!b||!b.mean) return;
      const here=mean(v), ratio=here/b.mean;
      e.ratios.push(ratio);
      e.detail.push({ plan, name:(state.plans[plan]&&state.plans[plan].name)||"", here, bench:b.mean, ratio, nComm:b.nComm });
    });
    e.detail.sort((x,y)=>y.ratio-x.ratio);
    e.index = e.ratios.length>=IDX_MIN_PLANS ? mean(e.ratios)*100 : null;
  });
  // every community that priced anything, including ones with too few shared plans
  state.rows.forEach(r=>{
    const k=r.comm_num||r.community; if(!k||by.has(k)) return;
    by.set(k,{ key:k, num:r.comm_num, jde:r.jde, name:r.community,
               plans:new Set(state.rows.filter(x=>(x.comm_num||x.community)===k).map(x=>x.plan_no)),
               cp:[], ex:[], ratios:[], detail:[], index:null });
  });
  return [...by.values()];
}
function idxClass(v){
  if(v==null) return "";
  if(v>=103) return "over";
  if(v<=97)  return "under";
  return "par";
}
/* ---- communities overview ---- */
function renderComms(a){
  const list=communityIndex().sort((x,y)=>String(x.name).localeCompare(y.name));
  const scored=list.filter(c=>c.index!=null);
  const spread=scored.length
    ? `${scored.length} communities indexed · ${(Math.min(...scored.map(c=>c.index))).toFixed(0)}–${(Math.max(...scored.map(c=>c.index))).toFixed(0)}`
    : "not enough shared plans to index";
  a.innerHTML=`<div class="panel">
    <div class="secbar">
      <span class="sectitle">Communities</span>
      <span class="hint">Index compares each community against what the same plans cost division-wide. 100 = par. ${esc(spread)}.</span>
    </div>
    <table class="pt ct">
    <thead><tr><th>Community</th><th>JDE</th><th>Plans</th><th>Avg cost / sq ft</th>
      <th>Avg extended cost</th><th class="c-ix">Cost index</th><th class="c-cis"></th><th class="c-ch"></th></tr></thead>
    <tbody>${list.map(c=>{
      const open=!!state.openComm[c.key];
      return `<tr class="crow${open?" open":""}" data-comm="${esc(c.key)}">
        <td><b>${esc(c.name||"—")}</b></td><td class="mono">${esc(c.jde||"")}</td>
        <td>${c.plans.size}</td><td>${c.cp.length?money2(mean(c.cp)):"—"}</td>
        <td>${c.ex.length?money(mean(c.ex)):"—"}</td>
        <td class="c-ix">${indexCellHTML(c)}</td>
        <td class="c-cis">${cisBtnHTML(c.jde, c.name)}</td>
        <td class="c-ch"><span class="chev">${open?"▾":"▸"}</span></td></tr>`
        + (open?`<tr class="pdet"><td colspan="8">${commDetailHTML(c)}</td></tr>`:"");
    }).join("")}</tbody></table></div>`;
  // the CIS link is a real anchor inside a clickable row — let it navigate
  a.querySelectorAll(".cisbtn").forEach(el=>el.onclick=e=>e.stopPropagation());
  a.querySelectorAll("[data-comm]").forEach(tr=>tr.onclick=()=>{
    const k=tr.dataset.comm; state.openComm[k]=!state.openComm[k]; renderComms(a); });
  a.querySelectorAll("[data-goplan]").forEach(el=>el.onclick=e=>{
    e.stopPropagation(); state.q=el.dataset.goplan; state.view="plans"; setTab(); render(); });
}
function indexCellHTML(c){
  if(c.index==null)
    return `<span class="mute" title="Needs at least ${IDX_MIN_PLANS} plans that are also built elsewhere">—</span>`;
  const off=c.index-100;
  const w=Math.min(100, Math.abs(off)*5);      // ±20% fills the bar
  return `<span class="ixw ${idxClass(c.index)}" title="${esc(c.ratios.length+" plans compared")}">
      <b>${c.index.toFixed(0)}</b>
      <span class="ixbar"><i style="width:${w.toFixed(1)}%;${off<0?"right:50%":"left:50%"}"></i></span>
      <span class="rng">${signPct(off/100)}</span></span>`;
}
function commDetailHTML(c){
  if(!c.detail.length) return `<div class="det"><div class="empty" style="padding:14px">
    None of this community's plans is built anywhere else this month, so there is nothing to compare it against.</div></div>`;
  return `<div class="det"><div class="detsec-h">Plan by plan
      <span class="hint">what each plan costs here against its division-wide average</span></div>
    <table class="dt"><thead><tr><th>Plan</th><th>Built in</th><th>Here</th><th>Division avg</th><th>Difference</th></tr></thead>
    <tbody>${c.detail.map(d=>`<tr>
      <td><a class="plink" data-goplan="${esc(d.plan)}">${esc(d.plan)}</a> ${esc(d.name||"")}</td>
      <td>${d.nComm} communities</td>
      <td>${money2(d.here)}</td><td>${money2(d.bench)}</td>
      <td class="${d.ratio>1.03?"dl up":d.ratio<0.97?"dl down":"dl flat"}">${signPct(d.ratio-1)}</td></tr>`).join("")}
    </tbody></table></div>`;
}

/* ---------------- LINE CHART ----------------
   Hand-drawn SVG rather than a charting library: it is a couple of dozen
   lines, it inherits the theme's colours through CSS variables, and it adds
   nothing to what the page has to download.

   The viewBox scales to the container, so the geometry below is in chart
   units, not pixels. A null point breaks the line rather than being drawn as
   zero — a month a plan wasn't priced is a gap, not a collapse in cost. */
const CHART_COLORS=["#0064d2","#e07a1f","#1a8f57","#b3261e","#7a4bc4",
                    "#0f9bb5","#c2185b","#6b7a3a","#8d6e63","#3f51b5"];
function lineChart(o){
  const W=o.width||760, H=o.height||260;
  const padL=o.padL||54, padR=16, padT=12, padB=o.legend===false?22:26;
  const labels=o.labels||[];
  const lines=(o.lines||[]).filter(l=>l.points && l.points.some(v=>v!=null));
  const fmtY=o.fmtY||(v=>String(v));
  if(!lines.length || !labels.length)
    return `<div class="empty" style="padding:18px">Nothing to chart yet.</div>`;

  const vals=[]; lines.forEach(l=>l.points.forEach(v=>{ if(v!=null) vals.push(v); }));
  let lo=Math.min(...vals), hi=Math.max(...vals);
  if(!(hi>lo)){ const p=Math.abs(hi||1)*0.05||1; lo=hi-p; hi=hi+p; }
  else { const p=(hi-lo)*0.12; lo-=p; hi+=p; }
  const X=i=> labels.length===1 ? padL+(W-padL-padR)/2
                                : padL + i*(W-padL-padR)/(labels.length-1);
  const Y=v=> padT + (1-(v-lo)/(hi-lo))*(H-padT-padB);

  /* Optional: each month is a clickable column. The hit areas are drawn first
     so they sit behind the line and its points — the points stay hoverable for
     their tooltips, and carry the same data attribute so clicking one works
     too. */
  const hits = !o.xClick ? "" : labels.map((l,i)=>{
    const w = labels.length>1 ? (W-padL-padR)/(labels.length-1) : (W-padL-padR);
    return `<rect class="ch-hit${o.activeX===i?" on":""}" data-xi="${i}"
        x="${(X(i)-w/2).toFixed(2)}" y="${padT}" width="${w.toFixed(2)}"
        height="${(H-padT-padB).toFixed(2)}"><title>${esc(o.xTitle?o.xTitle(l):l)}</title></rect>`;
  }).join("");

  const TICKS=4;
  let grid="";
  for(let t=0;t<=TICKS;t++){
    const v=lo+(hi-lo)*t/TICKS, y=Y(v).toFixed(2);
    grid+=`<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" class="ch-grid"/>`
        + `<text x="${padL-8}" y="${y}" class="ch-yl">${esc(fmtY(v))}</text>`;
  }
  const xl=labels.map((l,i)=>
    `<text x="${X(i).toFixed(2)}" y="${H-6}"
       class="ch-xl${o.xClick?" click":""}${o.activeX===i?" on":""}"${o.xClick?` data-xi="${i}"`:""}
       >${esc(l)}</text>`).join("");

  const body=lines.map((l,li)=>{
    const col=l.color||CHART_COLORS[li%CHART_COLORS.length];
    // split into runs of consecutive present values so gaps stay gaps
    const runs=[]; let cur=[];
    l.points.forEach((v,i)=>{ if(v==null){ if(cur.length) runs.push(cur); cur=[]; } else cur.push([i,v]); });
    if(cur.length) runs.push(cur);
    const paths=runs.filter(r=>r.length>1).map(r=>
      `<path d="${r.map(([i,v],k)=>(k?"L":"M")+X(i).toFixed(2)+" "+Y(v).toFixed(2)).join(" ")}"
         fill="none" stroke="${col}" stroke-width="${l.width||2.2}" stroke-linecap="round"
         stroke-linejoin="round"${l.dash?` stroke-dasharray="${l.dash}"`:""}/>`).join("");
    const dots=runs.flat().map(([i,v])=>
      `<circle cx="${X(i).toFixed(2)}" cy="${Y(v).toFixed(2)}" r="${l.width>2.5?4:3.2}"
         fill="${col}"${o.xClick?` data-xi="${i}"`:""}><title>${esc(labels[i]+" · "+(l.label||"")+" · "+fmtY(v))}</title></circle>`).join("");
    return paths+dots;
  }).join("");

  const legend = o.legend===false ? "" :
    `<div class="ch-legend">${lines.map((l,li)=>
      `<span class="ch-key"><i style="background:${l.color||CHART_COLORS[li%CHART_COLORS.length]}"></i>${esc(l.label||"")}</span>`
     ).join("")}</div>`;

  return `<div class="chart">
    <svg viewBox="0 0 ${W} ${H}" class="ch" role="img"
         aria-label="${esc(o.alt||"Line chart")}">${hits}${grid}${xl}${body}</svg>
    ${legend}</div>`;
}

/* ---------------- TRENDS ----------------
   Two months of the same homes is a price movement. Two months of different
   homes is a change in what we happened to price. The like-for-like toggle
   decides which question the chart answers, and defaults to the first. */
function trendBasket(){
  const idx=histBy(), dss=state.datasets;
  if(dss.length<2) return null;
  const sets=dss.map(ds=>{
    const s=new Set();
    (idx.get(ds)||new Map()).forEach(p=>p.forEach((r,k)=>s.add(k)));
    return s;
  });
  return new Set([...sets[0]].filter(k=>sets.every(s=>s.has(k))));
}
function trendData(lfl){
  const idx=histBy();
  const dss=state.datasets.slice().sort();
  const keep=lfl?trendBasket():null;
  const out={ ds:dss, all:dss.map(()=>null), n:dss.map(()=>0), bySeries:{} };
  dss.forEach((ds,i)=>{
    const bucket={}, allv=[];
    (idx.get(ds)||new Map()).forEach((p,plan)=>{
      const sk=seriesOf(plan);
      p.forEach((r,k)=>{
        if(keep && !keep.has(k)) return;
        if(r.kind==="shell" && !state.showShells) return;
        const v=cpsfOf(r); if(v==null) return;
        (bucket[sk]=bucket[sk]||[]).push(v); allv.push(v);
      });
    });
    out.all[i]=mean(allv); out.n[i]=allv.length;
    Object.keys(bucket).forEach(sk=>{
      const arr = out.bySeries[sk] || (out.bySeries[sk]=dss.map(()=>null));
      arr[i]=mean(bucket[sk]);
    });
  });
  return out;
}
function renderTrends(a, all){
  if(state.datasets.length<2){
    a.innerHTML=`<div class="panel"><div class="empty" style="padding:34px;text-align:center">
      Only one month is loaded, so there is nothing to trend yet. Load a second month to see movement.</div></div>`;
    return;
  }
  const t=trendData(state.trendLFL);
  const keys=Object.keys(t.bySeries)
    .sort((x,y)=>(SERIES_ORDER.indexOf(x)<0?99:SERIES_ORDER.indexOf(x))-(SERIES_ORDER.indexOf(y)<0?99:SERIES_ORDER.indexOf(y)));
  if(!state.trendTouched){
    // seed with the series that cover the most homes, so the chart says
    // something on arrival instead of showing a single line
    const size=k=>t.bySeries[k].filter(v=>v!=null).length*1000 +
                  all.filter(p=>p.series===k && !p.awaiting).length;
    keys.slice().sort((x,y)=>size(y)-size(x)).slice(0,5).forEach(k=>{ state.trendSeries[k]=true; });
  }
  const lines=[{ label:"All plans", color:"var(--navy)", width:3.2, points:t.all }]
    .concat(keys.filter(k=>state.trendSeries[k]).map((k,i)=>({
      label:seriesLabel(k), points:t.bySeries[k],
      color:CHART_COLORS[keys.indexOf(k)%CHART_COLORS.length] })));

  const first=t.all.find(v=>v!=null), last=[...t.all].reverse().find(v=>v!=null);
  const overall=(first!=null&&last!=null&&first)?(last-first)/first:null;
  const movers=moverRows(all);
  /* How many homes the line is drawn from. Like-for-like makes every month the
     same basket, so one number says it; without it the months differ and a
     single number would quietly pick one. */
  const nLo=Math.min(...t.n), nHi=Math.max(...t.n);
  const basket = nLo===nHi ? `${nLo.toLocaleString()} homes`
                           : `${nLo.toLocaleString()}–${nHi.toLocaleString()} homes per month`;

  a.innerHTML=`
    <div class="panel">
      <div class="secbar">
        <span class="sectitle">Cost per sq ft over time</span>
        <span class="hint">${esc(state.basis==="tax"?"with tax":"untaxed")} ·
          ${overall!=null?`${signPct(overall)} across ${esc(dsShort(t.ds[0]))} → ${esc(dsShort(t.ds[t.ds.length-1]))}`:"—"} ·
          ${esc(basket)} in the basket</span>
        <span class="spacer"></span>
        <label class="hint chk" title="Chart only the homes priced in every loaded month, so the line shows price movement rather than a change in what was priced">
          <input type="checkbox" id="chkLFL" ${state.trendLFL?"checked":""}> Like-for-like only</label>
      </div>
      ${lineChart({ labels:t.ds.map(dsShort), lines, fmtY:money2, height:280,
                    alt:"Average cost per square foot by month",
                    xClick:true, activeX:t.ds.indexOf(state.dataset),
                    xTitle:l=>"Show the tables for "+l })}
      <div class="charthint tiny">Click a month on the chart to load its figures into the other tabs.</div>
      <div class="serpicks">
        <span class="hint">Series lines</span>
        ${keys.map((k,i)=>`<button class="serpick${state.trendSeries[k]?" on":""}" data-sp="${esc(k)}">
          <i style="background:${CHART_COLORS[i%CHART_COLORS.length]}"></i>${esc(seriesLabel(k))}</button>`).join("")}
        <button class="linkbtn2" id="spNone">Clear</button>
      </div>
    </div>
    ${movers}`;

  $("chkLFL").onchange=e=>{ state.trendLFL=e.target.checked; renderTrends(a,all); };
  /* Clicking a month on the chart scopes the whole app to it. The chart keeps
     showing every month either way — only the tables follow the selection. */
  a.querySelectorAll("[data-xi]").forEach(el=>el.addEventListener("click",()=>{
    const ds=t.ds[+el.getAttribute("data-xi")];
    if(ds && ds!==state.dataset) setDataset(ds);
  }));
  a.querySelectorAll("[data-sp]").forEach(b=>b.onclick=()=>{
    const k=b.dataset.sp; state.trendTouched=true;
    state.trendSeries[k]=!state.trendSeries[k]; renderTrends(a,all); });
  $("spNone").onclick=()=>{ state.trendTouched=true; state.trendSeries={}; renderTrends(a,all); };
  a.querySelectorAll("[data-goplan]").forEach(el=>el.onclick=()=>{
    state.q=el.dataset.goplan; state.view="plans"; setTab(); render(); });
}
/* The plans that moved most between the two chosen months. A movement over a
   single home is noise, so the table says how many homes each one covers and
   sorts by size of move, not by significance — the reader can see both. */
function moverRows(all){
  if(!state.cmp) return "";
  const withD=all.filter(p=>p.delta && p.delta.n>0);
  if(!withD.length) return "";
  const byPct=withD.slice().sort((a,b)=>b.delta.pct-a.delta.pct);
  const up=byPct.slice(0,8), down=byPct.slice(-8).reverse();
  const tbl=(title,rows,note)=>`<div class="panel half">
    <div class="secbar"><span class="sectitle">${esc(title)}</span><span class="hint">${esc(note)}</span></div>
    <table class="pt ct"><thead><tr><th>Plan</th><th>Homes</th><th>${esc(dsShort(state.cmp))}</th>
      <th>${esc(dsShort(state.dataset))}</th><th>Change</th></tr></thead>
    <tbody>${rows.map(p=>`<tr>
      <td><a class="plink" data-goplan="${esc(p.plan)}">${esc(p.plan)}</a> ${esc(p.name||"")}</td>
      <td>${p.delta.n}</td><td>${money2(p.delta.from)}</td><td>${money2(p.delta.to)}</td>
      <td class="dl ${p.delta.pct>0?"up":p.delta.pct<0?"down":"flat"}">${signPct(p.delta.pct)}</td></tr>`).join("")}
    </tbody></table></div>`;
  return `<div class="twoup">
    ${tbl("Biggest increases", up, "like-for-like, cost per sq ft")}
    ${tbl("Biggest decreases", down, "like-for-like, cost per sq ft")}</div>`;
}

/* ---------------- COST CODE VARIANCE ----------------
   Aggregated in the database, not here: a month is tens of thousands of
   cost-code rows and paging them into the browser to average them would be
   slow and pointless. If the functions aren't installed the view says so
   rather than failing silently. */
async function loadCcVariance(){
  if(state.ccv || state.ccvBusy) return;
  if(DEMO||!sb||!state.dataset){ state.ccv=[]; return; }
  state.ccvBusy=true; state.ccvErr=null;
  try{
    const { data,error } = await sb.rpc("pdb_cc_variance",
      { p_dataset:state.dataset, p_prev:state.cmp||null, p_division:state.division });
    if(error) throw error;
    state.ccv=data||[];
  }catch(e){
    console.error(e);
    state.ccv=[]; state.ccvErr=(e&&e.message)||"Could not load cost-code aggregates.";
  }finally{ state.ccvBusy=false; }
}
async function loadCcCode(code){
  if(state.ccd[code] || state.ccdBusy[code]) return;
  if(DEMO||!sb){ state.ccd[code]=[]; return; }
  state.ccdBusy[code]=true;
  try{
    const { data,error } = await sb.rpc("pdb_cc_code_plans",
      { p_dataset:state.dataset, p_code:code, p_division:state.division });
    if(error) throw error;
    state.ccd[code]=data||[];
  }catch(e){ console.error(e); state.ccd[code]=[]; }
  finally{ state.ccdBusy[code]=false; }
}
const CC_SORTS=[
  ["spread","Widest disagreement"],
  ["cv","Most inconsistent"],
  ["avg","Largest cost"],
  ["move","Biggest movement"]
];
function ccSortKey(r){
  const avg=num(r.avg_cpsf)||0;
  if(state.ccSort==="avg")    return avg;
  if(state.ccSort==="cv")     return avg ? (num(r.sd_cpsf)||0)/avg : 0;
  if(state.ccSort==="move")   return (r.prev_avg!=null && num(r.prev_avg)) ? Math.abs((avg-num(r.prev_avg))/num(r.prev_avg)) : -1;
  return num(r.spread)||0;
}
function renderCodes(a){
  if(state.ccv===null && !state.ccvBusy){
    const pending=loadCcVariance();
    a.innerHTML=`<div class="panel"><div class="empty" style="padding:34px;text-align:center">Loading cost-code aggregates…</div></div>`;
    pending.then(()=>{ if(state.view==="codes") renderCodes(a); });
    return;
  }
  if(state.ccvBusy){
    a.innerHTML=`<div class="panel"><div class="empty" style="padding:34px;text-align:center">Loading cost-code aggregates…</div></div>`;
    return;
  }
  if(state.ccvErr){
    a.innerHTML=`<div class="panel"><div class="empty" style="padding:34px;text-align:center">
      <h3 style="margin:0 0 8px;color:var(--navy)">Cost-code analysis isn't available</h3>
      <p class="tiny" style="max-width:560px;margin:0 auto">Run <code>analytics_rpc.sql</code> in the Supabase SQL editor for
      this project, then reload. The aggregation runs in the database because a month holds far more
      cost-code rows than a browser should download.</p>
      <p class="tiny" style="margin-top:10px;opacity:.75">${esc(state.ccvErr)}</p></div></div>`;
    return;
  }
  const rows=(state.ccv||[]).slice().sort((x,y)=>ccSortKey(y)-ccSortKey(x));
  if(!rows.length){
    a.innerHTML=`<div class="panel"><div class="empty" style="padding:34px;text-align:center">
      No cost-code detail loaded for ${esc(dsLabel(state.dataset))}.</div></div>`;
    return;
  }
  // its own search box: the plans search is a filter that persists across tabs,
  // and borrowing it here would silently narrow the plans list on the way back
  const q=lc(state.ccq||"").trim();
  const shown=q?rows.filter(r=>lc((r.code||"")+" "+(r.description||"")).includes(q)):rows;
  const maxSpread=Math.max(...rows.map(r=>num(r.spread)||0), 0.0001);
  a.innerHTML=`
    <div class="bar">
      <input type="search" id="qcc" placeholder="Search cost code or description…" value="${esc(state.ccq||"")}">
      <span class="hint">${shown.length} of ${rows.length} codes · ${esc(dsLabel(state.dataset))} · untaxed</span>
      <span class="spacer"></span>
      <span class="hint">Sort</span>
      ${CC_SORTS.map(([k,l])=>`<button class="sortb${state.ccSort===k?" on":""}" data-ccsort="${k}">${l}</button>`).join("")}
    </div>
    <div class="panel">
      <div class="secbar"><span class="hint">
        <b>Disagreement</b> is how far apart two communities price the same code on the same plan, averaged over the plans that carry it —
        the part of the variation that isn't explained by plans being different sizes.
        <b>Inconsistency</b> is that spread relative to the code's own size, so a small code with wild swings ranks alongside a big one.
      </span></div>
      <table class="pt cvt">
      <thead><tr><th>Code</th><th>Description</th><th>Avg / sq ft</th><th>Range</th>
        <th>Disagreement</th><th>Inconsistency</th>
        ${state.cmp?`<th title="Change from ${esc(dsLabel(state.cmp))} to ${esc(dsLabel(state.dataset))}">Trend</th>`:""}
        <th>Plans</th><th class="c-ch"></th></tr></thead>
      <tbody>${shown.map(r=>ccRowHTML(r,maxSpread)).join("")}</tbody></table>
    </div>`;
  $("qcc").addEventListener("input",e=>{
    state.ccq=e.target.value;
    const at=e.target.selectionStart;
    renderCodes(a);
    const box=$("qcc"); if(box){ box.focus(); try{ box.setSelectionRange(at,at); }catch(err){} }
  });
  a.querySelectorAll("[data-ccsort]").forEach(b=>b.onclick=()=>{ state.ccSort=b.dataset.ccsort; renderCodes(a); });
  a.querySelectorAll("[data-code]").forEach(tr=>tr.onclick=async ()=>{
    const c=tr.dataset.code;
    state.openCode[c]=!state.openCode[c];
    if(state.openCode[c] && !state.ccd[c]){
      const pending=loadCcCode(c);
      renderCodes(a); await pending;
      if(state.view==="codes") renderCodes(a);
      return;
    }
    renderCodes(a);
  });
  a.querySelectorAll("[data-goplan]").forEach(el=>el.onclick=e=>{
    e.stopPropagation(); state.q=el.dataset.goplan; state.view="plans"; setTab(); render(); });
}
function ccRowHTML(r, maxSpread){
  const avg=num(r.avg_cpsf), sd=num(r.sd_cpsf)||0, sp=num(r.spread);
  const cv=avg?sd/avg:null;
  const prev=num(r.prev_avg);
  const mv=(prev!=null&&prev)?(avg-prev)/prev:null;
  const open=!!state.openCode[r.code];
  const NCOL=state.cmp?9:8;
  return `<tr class="crow${open?" open":""}" data-code="${esc(r.code)}">
    <td class="mono"><b>${esc(r.code)}</b></td>
    <td>${esc(r.description||"—")}</td>
    <td>${money2(avg)}</td>
    <td class="rng2">${money2(num(r.min_cpsf))}–${money2(num(r.max_cpsf))}</td>
    <td class="c-sp">${sp!=null?`<span class="spw"><b>${money2(sp)}</b>
        <span class="spbar"><i style="width:${(Math.min(1,sp/maxSpread)*100).toFixed(1)}%"></i></span></span>`:"—"}</td>
    <td>${cv!=null?`<span class="${cv>0.35?"dl up":""}">${pctF(cv)}</span>`:"—"}</td>
    ${state.cmp?`<td class="${mv==null?"":mv>0.005?"dl up":mv<-0.005?"dl down":"dl flat"}">${mv==null?"—":signPct(mv)}</td>`:""}
    <td>${r.n_plans}</td>
    <td class="c-ch"><span class="chev">${open?"▾":"▸"}</span></td></tr>`
    + (open?`<tr class="pdet"><td colspan="${NCOL}">${ccDetailHTML(r)}</td></tr>`:"");
}
function ccDetailHTML(r){
  if(state.ccdBusy[r.code]) return `<div class="det"><div class="hint" style="padding:10px 0">Loading…</div></div>`;
  const rows=state.ccd[r.code];
  if(!rows) return `<div class="det"><div class="hint" style="padding:10px 0">Open again to load.</div></div>`;
  if(!rows.length) return `<div class="det"><div class="empty" style="padding:14px">No plan detail for this code.</div></div>`;
  const top=rows.slice(0,25);
  return `<div class="det"><div class="detsec-h">${esc(r.code)} plan by plan
      <span class="hint">widest disagreement between communities first</span></div>
    <table class="dt"><thead><tr><th>Plan</th><th>Communities</th><th>Avg</th>
      <th>Cheapest</th><th>Dearest</th><th>Gap</th></tr></thead>
    <tbody>${top.map(d=>{
      const lo=num(d.min_cpsf), hi=num(d.max_cpsf), gap=(lo!=null&&hi!=null)?hi-lo:null;
      const nm=(state.plans[d.plan_no]&&state.plans[d.plan_no].name)||"";
      return `<tr><td><a class="plink" data-goplan="${esc(d.plan_no)}">${esc(d.plan_no)}</a> ${esc(nm)}</td>
        <td>${d.n_comms}</td><td>${money2(num(d.avg_cpsf))}</td>
        <td>${money2(lo)}<span class="rng">${esc(d.lo_comm||"")}</span></td>
        <td>${money2(hi)}<span class="rng">${esc(d.hi_comm||"")}</span></td>
        <td>${gap!=null?money2(gap):"—"}</td></tr>`;
    }).join("")}</tbody></table>
    ${rows.length>top.length?`<div class="hint" style="padding:8px 0 0">+ ${rows.length-top.length} more plans</div>`:""}</div>`;
}

/* ---------------- 2-point range slider ----------------
   Two native range inputs stacked on one track: keyboard and screen-reader
   support come free, and the thumbs stay grabbable because only the thumbs
   take pointer events. The lower thumb is raised above the upper one when
   both sit at the same end, otherwise the pair can deadlock at the top. */
function rangeSlider(hostId, key, fmt){
  const host=$(hostId); const r=state.rng[key]; if(!host||!r) return;
  const span=(r.max-r.min)||1;
  const pct=v=>((v-r.min)/span)*100;
  host.innerHTML=`
    <div class="rs">
      <div class="rs-vals"><span class="rs-lo-v">${fmt(r.lo)}</span><span class="rs-hi-v">${fmt(r.hi)}</span></div>
      <div class="rs-body">
        <div class="rs-rail"></div>
        <div class="rs-fill"></div>
        <input type="range" class="rs-in rs-lo" min="${r.min}" max="${r.max}" step="${r.step}" value="${r.lo}"
               aria-label="Minimum ${esc(key)}">
        <input type="range" class="rs-in rs-hi" min="${r.min}" max="${r.max}" step="${r.step}" value="${r.hi}"
               aria-label="Maximum ${esc(key)}">
      </div>
    </div>`;
  const lo=host.querySelector(".rs-lo"), hi=host.querySelector(".rs-hi");
  const fill=host.querySelector(".rs-fill");
  const loV=host.querySelector(".rs-lo-v"), hiV=host.querySelector(".rs-hi-v");
  /* The thumb's centre sits at  thumb/2 + f*(width - thumb),  not at f*width.
     Expressing the fill the same way in calc() keeps it welded to the thumbs at
     every position without JS needing to know the pixel width. The thumb size
     is read back from CSS so the two can't drift apart. */
  const T=parseFloat(getComputedStyle(host.querySelector(".rs")).getPropertyValue("--rs-thumb"))||17;
  const at=v=>{ const f=(v-r.min)/span; return `calc(${(f*100).toFixed(4)}% + ${((0.5-f)*T).toFixed(2)}px)`; };
  const paint=()=>{
    const fLo=(r.lo-r.min)/span, fHi=(r.hi-r.min)/span, d=Math.max(0,fHi-fLo);
    fill.style.left=at(r.lo);
    fill.style.width=`calc(${(d*100).toFixed(4)}% - ${(d*T).toFixed(2)}px)`;
    loV.textContent=fmt(r.lo); hiV.textContent=fmt(r.hi);
    // when both thumbs pile up at the max, the low thumb must sit on top to stay draggable
    lo.style.zIndex = (r.lo > r.max - span*0.02) ? 5 : 3;
  };
  const commit=()=>{ paint(); scheduleRepaint(); };
  lo.addEventListener("input",()=>{ r.touched=true; r.lo=Math.min(+lo.value, r.hi); lo.value=r.lo; commit(); });
  hi.addEventListener("input",()=>{ r.touched=true; r.hi=Math.max(+hi.value, r.lo); hi.value=r.hi; commit(); });
  paint();
}
/* Dragging fires input continuously; repaint the list on the next frame rather
   than per event, so a 126-row regroup never stutters the thumb. */
let repaintList=null, rafId=null;
function scheduleRepaint(){
  if(rafId) return;
  rafId=requestAnimationFrame(()=>{ rafId=null; if(repaintList) repaintList(); });
}

/* ---------------- export ---------------- */
function exportPlans(list){
  if(!window.XLSX){ uiAlert("Spreadsheet library didn't load — refresh and try again.","Export"); return; }
  const basis=state.basis==="tax"?"with tax":"untaxed";
  const cmp=state.cmp;
  const head=["Series","Series source","Homesite","Tier","Plan #","Plan name","Also known as","Sq ft","Beds","Baths","Levels","Footprint",
              `Avg cost/sq ft (${basis})`,`Min cost/sq ft`,`Max cost/sq ft`,
              `Avg extended cost (${basis})`,`Min extended`,`Max extended`,
              "Avg sales price","Min price","Max price","Gross margin $","Gross margin %",
              "Plan status","Communities","Kind","Availability"]
    .concat(cmp?[`${dsLabel(cmp)} cost/sq ft`,`Change $/sq ft`,`Change %`,`Change extended $`,"Homes compared"]:[]);
  const body=list.map(p=>{
    const d=p.delta;
    return [seriesLabel(p.series),p.origin,p.site,p.tier,p.plan,p.name,p.alias,p.sqft,p.beds,p.baths,p.sty,p.footprint,
      p.cpsf,p.cpsfLo,p.cpsfHi,p.ext,p.extLo,p.extHi,
      p.price,p.priceLo,p.priceHi,p.gm,p.gmPct,
      STATUS[p.status]||p.status,p.nComm,p.kind,p.awaiting?"awaiting pricing":""]
      .concat(cmp?[d?d.from:null, d?d.d:null, d?d.pct:null, d?d.extD:null, d?d.n:null]:[]);
  });
  const detHead=["Plan #","Plan name","Series","Community","JDE","Elev","Sq ft",
                 `Cost/sq ft (${basis})`,`Extended cost (${basis})`,"Sales price","Margin %","Status","Incomplete"];
  const det=[];
  list.forEach(p=>p.rows.forEach(r=>{
    const pr=num(r.base_price), ex=costOf(r);
    det.push([p.plan,p.name,seriesLabel(p.series),r.community,r.jde,r.elev,
      num(r.sqft),cpsfOf(r),ex,pr,(pr&&ex)?(pr-ex)/pr:null,r.status,r.incomplete?"yes":""]);}));
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head,...body]), "Plans");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([detHead,...det]), "By community");
  if(state.options.length){
    const oh=["Plan #","Community","Elev","Option code","Option","Amount (untaxed)"];
    const keep=new Set(list.map(p=>p.plan));
    const od=state.options.filter(o=>keep.has(o.plan_no) && String(o.opt_code).toUpperCase()!=="1BASE")
      .map(o=>[o.plan_no,o.community,o.elev,o.opt_code,o.opt_name,num(o.amount)]);
    if(od.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([oh,...od]), "Options");
  }
  const ci=communityIndex().filter(c=>c.index!=null).sort((a,b)=>b.index-a.index);
  if(ci.length){
    const ih=["Community","JDE","Plans priced","Plans compared","Avg cost/sq ft","Cost index (100 = par)","Difference"];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ih,
      ...ci.map(c=>[c.name,c.jde,c.plans.size,c.ratios.length,mean(c.cp),c.index,(c.index-100)/100])]),
      "Community index");
  }
  XLSX.writeFile(wb, `Plan-DB_${divOf(state.division).label}_${state.dataset||"export"}_${state.basis}_${new Date().toISOString().slice(0,10)}.xlsx`);
}

/* ---------------- BOOTSTRAP ---------------- */
if(!initRecovery()) checkSession();

