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
                 SHL:"Shell", DIS:"Discontinued", TMP:"Temporary" };
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

const state = {
  email:null, role:"viewer", view:"plans",
  rows:[], plans:{}, datasets:[], dataset:null,
  basis:"tax",                       // "tax" = with tax, "net" = untaxed
  q:"", sort:"name", sortDir:1,
  series:{},                         // series key -> included? (empty = all)
  site:{}, tier:{}, beds:{}, baths:{}, sty:{}, status:{},   // chip facets, see FACETS
  options:[],                        // per-plan options (small, loaded up front)
  cc:{}, ccBusy:{},                  // cost codes per plan — fetched on demand
  showShells:false,
  showAwaiting:true,                 // roster plans with no cost yet — shown by default
  showIncomplete:false,              // rows whose figures look unreliable
  rng:{},                            // key -> {min,max,lo,hi} live slider state
  open:{}                            // plan_no -> drill-down expanded?
};
const $  = id => document.getElementById(id);
const esc = s => String(s==null?"":s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lc  = s => String(s==null?"":s).toLowerCase();
const num = v => (typeof v==="number" && isFinite(v)) ? v : (v==null||v===""?null:(isFinite(+v)?+v:null));
const money = v => v==null?"—":"$"+Math.round(v).toLocaleString();
const money2= v => v==null?"—":"$"+v.toFixed(2);
const sqftF = v => v==null?"—":Math.round(v).toLocaleString();
const pctF = v => v==null?"—":(v*100).toFixed(1)+"%";

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
  wireChrome();
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
  $("dsPick").onchange=async e=>{ state.dataset=e.target.value; state.rng={}; await loadCosts(); render(); };
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
    const { data:pl } = await sb.from("pdb_plans").select("*").eq("division",CFG.DIVISION.key);
    state.plans={}; (pl||[]).forEach(r=>{ state.plans[r.plan_no]=r; });
  }catch(e){ console.error(e); state.plans={}; }
  try{
    const { data:ds } = await sb.from("pdb_plan_costs").select("dataset").eq("division",CFG.DIVISION.key);
    state.datasets=[...new Set((ds||[]).map(r=>r.dataset))].sort().reverse();
  }catch(e){ state.datasets=[]; }
  if(!state.dataset) state.dataset = state.datasets[0] || window.PDB_DEFAULT_DATASET || null;
  await loadCosts();
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
      .eq("division",CFG.DIVISION.key).eq("dataset",state.dataset).eq("plan_no",plan);
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
        .eq("division",CFG.DIVISION.key).eq("dataset",state.dataset).range(from,from+PAGE-1);
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
        .eq("division",CFG.DIVISION.key).eq("dataset",state.dataset)
        .range(from, from+PAGE-1);
      if(error) throw error;
      state.rows=state.rows.concat(data||[]);
      if(!data || data.length<PAGE) break;
    }
  }catch(e){ console.error(e); state.rows=[]; }
  await loadOptions();
  const sel=$("dsPick");
  if(state.datasets.length>1){
    sel.classList.remove("hidden");
    sel.innerHTML=state.datasets.map(d=>`<option value="${esc(d)}"${d===state.dataset?" selected":""}>${esc(dsLabel(d))}</option>`).join("");
  } else sel.classList.add("hidden");
}
function dsLabel(d){
  const m=String(d||"").match(/^(\d{4})-(\d{2})$/); if(!m) return d;
  return ["January","February","March","April","May","June","July","August","September","October","November","December"][+m[2]-1]+" "+m[1];
}

/* ---------------- ROLLUP ----------------
   One row per plan number. The source has a row per community x elevation, so
   a plan carries a cost RANGE across the communities that offer it; the
   headline figure is the average of those, which is what sorting and the
   sliders use. Unpriced rows (status DFW, or a plan not yet bid in that
   community) contribute nothing but still count toward "offered in N". */
function costOf(r){ return state.basis==="tax" ? num(r.ext_price_tax) : num(r.ext_price); }
function cpsfOf(r){ return state.basis==="tax" ? num(r.cpsf_tax)      : num(r.cpsf); }
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
    if(q){
      const hay=lc([p.plan,p.name,p.alias,seriesLabel(p.series),p.site,p.matrixComm,
        ...p.rows.map(r=>r.community)].join(" "));
      if(!hay.includes(q)) return false;
    }
    return true;
  });
}
function sortPlans(list){
  const d=state.sortDir;
  const key={ name:p=>lc(p.name||p.plan), plan:p=>p.plan, cpsf:p=>p.cpsf, ext:p=>p.ext,
              price:p=>p.price, gm:p=>p.gmPct, sqft:p=>p.sqft, comms:p=>p.nComm
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
  $("footMeta").textContent = state.rows.length
    ? `${dsLabel(state.dataset)} · ${state.rows.length.toLocaleString()} rows · ${state.basis==="tax"?"with tax":"untaxed"}`
    : "";
  const a=$("viewArea");
  if(!state.rows.length && !Object.keys(state.plans).length) return renderEmpty(a);
  if(state.view==="series") return renderSeries(a, all);
  if(state.view==="communities") return renderComms(a);
  renderPlans(a, all, list);
}
function renderEmpty(a){
  a.innerHTML=`<div class="panel"><div class="empty" style="padding:40px 24px;text-align:center">
    <h3 style="margin:0 0 8px;color:var(--navy)">No plan data loaded yet</h3>
    <p class="tiny" style="max-width:520px;margin:0 auto 4px">
      Run <code>supabase_setup.sql</code> and then the seed file in the Supabase SQL editor for
      this project. Cost data is deliberately not bundled into the site, so the app shows nothing
      until the tables are populated.</p>
    <p class="tiny" style="margin-top:10px">If you have just loaded it, sign out and back in to refresh.</p>
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
    p.alias?`<span class="pill" title="Same home as plan ${esc(p.alias)}">= ${esc(p.alias)}</span>`:""
  ].filter(Boolean).join(" ");
  const bb=[p.beds,p.baths].filter(Boolean).join(" / ")||"—";
  const st=p.status?`<span class="pill st-${esc(lc(p.status))}" title="${esc(STATUS[p.status]||p.status)}">${esc(p.status)}</span>`:"";
  const NCOL=9;
  if(p.awaiting){
    return `<tr class="prow await${open?" open":""}" data-plan="${esc(p.plan)}">
      <td class="c-plan"><span class="pno">${esc(p.plan)}</span>
        <span class="pnm">${esc(p.name||"—")}</span> ${tags}</td>
      <td class="c-sq">${sqftF(p.sqft)}</td>
      <td class="c-bb">${esc(bb)}</td>
      <td class="c-cp await-t" colspan="5">awaiting pricing<span class="rng">${
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
      <td class="c-cm">${p.nComm}</td>
      <td class="c-ch"><span class="chev">${open?"▾":"▸"}</span></td>
    </tr>` + (open?`<tr class="pdet"><td colspan="${NCOL}">${planDetailHTML(p)}</td></tr>`:"");
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
    <table class="dt"><thead><tr><th>Community</th><th>JDE</th><th>Elev</th><th>Sq ft</th>
      <th>Cost / sq ft</th><th>Extended cost</th><th>Sales price</th><th>Margin</th><th>Status</th></tr></thead>
      <tbody>${rows.map(r=>{
        const cp=cpsfOf(r), ex=costOf(r), pr=num(r.base_price);
        const gm=(pr&&ex)?(pr-ex)/pr:null;
        return `<tr${r.incomplete?' class="warnrow"':""}>
          <td>${esc(r.community||"—")}</td><td class="mono">${esc(r.jde||"")}</td>
          <td>${esc(r.elev||"—")}</td><td>${sqftF(num(r.sqft))}</td>
          <td>${money2(cp)}</td><td>${money(ex)}</td><td>${money(pr)}</td><td>${pctF(gm)}</td>
          <td>${esc(r.status||"—")}${r.incomplete?` <span class="pill warn">incomplete</span>`:""}</td></tr>`;
      }).join("")}</tbody></table>
    ${optionsHTML(p)}
    ${costCodeHTML(p)}
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
function clearAllFilters(){
  state.q=""; state.series={}; state.rng={};
  FACETS.forEach(f=>{ state[f.key]={}; });
  state.showShells=false; state.showAwaiting=true; state.showIncomplete=false; render();
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

/* ---- communities overview ---- */
function renderComms(a){
  const by=new Map();
  state.rows.forEach(r=>{
    const k=r.comm_num||r.community; if(!k) return;
    let e=by.get(k);
    if(!e){ e={num:r.comm_num,jde:r.jde,name:r.community,plans:new Set(),cp:[],ex:[]}; by.set(k,e); }
    e.plans.add(r.plan_no);
    const c=cpsfOf(r), x=costOf(r);
    if(c!=null && !r.incomplete && r.kind!=="shell"){ e.cp.push(c); e.ex.push(x); }
  });
  const list=[...by.values()].sort((x,y)=>String(x.name).localeCompare(y.name));
  const avg=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
  a.innerHTML=`<div class="panel"><table class="pt ct">
    <thead><tr><th>Community</th><th>JDE</th><th>Plans</th><th>Avg cost / sq ft</th><th>Avg extended cost</th></tr></thead>
    <tbody>${list.map(c=>`<tr class="crow" data-comm="${esc(c.name||"")}">
      <td><b>${esc(c.name||"—")}</b></td><td class="mono">${esc(c.jde||"")}</td>
      <td>${c.plans.size}</td><td>${c.cp.length?money2(avg(c.cp)):"—"}</td>
      <td>${c.ex.length?money(avg(c.ex)):"—"}</td></tr>`).join("")}</tbody></table></div>`;
  a.querySelectorAll("[data-comm]").forEach(tr=>tr.onclick=()=>{
    state.q=tr.dataset.comm; state.view="plans"; setTab(); render(); });
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
  const paint=()=>{
    fill.style.left=pct(r.lo)+"%"; fill.style.width=Math.max(0,pct(r.hi)-pct(r.lo))+"%";
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
  const head=["Series","Series source","Homesite","Tier","Plan #","Plan name","Sq ft","Beds","Baths","Levels","Footprint",
              `Avg cost/sq ft (${basis})`,`Min cost/sq ft`,`Max cost/sq ft`,
              `Avg extended cost (${basis})`,`Min extended`,`Max extended`,
              "Avg sales price","Min price","Max price","Gross margin $","Gross margin %",
              "Plan status","Communities","Kind","Availability"];
  const body=list.map(p=>[seriesLabel(p.series),p.origin,p.site,p.tier,p.plan,p.name,p.sqft,p.beds,p.baths,p.sty,p.footprint,
    p.cpsf,p.cpsfLo,p.cpsfHi,p.ext,p.extLo,p.extHi,
    p.price,p.priceLo,p.priceHi,p.gm,p.gmPct,
    STATUS[p.status]||p.status,p.nComm,p.kind,p.awaiting?"awaiting pricing":""]);
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
  XLSX.writeFile(wb, `Plan-DB_${state.dataset||"export"}_${state.basis}_${new Date().toISOString().slice(0,10)}.xlsx`);
}

/* ---------------- BOOTSTRAP ---------------- */
if(!initRecovery()) checkSession();

