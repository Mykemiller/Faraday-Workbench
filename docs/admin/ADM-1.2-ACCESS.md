# ADM-1.2 · People > Access (FDY-289)

The FDY-42 ISpyaDC access screen, moved into the console and repointed from `ispyadc_access` (ISpyaDC's own Supabase project, never created) to `product_access` in the Faraday project. ISpyaDC now reads that table itself.

## Screen · `/admin/people/access`

- One row per person who holds access to the chosen app. ISpyaDC is the default; `?app=jw` (or the App menu) shows another app.
- ISpyaDC's roles are `admin`, `tester`, `user`. A tester defaults to a 14-day expiry; an admin or user to none.
- **Add** by email. A new address becomes a person. A person who already has a row for the app is refused with a link to their page.
- Per row: change role, set or clear the expiry, pause or resume, revoke or restore.
- Every change opens the reason side panel (reason optional) and writes one `admin_audit` row through `auditedWrite()`, with the signed-in Owner's id as actor.
- Owner only. Anyone else gets a 404.

## What ISpyaDC does with it

ISpyaDC calls `estate_access_for(email, 'ispyadc')` server-side with a Faraday-project key and caches the answer for 60 seconds. So a grant, pause, expiry or revoke made here is live in ISpyaDC within 60 seconds, with no deploy. Only an `active`, unexpired `admin` row opens ISpyaDC's `/admin`.

## Removed from the Workbench

- `api/workbench-ispyadc-access.js` and the "ISpyaDC access" section of the Admin tab (now a link to this screen).
- The Workbench no longer uses `ISPYADC_SUPABASE_URL` or `ISPYADC_SERVICE_ROLE_KEY`; they can be deleted from its Vercel project.

## Files

`api/_admin/access.js` (list, grant by email) · row changes reuse `api/_admin/person.js` · page and browser code in `api/_admin/shell.js`, `api/_admin/client.js`.

## Tests

`test/access.mjs` (mocked client), `test/access-page.mjs` (Chromium).
