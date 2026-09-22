/* ============================================================
   Plan-DB — CORE product lineup: parser and roster matcher

   No DOM and no network, so the same file runs in load.html and under Node
   for testing. load.js does the reading and writing.

   THE SHEET
   One worksheet, read top to bottom. Four kinds of line matter:
     "TIER 2 SFD DETACHED"        section: tier and product type
     "(ORLANDO VERSION)"          which division(s) the NEXT plan belongs to;
                                  repeated before every versioned plan
     "2-4-2.5 UP 2 CAR"           stories-beds-baths, owner suite, garage;
                                  applies to the next plan
     qty 1, "COTTAGE - L056 KITSON"   a plan
   plus "SHELL / PLAN" blocks listing which plans each building holds.
   A plan with no version line is the regional CORE design (a generic number
   like 2520, or a lettered one no division is named for).

   THE MAPPING
   A plan's family is collection + name as printed: Kitson is L056 in
   Orlando, L076 in Tampa and 2520 as the CORE design, and all three are
   "COTTAGE|KITSON". That is what lines divisions up side by side. Numbers
   never cross divisions on their own.
   ============================================================ */
(function(root){
"use strict";

const norm = s => String(s==null?"":s).toUpperCase().replace(/\([^)]*\)/g," ")
                   .replace(/[^A-Z0-9]+/g," ").trim();
const title = s => String(s||"").toLowerCase()
  .replace(/\b([a-z])/g, c=>c.toUpperCase())
  .replace(/\bMc([a-z])/g, (m,c)=>"Mc"+c.toUpperCase());
const cellStr = v => v==null ? "" : String(v).replace(/\s+/g," ").trim();

/* Division keys a version line names. TX and GFC are other regions — the
   rows are kept in the lineup table but belong to no Plan-DB division. */
function versionDivs(v){
  const u=String(v||"").toUpperCase(), d=[];
  if(/ORLANDO|\bOLH\b/.test(u)) d.push("orlando");
  if(/TAMPA|\bTPU/.test(u))     d.push("tampa");
  if(/OCALA|\bOCA\b/.test(u))   d.push("ocala");
  return d;
}
/* "LO90" is L090 typed with a letter O. */
function fixCode(c){
  c=String(c||"").toUpperCase();
  const m=c.match(/^([A-Z])O(\d{2})$/);
  return m ? m[1]+"0"+m[2] : c;
}

const RX_TIER   = /^TIER\s+(\d+)\s+(.*?)(?:\s+CONTINUED)?$/i;
const RX_VER    = /^\((.+?)\s+VERSION\)$/i;
const RX_SHELLH = /^SHELL\s*\/\s*PLAN$/i;
const RX_CFG    = /^(\d(?:\.\d)?)-(\d)-(\d(?:\.\d)?)\s+(UP|DN)\b\s*(.*)$/i;
const RX_PLAN   = /^(.*?)\s*-?\s*\b([A-Z]{1,2}\d{2,3}|\d{3}[A-Z]|\d{4})\b\s*(.*)$/i;
const RX_SHELL  = /^([A-Z0-9]{3,4})\/([A-Z0-9,\/]+)\s+(.*?)\s*(?:\(([^)]*)\))?$/i;

function parseDate(aoa, fileName){
  for(const r of aoa.slice(0,8)) for(const v of (r||[])){
    const m=cellStr(v).match(/DATE:?\s*(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/i);
    if(m) return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  }
  const f=String(fileName||"").match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return f ? `${f[3]}-${f[1]}-${f[2]}` : null;
}

/* aoa: the sheet as an array of rows (column A first). */
function parse(aoa, fileName){
  const date=parseDate(aoa, fileName);
  const out=[]; const warn=[];
  let tier=null, product=null, version=null, cfg=null, cfgMas="", inShell=false, lastPlan=null;
  for(let i=0;i<aoa.length;i++){
    const r=aoa[i]||[]; const A=r[0], B=cellStr(r[1]);
    if(/^TOTAL/i.test(cellStr(A))) break;
    if(!B) continue;
    let m;
    if((m=B.match(RX_TIER))){ tier=m[1]; product=m[2].trim().toUpperCase(); version=null; cfg=null; inShell=false; continue; }
    if((m=B.match(RX_VER))){ version=m[1].trim().toUpperCase(); inShell=false; continue; }
    if(RX_SHELLH.test(B)){ inShell=true; continue; }
    if((m=B.match(RX_CFG))){
      cfg={ text:B, stories:m[1], beds:m[2], baths:m[3], suite:m[4].toUpperCase(),
            garage:(m[5]||"").trim().toUpperCase() };
      cfgMas=cellStr(r[9]); continue;
    }
    const qty=cellStr(A);
    if(qty==="1"){
      m=B.match(RX_PLAN);
      if(!m){ warn.push(`row ${i+1}: couldn't read a plan number in “${B}”`); continue; }
      const collection=m[1].replace(/[-\s]+$/,"").trim().toUpperCase();
      const rest=m[3]||"";
      const parens=(rest.match(/\(([^)]*)\)/g)||[]).join(" ").toUpperCase();
      const nameRaw=rest.replace(/\([^)]*\)/g," ").replace(/\s+/g," ").trim();
      const unit=/\bEND\b/.test(parens)?"End":/\bINT/.test(parens)?"Interior":null;
      const sq=r.slice(12,24).find(v=>typeof v==="number" && isFinite(v));
      const mas=[cellStr(r[9]),cfgMas].filter(Boolean).join(" / ");
      const rec={
        seq:i+1, kind:"plan", tier, product, collection,
        plan_code:fixCode(m[2]), plan_name:title(nameRaw), unit,
        nextgen:/NEXTGEN/.test(parens),
        version:version||"CORE", divisions:versionDivs(version),
        config:cfg?cfg.text:null, stories:cfg?cfg.stories:null, beds:cfg?cfg.beds:null,
        baths:cfg?cfg.baths.replace(/\.0$/,""):null, owner_suite:cfg?cfg.suite:null, garage:cfg?(cfg.garage||null):null,
        elevations:r.slice(2,9).map(cellStr).filter(Boolean).join(",")||null,
        masonry:mas||null, plan_width:cellStr(r[10])||null, plan_depth:cellStr(r[11])||null,
        sqft: sq==null?null:sq,
        family: norm(collection)+"|"+norm(nameRaw), members:null
      };
      out.push(rec); lastPlan=rec;
      version=null; cfg=null; cfgMas=""; inShell=false;
      continue;
    }
    if(inShell && (m=B.match(RX_SHELL))){
      const tag=(m[4]||"").toUpperCase();
      const divs = tag ? versionDivs(tag) : (lastPlan?lastPlan.divisions.slice():[]);
      out.push({ seq:i+1, kind:"shell", tier, product, collection:lastPlan?lastPlan.collection:null,
        plan_code:fixCode(m[1]), plan_name:title(m[3].replace(/[,\/]\s*/g,", ")), unit:null, nextgen:false,
        version: tag||(lastPlan?lastPlan.version:"CORE"), divisions:divs,
        config:null, stories:null, beds:null, baths:null, owner_suite:null, garage:null,
        elevations:null, masonry:null, plan_width:null, plan_depth:null, sqft:null,
        family:null, members:m[2].split(/[,\/]/).filter(Boolean).map(fixCode).join(",") });
      continue;
    }
  }
  return { date, rows:out, warnings:warn };
}

/* Two names agree when, ignoring case, punctuation and anything in brackets,
   one is the other or starts with it: "Summit (End)" = SUMMIT,
   "Crestone II" = CRESTONE. A blank roster name agrees with anything. */
function namesAgree(a,b){
  const x=norm(a), y=norm(b);
  if(!x||!y) return true;
  if(x===y || x.startsWith(y+" ") || y.startsWith(x+" ")) return true;
  return x.replace(/ /g,"")===y.replace(/ /g,"");     // "Deniro" = DE NIRO
}

const PLAN_COLS=["division","plan_no","name","series","homesite","tier","series_origin","core_alias",
  "sqft","beds","baths","levels","garage","footprint","matrix_community","permit_ready","plan_pending",
  "core_family","collection","plan_width","plan_depth","masonry","elevations","lineup_config",
  "lineup_sqft","lineup_date","updated_at","updated_by"];

/* Work out what the sheet changes in the roster. Nothing is written here.
   roster: every pdb_plans row, all divisions. knownSeries: series names the
   app already uses, so "CLASSIC" lands on the existing "Classic".
   Returns full rows (every column) so the upsert can never null a column it
   didn't mean to touch. */
function plan(parsed, roster, opts){
  opts=opts||{};
  const divs=opts.divisions||["orlando","tampa","ocala"];
  const known=(opts.knownSeries||[]).reduce((m,s)=>{ m[norm(s)]=s; return m; },{});
  const now=opts.now||new Date().toISOString();
  const by=new Map(); divs.forEach(d=>by.set(d,new Map()));
  (roster||[]).forEach(r=>{ const m=by.get(r.division); if(m) m.set(String(r.plan_no).toUpperCase(), r); });
  const seriesFor=L=>known[norm(L.collection)]||title(L.collection);
  const rep={ matched:[], added:[], conflicts:[], tierChanges:[], seriesSet:[], sqftFixes:[], unplaced:[], other:[] };
  const touched=new Map();          // div|plan -> row
  const full=r=>{ const o={}; PLAN_COLS.forEach(k=>{ o[k]=r[k]===undefined?null:r[k]; });
    o.plan_pending=!!o.plan_pending;            // NOT NULL in the table
    if(!o.series_origin) o.series_origin="unassigned";
    return o; };

  for(const L of parsed.rows){
    if(L.kind!=="plan") continue;
    const code=L.plan_code;
    if(!code || /^0+$/.test(code)){ rep.other.push({L, why:"no plan number yet"}); continue; }
    const versioned=L.divisions.length>0;
    // A versioned plan belongs to the divisions it names. A CORE plan only
    // attaches where a division already carries that number under the same
    // name — a number alone never crosses divisions.
    const targets = versioned ? L.divisions.filter(d=>by.has(d)) : divs.filter(d=>by.get(d).has(code));
    if(!targets.length){
      if(versioned || !/^\d/.test(code)) rep.unplaced.push({L});
      else rep.other.push({L, why:"CORE design, not used by a division under this number"});
      continue;
    }
    for(const d of targets){
      const key=d+"|"+code;
      const ex=touched.get(key) || by.get(d).get(code);
      if(ex){
        if(!namesAgree(ex.name, L.plan_name)){
          if(versioned) rep.conflicts.push({division:d, plan_no:code, roster:ex.name, lineup:L.plan_name, L});
          continue;
        }
        // A CORE row only has the number to go on, so the roster must carry a
        // name that agrees — an unnamed plan sharing the number is not proof.
        if(!versioned && !String(ex.name||"").trim()){
          rep.other.push({L, why:`${d} ${code} has no name to confirm it`}); continue;
        }
        const r=full(ex);
        r.core_family=L.family; r.collection=title(L.collection);
        r.plan_width=L.plan_width; r.plan_depth=L.plan_depth; r.masonry=L.masonry;
        r.elevations=L.elevations; r.lineup_config=L.config; r.lineup_sqft=L.sqft;
        r.lineup_date=parsed.date;
        if(L.tier && String(ex.tier||"")!==L.tier){
          if(ex.tier) rep.tierChanges.push({division:d, plan_no:code, name:ex.name, from:ex.tier, to:L.tier});
          r.tier=L.tier;
        }
        if(!r.name) r.name=L.plan_name+(L.unit?` (${L.unit})`:"");
        // Blank sizes are filled; a size more than 8% off the sheet is replaced
        // and reported. Those come from a bad workbook row (Tampa's Frey, Nash,
        // Springsteen and Santana at 3,041 from one Cypress Point block).
        if(L.sqft!=null){
          const cur=r.sqft==null?null:+r.sqft;
          if(cur==null) r.sqft=L.sqft;
          else if(Math.abs(cur-L.sqft)/L.sqft>0.08){ rep.sqftFixes.push({division:d, plan_no:code, name:r.name, from:cur, to:L.sqft}); r.sqft=L.sqft; }
        }
        if(!r.beds && L.beds) r.beds=L.beds;
        if(!r.baths && L.baths) r.baths=L.baths;
        if(!r.levels && L.stories) r.levels=L.stories;
        if(!r.garage && L.garage) r.garage=L.garage;
        const weak = !r.series || r.series==="LEGACY" || ["inferred","unassigned"].includes(r.series_origin);
        if(weak && r.series!=="SHELL"){
          const s=seriesFor(L);
          rep.seriesSet.push({division:d, plan_no:code, name:r.name, from:r.series||"—", to:s});
          r.series=s; r.series_origin="lineup";
        }
        r.updated_at=now; r.updated_by=opts.email||null;
        touched.set(key, r); rep.matched.push({division:d, plan_no:code, name:r.name, family:L.family});
      } else {
        const r=full({ division:d, plan_no:code, name:L.plan_name+(L.unit?` (${L.unit})`:""),
          series:seriesFor(L), tier:L.tier, series_origin:"lineup", sqft:L.sqft, beds:L.beds,
          baths:L.baths, levels:L.stories, garage:L.garage, plan_pending:false,
          core_family:L.family, collection:title(L.collection), plan_width:L.plan_width,
          plan_depth:L.plan_depth, masonry:L.masonry, elevations:L.elevations,
          lineup_config:L.config, lineup_sqft:L.sqft, lineup_date:parsed.date,
          updated_at:now, updated_by:opts.email||null });
        touched.set(key, r); rep.added.push({division:d, plan_no:code, name:r.name, family:L.family});
        by.get(d).set(code, r);
      }
    }
  }
  return { rows:[...touched.values()], report:rep };
}

/* Rows for pdb_core_lineup. */
function lineupRows(parsed, fileName){
  return parsed.rows.map(L=>({ lineup_date:parsed.date, seq:L.seq, kind:L.kind, tier:L.tier, product:L.product,
    collection:L.collection, plan_code:L.plan_code, plan_name:L.plan_name, unit:L.unit, nextgen:!!L.nextgen,
    version:L.version, divisions:L.divisions, config:L.config, stories:L.stories, beds:L.beds, baths:L.baths,
    owner_suite:L.owner_suite, garage:L.garage, elevations:L.elevations, masonry:L.masonry,
    plan_width:L.plan_width, plan_depth:L.plan_depth, sqft:L.sqft, family:L.family, members:L.members,
    source_file:fileName||null }));
}

const api={ parse, plan, lineupRows, namesAgree, norm, title, PLAN_COLS };
if(typeof module!=="undefined" && module.exports) module.exports=api;
root.PdbLineup=api;
})(typeof window!=="undefined"?window:globalThis);
