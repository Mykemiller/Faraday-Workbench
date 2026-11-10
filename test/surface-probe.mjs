// specifier is env-overridable, so this must be a dynamic import
const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* CC-WORKBENCH-SIGNAL-ROOM-TILE-1.0 — the Signal Room tile's public-surface line.
   The storefront RPC reports what is in the database; this line reports whether
   the public page is actually up. The cases that matter: a down surface is a RED
   finding even while the tile's database metrics look healthy, an unreadable
   health endpoint is never shown as up, and the probe adds to the storefront
   lane's conditions instead of replacing them. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PAGE_URL = process.env.WB_PAGE || ('file://' + path.join(REPO, 'index.html'));
const CHROME = process.env.WB_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const scoring = JSON.parse(fs.readFileSync(path.join(HERE,'fixtures','scoring-panels.payload.json'),'utf8'));
const other   = JSON.parse(fs.readFileSync(path.join(HERE,'fixtures','workbench-payloads.json'),'utf8'));
scoring.computed_at = new Date(Date.now() - 3*3600e3).toISOString();
const HEALTH = 'https://faraday-signal-room.com/api/signal-room/health';

const fails = [];
const ok = (c,m)=>{ console.log((c?'PASS':'FAIL')+'  '+m); if(!c) fails.push(m); };
const browser = await chromium.launch({ executablePath: CHROME });

/* Load the Workbench with one canned health response; return the tile line,
   the storefront lane's finding keys, and what the page requested. */
async function run({ health, probe = true }) {
  const page = await browser.newPage();
  const errs = [], asked = [];
  page.on('pageerror', e=>errs.push('JS EXCEPTION: '+e));
  if (probe) await page.addInitScript(()=>{ window.__WB_SURFACE_PROBE = true; });
  const serve = (name,body)=>page.route(`**/rpc/${name}`, r =>
    r.fulfill({status:200, contentType:'application/json', body:JSON.stringify(body)}));
  await serve('workbench_scoring_panels', scoring);
  await serve('workbench_health', other.health);
  await serve('workbench_idf', other.idf);
  await serve('workbench_forecast_model', other.forecast);
  await serve('workbench_storefront', other.storefront);
  await page.route(HEALTH, r => { asked.push(r.request().url());
    return health === 'abort' ? r.abort()
      : r.fulfill({status:health.status, contentType:'application/json',
          headers:{'access-control-allow-origin':'*'}, body:health.body}); });
  await page.goto(PAGE_URL);
  await page.waitForSelector('#storefronts .surf[data-surface="signal-room"]', {timeout:15000});
  if (probe) await page.waitForFunction(()=>
    !document.querySelector('#storefronts .surf[data-surface="signal-room"]').textContent.includes('checking'), null, {timeout:15000});
  await page.waitForTimeout(300);
  const out = await page.evaluate(()=>{
    const el = document.querySelector('#storefronts .surf[data-surface="signal-room"]');
    return {
      text: el.textContent,
      href: el.querySelector('a').getAttribute('href'),
      cls: el.querySelector('span').className,
      surfLines: document.querySelectorAll('#storefronts .surf').length,
      keys: (CONDITIONS.get('storefront')||[]).map(c=>c.key+'|'+c.sev),
      triage: document.body.innerText,
    };
  });
  await page.close();
  return { ...out, errs, asked };
}
const J = o => JSON.stringify(o);

/* 1 — healthy, launched feed */
let r = await run({ health:{ status:200, body:J({ok:true,status:'ok',live:true,signals:200,last24h:28,newestFiredAt:'2026-11-10T07:30:00.000Z'}) } });
ok(r.href==='https://faraday-signal-room.com/signal-room', 'tile links the public Signal Room surface');
ok(r.surfLines===1, 'only the Signal Room tile carries a surface line (got '+r.surfLines+')');
ok(/FEED LIVE · 28 in 24h · newest 11\/10\/26/.test(r.text), 'healthy feed reads FEED LIVE with the measured count — "'+r.text+'"');
ok(r.cls==='s-up', 'healthy feed is styled up');
ok(!r.keys.some(k=>k.includes('SIGNAL_ROOM.SURFACE')), 'a healthy surface raises no finding');
const baseKeys = r.keys;
ok(r.errs.length===0, 'no JS exceptions (healthy) '+r.errs.join(' | '));

/* 2 — the 2026-11-10 production state: reads fail, endpoint answers 503 */
r = await run({ health:{ status:503, body:J({ok:false,status:'query_failed',live:true,signals:0,last24h:0,newestFiredAt:null}) } });
ok(/FEED DOWN · query_failed/.test(r.text), 'down feed names the status — "'+r.text+'"');
ok(r.cls==='s-down', 'down feed is styled down');
ok(r.keys.includes('ESTATE.SIGNAL_ROOM.SURFACE_DOWN|red'), 'a down public surface is a RED finding');
ok(baseKeys.every(k=>r.keys.includes(k)), 'the probe adds to the storefront lane; it does not replace the board\'s own findings');
ok(/faraday-signal-room\.com is serving an error/.test(r.triage), 'the red finding is visible in the triage bar');

/* 3 — populated but behind the Signal Room's own launch flag */
r = await run({ health:{ status:200, body:J({ok:true,status:'ok',live:false,signals:200,last24h:3,newestFiredAt:'2026-11-10T07:30:00.000Z'}) } });
ok(/FEED UP · PREVIEW FLAG · 3 in 24h/.test(r.text), 'flag-off feed reads PREVIEW, not LIVE — "'+r.text+'"');
ok(!r.keys.some(k=>k.includes('SIGNAL_ROOM.SURFACE')), 'a preview surface raises no finding');

/* 4 — endpoint not deployed yet (404 HTML), and unreachable */
for (const [name,health] of [['404',{status:404,body:'<html>not found</html>'}],['network failure','abort']]) {
  r = await run({ health });
  ok(/surface health unreadable/.test(r.text) && !/LIVE|FEED UP/.test(r.text), name+': unreadable health is never shown as up — "'+r.text+'"');
  ok(r.keys.includes('ESTATE.SIGNAL_ROOM.SURFACE_UNREADABLE|amber'), name+': unreadable health is an AMBER finding');
  ok(r.errs.length===0, name+': no JS exceptions '+r.errs.join(' | '));
}

/* 5 — a truthy-but-wrong body must not read as up */
r = await run({ health:{ status:200, body:J({ok:'true',live:true,last24h:99}) } });
ok(!/LIVE|FEED UP/.test(r.text), 'ok:"true" (a string) is not healthy — "'+r.text+'"');

/* 6 — opened from disk without the opt-in, the page calls no other deployment */
r = await run({ health:{ status:200, body:J({ok:true,live:true,last24h:1}) }, probe:false });
ok(r.asked.length===0, 'no health request from a local file without the opt-in');
ok(/surface not probed/.test(r.text), 'the tile says the surface was not probed — "'+r.text+'"');

await browser.close();
console.log(fails.length ? '\n'+fails.length+' FAILED' : '\nALL PASS  surface-probe');
process.exit(fails.length?1:0);
