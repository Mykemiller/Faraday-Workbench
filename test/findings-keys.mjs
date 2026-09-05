/* CC-WORKBENCH-FINDINGS-REMEDIATION-1.0
 * D1 every finding carries a stable unique finding_key
 * D4 a key present before and absent after renders as a CLEARED chip
 * D5 a CRITICAL chip expands to a remediation panel with a Copy button
 * D6 a key with no authored row renders the literal "No remediation authored"
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_URL = 'file://' + path.join(HERE, '..', 'index.html');
const CHROME = process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium';

const scoring = JSON.parse(fs.readFileSync(path.join(HERE,'fixtures','scoring-panels.payload.json'),'utf8'));
const other   = JSON.parse(fs.readFileSync(path.join(HERE,'fixtures','workbench-payloads.json'),'utf8'));

const fails = [];
const ok = (c,m)=>{ console.log((c?'PASS':'FAIL')+'  '+m); if(!c) fails.push(m); };

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
const errs=[];
page.on('pageerror', e=>errs.push('JS EXCEPTION: '+e));

// One seeded key + one deliberately unseeded key, so D6 is exercised for real.
const SEEDED = 'SCORING.JTS.NO_MODEL_REGISTERED';
const syncBody = {
  synced: true,
  cleared: [{ key:'SCORING.JDS.COMPOSER_NO_SCHEDULE', lane:'Scoring', severity:'red',
              headline:'JDS composer runs on no schedule', cleared_at:new Date().toISOString() }],
  remediation: { [SEEDED]: { lane:'SCORING', severity:'critical',
    plain_english:'PLAIN ENGLISH MARKER', cc_prompt_seed:'CC PROMPT SEED MARKER' } }
};

const serve = (name,body)=>page.route(`**/rpc/${name}`, r =>
  r.fulfill({status:200, contentType:'application/json', body:JSON.stringify(body)}));
await serve('workbench_scoring_panels', scoring);
await serve('workbench_health', other.health);
await serve('workbench_idf', other.idf);
await serve('workbench_forecast_model', other.forecast);
await serve('workbench_storefront', other.storefront);
await serve('workbench_findings_sync', syncBody);

await page.goto(PAGE_URL);
await page.waitForFunction(()=>document.querySelectorAll('#triage-in .chip[data-key]').length>0,
  null, {timeout:15000});
await page.waitForTimeout(500);

ok(errs.length===0, 'no JS exceptions' + (errs.length?': '+errs.slice(0,3).join(' | '):''));

// ---- D1: every finding carries a key, and keys are unique ----
const keys = await page.evaluate(()=>[...document.querySelectorAll('#triage-in .chip[data-view]')]
  .map(b=>b.dataset.key||''));
ok(keys.length>0, `findings rendered (${keys.length})`);
ok(keys.every(k=>k.length>0), `every finding carries a finding_key (${keys.filter(k=>k).length}/${keys.length})`);
const uniq = new Set(keys);
ok(uniq.size===keys.length, `finding_keys are unique (${uniq.size}/${keys.length})`);
const FMT = /^[A-Z0-9]+(\.[A-Z0-9_]+){2,}$/;
const badFmt = keys.filter(k=>!FMT.test(k));
ok(badFmt.length===0, 'every key is uppercase dot-delimited LANE.SUBJECT.CONDITION'
  + (badFmt.length?': '+badFmt.slice(0,3).join(', '):''));

// ---- canonical keys the CC names, for findings this fixture actually raises ----
for (const k of ['SCORING.JTS.NO_MODEL_REGISTERED','SCORING.JDS.FLAT_LAYER_COLUMNS_STALE',
                 'IDF5.LINKAGE.THREE_ENGINES_LIVE','SCORING.JPAS.RSC_IMPUTED_91PCT',
                 'SCORING.JPAS.CONF_MULT_COMPLETENESS_ONLY'])
  ok(keys.includes(k), `canonical key present: ${k}`);

/* D1 STABILITY. The RSC key reads "..._91PCT" but that is a FROZEN LABEL, not a
   live reading: it is generated from tier_code. Re-render with a different
   imputation percentage and a different weight; the key must not move, or
   "before vs after" comparison breaks the moment the number it names changes. */
{
  const drifted = JSON.parse(JSON.stringify(scoring));
  for (const t of drifted.jpas.live_tiers)
    if (t.tier_code === 'RSC') { t.imputation.pct_imputed = 93.4; t.tier_weight = 7; }
  const p2 = await browser.newPage();
  const serve2 = (name,body)=>p2.route(`**/rpc/${name}`, r =>
    r.fulfill({status:200, contentType:'application/json', body:JSON.stringify(body)}));
  await serve2('workbench_scoring_panels', drifted);
  await serve2('workbench_health', other.health);
  await serve2('workbench_idf', other.idf);
  await serve2('workbench_forecast_model', other.forecast);
  await serve2('workbench_storefront', other.storefront);
  await serve2('workbench_findings_sync', syncBody);
  await p2.goto(PAGE_URL);
  await p2.waitForFunction(()=>document.querySelectorAll('#triage-in .chip[data-key]').length>0,
    null, {timeout:15000});
  const after = await p2.evaluate(()=>[...document.querySelectorAll('#triage-in .chip[data-view]')]
    .map(b=>({key:b.dataset.key,text:b.textContent})));
  const rsc = after.find(x=>x.key.startsWith('SCORING.JPAS.RSC'));
  ok(!!rsc, 'RSC imputation finding still raised after drift');
  ok(!!rsc && rsc.key==='SCORING.JPAS.RSC_IMPUTED_91PCT',
    `finding_key is STABLE across a value change (${rsc && rsc.key})`);
  ok(!!rsc && /93\.4% imputed at weight 7/.test(rsc.text),
    'headline still reflects the LIVE value, only the key is frozen');
  await p2.close();
}

// ---- D4: CLEARED chip ----
const cleared = await page.evaluate(()=>{
  const el=document.querySelector('#triage-in .chip.cleared');
  if(!el) return null;
  const cs=getComputedStyle(el);
  return { text:el.textContent, border:cs.borderLeftColor, borderTop:cs.borderTopColor };
});
ok(!!cleared, 'a CLEARED chip renders for a key that disappeared');
ok(!!cleared && /Cleared/i.test(cleared.text), 'CLEARED chip is labelled');
ok(!!cleared && /JDS composer/.test(cleared.text), 'CLEARED chip names the finding that cleared');
// gold is #C4922A -> rgb(196, 146, 42)
ok(!!cleared && cleared.border.includes('196, 146, 42'),
  `CLEARED chip is gold-outlined (${cleared && cleared.border})`);

// ---- D5: remediation panel on a CRITICAL chip ----
await page.click(`.rembtn[data-rem="${SEEDED}"]`);
await page.waitForTimeout(200);
const panel = await page.evaluate(()=>{
  const el=document.querySelector('#triage-in .rem');
  return el ? { text:el.innerText, hasCopy:!!el.querySelector('.copybtn'),
                seed:(el.querySelector('.remseed')||{}).textContent||'' } : null;
});
ok(!!panel, 'CRITICAL chip expands to a remediation panel');
ok(!!panel && panel.text.includes('PLAIN ENGLISH MARKER'), 'panel shows authored plain_english');
ok(!!panel && panel.seed.includes('CC PROMPT SEED MARKER'), 'panel shows the cc_prompt_seed block');
ok(!!panel && panel.hasCopy, 'cc_prompt_seed block carries a Copy button');

// warnings must NOT carry a remediation toggle — D5 says CRITICAL only
const amberRem = await page.evaluate(()=>
  [...document.querySelectorAll('#triage-in .chip.amber')]
    .filter(c=>c.nextElementSibling && c.nextElementSibling.classList.contains('rembtn')).length);
ok(amberRem===0, 'WARNING chips carry no remediation toggle');

// ---- D6: unseeded key renders the literal honesty string ----
await page.click(`.rembtn[data-rem="${SEEDED}"]`);           // collapse
const unseeded = await page.evaluate(()=>{
  const b=[...document.querySelectorAll('.rembtn[data-rem]')]
    .find(x=>x.dataset.rem!=='SCORING.JTS.NO_MODEL_REGISTERED');
  if(!b) return null; b.click();
  const el=document.querySelector('#triage-in .rem');
  return el?{key:b.dataset.rem,text:el.innerText}:null;
});
ok(!!unseeded, 'an unseeded CRITICAL also expands');
ok(!!unseeded && unseeded.text.includes('No remediation authored'),
  `unauthored finding renders the literal string (${unseeded && unseeded.key})`);

// ---- D3: both controls exist ----
const ctl = await page.evaluate(()=>({
  reread:!!document.getElementById('btn-reread'),
  recompute:!!document.getElementById('btn-recompute'),
  stamps:document.querySelectorAll('#triage-in .lstamp').length }));
ok(ctl.reread, 'Re-read control renders');
ok(ctl.recompute, 'Recompute control renders');
ok(ctl.stamps===5, `per-lane stamps render (${ctl.stamps}/5)`);

await browser.close();
console.log(fails.length?`\n${fails.length} FAILURE(S)`:'\nALL PASS');
process.exit(fails.length?1:0);
