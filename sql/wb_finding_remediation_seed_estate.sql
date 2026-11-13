-- CC-WORKBENCH-CRITICALS-ESTATE-LINKS-1.0 (FDY-324) · migration wb_finding_remediation_seed_estate
-- Authored remediation for the three Estate criticals that had none, plus a one-line "Tracked in"
-- pointer appended to the three Scoring criticals. The existing Scoring copy is Myke's; it is
-- appended to, never rewritten, and the append is guarded so a re-run changes nothing.
-- No scoring table, column or function is touched.
insert into public.workbench_finding_remediation (finding_key, lane, severity, plain_english, cc_prompt_seed, authored_by) values
('ESTATE.BOUNDSTONE.BS_01_03_JUST_FUNCTIONING','ESTATE','critical',
$t$Boundstone is red because one Linear issue is Urgent and still open: FDY-77, "News never becomes a record candidate" (status Todo). The tile label "BS 01.03 · JUST FUNCTIONING" is only a release-maturity label and no longer drives this rating. 1 Urgent issue is open for the Boundstone label; the other 3 Urgent issues carrying that label are Done. The public site (www.boundstone.org) answers 401, which is its access gate, so no health endpoint is wired here yet. Fix: get FDY-77 moving or re-prioritise it. The finding clears when no Urgent Boundstone issue is open. https://linear.app/my-faraday/issue/FDY-77$t$,
$t$GOAL: Clear ESTATE.BOUNDSTONE.BS_01_03_JUST_FUNCTIONING by resolving or honestly re-rating Linear FDY-77.
CONTEXT: Repo Mykemiller/boundstone, Supabase ycadmmngkdhvpcsrcuaq (schema boundstone is read-only here). record_candidates is empty so Latest Records cannot advance past 28 Jul. Verified 2026-11-12.
REQUIREMENTS: Read FDY-77 in full. Diagnose why news never becomes a record candidate. No writes to the Boundstone Supabase project without Myke.
DECISIONS: Fix vs re-prioritise: recommend fix (Urgent for 2+ weeks); default: diagnose and report.
STEPS: 1) read FDY-77 and linked PRs. 2) trace the news-to-candidate path. 3) propose the smallest change. 4) open a PR.
ACCEPTANCE: FDY-77 is Done or lowered with a written reason; the finding is gone from the Workbench banner.
SYNC: Linear FDY-77; Notion Faraday Run Log row.$t$,
'Claude (CC-WORKBENCH-CRITICALS-ESTATE-LINKS-1.0)'),
('ESTATE.ISPYADC.IS_01_04_JUST_FUNCTIONING','ESTATE','critical',
$t$ISpyaDC was red only because its release label reads "IS 01.04 · JUST FUNCTIONING". That is a maturity label, not a fault. 0 Urgent Linear issues are open for ISpyaDC and no health check is failing, so the Workbench now rates it amber. The real open question is FDY-248: continue or park ISpyaDC, after the Usable v1 target of 2026-10-09 was missed. That is your decision to make. https://linear.app/my-faraday/issue/FDY-248$t$,
$t$GOAL: Close the ISpyaDC continue-or-park decision (Linear FDY-248).
CONTEXT: Repo Mykemiller/I-Spy-a-DC (private). Usable v1 target 2026-10-09 missed; issues 18/19/20/42 In Progress, 21/22/23 Backlog, no movement since 2026-10-09.
REQUIREMENTS: Present the evidence for continue vs park. Do not change the product or its tile copy.
DECISIONS: Continue vs park is Myke's; recommend a dated checkpoint; default: park the Backlog issues, keep the In Progress ones.
STEPS: 1) read FDY-248. 2) summarise movement per issue. 3) write the recommendation in the issue.
ACCEPTANCE: FDY-248 has a recorded decision.
SYNC: Linear FDY-248; Notion Faraday Decision Log.$t$,
'Claude (CC-WORKBENCH-CRITICALS-ESTATE-LINKS-1.0)'),
('ESTATE.ESTATE_SECURITY.RED_5_URGENT','ESTATE','critical',
$t$Estate Security is a real red. 4 Urgent issues carrying the Estate Security label are open: FDY-205 (lock down unauthenticated email sending, In Progress), FDY-206 (retire key-diag, In Progress), FDY-208 (retire shovels-probe and dc-permit-match, In Progress) and FDY-119 (subscriber configurator UI, Todo; check whether this label belongs on it). FDY-207 and FDY-149 are already Done, so the tile text "5 URGENT" is out of date. Open issues: https://linear.app/my-faraday/issue/FDY-205 · https://linear.app/my-faraday/issue/FDY-206 · https://linear.app/my-faraday/issue/FDY-208 · https://linear.app/my-faraday/issue/FDY-119$t$,
$t$GOAL: Close the open Urgent Estate Security issues FDY-205, FDY-206, FDY-208 and decide whether FDY-119 belongs under this label.
CONTEXT: Supabase ycadmmngkdhvpcsrcuaq edge functions. Done already: FDY-207, FDY-149. Measured 2026-11-12.
REQUIREMENTS: Each function is retired to a 410 stub or requires the house cron token. Never print or store secret values. Secrets and key rotation are Myke's (Tier 3).
DECISIONS: Order: recommend FDY-205 (email send) first, then FDY-208 (credit spend), then FDY-206; default: that order.
STEPS: 1) read each issue. 2) verify the current deployed function behaviour with an unauthenticated request. 3) ship the fix or retire the function. 4) re-probe.
ACCEPTANCE: Each issue Done with a re-probe result; the banner no longer shows Estate Security red.
SYNC: Linear FDY-205/206/208; Notion Faraday Run Log row.$t$,
'Claude (CC-WORKBENCH-CRITICALS-ESTATE-LINKS-1.0)')
on conflict (finding_key) do nothing;     -- an authored row is never overwritten by a re-run

update public.workbench_finding_remediation set plain_english = plain_english ||
  ' Tracked in FDY-325 (diagnosis and shadow-compute proposal, waits for Gate 0): https://linear.app/my-faraday/issue/FDY-325. Related: FDY-312.',
  updated_at = now()
where finding_key = 'SCORING.JPAS.CONF_MULT_COMPLETENESS_ONLY' and plain_english not like '%FDY-325%';

update public.workbench_finding_remediation set plain_english = plain_english ||
  ' Tracked in FDY-326 (diagnosis and shadow-compute proposal, waits for Gate 0): https://linear.app/my-faraday/issue/FDY-326. Related: FDY-312.',
  updated_at = now()
where finding_key = 'SCORING.JDS.SUPPLY_IMPUTED_CONTENTION' and plain_english not like '%FDY-326%';

update public.workbench_finding_remediation set plain_english = plain_english ||
  ' Tracked in FDY-312 (JPAS health remediation, workstream JH-08 RSC): https://linear.app/my-faraday/issue/FDY-312.',
  updated_at = now()
where finding_key = 'SCORING.JPAS.RSC_IMPUTED_91PCT' and plain_english not like '%FDY-312%';
