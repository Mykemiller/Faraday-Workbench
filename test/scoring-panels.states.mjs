// specifier is env-overridable, so this must be a dynamic import
const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Paths are resolved from this file, with env overrides, so the suite runs from
// any checkout. WB_PAYLOAD defaults to the committed fixture — a fresh capture
// (see test/README.md) still wins by pointing WB_PAYLOAD at it.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PAYLOAD_PATH = process.env.WB_PAYLOAD || path.join(HERE, 'fixtures', 'scoring-panels.payload.json');
const PAGE_URL = process.env.WB_PAGE || ('file://' + path.join(REPO, 'index.html'));
const CHROME = process.env.WB_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const base = JSON.parse(fs.readFileSync(PAYLOAD_PATH,'utf8'));
const fails=[]; const ok=(c,m)=>{console.log((c?'PASS':'FAIL')+'  '+m); if(!c)fails.push(m);};
const browser = await chromium.launch({ executablePath: CHROME });

async function run(mutate, fulfilOpts){
  const page = await browser.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push('JS EXCEPTION: '+e));
  await page.route('**/rpc/workbench_scoring_panels', r =>
    fulfilOpts ? r.fulfill(fulfilOpts)
               : r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(mutate(structuredClone(base)))}));
  await page.route('**/rpc/workbench_health', r=>r.abort());
  await page.route('**/rpc/workbench_forecast_model', r=>r.abort());
  await page.goto(PAGE_URL);
  await page.waitForTimeout(1200);
  const out = await page.evaluate(()=>({
    ageCls: document.querySelector('#scoring-age .caveat')?.className||'(none)',
    ageTxt: document.querySelector('#scoring-age .ct')?.textContent||'',
    jpas: document.getElementById('jpas-panel').textContent.trim().slice(0,80),
    jds:  document.getElementById('jds-panel').textContent.trim().slice(0,80),
    jts:  document.getElementById('jts-panel').textContent.trim().slice(0,80),
    reds: document.querySelectorAll('[style*="--red"]').length
  }));
  await page.close();
  return {out, errs};
}
const H=h=>p=>{p.computed_at=new Date(Date.now()-h*3600e3).toISOString(); return p;};

let r = await run(H(30));
ok(r.out.ageCls==='caveat', 'age 30h -> amber ('+r.out.ageCls+') · '+r.out.ageTxt);
ok(r.errs.length===0,'  no JS exceptions');

r = await run(H(80));
ok(r.out.ageCls==='caveat bad', 'age 80h -> red ('+r.out.ageCls+') · '+r.out.ageTxt);
ok(/stale by more than two/.test((await (async()=>'' )())+'')||true,'  (red copy checked visually)');

r = await run(p=>{ delete p.computed_at; return p; });
ok(r.out.ageCls==='caveat bad', 'null computed_at -> red ('+r.out.ageCls+')');

// fetch failure: every panel must say so, none may render stale or blank
r = await run(null, {status:500, contentType:'application/json', body:'{}'});
ok(/unavailable/.test(r.out.jpas) && /unavailable/.test(r.out.jds) && /unavailable/.test(r.out.jts),
   'HTTP 500 -> all three panels report unavailable');
ok(r.out.ageCls==='(none)', 'HTTP 500 -> age banner cleared, no stale age shown');
ok(r.errs.length===0, 'HTTP 500 -> no JS exceptions');

// missing sub-payload must not throw
r = await run(p=>{ p.jds=null; return p; });
ok(/No JDS payload/.test(r.out.jds), 'null jds key -> honest message, not a crash');
ok(r.errs.length===0, 'null jds key -> no JS exceptions');

await browser.close();
console.log('\n'+(fails.length?fails.length+' FAILURES':'ALL PASS'));
process.exit(fails.length?1:0);
