-- CC-IDF-ONE-ENGINE-1.0 (2026-09-25) — Workbench IDF linkage panel measures engine
-- liveness instead of archive size.
--
-- Defect: workbench_idf_compute() sourced legacy_* counts from the G1 frozen
-- archives (artifact_subdomain_candidates_frozen_20260903 = 6,919 rows,
-- tagspine_subdomain_rules_frozen_20260903 = 31 rows). Archives never change, so
-- IDF5.LINKAGE.THREE_ENGINES_LIVE could never clear even after tagspine was
-- retired (CC-TAGSPINE-RETIREMENT-1.0, 2026-09-03) and the artifact ledger was
-- made the only writer of artifacts.ifs_subdomains (D3, 2026-09-05).
--
-- Change: linkage.legacy_* now count the LIVE legacy tables (0 when dropped);
-- archive sizes move to linkage.archived_*; a new linkage.engines[] array
-- reports each engine's writers, rows, last write and whether it is live; and
-- linkage.sel_drift reports rows where subdomain_entity_link disagrees with the
-- *_domain_tags tables the ledger actually reads. Nothing is retired or dropped.

CREATE OR REPLACE FUNCTION public.workbench_idf_linkage()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_legacy_cand  bigint := 0;
  v_legacy_rules bigint := 0;
  v_ledger       jsonb;
  v_sel          jsonb;
  v_tag          jsonb;
  v_drift        jsonb;
  v_live         int;
BEGIN
  -- Live legacy tables: dropped by CC-TAGSPINE-RETIREMENT-1.0; 0 while absent.
  IF to_regclass('public.artifact_subdomain_candidates') IS NOT NULL THEN
    EXECUTE 'select count(*) from public.artifact_subdomain_candidates' INTO v_legacy_cand;
  END IF;
  IF to_regclass('public.tagspine_subdomain_rules') IS NOT NULL THEN
    EXECUTE 'select count(*) from public.tagspine_subdomain_rules' INTO v_legacy_rules;
  END IF;

  -- Engine 1: artifact ledger (canonical writer of artifacts.ifs_subdomains, D3).
  SELECT jsonb_build_object(
    'key','ledger',
    'name','Artifact ledger (idf_refresh_all → idf_assignment_staging → idf_ledger_commit)',
    'store','artifact_subdomain_provenance → artifacts.ifs_subdomains',
    'role','canonical',
    'rows',(SELECT count(*) FROM artifact_subdomain_provenance),
    'artifacts',(SELECT count(*) FROM artifacts WHERE coalesce(cardinality(ifs_subdomains),0) > 0),
    'last_write_at',(SELECT max(created_at) FROM artifact_subdomain_provenance),
    'writers',(SELECT count(*) FROM cron.job WHERE active AND command ILIKE '%idf_refresh_all%'),
    'live', EXISTS (SELECT 1 FROM cron.job WHERE active AND command ILIKE '%idf_refresh_all%'))
  INTO v_ledger;

  -- Engine 2: entity linkage table. Counted live only if something still writes it.
  SELECT jsonb_build_object(
    'key','entity_link',
    'name','Entity linkage (subdomain_entity_link)',
    'store','subdomain_entity_link',
    'role','entity read-model (not an artifact classifier)',
    'rows',(SELECT count(*) FROM subdomain_entity_link),
    'last_write_at',(SELECT max(linked_at) FROM subdomain_entity_link),
    'writers', w.n,
    'live', w.n > 0)
  INTO v_sel
  FROM (
    SELECT (SELECT count(*) FROM cron.job WHERE active AND command ILIKE '%subdomain_entity_link%')
         + (SELECT count(*) FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f','p')
               AND pg_get_functiondef(p.oid) ~* '(insert\s+into|update)\s+(public\.)?subdomain_entity_link\M') AS n
  ) w;

  -- Engine 3: legacy tagspine rule engine (retired 2026-09-03, archived).
  SELECT jsonb_build_object(
    'key','tagspine',
    'name','Legacy tagspine rules → artifact_subdomain_candidates',
    'store','artifact_subdomain_candidates (dropped; archive *_frozen_20260903)',
    'role','retired',
    'rows', v_legacy_cand + v_legacy_rules,
    'archived_rows',(SELECT count(*) FROM artifact_subdomain_candidates_frozen_20260903)
                   + (SELECT count(*) FROM tagspine_subdomain_rules_frozen_20260903),
    'last_write_at',(SELECT max(created_at) FROM artifact_subdomain_candidates_frozen_20260903),
    'writers', w.n,
    'live', (v_legacy_cand + v_legacy_rules) > 0 OR w.n > 0)
  INTO v_tag
  FROM (
    SELECT (SELECT count(*) FROM cron.job WHERE active AND command ~* 'tagspine|artifact_subdomain_candidates\M')
         + (SELECT count(*) FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f','p')
               AND pg_get_functiondef(p.oid) ~* '(insert\s+into|update)\s+(public\.)?(artifact_subdomain_candidates|tagspine_subdomain_rules)\M') AS n
  ) w;

  -- SEL vs the *_domain_tags tables the ledger's roster lanes actually read.
  WITH sel AS (SELECT pillar::text pl, record_id, subdomain_code FROM subdomain_entity_link),
  tg AS (
    SELECT 'company' pl, company_uid record_id, subdomain_code FROM company_domain_tags
    UNION ALL SELECT 'person', person_id::text, subdomain_code FROM person_domain_tags
    UNION ALL SELECT 'institution', institution_uid, subdomain_code FROM institution_domain_tags)
  SELECT jsonb_build_object(
    'only_in_entity_link', (SELECT count(*) FROM (SELECT * FROM sel EXCEPT SELECT * FROM tg) a),
    'only_in_domain_tags', (SELECT count(*) FROM (SELECT * FROM tg EXCEPT SELECT * FROM sel) b))
  INTO v_drift;

  v_live := (v_ledger->>'live')::boolean::int + (v_sel->>'live')::boolean::int + (v_tag->>'live')::boolean::int;

  RETURN jsonb_build_object(
    'total',   (SELECT count(*) FROM subdomain_entity_link),
    'by_pillar', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY links DESC),'[]'::jsonb)
                    FROM (SELECT pillar::text AS pillar, count(*) AS links,
                                 count(DISTINCT subdomain_code) AS subdomains
                            FROM subdomain_entity_link GROUP BY pillar::text) l),
    -- LIVE legacy tables (0 once dropped). Archives are reported separately.
    'legacy_artifact_subdomain_candidates', v_legacy_cand,
    'legacy_tagspine_subdomain_rules',      v_legacy_rules,
    'archived_artifact_subdomain_candidates', (SELECT count(*) FROM artifact_subdomain_candidates_frozen_20260903),
    'archived_tagspine_subdomain_rules',      (SELECT count(*) FROM tagspine_subdomain_rules_frozen_20260903),
    'canonical_engine', 'ledger',
    'live_engine_count', v_live,
    'engines', jsonb_build_array(v_ledger, v_sel, v_tag),
    'sel_drift', v_drift
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.workbench_idf_compute()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p jsonb;
  pfm jsonb := public.pillar_freshness_map();
BEGIN
  WITH
  reg AS (
    SELECT
      (SELECT count(*) FROM faraday_domains)                        AS domains,
      (SELECT count(*) FROM faraday_subdomains)                     AS subdomains_all,
      (SELECT count(*) FROM faraday_subdomains WHERE active)        AS subdomains_active,
      (SELECT count(*) FROM faraday_themes)                         AS themes
  ),
  p4 AS (
    SELECT
      count(*)                                                        AS stored,
      count(*) FILTER (WHERE superseded_by IS NULL)                   AS scorer_visible,
      count(*) FILTER (WHERE superseded_by IS NOT NULL)               AS superseded,
      count(*) FILTER (WHERE jurisdiction_id IS NOT NULL)             AS geo_bound,
      count(*) FILTER (WHERE publishable)                             AS publishable,
      count(fa_band)                                                  AS fa_bound,
      count(*) FILTER (WHERE lifecycle_status::text = 'unknown')      AS lifecycle_unknown
    FROM dc_facilities
  ),
  jds AS (
    SELECT
      max(jds_computed_at)                                     AS computed_at,
      count(*) FILTER (WHERE jds_computed_at IS NOT NULL)      AS scored_rows,
      (SELECT jds_breakdown->>'formula_version'
         FROM jurisdictions
        WHERE jds_breakdown ? 'formula_version'
        LIMIT 1)                                               AS formula_version
    FROM jurisdictions
  ),
  cron_jds AS (
    SELECT
      count(*) FILTER (WHERE active)      AS active_jobs,
      count(*) FILTER (WHERE NOT active)  AS paused_jobs
    FROM cron.job
    WHERE jobname ILIKE '%jds%'
  )
  SELECT jsonb_build_object(
    'registry', jsonb_build_object(
      'domains',            (SELECT domains FROM reg),
      'subdomains_active',  (SELECT subdomains_active FROM reg),
      'subdomains_all',     (SELECT subdomains_all FROM reg),
      'themes',             (SELECT themes FROM reg)
    ),
    'pillars', jsonb_build_array(
      jsonb_build_object('n',1,'name','Jurisdictions','home','jurisdictions · jpas_attributes',
        'rows',(SELECT count(*) FROM jurisdictions),
        'satellite',(SELECT count(*) FROM jpas_attributes),
        'conf',(SELECT count(confidence_band) FROM jurisdictions),
        'rev',(SELECT count(review_state) FROM jurisdictions),
        'fa',(SELECT count(fa_band) FROM jurisdictions),
        'fresh', coalesce(pfm->'1', jsonb_build_object('state','no_feed'))),
      jsonb_build_object('n',2,'name','Companies','home','companies · _aliases · _facts',
        'rows',(SELECT count(*) FROM companies),
        'satellite',(SELECT count(*) FROM company_aliases),
        'conf',(SELECT count(confidence_band) FROM companies),
        'rev',(SELECT count(review_state) FROM companies),
        'fa',(SELECT count(fa_band) FROM companies),
        'fresh', coalesce(pfm->'2', jsonb_build_object('state','no_feed'))),
      jsonb_build_object('n',3,'name','People','home','people · person_affiliations',
        'rows',(SELECT count(*) FROM people),
        'satellite',(SELECT count(*) FROM person_affiliations),
        'conf',(SELECT count(confidence_band) FROM people),
        'rev',(SELECT count(review_state) FROM people),
        'fa',(SELECT count(fa_band) FROM people),
        'fresh', coalesce(pfm->'3', jsonb_build_object('state','no_feed'))),
      jsonb_build_object('n',4,'name','DC Facilities','home','dc_facilities (merged corpus)',
        'rows',(SELECT stored FROM p4),
        'satellite',(SELECT scorer_visible FROM p4),
        'conf',(SELECT count(confidence_band) FROM dc_facilities),
        'rev',(SELECT count(review_state) FROM dc_facilities),
        'fa',(SELECT fa_bound FROM p4),
        'fresh', coalesce(pfm->'4', jsonb_build_object('state','no_feed'))),
      jsonb_build_object('n',5,'name','Reg. & Research Bodies','home','institutions',
        'rows',(SELECT count(*) FROM institutions),
        'satellite',(SELECT count(*) FROM institution_domain_tags),
        'conf',(SELECT count(confidence_band) FROM institutions),
        'rev',(SELECT count(review_state) FROM institutions),
        'fa',(SELECT count(fa_band) FROM institutions),
        'fresh', coalesce(pfm->'5', jsonb_build_object('state','no_feed'))),
      jsonb_build_object('n',6,'name','Sources','home','source_registry',
        'rows',(SELECT count(*) FROM source_registry),
        'satellite',0,
        'conf',(SELECT count(confidence_band) FROM source_registry),
        'rev',(SELECT count(review_state) FROM source_registry),
        'fa',(SELECT count(fa_band) FROM source_registry),
        'fresh', coalesce(pfm->'6', jsonb_build_object('state','no_feed')))
    ),
    'p4_detail', (SELECT to_jsonb(p4) FROM p4),
    'p4_confidence', (
      SELECT coalesce(jsonb_object_agg(band, c), '{}'::jsonb)
      FROM (SELECT coalesce(confidence_band::text,'(null)') AS band, count(*) AS c
              FROM dc_facilities GROUP BY 1) z
    ),
    -- CC-IDF-ONE-ENGINE-1.0: liveness-measured linkage block (see workbench_idf_linkage)
    'linkage', public.workbench_idf_linkage(),
    'mention_entities', (SELECT count(*) FROM entities),
    'jds', (SELECT jsonb_build_object(
              'formula_version', formula_version,
              'computed_at',     computed_at,
              'scored_rows',     scored_rows,
              'cron_active',     (SELECT active_jobs FROM cron_jds),
              'cron_paused',     (SELECT paused_jobs FROM cron_jds)
            ) FROM jds)
  ) INTO p;

  INSERT INTO public.workbench_idf_cache (id, payload, computed_at)
  VALUES (1, p, now())
  ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, computed_at = excluded.computed_at;

  RETURN p;
END;
$function$;

-- Remediation copy for the residual finding the new panel raises (amber, not red).
INSERT INTO public.workbench_finding_remediation
  (finding_key, lane, severity, plain_english, cc_prompt_seed, authored_by)
VALUES (
  'IDF5.LINKAGE.ENTITY_LINK_DRIFT', 'IDF 5.0', 'warning',
  'The artifact ledger is now the only engine assigning IDF sub-domains to artifacts. subdomain_entity_link is a one-time copy of the company, person and institution tag tables, made on 29-30 Aug, and nothing has written to it since. The ledger reads the tag tables, not this copy, so artifacts are unaffected, but the coverage views and this panel read the copy, and it has drifted from the tag tables. Until the copy is replaced by a view over the tag tables, entity coverage figures can differ from what the ledger actually uses.',
  'In the Faraday estate (Supabase project ycadmmngkdhvpcsrcuaq), list every row where subdomain_entity_link differs from company_domain_tags, person_domain_tags and institution_domain_tags (keyed on pillar, record_id, subdomain_code), with the evidence and basis each side carries. Propose for each row whether the tag table or the link table is right. Then draft (do not apply) a migration that renames subdomain_entity_link to an archive and replaces it with a view of the same name and columns over the three tag tables, so sel_orphans, sel_validate_record and the v_subdomain_coverage_* views keep working. IDF taxonomy is a human-approval carve-out, so present the row list and the draft migration and stop.',
  'Claude (CC-IDF-ONE-ENGINE-1.0)')
ON CONFLICT (finding_key) DO UPDATE
  SET plain_english = excluded.plain_english, cc_prompt_seed = excluded.cc_prompt_seed,
      severity = excluded.severity, lane = excluded.lane, updated_at = now();

SELECT public.workbench_idf_compute();
