# CC-IDF-ONE-ENGINE-1.0 — Run report

Fri 2026-09-25 18:55 CDT · Supabase `ycadmmngkdhvpcsrcuaq` · closes Workbench finding `IDF5.LINKAGE.THREE_ENGINES_LIVE`

## Verdict

There is already one IDF engine. The artifact ledger (`idf_refresh_all` → `idf_assignment_staging` → `idf_ledger_commit` → `artifact_subdomain_provenance` → `artifacts.ifs_subdomains`) is the only thing that writes artifact sub-domain assignments, and a trigger has enforced that since D3 (2026-09-05). Tagspine was retired on 2026-09-03 and its output was absorbed into the ledger. `subdomain_entity_link` has had no writer since 2026-08-30.

The red finding kept firing because `workbench_idf_compute()` counted the **frozen archives** (6,919 + 31 rows) as if they were live engines. Archives never shrink, so the finding could never clear. That was a Workbench measurement defect, not a live-engine defect.

Nothing was retired or dropped.

## 1. Inventory — every object that writes IDF sub-domain assignments

| # | Object | Writes | Written by | Read by | Rows | Last write (UTC) | Live product surface? |
|---|---|---|---|---|---|---|---|
| E1 | Artifact ledger | `idf_assignment_staging` → `artifact_subdomain_provenance` → `artifacts.ifs_subdomains` | `idf_refresh_all()` via cron `idf-subdomain-refresh-daily` (06:45, AUTO-211), six `idf_stage_*` lanes, `idf_record_subdomain_assignment()`; trigger `trg_artifacts_require_subdomain_provenance` blocks any other writer | `v_artifact_subdomain_tags` → `v_jw_signal_section_routing` (Jurisdiction Watch briefs); `generate_signals_interim` (AUTO-199 signals → `signals.subdomain_tags`); `v_artifact_tagging_health`; `workbench_health_compute` | 314,448 ledger rows / 115,148 artifacts; staging 0 | 2026-09-25 06:45 | **Yes** — JW brief routing and daily signals |
| E2 | Entity linkage | `subdomain_entity_link` | One-time CC runs (CC-IDF-SUBDOMAIN-LINKAGE-1.0, CC-IDF-INSTITUTIONS-1.1); no function or cron writes it now | `v_subdomain_coverage_{companies,people,institutions}`, `sel_orphans`, `sel_validate_record`, `workbench_idf_compute` | 4,284 (person 2,179 · company 1,703 · institution 402) | 2026-08-30 00:36 | No (Workbench/coverage only) |
| E2-src | Entity tag tables | `company_domain_tags`, `person_domain_tags`, `institution_domain_tags` | `cc_coenrich_apply_domain_tags` (cron paused), manual CC runs | **E1's roster lanes** (`idf_stage_roster_company/person`, `idf_stage_institution`), `v_faraday_subdomain_coverage`, `pillar_feed_staleness_check` | 1,702 / 2,179 / 416 | 2026-09-07 14:18 | Indirectly, as E1 inputs |
| E1-rules | Content rules | `subdomain_tag_rules` (68 active of 99) | Manual | `idf_stage_content_rules` (E1 lane), `company_domain_tag_rules` view | 99 | 2026-09-06 15:39 | Indirectly, as E1 input |
| E3 | Legacy tagspine | `artifact_subdomain_candidates`, `tagspine_subdomain_rules` (live tables **dropped**) | Nothing (retired CC-TAGSPINE-RETIREMENT-1.0) | Archives read only by `workbench_idf_compute` (fixed here) | live 0; archived 6,919 + 31 (+13,883 `artifacts_ifs_subdomains_frozen_20260903`) | 2026-08-01 11:26 | No |
| — | `entities.ifs_domains` | domain (not sub-domain) tags | edge fn `engine-idf-entities` every 5 min | E1 `entity_inherit_v1` lane (196,209 ledger rows) | — | live | Indirectly, as E1 input |

Edge functions: all 125 active functions were scanned; none reads or writes any sub-domain assignment table directly.

Ledger rows by origin: entity_inherit_v1 196,209 · roster_company_primary_v1 80,117 · institution_primary_v1 9,204 · envelope_v1 7,901 (migrated from E3) · roster_person_v1 7,359 · keyword_v1 6,669 (migrated E3) · facility_structural_v1 4,916 · content_rule_v1 1,823 · lane_v1 250 (migrated E3). The 6,669 + 250 migrated rows equal E3's 6,919 candidates exactly.

## 2. 200-artifact comparison

Sample: 200 artifacts drawn deterministically (`order by md5(artifact_id || 'IDF5-3ENG-20260925')`) from the 13,883 artifacts where E3 had an opinion, so every engine could speak. E1-native excludes the rows E1 imported from E3; E1-full is `artifacts.ifs_subdomains`. E2 maps artifact → `artifact_entities` → company/institution/person → `subdomain_entity_link` (primary tags).

| Pair | Both classify | Exact match | Partial overlap | Disjoint | Disagreement (all 200) | Disagreement (both classify) | Mean Jaccard |
|---|---|---|---|---|---|---|---|
| E1-full vs E3 | 200 | 94 | 106 | 0 | 53.0% | 53.0% | 0.62 |
| E1-native vs E3 | 124 | 18 | 66 | 40 | 91.0% | 85.5% | 0.17 |
| E1-native vs E2 | 81 | 15 | 64 | 2 | 55.0% | 81.5% | 0.29 |
| E1-full vs E2 | 82 | 7 | 72 | 3 | 96.5% | 91.5% | 0.15 |
| E2 vs E3 | 82 | 15 | 12 | 55 | 92.5% | 81.7% | 0.10 |

Reading:
- **E3 ⊂ E1 on all 200.** Every tagspine code survives in `artifacts.ifs_subdomains`; E1 only adds. No live surface can see a tagspine-only answer that contradicts the ledger.
- **E2 ⊂ E1 on 78 of 82.** The four exceptions are the E2 drift below, not a competing opinion.
- Raw disagreement is high because the engines read different evidence (keywords vs. entity rosters vs. content rules), so they are additive lanes, not rival classifiers. Hard contradiction (disjoint sets) between E1 and E2 is 2–3 artifacts in 200.
- E1-native vs E3 disjoint on 40: tagspine keyword hits the native lanes never make. Those survive in E1 only because the E3 rows were migrated (`keyword_v1`, `envelope_v1`) and are not regenerated.

## 3. Recommendation

**Canonical: E1, the artifact ledger.** It is the only live writer, is trigger-enforced, carries per-row provenance and confidence, is idempotent (verified 2026-09-05), and every live product surface already reads it.

Migration path for the other two (human approval required; not applied):
1. **E3 tagspine — already migrated.** Keep `*_frozen_20260903` as audit archives. Decide a drop date, and whether `keyword_v1` / `envelope_v1` rows should stay frozen or be replaced by content rules in `subdomain_tag_rules`.
2. **E2 subdomain_entity_link — demote to a read-model.** It is a stale copy of the tag tables that E1 actually reads, and it has drifted: 16 rows only in the link table, 29 only in the tag tables (14 institution tags added 2026-09-07; 15/16 company mismatches). Reconcile those 45 rows, then replace the table with a same-named view over the three `*_domain_tags` tables so `sel_*` functions and the coverage views keep working. Seed prompt stored under `IDF5.LINKAGE.ENTITY_LINK_DRIFT`.

## 4. Workbench changes

Database (`cc_idf_one_engine_workbench_1_0`, applied): new `workbench_idf_linkage()`; `workbench_idf_compute()` now calls it. `linkage.legacy_*` counts the live legacy tables (0); archive sizes moved to `linkage.archived_*`; new `engines[]`, `live_engine_count` (now 1), `canonical_engine` = `ledger`, `sel_drift`. Remediation row authored for the new amber finding. Cache refreshed 2026-09-25 23:52 UTC.

Page (`index.html`): the linkage panel renders measured per-engine liveness instead of hard-coded "three engines are live" copy. `THREE_ENGINES_LIVE` fires only when more than one engine has a live writer. `ENTITY_LINK_DRIFT` (amber) surfaces the E2 drift. Pre-change payloads fall back to the old rule. Tests: all four suites pass, with a new one-engine case.
