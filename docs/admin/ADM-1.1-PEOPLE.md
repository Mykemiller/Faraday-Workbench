# ADM-1.1 · People directory and Person page (FDY-288)

The centre of the console. Reads `estate_people`, `product_access` and `contact_consent` (FDY-252 Phase 1). Owner only.

**Needs the Faraday migration `20261110150000_fdy288_access_pause_persona.sql` applied first** (status `paused`, column `persona_preset`). Without it the directory fails closed.

## Directory · `/admin/people`

- Search by name or email.
- Filter by app, status (active, paused, expired, revoked, no access), expiry (within 7 or 30 days, never, expired) and persona preset (MF-01 to MF-21, or not set). With an app chosen, status and expiry look at that app's row only.
- Filters live in the URL, so a filtered list can be linked: `/admin/people?app=jw&status=paused`.
- Each row lists the person's apps, plan band, consent status and persona. Plan reads "None yet" until Phase 3.
- **Add a person** grants their first access. The email is lowercased. An address already in the directory is refused with a message and a link to that person.

## Person page · `/admin/people/<person id>`

Every access row, consent row and audit row about the person, plus persona and plan.

| Change | What it does |
| -- | -- |
| Grant | Adds access to an app the person does not have. Testers default to a 14-day expiry. |
| Pause / Resume | Status `paused` keeps the row but the person cannot use the app until resumed. |
| Expire now / expiry date | Sets or clears the expiry. |
| Revoke / Restore | Ends access; restore brings it back. |
| Role | Changes the role within the app. |
| Persona | Sets or clears the persona preset. |

Every change opens the reason side panel (before, after, optional reason) and goes through `auditedWrite()`, so the database function writes the change and its `admin_audit` row together, with the signed-in person's id as actor. A link that carries `?issue=FDY-123` starts each reason as that issue.

Guards:

- The Owner cannot pause, expire or revoke their own console access.
- Granting, restoring or changing a `workbench` (console) role needs a sign-in under 10 minutes old.
- Roles offered: ISpyaDC user, tester, admin; other apps member, editor, admin; the console owner only (D4). Virtual Team Member is not a per-app role (D11).
- The consent token is never read by the console.

## Files

`api/_admin/people-logic.js` (pure: filters, validation) · `api/_admin/people.js` · `api/_admin/person.js` · `api/_admin/client.js` (browser code, printed into the page inside the Owner gate) · `api/_admin/shell.js`.

## Tests

`test/people.mjs` (mocked client), `test/people-page.mjs` (Chromium), `test/people-localdb.mjs` (local Postgres with the real functions; set `WB_PG_URL`).
