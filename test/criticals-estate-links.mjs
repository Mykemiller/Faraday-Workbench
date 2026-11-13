/* FDY-324 · CC-WORKBENCH-CRITICALS-ESTATE-LINKS-1.0
   Pure-function checks pulled straight out of index.html (no browser needed):
   D-1 Estate severity, OPEN ↗ link rendering, FIX-text linkify, staleness colours,
   and static checks on the three migration files. */
import fs from 'node:fs'; import vm from 'node:vm'; import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function grab(name){                       // source of `function name(...){...}` by brace matching
  const i = html.indexOf('function ' + name + '('); assert.ok(i >= 0, 'missing ' + name);
  let d = 0, j = html.indexOf('{', i);
  for (let k = j; k < html.length; k++) { if (html[k] === '{') d++; else if (html[k] === '}' && --d === 0) return html.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
const ctx = vm.createContext({});
vm.runInContext(`
  const esc=s=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const KSLUG=s=>String(s||"").toUpperCase().replace(/[^A-Z0-9]+/g,"_").replace(/^_+|_+$/g,"").slice(0,64)||"UNKNOWN";
  const cond=(key,sev,text,view,anchor,detail)=>({key,sev,text,view,anchor,detail});
  ${['estateTileCond','openLinkHtml','linkifyEsc','stalenessClass'].map(grab).join('\n')}
`, ctx);
const run = (c) => vm.runInContext(c, ctx);
const tile = (o) => ({ slug: 'x', name: 'X', status: 'warn', status_tag: 'XX 01.01 · JUST FUNCTIONING', blurb: 'b', ...o });

// D-1
const amber = run('estateTileCond')(tile({ name: 'ISpyaDC', slug: 'ispyadc' }), { state: 'ok', keys: [] }, null);
assert.equal(amber.sev, 'amber'); assert.match(amber.text, /^ISpyaDC — maturity IS|^ISpyaDC — maturity XX/);
const red = run('estateTileCond')(tile({ name: 'Estate Security', slug: 'estate-security', status_tag: 'RED · 5 URGENT' }),
  { state: 'ok', keys: ['FDY-205', 'FDY-206', 'FDY-208', 'FDY-119'] }, null);
assert.equal(red.sev, 'red'); assert.equal(red.key, 'ESTATE.ESTATE_SECURITY.RED_5_URGENT'); assert.match(red.text, /4 Urgent open/);
assert.equal(run('estateTileCond')(tile(), { state: 'ok', keys: [] }, { state: 'down', text: 't' }).sev, 'red');
assert.equal(run('estateTileCond')(tile(), { state: 'unreadable', keys: [] }, null).sev, 'amber');
assert.equal(run('estateTileCond')(tile({ status: 'live' }), { state: 'ok', keys: ['FDY-1'] }, null), null);
assert.equal(run('estateTileCond')(tile({ slug: 'boundstone', name: 'Boundstone', status_tag: 'BS 01.03 · JUST FUNCTIONING' }), { state: 'ok', keys: [] }, null).key,
  'ESTATE.BOUNDSTONE.BS_01_03_JUST_FUNCTIONING');            // key is stable, so a re-rate is not a clear

// OPEN link
const open = run('openLinkHtml');
assert.match(open({ live_url: 'https://ispyadc.com' }), /href="https:\/\/ispyadc.com" target="_blank" rel="noopener noreferrer"/);
assert.match(open({ live_url: 'https://ispyadc.com' }), />OPEN ↗</);
for (const bad of [null, '', 'javascript:alert(1)', 'ispyadc.com']) assert.match(open({ live_url: bad }), /NO LIVE URL/);
assert.doesNotMatch(open({ live_url: null }), /<a /);

// FIX linkify
const lk = run('linkifyEsc')('See https://linear.app/my-faraday/issue/FDY-205. <b>x</b>');
assert.match(lk, /<a href="https:\/\/linear.app\/my-faraday\/issue\/FDY-205" target="_blank" rel="noopener noreferrer">[^<]*<\/a>\./);
assert.match(lk, /&lt;b&gt;/);

// staleness (D-5)
const hrs = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const sc = run('stalenessClass');
assert.equal(sc(hrs(1)), ''); assert.equal(sc(hrs(27)), 's-amber'); assert.equal(sc(hrs(49)), 's-red'); assert.equal(sc(null), '');

// static: page wiring + migrations
assert.doesNotMatch(html, /animation:tick/, 'ticker must not scroll');
assert.match(html, /await probeUrgent\(\)/);
assert.match(html, /FETCH_FAILED\$\|STOREFRONT\\.FALLBACK_COPY\$/, 'degraded reads must not sync');
for (const f of ['wb_criticals_prestate_snapshots', 'wb_storefront_tiles_add_live_url', 'wb_finding_remediation_seed_estate']) {
  const q = fs.readFileSync(new URL(`../sql/${f}.sql`, import.meta.url), 'utf8');
  assert.doesNotMatch(q, /\b(jpas_|jds_|jts_)\w*\s*(set|=)|update\s+public\.(jurisdictions|jpas|jds)/i, f + ' must not write scoring tables');
  assert.doesNotMatch(q, /drop\s+(function|table)\s/i);
}
const seed = fs.readFileSync(new URL('../sql/wb_finding_remediation_seed_estate.sql', import.meta.url), 'utf8');
assert.match(seed, /on conflict \(finding_key\) do nothing/);
console.log('criticals-estate-links: all checks passed');
