# ADM-2.1 · Apps (FDY-294)

The Workbench half of the app registry: one card per app, a promote control, an Owner-set state from 03.00, and the first settings (the Workbench itself is the pilot). The tables and functions live in the Faraday Supabase project (migration in the other repo); this repo only reads and calls them.

## Screens

- `/admin/apps` (Cards): one card per app, from `app_registry`. Each shows the code, name, version as `XX.YY`, the state with how it was set ("set by rule" or "set by Owner"), the lifecycle stage, owner ("Owner not set" when empty), Supabase project, settings schema version and its tracker and console links. Three live fields load after the card is drawn: Open tickets, Last build, Key metric.
- `/admin/apps/settings` (Settings): the Workbench's settings, each with type and range, default, effective value, enforcement status, precedence group and whether a change needs a redeploy. The other 14 apps follow.
- Owner only. Anyone else gets the same bare 404 as every other console route.

## The state rule

| Version | State | Set by |
|---|---|---|
| below 01.00 | Not Ready | rule |
| 01.00 to 02.99 | Just Functioning | rule |
| 03.00 and above | any of Launch Ready, Needs Tuning, Just Functioning, Not Ready, Not Started | the Owner |

A version changes only through **Promote**, which must name the release (up to 120 characters). The version is `XX.YY`: two whole numbers of one or two digits each. `3.4` and `03.04` are the same; `3.`, `.4`, `a.b`, `3.4.5`, `03.100` and negatives are refused. A promote below 03.00 sets the state by rule; at 03.00 and above it leaves the state, and who set it, alone. **Set state** is disabled below 03.00 and refused by the server too.

Every promote, state change and setting change opens the reason panel (before and after, reason optional) and writes one `admin_audit` row through `auditedWrite()` (`app_registry_promote`, `app_registry_set_state`, `app_setting_set`; the database function writes the row in the same transaction; actor is the signed-in Owner). A change that changes nothing writes no row.

## Live reads and what "unavailable" means

`GET /api/admin/apps` returns stored fields only, so a slow outside service can never hold back the cards. Each live field is its own request:

- **Last build**: `GET /api/admin/apps?live=<CODE>&part=build` asks Vercel for the newest READY production deployment of the app's `vercel_project` and returns its time, short commit and the first line of the commit message.
- **Key metric**: `?live=<CODE>&part=metric` calls `app_registry_metric(p_code)`. A null label means the app has no metric yet and the card says "Not measured".
- **Open tickets**: the browser calls the existing session-gated `/api/workbench-linear?label=<linear_label>` per card and shows the count.

A live read that fails, times out or is not configured shows **unavailable** for that field only. The route still answers HTTP 200 (`{status:'unavailable'}`), never a 5xx, and the other fields and the card are unaffected. `reason` tells why: `not configured` (no token or no `vercel_project`), `failed`, or `disabled`. A card with no `linear_label` shows Open tickets as unavailable.

## Environment

| Variable | Needed for |
|---|---|
| `VERCEL_API_TOKEN` | Last build. A read-only token. Without it the field says unavailable. |
| `VERCEL_TEAM_ID` | Optional. Added as `teamId` when the projects belong to a team. |
| `LINEAR_API_KEY` | Already set; used by `/api/workbench-linear` for Open tickets. |

The Vercel project name (`vercel_project`) is never sent to the browser.

## Pilot settings (app WB)

| Key | Type | Default | Status |
|---|---|---|---|
| `apps_live_read_timeout_ms` | integer 500 to 15000 | 4000 | **Enforced**: the cap on each outbound live read |
| `apps_live_reads_enabled` | boolean | true | **Enforced**: false makes Last build and Key metric unavailable with no outbound call |
| `audit_page_size` | integer 25 to 500 | 100 | Recorded only: stored and audited, not read by the Audit screen yet |

The effective value is the stored value when a row exists, else the default. If the settings cannot be read, live reads use 4000 ms and stay on. `apps_live_reads_enabled` does not affect Open tickets, which the browser reads through the existing Linear route.

## Follow-ups

- Settings tabs for the other 14 apps (each needs its definitions seeded and its enforcing code written).
- Wire `audit_page_size` into the Audit screen so it moves from recorded only to enforced.

## Files

`api/_admin/apps-logic.js` (pure rules and shaping) · `api/_admin/apps.js` (the route) · one line in `api/admin/[route].js` · three entries in `api/_audit.js` · `api/admin/shell.js` (the `/admin/apps/settings` page id) · page and browser code in `api/_admin/shell.js`, `api/_admin/client.js`.

## Tests

`test/apps.mjs` (logic and route, mocked database), `test/apps-page.mjs` (Chromium).
