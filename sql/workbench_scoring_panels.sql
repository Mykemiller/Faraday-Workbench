-- CC-WORKBENCH-SCORING-PANELS-2.0
-- Faraday Workbench — JPAS / JDS / JTS scoring panels.
--
-- Applied to Supabase project ycadmmngkdhvpcsrcuaq 2026-08-19 as migrations
--   cc_workbench_scoring_panels_2_phase1_cache
--   cc_workbench_scoring_panels_2_phase2_jpas
--   cc_workbench_scoring_panels_2_phase3_jds_v2
--   cc_workbench_scoring_panels_2_phase4_jts
--   cc_workbench_scoring_panels_2_phase5_assemble_refresh_read
--   cc_workbench_scoring_panels_2_phase6_cron
-- Checked in for provenance — the Workbench's DDL has otherwise only ever
-- existed inside Supabase's own migration table (same posture as
-- sql/workbench_forecast_model.sql). This file is the source of truth; the
-- deployed bodies are semantically identical (Panel 1 was applied without the
-- inline -- comments, and adjacent string literals are concatenated by the
-- parser, so the emitted payload is byte-identical either way).
--
-- Supersedes CC-WORKBENCH-SCORING-PANELS-1.0, which was drafted 2026-08-19 and
-- never applied (workbench_scoring_cache confirmed absent). Nothing to roll back.
--
-- Shape follows the established Workbench triad (D1/F1): heavy *_compute()
-- behind service_role, a one-row cache table, a cron'd *_refresh(), and a thin
-- anon-callable reader. One shared cache, three payload keys, one hourly cron
-- (D2) so the three panels can never disagree about "as of when".
--
-- READ-ONLY (D12). Nothing here computes, derives or persists a score. Zero
-- writes to jpas_attributes, jurisdictions, jts_*, jw_score_history or any
-- other scoring surface.

-- ---------------------------------------------------------------------------
-- Phase 1 — cache table
-- ---------------------------------------------------------------------------

create table if not exists public.workbench_scoring_cache (
  id          integer primary key,
  payload     jsonb        not null,
  computed_at timestamptz  not null default now()
);

comment on table public.workbench_scoring_cache is
  'CC-WORKBENCH-SCORING-PANELS-2.0. Single-row (id=1) cache for the three Workbench '
  'scoring panels: payload->jpas, payload->jds, payload->jts. Read-only projection of '
  'registry and score state; never an input to any score. Service-role-only (RLS deny-all).';

alter table public.workbench_scoring_cache enable row level security;

revoke all on table public.workbench_scoring_cache from public, anon, authenticated;
grant select, insert, update on table public.workbench_scoring_cache to service_role;

-- ---------------------------------------------------------------------------
-- Phase 2 — Panel 1: JPAS tier status
-- ---------------------------------------------------------------------------
-- Tier membership resolves by registry join on attribute_code (D3).
-- jpas_attributes.tier_code is never read: it holds 12 distinct values mixing
-- tier codes with composition-slot labels (T2_power, T5_environmental, ...) and
-- PWR/WTR/COM/LBR never appear in it at all (F2).
--
-- Two lanes (D4): live_tiers is authoritative (quality_tier_code, filtered to
-- quality_is_active); registry_tiers is diagnostic only, and carries the dead
-- is_active flag under an explicit legacy_flag_is_dead marker.

create or replace function public.workbench_jpas_panel_compute()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $fn$
with live_w as (
  select distinct quality_tier_code as tier_code, quality_tier_weight as weight
  from jpas_attribute_registry
  where quality_is_active
),
live_attrs as (
  select quality_tier_code as tier_code,
         count(*)                                            as attrs_live,
         count(*) filter (where quality_attribute_weight = 0) as attrs_zero_weight,
         round(sum(quality_attribute_weight), 4)             as attr_weight_sum,
         jsonb_agg(jsonb_build_object(
           'code',     attribute_code,
           'name',     attribute_name,
           'weight',   quality_attribute_weight,
           'method',   quality_normalization,
           'polarity', quality_polarity) order by attribute_code) as attributes
  from jpas_attribute_registry
  where quality_is_active
  group by quality_tier_code
),
live_vol as (
  select r.quality_tier_code as tier_code,
         count(*)                          as attribute_rows,
         count(distinct a.jurisdiction_id) as jurisdictions_with_data,
         max(a.captured_at)                as last_write,
         count(*) filter (where a.confidence_tier = 'VRF') as vrf_rows,
         count(*) filter (where a.confidence_tier = 'SRC') as src_rows,
         count(*) filter (where a.confidence_tier = 'EST') as est_rows,
         count(*) filter (where a.confidence_tier = 'INF') as inf_rows,
         count(*) filter (where a.confidence_tier = 'ABS') as abs_rows
  from jpas_attributes a
  join jpas_attribute_registry r on r.attribute_code = a.attribute_code
  where r.quality_is_active
  group by r.quality_tier_code
),
-- D9: per-tier imputation coverage, read from the persisted breakdown. The
-- breakdown mixes per-tier objects with scalar keys (model,
-- expected_attributes), so the object filter is load-bearing.
imputation as (
  select k.key as tier_code,
         count(*)                                                                as jurisdictions,
         count(*) filter (where (k.value ->> 'imputed')::boolean)                as imputed,
         count(*) filter (where k.value ->> 'imputed_from' = 'state_median')     as from_state_median,
         count(*) filter (where k.value ->> 'imputed_from' = 'national_median')  as from_national_median,
         count(*) filter (where k.value ->> 'imputed_from' = 'fallback_50')      as from_fallback_50
  from jurisdictions j
  cross join lateral jsonb_each(j.jpas_quality_breakdown) k
  where j.jpas_quality_breakdown is not null
    and jsonb_typeof(k.value) = 'object'
  group by k.key
),
registry_lane as (
  select tier_code,
         max(tier_name)                            as tier_name,
         count(*)                                  as attrs_registered,
         count(*) filter (where is_active)         as attrs_is_active_flag,
         count(*) filter (where quality_is_active) as attrs_live
  from jpas_attribute_registry
  group by tier_code
),
rows_per as (
  select attribute_code, count(distinct jurisdiction_id) as j
  from jpas_attributes group by attribute_code
)
select jsonb_build_object(
  'panel',                          'jpas_tier_status',
  'live_composer',                  'jw_recompute_us_jpas_quality',
  'live_weight_column',             'quality_tier_weight',
  'live_weight_budget',             (select sum(weight) from live_w),
  'live_tier_count',                (select count(*)    from live_w),
  'attributes_registered',          (select count(*) from jpas_attribute_registry),
  'attributes_live',                (select count(*) from jpas_attribute_registry where quality_is_active),
  'attributes_registered_not_live', (select count(*) from jpas_attribute_registry where not quality_is_active),
  'attribute_rows_total',           (select count(*) from jpas_attributes),
  'jurisdictions_scored',           (select count(*) from jurisdictions where jpas_quality is not null),
  'jurisdictions_total',            (select count(*) from jurisdictions),
  'avg_quality',                    (select round(avg(jpas_quality), 2)      from jurisdictions),
  'avg_completeness',               (select round(avg(jpas_completeness), 2) from jurisdictions),
  'expected_attributes',            (select (jpas_quality_breakdown ->> 'expected_attributes')::int
                                       from jurisdictions
                                      where jpas_quality_breakdown ? 'expected_attributes' limit 1),
  'last_recomputed_at',             (select max(jpas_quality_computed_at) from jurisdictions),

  'live_tiers', coalesce((
    select jsonb_agg(jsonb_build_object(
      'tier_code',               w.tier_code,
      'tier_weight',             w.weight,
      'attrs_live',              la.attrs_live,
      'attrs_zero_weight',       la.attrs_zero_weight,
      'attr_weight_sum',         la.attr_weight_sum,
      'attributes',              la.attributes,
      'attribute_rows',          coalesce(lv.attribute_rows, 0),
      'jurisdictions_with_data', coalesce(lv.jurisdictions_with_data, 0),
      'last_write',              lv.last_write,
      'confidence_mix', jsonb_build_object(
        'VRF', coalesce(lv.vrf_rows,0), 'SRC', coalesce(lv.src_rows,0),
        'EST', coalesce(lv.est_rows,0), 'INF', coalesce(lv.inf_rows,0),
        'ABS', coalesce(lv.abs_rows,0)),
      'imputation', jsonb_build_object(
        'jurisdictions',        coalesce(im.jurisdictions, 0),
        'imputed',              coalesce(im.imputed, 0),
        'pct_imputed',          case when coalesce(im.jurisdictions,0) = 0 then null
                                     else round(100.0 * im.imputed / im.jurisdictions, 1) end,
        'from_state_median',    coalesce(im.from_state_median, 0),
        'from_national_median', coalesce(im.from_national_median, 0),
        'from_fallback_50',     coalesce(im.from_fallback_50, 0))
    ) order by w.weight desc, w.tier_code)
    from live_w w
    left join live_attrs la on la.tier_code = w.tier_code
    left join live_vol   lv on lv.tier_code = w.tier_code
    left join imputation im on im.tier_code = w.tier_code
  ), '[]'::jsonb),

  'registry_tiers', coalesce((
    select jsonb_agg(jsonb_build_object(
      'tier_code',            rl.tier_code,
      'tier_name',            rl.tier_name,
      'attrs_registered',     rl.attrs_registered,
      'attrs_is_active_flag', rl.attrs_is_active_flag,
      'attrs_live',           rl.attrs_live,
      'in_live_composer',     exists (select 1 from live_w w where w.tier_code = rl.tier_code)
    ) order by rl.tier_code)
    from registry_lane rl
  ), '[]'::jsonb),
  'legacy_flag_is_dead', true,
  'legacy_flag_note',    'is_active and attribute_weight reach no score. jw_recompute_us_jpas raises P0001 '
                         '(retired by CC-JPAS-QUALITY-AUTHORITATIVE-CUTOVER-1.0). quality_is_active is the sole gate.',

  'taxonomy_divergence', coalesce((
    select jsonb_agg(jsonb_build_object(
      'attribute_code', attribute_code,
      'registry_tier',  tier_code,
      'live_tier',      quality_tier_code) order by attribute_code)
    from jpas_attribute_registry
    where quality_tier_code is not null and quality_tier_code <> tier_code
  ), '[]'::jsonb),

  -- D10: standing instrumentation for registry-vs-reality drift. This class of
  -- drift (PWR-11, WTR-07) has recurred often enough to warrant measuring it
  -- rather than rediscovering it per-CC.
  'registry_vs_reality', jsonb_build_object(
    'dark_data_attributes',
      (select count(*) from jpas_attribute_registry r join rows_per p using (attribute_code)
        where not r.quality_is_active and p.j > 0),
    'dark_data_jurisdiction_rows',
      (select coalesce(sum(p.j),0) from jpas_attribute_registry r join rows_per p using (attribute_code)
        where not r.quality_is_active and p.j > 0),
    'dark_data_codes',
      (select coalesce(jsonb_agg(r.attribute_code order by r.attribute_code), '[]'::jsonb)
         from jpas_attribute_registry r join rows_per p using (attribute_code)
        where not r.quality_is_active and p.j > 0),
    'live_with_zero_data',
      (select count(*) from jpas_attribute_registry r left join rows_per p using (attribute_code)
        where r.quality_is_active and coalesce(p.j,0) = 0),
    'live_with_zero_data_codes',
      (select coalesce(jsonb_agg(r.attribute_code order by r.attribute_code), '[]'::jsonb)
         from jpas_attribute_registry r left join rows_per p using (attribute_code)
        where r.quality_is_active and coalesce(p.j,0) = 0),
    'live_but_registry_says_gated',
      (select coalesce(jsonb_agg(attribute_code order by attribute_code), '[]'::jsonb)
         from jpas_attribute_registry
        where quality_is_active and source_pipeline ~* '(gated|not built)'),
    'active_flag_contradictions',
      (select count(*) from jpas_attribute_registry where is_active is distinct from quality_is_active),
    'active_flag_contradiction_codes',
      (select coalesce(jsonb_agg(attribute_code order by attribute_code), '[]'::jsonb)
         from jpas_attribute_registry where is_active is distinct from quality_is_active)
  ),

  -- D11: the two live composer defects, structured rather than footnoted. A
  -- quality score rendered without these overstates what the number means.
  'composer_defects', jsonb_build_array(
    jsonb_build_object(
      'defect',       'tier_quality divides by the weight of attributes that returned a row',
      'effect',       'A missing attribute is not penalised - absence is free. A tier scored on one '
                      'of six attributes reads the same as a tier scored on all six.',
      'status',       'Proposed, not Confirmed',
      'decision_ref', 'DEC-31'),
    jsonb_build_object(
      'defect',       'conf_mult feeds completeness only',
      'effect',       'Confidence tier has zero effect on the ranking number. An EST row and a VRF '
                      'row contribute identically to jpas_quality.',
      'status',       'Live',
      'decision_ref', 'CC-JPAS-QUALITY-COMPLETENESS-1.0 (Qd)')
  ),

  -- F4: the weight budget invariant holds but nothing defends it. If two active
  -- rows in one tier ever carried different tier weights, the composer's
  -- DISTINCT CTE would count that tier twice and the denominator would silently
  -- exceed the hardcoded /100.0. Measured here so a breach is visible.
  'weight_integrity', jsonb_build_object(
    'budget',                (select sum(weight) from live_w),
    'budget_is_100',         (select sum(weight) = 100 from live_w),
    'tiers_with_split_weight',
      (select count(*) from (
         select quality_tier_code from jpas_attribute_registry
          where quality_is_active
          group by quality_tier_code having count(distinct quality_tier_weight) > 1) s),
    'tiers_attr_weights_off_one',
      (select count(*) from (
         select quality_tier_code from jpas_attribute_registry
          where quality_is_active
          group by quality_tier_code having round(sum(quality_attribute_weight),4) <> 1.0) s),
    'composer_divisor',      'hardcoded literal /100.0',
    'note',                  'Nothing enforces the budget. A vector that does not sum to 100 silently '
                             'deflates or inflates every score.')
);
$fn$;

comment on function public.workbench_jpas_panel_compute() is
  'CC-WORKBENCH-SCORING-PANELS-2.0 Panel 1. Read-only JPAS tier status. Tier membership '
  'resolves by registry join on attribute_code; jpas_attributes.tier_code is never read (D3/F2).';

-- ---------------------------------------------------------------------------
-- Phase 3 — Panel 2: JDS status
-- ---------------------------------------------------------------------------
-- D5: weights and layer counts read from the persisted jds_breakdown, so this
-- records what was actually applied rather than restating a formula that drifts
-- when the composer changes.
-- D6: scheduling and imputation coverage are first-class fields. A JDS panel
-- showing a score but not that half the supply term is imputed, and that
-- nothing refreshes it, is worse than no panel.

create or replace function public.workbench_jds_panel_compute()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $fn$
with scored as (
  select jds_score, jds_tier, jds_breakdown, jds_computed_at, level,
         jds_l1_count, jds_l2_count, jds_l3_count, jds_l4_count
  from jurisdictions
  where jds_computed_at is not null
),
weights as (
  select b.jds_breakdown -> 'weights' as w, count(*) as n
  from scored b
  where b.jds_breakdown ? 'weights'
  group by 1
),
versions as (
  select coalesce(jds_breakdown ->> 'formula_version', 'unversioned') as fv, count(*) as n
  from scored group by 1
),
tiers as (
  select coalesce(jds_tier, 'unscored') as tier, count(*) as n from scored group by 1
),
levels as (
  select level::text as lvl, count(*) as n from scored group by 1
),
qc as (
  select coalesce(jds_breakdown -> 'supply' ->> 'queue_coverage', 'unknown') as cov, count(*) as n
  from scored group by 1
)
select jsonb_build_object(
  'panel',                 'jds_status',
  'composer',              'jw_rollup_county_jds',
  'grain',                 'county',
  'composer_is_scheduled',
    (select exists (select 1 from cron.job where active and command ilike '%jw_rollup_county_jds%')),
  'scheduled_jobs', coalesce((
    select jsonb_agg(jsonb_build_object('jobname', jobname, 'schedule', schedule) order by jobid)
    from cron.job where active and command ilike '%jw_rollup_county_jds%'
  ), '[]'::jsonb),
  'scheduling_note',
    'No cron invokes the JDS composer. Scores persist from the last manual run and do not '
    'refresh as facilities, queue rows or parcels change. cron.job is RLS-scoped to the '
    'calling role, so this reads jobs visible to the function owner.',
  'jurisdictions_scored',  (select count(*) from scored),
  'last_computed_at',      (select max(jds_computed_at) from scored),
  'avg_score',             (select round(avg(jds_score), 2) from scored),
  'min_score',             (select min(jds_score) from scored),
  'max_score',             (select max(jds_score) from scored),
  'weights_source',        'persisted jurisdictions.jds_breakdown->weights',
  'weight_variants',       (select count(*) from weights),
  'weights', coalesce((
    select jsonb_agg(jsonb_build_object('weights', w, 'jurisdictions', n) order by n desc)
    from weights
  ), '[]'::jsonb),
  'formula_versions', coalesce((
    select jsonb_agg(jsonb_build_object('formula_version', fv, 'jurisdictions', n) order by n desc)
    from versions
  ), '[]'::jsonb),
  'tier_distribution', coalesce((
    select jsonb_agg(jsonb_build_object('tier', tier, 'jurisdictions', n) order by n desc) from tiers
  ), '[]'::jsonb),
  'level_distribution', coalesce((
    select jsonb_agg(jsonb_build_object('level', lvl, 'jurisdictions', n) order by n desc) from levels
  ), '[]'::jsonb),
  -- Layer counts read from the breakdown, same rationale as D5. The flat
  -- jurisdictions.jds_l*_count columns are NOT written by county-v1: all 3,222
  -- rows carry 0 while the breakdown carries the real counts. Reading the flat
  -- columns here would have rendered an all-zero layer table beside a
  -- non-zero score.
  'layer_coverage', jsonb_build_object(
    'source',             'persisted jds_breakdown->demand_canonical',
    'l1_with_facilities', (select count(*) from scored where (jds_breakdown -> 'demand_canonical' ->> 'l1')::int > 0),
    'l2_with_facilities', (select count(*) from scored where (jds_breakdown -> 'demand_canonical' ->> 'l2')::int > 0),
    'l3_with_facilities', (select count(*) from scored where (jds_breakdown -> 'demand_canonical' ->> 'l3')::int > 0),
    'l4_with_parcels',    (select count(*) from scored where (jds_breakdown -> 'demand_canonical' ->> 'l4')::int > 0),
    'l1_total',           (select sum((jds_breakdown -> 'demand_canonical' ->> 'l1')::int) from scored),
    'l2_total',           (select sum((jds_breakdown -> 'demand_canonical' ->> 'l2')::int) from scored),
    'l3_total',           (select sum((jds_breakdown -> 'demand_canonical' ->> 'l3')::int) from scored),
    'l4_total',           (select sum((jds_breakdown -> 'demand_canonical' ->> 'l4')::int) from scored),
    'flat_columns_stale', (select count(*) filter (where coalesce(jds_l1_count,0) > 0) = 0 from scored)),
  'imputation', jsonb_build_object(
    'supply_contention_imputed',
      (select count(*) from scored where (jds_breakdown -> 'supply' ->> 'contention_imputed')::boolean),
    -- Deliberately "not_imputed", not "measured": the 69 rows with imputation
    -- suppressed for absent infrastructure are neither imputed nor measured.
    'supply_contention_not_imputed',
      (select count(*) from scored where (jds_breakdown -> 'supply' ->> 'contention_imputed')::boolean is false),
    'pct_supply_contention_imputed',
      (select case when count(*) = 0 then null else round(100.0 *
         count(*) filter (where (jds_breakdown -> 'supply' ->> 'contention_imputed')::boolean)
         / count(*), 1) end from scored),
    'imputation_suppressed_no_infrastructure',
      (select count(*) from scored
        where (jds_breakdown -> 'supply' ->> 'imputation_suppressed_no_infrastructure')::boolean),
    'queue_coverage', coalesce((
      select jsonb_agg(jsonb_build_object('coverage', cov, 'jurisdictions', n) order by n desc) from qc
    ), '[]'::jsonb),
    'demand_canonical_structural_zero',
      (select count(*) from scored where (jds_breakdown -> 'demand_canonical' ->> 'structural_zero')::boolean),
    'power_contention_rows',          (select count(*) from jurisdiction_power_contention),
    'power_contention_rows_measured',
      (select count(*) from jurisdiction_power_contention where queue_coverage = 'measured')),
  'caveats', jsonb_build_array(
    jsonb_build_object(
      'caveat', 'The JDS composer is on no schedule',
      'effect', 'Scores are a snapshot of the last manual run, not a current reading.',
      'status', 'Live'),
    jsonb_build_object(
      'caveat', 'Half the supply term rests on imputed contention',
      'effect', 'Exactly half the scored counties have measured queue coverage; the rest take an '
                'imputed contention value or, where there is no infrastructure at all, have '
                'imputation suppressed.',
      'status', 'Live'),
    jsonb_build_object(
      'caveat', 'The flat jurisdictions.jds_l*_count columns are not written by county-v1',
      'effect', 'All 3,222 scored rows carry 0 in those columns while the breakdown carries the '
                'real layer counts. Any consumer reading the flat columns sees an empty pipeline.',
      'status', 'Live, found by this CC'))
);
$fn$;

comment on function public.workbench_jds_panel_compute() is
  'CC-WORKBENCH-SCORING-PANELS-2.0 Panel 2. Read-only JDS status. Weights and layer counts read from the persisted jds_breakdown (D5); scheduling and imputation coverage are first-class fields (D6).';

-- ---------------------------------------------------------------------------
-- Phase 4 — Panel 3: JTS readiness
-- ---------------------------------------------------------------------------
-- D7: this is a READINESS panel, not a formula panel. jts_model_registry is
-- empty, so there is no formula to render. PFI is the live forward-looking
-- system and appears in a separately labelled adjacent_live_system block —
-- rendering it as JTS would assert a trajectory score that does not exist.

create or replace function public.workbench_jts_panel_compute()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $fn$
with model_count as (select count(*) as n from jts_model_registry),
feeds as (
  select * from (values
    ('jps_history',                'JPS posture history — the trajectory series itself',
     (select count(*) from jps_history)),
    ('jw_score_history',           'JPAS quality/completeness history',
     (select count(*) from jw_score_history)),
    ('jurisdiction_signals',       'Tier-change signals emitted by jw_apply_posture_run',
     (select count(*) from jurisdiction_signals)),
    ('jw_signal_events',           'Bulletin signal events (permit velocity, incentive filings, opposition)',
     (select count(*) from jw_signal_events)),
    ('ref_ferc_queue',             'ISO/RTO interconnection queue — JTS-06 grid buildout',
     (select count(*) from ref_ferc_queue)),
    ('grid_buildout_projects',     'PUC/ISO transmission build projects — JTS-06 grid buildout',
     (select count(*) from grid_buildout_projects)),
    ('ferc_form1_plant_additions', 'FERC Form 1 plant additions — JTS-07 utility capex trend',
     (select count(*) from ferc_form1_plant_additions)),
    ('jurisdiction_water_trend',   'Water trajectory rows (jts_snapshots-shaped, never promoted)',
     (select count(*) from jurisdiction_water_trend))
  ) f(feed, purpose, rows)
)
select jsonb_build_object(
  'panel',           'jts_readiness',
  'formula_exists',  (select n > 0 from model_count),
  'readiness_note',
    'JTS has a registry and a snapshot table but no model and no snapshots. Nothing computes a '
    'trajectory score today. This panel reports what exists and what blocks each attribute; it '
    'deliberately does not render a score, and does not present PFI as JTS.',
  'models_registered',   (select n from model_count),
  'snapshots',           (select count(*) from jts_snapshots),
  'attributes_registered',(select count(*) from jts_attribute_registry),
  'attributes_active',   (select count(*) from jts_attribute_registry where is_active),
  'confidence_labels', coalesce((
    select jsonb_agg(to_jsonb(l) order by l::text) from jts_confidence_labels l
  ), '[]'::jsonb),
  'attributes', coalesce((
    select jsonb_agg(jsonb_build_object(
      'attribute_code',          r.attribute_code,
      'attribute_name',          r.attribute_name,
      'construct',               r.construct,
      'default_confidence_label',r.default_confidence_label,
      'is_active',               r.is_active,
      -- Blocking condition, structured. Every attribute is blocked today; the
      -- inactive two carry a second, attribute-specific blocker in the registry.
      'blocked_by',              case when not r.is_active then 'registry_inactive'
                                      else 'no_model_registered' end,
      'blocking_note',           nullif(btrim(coalesce(r.notes, '')), '')
    ) order by r.attribute_code)
    from jts_attribute_registry r
  ), '[]'::jsonb),
  'feeds', coalesce((
    select jsonb_agg(jsonb_build_object(
      'feed', feed, 'purpose', purpose, 'rows', rows, 'has_data', rows > 0
    ) order by feed) from feeds
  ), '[]'::jsonb),
  'feeds_empty', (select count(*) from feeds where rows = 0),
  'adjacent_live_system', jsonb_build_object(
    'system',        'PFI (Predictive Forecast Index)',
    'relationship',  'Adjacent, not JTS. PFI forecasts JPS posture; it is not a trajectory score '
                     'and does not satisfy any JTS attribute.',
    'models',        (select count(*) from pfi_model_registry),
    'models_detail', coalesce((
      select jsonb_agg(jsonb_build_object(
        'model_version', model_version,
        'activated_at',  activated_at,
        'retired_at',    retired_at) order by model_version)
      from pfi_model_registry
    ), '[]'::jsonb),
    'forecasts',      (select count(*) from pfi_forecasts),
    'jps_snapshots',  (select count(*) from pfi_jps_snapshots),
    'trend_features', (select count(*) from pfi_trend_features))
);
$fn$;

comment on function public.workbench_jts_panel_compute() is
  'CC-WORKBENCH-SCORING-PANELS-2.0 Panel 3. JTS READINESS, not JTS formula (D7). Emits formula_exists=false, the 7-attribute registry with per-attribute blocking conditions, per-feed row counts, and PFI in a separately labelled adjacent_live_system block.';

-- ---------------------------------------------------------------------------
-- Phase 5 — assembler, refresh, reader, grants
-- ---------------------------------------------------------------------------

-- One payload, three keys (D2) so the panels can never disagree about
-- "as of when" — the exact failure a status panel exists to prevent.
create or replace function public.workbench_scoring_panels_compute()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select jsonb_build_object(
    'cc',   'CC-WORKBENCH-SCORING-PANELS-2.0',
    'jpas', public.workbench_jpas_panel_compute(),
    'jds',  public.workbench_jds_panel_compute(),
    'jts',  public.workbench_jts_panel_compute()
  );
$fn$;

create or replace function public.workbench_scoring_panels_refresh()
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  insert into public.workbench_scoring_cache (id, payload, computed_at)
  values (1, public.workbench_scoring_panels_compute(), now())
  on conflict (id) do update
    set payload     = excluded.payload,
        computed_at = excluded.computed_at;
end;
$fn$;

-- Anon-callable reader: cache only, cannot hang. Deliberately does NOT fall
-- back to _compute() on a cache miss (workbench_health() does) — here that
-- fallback scans ~745k jpas_attributes rows plus a lateral jsonb_each over
-- 39k breakdowns and takes ~12s, well past the anon statement timeout. An
-- honest empty payload beats a hung request.
create or replace function public.workbench_scoring_panels()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select coalesce(
    (select payload || jsonb_build_object('computed_at', computed_at)
       from public.workbench_scoring_cache where id = 1),
    '{"jpas": null, "jds": null, "jts": null, "computed_at": null}'::jsonb
  );
$fn$;

comment on function public.workbench_scoring_panels() is
  'CC-WORKBENCH-SCORING-PANELS-2.0. Read-only JPAS/JDS/JTS scoring-panel payload for the Faraday Workbench static page. Reads workbench_scoring_cache; SECURITY DEFINER over RLS-denied registry and score tables, same posture as workbench_health() and workbench_forecast_model().';

revoke all on function public.workbench_jpas_panel_compute()      from public, anon, authenticated;
revoke all on function public.workbench_jds_panel_compute()       from public, anon, authenticated;
revoke all on function public.workbench_jts_panel_compute()       from public, anon, authenticated;
revoke all on function public.workbench_scoring_panels_compute()  from public, anon, authenticated;
revoke all on function public.workbench_scoring_panels_refresh()  from public, anon, authenticated;
revoke all on function public.workbench_scoring_panels()          from public;

grant execute on function public.workbench_jpas_panel_compute()     to service_role;
grant execute on function public.workbench_jds_panel_compute()      to service_role;
grant execute on function public.workbench_jts_panel_compute()      to service_role;
grant execute on function public.workbench_scoring_panels_compute() to service_role;
grant execute on function public.workbench_scoring_panels_refresh() to service_role;
grant execute on function public.workbench_scoring_panels()         to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Phase 6 — cron
-- ---------------------------------------------------------------------------
-- One hourly cron for all three panels (D2). Offset from the other two
-- Workbench refreshes (jobid 33 */5, jobid 150 at :07) so the ~12s compute
-- does not stack on them.

select cron.schedule(
  'workbench-scoring-panels-refresh-hourly',
  '22 * * * *',
  $cron$select public.workbench_scoring_panels_refresh();$cron$
);

select public.workbench_scoring_panels_refresh();
