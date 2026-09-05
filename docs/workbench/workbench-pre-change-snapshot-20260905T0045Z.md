# Workbench pre-change snapshot — 2026-09-05T00:45Z
Captured BEFORE any mutation. CC-WORKBENCH-FINDINGS-REMEDIATION-1.0.
Project ycadmmngkdhvpcsrcuaq. Repo Mykemiller/Faraday-Workbench @ 24a2dbb (== live prod deploy).

## Cache rows (id, computed_at, payload bytes)
forecast_model  1  2026-09-05 00:07:00.015345+00  1392 B
health          1  2026-09-05 00:30:00.113449+00  4379 B
idf             1  2026-09-03 16:04:07.357929+00  1158 B   <-- STALE, no cron (D7 target)
scoring         1  2026-09-04 10:15:00.073035+00  9880 B
storefront      1  2026-09-04 10:30:00.122413+00  1993 B

## cron.job where command ilike '%workbench%'
33   workbench-health-refresh-5min            */5 * * * *   active=t
150  workbench-forecast-model-refresh-hourly  7 * * * *     active=t
237  workbench-scoring-panels-refresh-daily   15 10 * * *   active=t
240  workbench-storefront-refresh-daily       30 10 * * *   active=t
(no job for workbench_idf_refresh)

## Function grants (pre-change)
workbench_health / _storefront / _idf / _scoring_panels / _forecast_model  : anon=t auth=t svc=t  secdef=t
workbench_*_refresh (all five)                                             : anon=f auth=f svc=t  secdef=t

## Measured refresh durations (cron.job_run_details, 14d)
workbench-health-refresh-5min             runs 4026 ok / 6 bad  avg 28.60s  max 114.40s
workbench-scoring-panels-refresh-daily    runs 14 ok / 0 bad    avg 21.76s  max  27.36s
workbench-forecast-model-refresh-hourly   runs 336 ok / 0 bad   avg  9.95s  max  20.71s
workbench-storefront-refresh-daily        runs 14 ok / 0 bad    avg  0.22s  max   0.25s
workbench_idf_refresh                     UNMEASURED - no cron, and MCP role lacks EXECUTE

## Live condition state (9 CRITICAL / 11 WARNING) - reconciled against payloads
ESTATE  red 1 amber 1 | FEEDS red 1 amber 2 | SCORING red 6 amber 4 | IDF5 red 1 amber 4

## Payload facts underpinning the count
idf.domains_dark=0  subdomains_no_feed=52/117  signals.status=ok
engine_stats.companies_new_signals_7d=102  automations_24h=662 succeeded=655 (7 failed)
dc.season_status=active days_left=0 season_ends_on=2026-09-04 players_24h_total=0
dc.bank: total 373, published 238, retired 119, unpublished 9, synced_on 2026-07-04, through 2026-07-31, remaining_scheduled 196
storefront: 1 tile status=warn (Daily Challenge, LIVE / STALE); stale_lanes=[]; no probe_error/fallback
scoring.computed_at 2026-09-04 10:15 (~14h old -> no age condition)
 jpas.composer_defects: [tier_quality divisor = "Proposed, not Confirmed" -> amber]
                        [conf_mult feeds completeness only = "Live" -> red]
 jpas.weight_integrity: budget_is_100=true, split=0, off_one=0 -> no condition
 jpas.registry_vs_reality: live_with_zero_data=0, gated=[PWR-11], dark=25 (43014 rows), contradictions=0
 jpas.live_tiers pct_imputed: PWR 50.3/COM 1.1/ENV 50.7/NET 0.9/REG 89.7/WTR 0.6/INC 1.1/LBR 50.3/RSC 91.7
   -> only RSC >= 90 fires
 jds.composer_is_scheduled=false; layer_coverage.flat_columns_stale=true
 jds.caveats: 3 Live; 2 excluded by /schedule|flat / regex; 1 fires (supply/imputed contention)
 jts.formula_exists=false; jts.feeds_empty=1
idf.linkage legacy_artifact_subdomain_candidates=6919 legacy_tagspine_subdomain_rules=31 (sum 6950)
 linked pillars = person, company, institution -> unlinked 3 (jurisdiction, facility, source)
 pillars fa: 5 of 6 are 0 (JS-falsy) -> "empty on 5 of 6"
 p4_detail: stored=18217 geo_bound=16420 (delta 1797) lifecycle_unknown=16604
 NOTE: geo_bound 16420 is the PRE-CC-DCRES-US-FILL number; jurisdiction-watch reports 17462
       post-fill (2026-09-03). Confirms the IDF cache is stale -> D7.

## FEEDS "Active-but-empty sources: 6" - real basis
index.html:780 MODEL_METRICS {k:"active_but_empty", good:"zero"}; :846 v>0 -> red.
Value read from workbench_forecast_model_cache.payload.snapshots[0].active_but_empty = 6
  (snapshot captured 2026-09-03T23:39:42Z; prior snapshot 2026-08-31 had 4).
Written by public.fn_capture_forecast_metrics:
  (select count(*) from v_source_backlog_queue where action_class='active_but_empty')
Live re-run of that predicate today = 6 (agrees).
v_source_backlog_queue is built on source_registry (NOT jw_data_source_registry) and
action_class='active_but_empty' means: source_type in
 (government_feed, industry_entity, data_portal, company_feed)
 AND destination_table IS NOT NULL AND years_ingested IS NULL AND status='active'
 AND temporal_semantics <> 'presence'.
The six rows are all agenda:* municipal feeds -> opposition_signals:
  agenda:4b5ba634 https://co.ellis.tx.us (custom)
  agenda:805dfeda maricopa (legistar)
  agenda:82928fee https://www.pwcva.gov/... (custom)
  agenda:8fbdf76a cook-county (legistar)
  agenda:c6b9cc2d dupage (legistar)
  agenda:e9cddd5c https://www.celebratedouglascounty.com (custom)
The CC's assumed query hits a DIFFERENT registry (jw_data_source_registry) and returns a
disjoint set of 3 (dc:epoch-ai, dol:davis-bacon, eia:ct-crosswalk-resolved).

## Vercel
project prj_RFSzXJvknx9uEMoHt5DHAZf1biVS "faraday-workbench" team_JS3rgFwySt8w8yds7fAh1KeM
deploys from github Mykemiller/Faraday-Workbench branch main (NOT faraday-today)
prod deploy dpl_GfSRNWHJPSfMBrk2d2rFHWGD6cHH sha 24a2dbb -> www.faraday-stuff.com
deployment protection: passwordProtection=false, ssoProtection=ENABLED but
  deploymentType="all_except_custom_domains", trustedIps=false
  => www.faraday-stuff.com is NOT access-controlled. "MYKE ONLY" is a text label only.
repo has NO api/ dir, NO middleware, NO build step, NO env vars; static index.html
  with hardcoded publishable key sb_publishable_fDRdRxznJ7E7syPxfNt7hw__Yukn6Tg
