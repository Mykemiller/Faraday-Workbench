// specifier is env-overridable, so this must be a dynamic import
const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* CC-WORKBENCH-IA-1.0 — the view split and the triage bar.
   The whole point of the redesign is that hiding panels behind tabs must NOT
   bury bad news (CC-WORKBENCH-SCORING-PANELS-UI-1.0 §5.2). So the assertions
   that matter most here are: every red condition is visible without opening a
   disclosure, and it is reachable from wherever you are. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PAGE_URL = process.env.WB_PAGE || ('file://' + path.join(REPO, 'index.html'));
const CHROME = process.env.WB_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const scoring = JSON.parse(fs.readFileSync(path.join(HERE,'fixtures','scoring-panels.payload.json'),'utf8'));
const other   = JSON.parse(fs.readFileSync(path.join(HERE,'fixtures','workbench-payloads.json'),'utf8'));
scoring.computed_at = new Date(Date.now() - 3*3600e3).toISOString();

const fails = [];
const ok = (c,m)=>{ console.log((c?'PASS':'FAIL')+'  '+m); if(!c) fails.push(m); };

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
const errs=[];
page.on('pageerror', e=>errs.push('JS EXCEPTION: '+e));
page.on('console', m=>{ if(m.type()==='error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });

const serve = (name,body)=>page.route(`**/rpc/${name}`, r =>
  r.fulfill({status:200, contentType:'application/json', body:JSON.stringify(body)}));
await serve('workbench_scoring_panels', scoring);
await serve('workbench_health', other.health);
await serve('workbench_idf', other.idf);
await serve('workbench_forecast_model', other.forecast);
await serve('workbench_storefront', other.storefront);

await page.goto(PAGE_URL);
await page.waitForFunction(()=>document.querySelectorAll('#viewnav .vc').length>0 ||
  document.getElementById('verdict')?.textContent.includes('CLEAR'), null, {timeout:15000});
await page.waitForTimeout(400);

ok(errs.length===0, 'no JS exceptions' + (errs.length?': '+errs.slice(0,3).join(' | '):''));

// ---- views ----
const v = await page.evaluate(()=>({
  js: document.body.classList.contains('js-views'),
  visible: ['estate','feeds','scoring','idf','links'].filter(id=>{
    const el=document.getElementById(id); return el && getComputedStyle(el).display!=='none'; }),
  tabs: [...document.querySelectorAll('#viewnav button')].map(b=>b.dataset.view),
  selected: document.querySelector('#viewnav button[aria-selected="true"]')?.dataset.view,
  roving: [...document.querySelectorAll('#viewnav button')].filter(b=>b.tabIndex===0).length
}));
ok(v.js, 'progressive enhancement: js-views applied by script');
ok(v.tabs.join()==='estate,feeds,scoring,idf,links', 'five views registered: '+v.tabs.join(', '));
ok(v.visible.length===1, `exactly one view visible (${v.visible.join(', ')||'none'})`);
ok(v.selected==='estate', 'estate is the default view ('+v.selected+')');
ok(v.roving===1, `roving tabindex: exactly one tab is focusable (${v.roving})`);

// every panel still renders even while its view is hidden
const rendered = await page.evaluate(()=>['storefronts','idf-health','dc-health','forecast-model',
  'jpas-panel','jds-panel','jts-panel','idf-pillars','idf-drift','stats']
  .filter(id=>{const e=document.getElementById(id); return e && e.children.length>0 && !/Loading/.test(e.textContent);}));
ok(rendered.length===10, `all 10 panels render regardless of view visibility (${rendered.length}/10)`);

// ---- triage: the §5.2 rule applied at page scale ----
const tr = await page.evaluate(()=>{
  const bar=document.getElementById('triage-in');
  const inDetails=el=>!!el.closest('details');
  const chips=[...bar.querySelectorAll('.chip[data-view]')];
  return {
    verdict: document.getElementById('verdict')?.textContent.trim(),
    red: chips.filter(c=>c.classList.contains('red')).map(c=>c.textContent),
    redHidden: chips.filter(c=>c.classList.contains('red')&&inDetails(c)).length,
    amber: chips.filter(c=>c.classList.contains('amber')).length,
    views: [...new Set(chips.map(c=>c.dataset.view))],
    anchored: chips.filter(c=>c.dataset.anchor).length,
    counts: [...document.querySelectorAll('#viewnav .vc')].length
  };
});
ok(tr.red.length>0, `triage surfaces ${tr.red.length} critical condition(s)`);
ok(tr.redHidden===0, 'NO critical condition is hidden behind a disclosure (§5.2 at page scale)');
ok(/CRITICAL/.test(tr.verdict||''), 'verdict states the critical count: '+tr.verdict);
ok(tr.counts>0, `tab badges carry per-view counts (${tr.counts})`);
ok(tr.anchored===tr.red.length+tr.amber, 'every chip links back to the panel that owns it');

// conditions are drawn from more than one payload, i.e. the bar spans views
ok(tr.views.length>=2, `triage spans ${tr.views.length} views: ${tr.views.join(', ')}`);

// the known-live defects must each appear
const txt = tr.red.join(' | ') + ' | ' + await page.evaluate(()=>document.getElementById('triage-in').textContent);
ok(/JTS: no model registered/i.test(txt), 'JTS "no model registered" reaches the triage bar');
ok(/flat layer columns/i.test(txt), 'JDS stale flat columns reaches the triage bar');
ok(/linkage engines/i.test(txt), 'IDF three-live-linkage-engines reaches the triage bar');

// ---- navigation ----
await page.click('#tab-scoring');
let cur = await page.evaluate(()=>({sel:document.querySelector('#viewnav button[aria-selected="true"]')?.dataset.view,
  vis:['estate','feeds','scoring','idf','links'].filter(id=>getComputedStyle(document.getElementById(id)).display!=='none'),
  hash:location.hash}));
ok(cur.sel==='scoring' && cur.vis.join()==='scoring', 'clicking a tab switches the view');
ok(cur.hash==='#scoring', 'hash tracks the active view ('+cur.hash+')');

await page.focus('#tab-scoring');
await page.keyboard.press('ArrowRight');
cur = await page.evaluate(()=>document.querySelector('#viewnav button[aria-selected="true"]')?.dataset.view);
ok(cur==='idf', 'ArrowRight moves to the next view ('+cur+')');
await page.keyboard.press('Home');
cur = await page.evaluate(()=>document.querySelector('#viewnav button[aria-selected="true"]')?.dataset.view);
ok(cur==='estate', 'Home returns to the first view ('+cur+')');

// a triage chip navigates to the owning view
const jumped = await page.evaluate(async ()=>{
  const c=[...document.querySelectorAll('#triage-in .chip[data-view]')].find(x=>x.dataset.view==='scoring');
  if(!c) return null; c.click(); await new Promise(r=>setTimeout(r,150));
  return document.querySelector('#viewnav button[aria-selected="true"]')?.dataset.view;
});
ok(jumped==='scoring', 'clicking a triage chip jumps to the owning view ('+jumped+')');

// deep links, including the legacy anchors the split would otherwise have broken
for (const [hash, want] of [['#scoring','scoring'],['#idf','idf'],['#observability','estate'],['#jds-panel','scoring']]) {
  await page.evaluate(h=>{location.hash=h;}, hash);
  await page.waitForTimeout(120);
  const got = await page.evaluate(()=>document.querySelector('#viewnav button[aria-selected="true"]')?.dataset.view);
  ok(got===want, `deep link ${hash} resolves to the ${want} view (${got})`);
}

// ---- the season fix ----
const season = await page.evaluate(()=>{
  const el=document.getElementById('dc-health');
  return {pill: el.querySelector('.pill')?.textContent, line: el.querySelector('.seasonbar')?.textContent};
});
ok(season.pill==='ACTIVE', `an active season reads ACTIVE, not CLOSED (${season.pill})`);
ok(/1 day left/.test(season.line||''), 'days-left is stated truthfully: '+ (season.line||'').trim());
ok(!/between seasons/.test(season.line||''), 'an active season is not labelled "between seasons"');

// ---- folds never swallow a caveat ----
const cavInFold = await page.evaluate(()=>document.querySelectorAll('details.fold .caveat').length);
ok(cavInFold===0, `no caveat is nested inside a fold (${cavInFold})`);

// ---- the scrolling budget this redesign exists to fix ----
const heights={};
for (const v of ['estate','feeds','scoring','idf','links']) {
  await page.click('#tab-'+v); await page.waitForTimeout(150);
  heights[v] = await page.evaluate(()=>document.documentElement.scrollHeight);
}
const deepest = Math.max(...Object.values(heights));
ok(deepest < 4500, `deepest view is ${deepest}px (~${(deepest/900).toFixed(1)} screens at 900px) — was ~10,600px in one column`);
console.log('      per view: ' + Object.entries(heights).map(([k,v])=>`${k} ${v}`).join(' · '));

await page.screenshot({ path: process.env.WB_SHOT || '/tmp/ia.png', fullPage:true });

// ---- progressive enhancement: with JS off the page must not hide anything ----
const noJs = await browser.newContext({ javaScriptEnabled:false });
const np = await noJs.newPage();
await np.goto(PAGE_URL);
const shown = await np.evaluate(()=>['estate','feeds','scoring','idf','links']
  .filter(id=>getComputedStyle(document.getElementById(id)).display!=='none'));
ok(shown.length===5, `JS disabled: all five sections stay visible, nothing is trapped behind a tab (${shown.length}/5)`);
await noJs.close();

await browser.close();
console.log('\n'+(fails.length?fails.length+' FAILURES':'ALL PASS'));
process.exit(fails.length?1:0);
