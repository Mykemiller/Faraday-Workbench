# FDY-360 — live-site links on every app tile and Admin Panel card

Run 2026-11-13 (US Central, afternoon). Decisions (Myke): canonical store = `app_registry`; FDY-324's tile-table `live_url` migration superseded; go ahead.

## 1. Findings

```
app_registry.live_url ──► Admin Panel Apps cards   (direct read, REGISTRY_COLS)
        │
        └─ tile_slug ───► workbench_storefront_compute() ─► workbench_storefront_cache ─► status board
```

- **Two registries, one join.** Admin Panel cards read `public.app_registry` (15 rows). The board reads `workbench_storefront_tiles` through `workbench_storefront_compute()` into `workbench_storefront_cache`. They join on `app_registry.tile_slug`. WB has no tile, so it can only ever appear on the cards.
- **Why "NO LIVE URL" showed.** Production had no `live_url` column and the compute function never emitted one, so every tile fell through to the fallback pill. It was not a stale cache. FDY-324's front-end already read `t.live_url`; its migration (`wb_storefront_tiles_add_live_url.sql`) had never been applied.
- **Decision applied.** The URL lives in `app_registry.live_url` only. The compute function looks it up through `tile_slug`. FDY-324's file is deleted in this PR; the tiles table gets no column.
- **Cache.** `workbench_storefront_refresh()` was run after the migration; the cache now carries 11 tiles with a URL.

## 2. URL map (HTTP checked from Postgres `extensions.http` GET on 2026-11-13; the dev container cannot reach these hosts)

| Code | App | live_url | Source | HTTP | Notes |
|---|---|---|---|---|---|
| BL | Briefing Library | https://www.faraday-intelligence.ai/library | FDY-324 map + path check | 200 | Path on the brand site; project `faraday-briefing-library` only has a `*.vercel.app` host (307) |
| BS | Boundstone | NULL | vercel | 401 | boundstone.org, www and boardstone.vercel.app all answer 401: not 2xx/3xx, left null per rule |
| CH | Civic-Host | https://civic-host.com | vercel custom domain | 200 | |
| DC | Daily Challenge | https://www.faradaydailychallenge.com | vercel custom domain | 200 | Apex 308-redirects to www; canonical www stored |
| FA | Faraday Academy | https://faraday-academy.vercel.app/academy | vercel | 200 | **preview-grade URL, consider a custom domain**; no LearnWorlds domain found |
| FP | Faraday Predicts | https://www.faraday-intelligence.ai/predicts | brand site path | 200 | Shares Vercel project with DC and LO |
| IA | Intelligent Alert | https://www.faraday-intelligence.ai/intelligent-alert | brand site path | 200 | No own Vercel project |
| IS | ISpyaDC | https://ispyadc.com | vercel custom domain | 200 | |
| JW | Jurisdiction Watch | https://www.jurisdiction-watch.com | vercel custom domain | 200 | Apex 308-redirects to www; canonical www stored |
| LA | Live Agent | https://www.faraday-live-agent.com | vercel custom domain | 200 | New domain (attached 2026-11-12/13). Tile is disabled, so only the card shows it |
| LO | League Office | https://league-office.vercel.app | vercel | 200 | **preview-grade URL, consider a custom domain** |
| PP | Panel Podcast | NULL | none | n/a | No repo, Vercel project or domain; concept stage |
| SR | Signal Room | https://faraday-signal-room.com/signal-room | vercel custom domain | 200 | Bare domain answers 307 |
| TF | ThoughtForge Panel | https://www.faraday-thoughtforge.com/ | vercel custom domain | 200 | |
| WB | Faraday Workbench | https://www.faraday-stuff.com | vercel custom domain | 200 | The bare `faraday-stuff.com` is not attached to the project and does not resolve, so www is stored (your seed value needed this change) |

`estate-security` and `idf-health` are tiles with no app row; they show NO LIVE URL until they have one.

## 3. Changes

- Migration `add_live_url_to_app_registry` (applied 2026-11-13 ~18:40 UTC, outside the 07:00–09:00 window): snapshot table `_snapshot_app_registry_20261113` (15 rows) → `live_url` column + `app_registry_live_url_https` CHECK → audited Owner RPC `app_registry_set_live_url` (service role only) → idempotent backfill of 13 apps → asserted-`replace()` patch of `workbench_storefront_compute()`. A rolled-back probe of the same SQL ran first and passed.
- Code: `live-link.js` (the shared `LiveSiteLink`, used by both surfaces), `index.html` (pill = "LIVE SITE ↗", muted "NO LIVE URL" otherwise), `api/_admin/{apps,apps-logic,client,shell}.js` (card link before Tracker, Owner "Live site" editor, `set_live_url` action), `api/_audit.js`, `api/_rights.js` (Owner only), `sql/add_live_url_to_app_registry.sql`, tests.
- Editing: each Admin card has a **Live site** button that opens a one-field form; it goes through the reason panel and writes an `admin_audit` row. The Settings tab is a WB-only key/value pilot, so the editor lives on the card.

## 4. Verification

```sql
select code, name, live_url from app_registry order by code;
select count(*) filter (where live_url is null) as missing from app_registry;   -- 2 (BS, PP)
select t->>'slug', t->>'live_url' from jsonb_array_elements(workbench_storefront_compute()->'tiles') t;
```

Prod after apply: 13 URLs, 2 NULL; board payload carries `live_url` on 11 enabled tiles; function ACL = postgres + service_role; snapshot RLS on; probe left no residue (0 `app.live_url` audit rows, BS still NULL). Security advisors: one new INFO, `rls_enabled_no_policy` on the snapshot (intended deny-all). `npm test` green, including new `test/live-site-link.mjs`. The repo has no build, lint or type-check step.

## 5. Rollback

```sql
update public.app_registry set live_url = null;
alter table public.app_registry drop constraint app_registry_live_url_https;
alter table public.app_registry drop column live_url;
alter function public.app_registry_set_live_url(text,text,text,text,boolean,text) rename to app_registry_set_live_url_retired;
revoke all on function public.app_registry_set_live_url_retired(text,text,text,text,boolean,text) from service_role;
-- compute function: remove the one added pair, then refresh the cache
do $$ declare d text := pg_get_functiondef('public.workbench_storefront_compute'::regproc);
  p constant text := E'\n      \'live_url\', (select ar.live_url from public.app_registry ar where ar.tile_slug = r.slug limit 1),';
begin if position(p in d) = 0 then raise exception 'pair not found'; end if; execute replace(d, p, ''); end $$;
select public.workbench_storefront_refresh();
```

The pre-change rows are in `_snapshot_app_registry_20261113` (drop it after the rollback is no longer needed).

## 6. Note on timing

Production already runs FDY-324's front end, so the board shows "OPEN ↗" on those 11 tiles now. This PR renames the pill to "LIVE SITE ↗" once deployed.
