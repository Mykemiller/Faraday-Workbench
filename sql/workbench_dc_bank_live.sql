-- CC-WORKBENCH-DC-BANK-LIVE-1.0 — Daily Challenge bank metrics read live from
-- Supabase instead of the hand-pasted Airtable snapshot in workbench_config.
--
-- Why: workbench_config.puzzle_bank was a one-time snapshot (synced 2026-07-04,
-- "through 2026-07-31") with no automation behind it, so the DC health panel
-- reported a healthy bank while dc_puzzle_bank_staging had nothing scheduled
-- ahead. League Office's "days cached" counts dc_daily_page_content rows even
-- when their games array is empty, so it overstates runway from the other side.
--
-- Rules this encodes:
--   * "today" is America/Chicago (the seasons tz and League Office's ctToday()),
--     never UTC current_date — UTC reads tomorrow's row from 7pm Chicago onward.
--   * A cached day only counts if its games array is non-empty. An empty shell
--     row is exhaustion, not content.
--   * scheduled_ahead excludes Retired rows.
--
-- Applied to project ycadmmngkdhvpcsrcuaq on 2026-09-09. workbench_config is
-- left in place but no longer read by any workbench RPC.

-- 1. workbench_health_compute — dc section rewired, Chicago date everywhere.
CREATE OR REPLACE FUNCTION public.workbench_health_compute()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with ct as materialized (
  select (now() at time zone 'America/Chicago')::date as today
),
art_codes as materialized (
  select artifact_id, discovered_at, code from (
    select a.artifact_id, a.discovered_at, c as code
    from artifacts a, unnest(a.ifs_domains) c
    union
    select a.artifact_id, a.discovered_at, e.value #>> '{}' as code
    from artifacts a, jsonb_array_elements(coalesce(a.signal_envelope->'idf_domains','[]'::jsonb)) e
    union
    select a.artifact_id, a.discovered_at, c as code
    from artifacts a, unnest(a.ifs_subdomains) c
    union
    select a.artifact_id, a.discovered_at, p.subdomain_code as code
    from artifact_subdomain_provenance p
    join artifacts a on a.artifact_id = p.artifact_id
  ) u
  where code ~ '^D[0-9]+(\.[0-9]+)?$'
),
code_set as materialized (
  select distinct code from art_codes
),
dom_art as (
  select split_part(code, '.', 1) as domain_code,
         count(distinct artifact_id)::int as all_art,
         count(distinct artifact_id) filter (where discovered_at >= now() - interval '7 days')::int as new_7d
  from art_codes
  group by 1
),
sub_stats as (
  select s.domain_code,
         count(*)::int as subs,
         count(*) filter (where cs.code is null)::int as subs_no_feed
  from faraday_subdomains s
  left join code_set cs on cs.code = s.subdomain_code
  where s.active
  group by 1
),
dom as (
  select d.domain_code, d.domain_num, d.domain_name, d.emoji,
         coalesce(ss.subs, 0) as subs,
         coalesce(ss.subs_no_feed, 0) as subs_no_feed,
         coalesce(da.all_art, 0) as all_art,
         coalesce(da.new_7d, 0) as new_7d
  from faraday_domains d
  left join sub_stats ss on ss.domain_code = d.domain_code
  left join dom_art da on da.domain_code = d.domain_code
  where d.active
),
dom_j as (
  select
    jsonb_agg(jsonb_build_object(
      'num', domain_num, 'code', domain_code, 'name', domain_name, 'emoji', emoji,
      'subdomains', subs, 'subs_no_feed', subs_no_feed, 'all_art', all_art, 'new_7d', new_7d,
      'dark', (all_art = 0)
    ) order by domain_num) as arr,
    count(*)::int as dcount,
    coalesce(sum(subs),0)::int as subs_total,
    count(*) filter (where all_art = 0)::int as dark_domains
  from dom
),
feedless as (
  select
    coalesce(jsonb_agg(jsonb_build_object('code', s.subdomain_code, 'name', s.display_name, 'domain', s.domain_code)
             order by s.domain_code, s.subdomain_code), '[]'::jsonb) as arr,
    count(*)::int as n
  from faraday_subdomains s
  left join code_set cs on cs.code = s.subdomain_code
  where s.active and cs.code is null
),
feed_obs as materialized (
  select p.subdomain_code,
         lower(regexp_replace(regexp_replace(regexp_replace(a.source_url,'^(https?:)?//',''),'/.*$',''),'^www\.','')) as host,
         count(distinct p.artifact_id) as n,
         max(a.discovered_at) as last_seen
  from artifact_subdomain_provenance p
  join artifacts a on a.artifact_id = p.artifact_id
  where a.source_url is not null
  group by 1,2
),
feed_short as (
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'code', x.subdomain_code, 'name', x.display_name,
      'domain', x.domain_code, 'publishers', x.qual_hosts)
      order by x.qual_hosts, x.subdomain_code), '[]'::jsonb) as arr,
    count(*)::int as n
  from (
    select s.subdomain_code, s.display_name, s.domain_code,
           count(*) filter (
             where o.n >= 3 and o.last_seen >= now() - interval '90 days'
           )::int as qual_hosts
    from faraday_subdomains s
    left join feed_obs o on o.subdomain_code = s.subdomain_code
    where s.active
    group by 1,2,3
  ) x
  where x.qual_hosts < 2
),
art_counts as (
  select count(*) as total,
         count(*) filter (where discovered_at >= now() - interval '24 hours') as h24,
         count(*) filter (where discovered_at >= now() - interval '7 days') as d7
  from artifacts
),
health_counts as (
  select count(*) filter (where run_started_at >= now() - interval '24 hours') as runs_24h,
         count(*) filter (where run_started_at >= now() - interval '24 hours' and success) as ok_24h
  from automation_health_log
),
jur_counts as (
  select count(*) as total,
         count(*) filter (where current_score is not null) as scored,
         count(*) filter (where jpas_quality is not null) as jpas_scored,
         count(*) filter (where is_active) as active
  from jurisdictions
),
signal_counts as (
  select count(*) as total,
         count(*) filter (where fired_at >= now() - interval '24 hours') as h24,
         max(fired_at) as last_fired
  from signals
),
-- Daily Challenge: the bank, measured, not remembered.
bank as (
  select count(*)::int                                                    as total,
         count(*) filter (where published = 'Retired')::int               as retired,
         count(*) filter (where published = 'Published')::int             as published,
         count(*) filter (where published = 'Unpublished')::int           as unpublished,
         count(*) filter (where go_live_date >= ct.today
                            and coalesce(published,'') <> 'Retired')::int as scheduled_ahead,
         max(go_live_date) filter (where go_live_date >= ct.today
                                     and coalesce(published,'') <> 'Retired') as through,
         max(go_live_date)                                                as last_go_live,
         (greatest(max(generated_at), max(synced_at), max(approved_at))
            at time zone 'America/Chicago')::date                         as last_written
  from dc_puzzle_bank_staging, ct
  group by ct.today
),
pc as (
  select count(*) filter (where p.puzzle_date >= ct.today
                            and jsonb_array_length(coalesce(p.about_content->'games','[]'::jsonb)) > 0)::int as days_cached,
         coalesce(max(jsonb_array_length(coalesce(p.about_content->'games','[]'::jsonb)))
                    filter (where p.puzzle_date = ct.today), 0)::int as live_today,
         max(p.puzzle_date) filter (where jsonb_array_length(coalesce(p.about_content->'games','[]'::jsonb)) > 0) as last_content_date,
         bool_or(p.puzzle_date = ct.today) as today_row_exists
  from dc_daily_page_content p, ct
  group by ct.today
),
today_games as (
  select g.game
  from dc_daily_page_content p
  cross join lateral jsonb_array_elements(p.about_content->'games') as g(game)
  where p.puzzle_date = (select today from ct)
),
game_act as (
  select lower(trim(game_type)) as gt, count(distinct subscriber_id)::int as players, coalesce(max(score),0)::int as high
  from dc_daily_attempts
  where play_date = (select today from ct)
  group by 1
),
puzzles_j as (
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'name', tg.game->>'name', 'type', tg.game->>'puzzle_type', 'topic', tg.game->>'topic',
      'players_24h', coalesce(ga.players,0), 'high_score_24h', coalesce(ga.high,0)
    )), '[]'::jsonb) as arr,
    coalesce(sum(coalesce(ga.players,0)),0)::int as players_total
  from today_games tg
  left join game_act ga on ga.gt = lower(trim(tg.game->>'puzzle_type'))
),
season as (
  select name, status::text as st, ends_on, (ends_on - (select today from ct))::int as days_left
  from seasons
  order by
    (status = 'active') desc,
    ((select today from ct) between starts_on and ends_on) desc,
    starts_on desc
  limit 1
)
select jsonb_build_object(
  'generated_at', now(),
  'idf', jsonb_build_object(
    'domains_active', (select dcount from dom_j),
    'domains_dark', (select dark_domains from dom_j),
    'subdomains_total', (select subs_total from dom_j),
    'subdomains_no_feed', (select n from feedless),
    'companies', (select count(*) from tracking_companies where active),
    'entities', (select count(*) from entities),
    'artifacts_total', (select total from art_counts),
    'artifacts_24h', (select h24 from art_counts),
    'artifacts_7d', (select d7 from art_counts),
    'by_domain', (select arr from dom_j),
    'feedless_subdomains', (select arr from feedless),
    'subdomains_feed_shortfall', (select n from feed_short),
    'feed_shortfall_subdomains', (select arr from feed_short)
  ),
  'jps', jsonb_build_object(
    'scored', (select scored from jur_counts),
    'total', (select total from jur_counts),
    'jpas_scored', (select jpas_scored from jur_counts)
  ),
  'dc', jsonb_build_object(
    'as_of_date', (select today from ct),
    'season_name', (select name from season),
    'season_status', (select st from season),
    'season_ends_on', (select ends_on from season),
    'days_left', greatest(coalesce((select days_left from season),0),0),
    'bank', jsonb_build_object(
      'source', 'Supabase · dc_puzzle_bank_staging + dc_daily_page_content',
      'total', coalesce((select total from bank),0),
      'retired', coalesce((select retired from bank),0),
      'published', coalesce((select published from bank),0),
      'unpublished', coalesce((select unpublished from bank),0),
      'scheduled_ahead', coalesce((select scheduled_ahead from bank),0),
      'through', (select through from bank),
      'last_go_live', (select last_go_live from bank),
      'last_written', (select last_written from bank),
      'days_cached', coalesce((select days_cached from pc),0),
      'live_today', coalesce((select live_today from pc),0),
      'today_row_exists', coalesce((select today_row_exists from pc),false),
      'last_content_date', (select last_content_date from pc)
    ),
    'puzzles_today', (select arr from puzzles_j),
    'players_24h_total', (select players_total from puzzles_j)
  ),
  'signals', jsonb_build_object(
    'total', (select total from signal_counts),
    'last_24h', (select h24 from signal_counts),
    'last_fired', (select last_fired from signal_counts),
    'rules_defined', (select count(*) from signal_configuration_rules where not paused),
    'candidates_24h', (select count(*) from artifact_enrichments where priority_flag and created_at >= now() - interval '24 hours'),
    'status', case when (select h24 from signal_counts) = 0 then 'stalled' else 'ok' end
  ),
  'engine_stats', jsonb_build_object(
    'automations_24h', (select runs_24h from health_counts),
    'automations_succeeded_24h', (select ok_24h from health_counts),
    'jurisdictions', (select total from jur_counts),
    'jurisdictions_active', (select active from jur_counts),
    'artifacts_total', (select total from art_counts),
    'new_artifacts_24h', (select h24 from art_counts),
    'companies', (select count(*) from tracking_companies where active),
    'companies_new_signals_7d', (
      select count(distinct ct.value)
      from signals s, jsonb_array_elements_text(s.company_tags) ct
      where s.fired_at >= now() - interval '7 days'
    ),
    'predictions', (select count(*) from predictions),
    'new_predictions_24h', (select count(*) from predictions where date_created >= now() - interval '24 hours')
  )
) $function$;

-- 2. workbench_storefront_compute — daily-challenge probe measures exhaustion.
CREATE OR REPLACE FUNCTION public.workbench_storefront_compute()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r         record;
  v_tiles   jsonb := '[]'::jsonb;
  v_stale   jsonb := '[]'::jsonb;
  v_metrics jsonb;
  v_basis   text;
  v_today   date := (now() at time zone 'America/Chicago')::date;
begin
  for r in
    select * from public.workbench_storefront_tiles where enabled order by display_order, slug
  loop
    v_metrics := '{}'::jsonb;
    v_basis   := 'no_feed';

    -- Per-tile isolation: one missing probe table or one bad query degrades ONE
    -- tile into stale_lanes[]; it must never take the whole board down.
    begin
      case r.slug
        when 'daily-challenge' then
          -- bank_rows alone looked healthy while nothing was scheduled ahead.
          -- scheduled_ahead / days_cached are the numbers that say "exhausted".
          -- A cached day counts only when its games array is non-empty.
          select jsonb_build_object(
                   'bank_rows',        count(*),
                   'max_go_live_date', max(go_live_date),
                   'scheduled_ahead',  count(*) filter (where go_live_date >= v_today
                                                          and coalesce(published,'') <> 'Retired'),
                   'days_cached',      (select count(*) from public.dc_daily_page_content
                                         where puzzle_date >= v_today
                                           and jsonb_array_length(coalesce(about_content->'games','[]'::jsonb)) > 0))
            into v_metrics from public.dc_puzzle_bank_staging;
          v_basis := 'measured';

        when 'briefing-library' then
          select jsonb_build_object('catalog_rows', count(*))
            into v_metrics from public.library_catalog_cache;
          v_basis := 'measured';

        when 'jurisdiction-watch' then
          select jsonb_build_object(
                   'promoted_jurisdictions',
                   (select count(*) from public.jurisdictions where editorial_status = 'promoted'),
                   'briefings',
                   (select count(*) from public.jw_briefings))
            into v_metrics;
          v_basis := 'measured';

        when 'faraday-academy' then
          select jsonb_build_object(
                   'courses_total', (select count(*) from public.academy_courses),
                   'by_status', coalesce(
                     (select jsonb_object_agg(s, c)
                        from (select status::text as s, count(*) as c
                                from public.academy_courses group by 1) t),
                     '{}'::jsonb))
            into v_metrics;
          v_basis := 'measured';

        when 'live-agent' then
          select jsonb_build_object('enrich_batches', count(*))
            into v_metrics from public.enrich_batches;
          v_basis := 'measured';

        when 'signal-room' then
          select jsonb_build_object('signals', count(*))
            into v_metrics from public.signals;
          v_basis := 'measured';

        when 'league-office' then
          select jsonb_build_object('audit_log_rows', count(*))
            into v_metrics from public.lo_audit_log;
          v_basis := 'measured';

        else
          -- intelligent-alert, thought-forge, civic-host: no Supabase-side feed exists.
          -- Absence of a feed is NOT zero. Emit {} and say so.
          v_metrics := '{}'::jsonb;
          v_basis   := 'no_feed';
      end case;

    exception when others then
      v_metrics := '{}'::jsonb;
      v_basis   := 'probe_error';
      v_stale   := v_stale || jsonb_build_array(jsonb_build_object(
        'slug',      r.slug,
        'detail',    left(regexp_replace(SQLERRM, '\s+', ' ', 'g'), 240),
        'sqlstate',  SQLSTATE));
    end;

    v_tiles := v_tiles || jsonb_build_array(jsonb_build_object(
      'slug',          r.slug,
      'name',          r.name,
      'status',        r.status,
      'status_tag',    r.status_tag,
      'jira_key',      r.jira_key,
      'jira_url',      r.jira_url,
      'blurb',         r.blurb,
      'display_order', r.display_order,
      'metrics',       v_metrics,
      'metric_basis',  v_basis));
  end loop;

  return jsonb_build_object(
    'generated_at', now(),
    'tiles',        v_tiles,
    'stale_lanes',  v_stale);
end;
$function$;

-- 3. Editorial copy (approved by Myke 2026-09-09, "blurb yes"). No hardcoded
--    counts or dates — the metrics row carries those and refreshes itself.
update public.workbench_storefront_tiles
   set blurb = 'Static page live, bank exhausted — nothing scheduled ahead, the nightly rotator writes empty page rows, and the active season has no generated content. Fix is a generation run (human gate).',
       updated_at = now()
 where slug = 'daily-challenge';

update public.workbench_finding_remediation
   set plain_english = 'The Daily Challenge storefront is live and serving, but its bank is exhausted. Every puzzle in dc_puzzle_bank_staging has a go-live date in the past, the nightly sync-day-content job writes an empty seven-game shell for each new day, and the active season has never had a generation run. League Office''s puzzle-cache count includes those empty shells, so it overstates runway. A visitor today finds a live product with no games in it.',
       cc_prompt_seed = 'The Daily Challenge bank is exhausted. Report from dc_puzzle_bank_staging: unpublished, unretired puzzles and the date coverage they give at seven games a day. Report from dc_puzzle_generation_runs whether any run targets the active season in seasons; if none, spell out the generation run required (season, target count, theme-calendar coverage from dc_daily_theme). Report why /api/cron/sync-day-content writes rows with an empty games array when nothing is scheduled. Do not publish puzzles, run generation, or create a season; each is a human-approval carve-out.',
       updated_at = now()
 where finding_key = 'ESTATE.DAILY_CHALLENGE.LIVE_STALE';

-- 4. Rebuild both caches now rather than waiting for cron 33 (5 min) / 240 (daily).
select public.workbench_health_refresh();
select public.workbench_storefront_refresh();
