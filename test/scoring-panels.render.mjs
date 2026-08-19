import { chromium } from '/tmp/node_modules/playwright/index.mjs';
import fs from 'fs';

const _p = JSON.parse(fs.readFileSync('/tmp/payload.json','utf8'));
// stamp at run time so the assertion is not brittle to the fixture ageing
_p.computed_at = new Date(Date.now() - 3*3600e3).toISOString();
const payload = JSON.stringify(_p);
const fails = [];
const ok = (c,m)=>{ console.log((c?'PASS':'FAIL')+'  '+m); if(!c) fails.push(m); };

const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const errs=[];
page.on('pageerror', e=>errs.push('JS EXCEPTION: '+e));
// Deliberately-aborted RPCs and file:// font loads produce network console noise
// that is not a defect in this code; only real JS exceptions count.
page.on('console', m=>{ if(m.type()==='error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });

await page.route('**/rpc/workbench_scoring_panels', r =>
  r.fulfill({ status:200, contentType:'application/json', body:payload }));
// existing panels' RPCs are irrelevant here; fail them fast so the page settles
await page.route('**/rpc/workbench_health', r=>r.abort());
await page.route('**/rpc/workbench_forecast_model', r=>r.abort());

await page.goto('file:///home/user/Faraday-Workbench/index.html');
await page.waitForFunction(()=>!document.querySelector('#jts-panel .hnote')?.textContent.includes('Loading'), null, {timeout:15000});

ok(errs.length===0, 'no JS exceptions' + (errs.length?': '+errs.slice(0,3).join(' | '):''));

// --- caveat-before-data: the governing rule of §5.2 ---
for (const id of ['jpas-panel','jds-panel','jts-panel']) {
  const r = await page.evaluate(id=>{
    const el=document.getElementById(id);
    const kids=[...el.children];
    const firstCav=kids.findIndex(k=>k.classList.contains('caveat'));
    const firstData=kids.findIndex(k=>k.classList.contains('dscroll')||k.classList.contains('hnote')||k.classList.contains('subhead'));
    return {n:kids.length, firstCav, firstData, cavs:el.querySelectorAll('.caveat').length};
  }, id);
  ok(r.cavs>0, `${id}: renders at least one caveat (${r.cavs})`);
  ok(r.firstCav===0, `${id}: first child is a caveat block (index ${r.firstCav})`);
  ok(r.firstData===-1 || r.firstCav < r.firstData, `${id}: caveats precede data`);
}

// --- specific caveat-forward assertions ---
const t = await page.evaluate(()=>({
  age: document.querySelector('#scoring-age .caveat')?.className,
  ageTxt: document.querySelector('#scoring-age .ct')?.textContent,
  jpasCts: [...document.querySelectorAll('#jpas-panel .caveat .ct')].map(e=>e.textContent),
  jpasBad: document.querySelectorAll('#jpas-panel .caveat.bad').length,
  jpasOk:  document.querySelectorAll('#jpas-panel .caveat.ok').length,
  impHi:   [...document.querySelectorAll('#jpas-panel td.imp-hi')].map(e=>e.textContent),
  impMid:  [...document.querySelectorAll('#jpas-panel td.imp-mid')].map(e=>e.textContent),
  tierRows:[...document.querySelectorAll('#jpas-panel .dtable')][0]?.querySelectorAll('tbody tr').length,
  rvrRows:[...document.querySelectorAll('#jpas-panel .dtable')][1]?.querySelectorAll('tbody tr').length,
  jdsCts:  [...document.querySelectorAll('#jds-panel .caveat .ct')].map(e=>e.textContent),
  jdsBad:  document.querySelectorAll('#jds-panel .caveat.bad').length,
  jtsCts:  [...document.querySelectorAll('#jts-panel .caveat .ct')].map(e=>e.textContent),
  jtsFeedNo: [...document.querySelectorAll('#jts-panel .feed-no')].length,
  bodyText: document.getElementById('jpas-panel').textContent + document.getElementById('jds-panel').textContent + document.getElementById('jts-panel').textContent
}));

ok(/ok$/.test(t.age||''), 'age banner green at 3h old ('+t.age+')');
ok(/3\.0h old/.test(t.ageTxt||''), 'age banner states age: '+t.ageTxt);

ok(t.jpasCts.some(c=>/Proposed, not Confirmed/i.test(c)), 'JPAS: DEC-31 rendered as Proposed, not Confirmed');
ok(t.jpasCts.some(c=>/Composer defect — Live/i.test(c)), 'JPAS: the Live defect rendered as Live');
ok(t.jpasBad>=1 && t.jpasOk>=1, `JPAS: severity grammar applied (bad=${t.jpasBad}, ok=${t.jpasOk})`);
ok(t.jpasCts.some(c=>/Weight budget holding/i.test(c)), 'JPAS: weight budget shows holding (green)');
ok(t.tierRows===9, `JPAS: 9 tier rows in the tier table (${t.tierRows})`);
ok(t.rvrRows===4, `JPAS: 4 registry-vs-reality rows (${t.rvrRows})`);
ok(t.impHi.length===2, `JPAS: two tiers red at >=90% imputed (${t.impHi.join(', ')})`);
ok(t.impMid.length===3, `JPAS: three tiers amber at >=50% (${t.impMid.join(', ')})`);

ok(t.jdsCts.some(c=>/No schedule/i.test(c)), 'JDS: NO SCHEDULE caveat present');
ok(t.jdsCts.some(c=>/Flat layer columns are stale/i.test(c)), 'JDS: stale flat columns caveat present');
ok(t.jdsBad>=2, `JDS: operational failures are red (${t.jdsBad})`);
ok(/"Not imputed" is not the same as "measured"/.test(t.bodyText), 'JDS: measured-vs-not-imputed distinction stated');
ok(/1,611/.test(t.bodyText), 'JDS: measured count 1,611 shown');

ok(t.jtsCts.some(c=>/No model registered/i.test(c)), 'JTS: NO MODEL REGISTERED headline');
ok(/adjacent, NOT JTS/i.test(t.bodyText) || /not a trajectory score/i.test(t.bodyText), 'JTS: PFI labelled adjacent, not JTS');
ok(t.jtsFeedNo>=1, `JTS: empty feed flagged (${t.jtsFeedNo} markers)`);
ok(/ferc_form1_plant_additions/.test(t.bodyText), 'JTS: the empty feed is named');

await page.screenshot({ path:'/tmp/panels.png', fullPage:true });
await browser.close();
console.log('\n'+(fails.length?fails.length+' FAILURES':'ALL '+'PASS'));
process.exit(fails.length?1:0);
