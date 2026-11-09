# ADM-0.4 · Admin console shell (FDY-287)

The empty console at `/admin`, inside the Workbench. Depends on ADM-0.2 (sign-in). Decisions applied: D2, D4.

## Screens

| Area | URL | Now |
| -- | -- | -- |
| Home | `/admin` | Coming in Phase 1 |
| People | `/admin/people` | Read-only list of `estate_people` with each person's `product_access` |
| Apps | `/admin/apps` | Coming in Phase 2 |
| Plans and billing | `/admin/plans` | Coming in Phase 3 |
| Audit | `/admin/audit` | Read-only, newest 100 `admin_audit` rows, filter by subject email |
| Console | `/admin/console` | Coming in Phase 2 |

## Who can see it

A signed-in **Owner** only (`requireOwner()` in `api/_auth.js`). No session, an expired session, a non-owner, a revoked Owner and a **break-glass session** all get a bare 404, for the pages and for their data routes. The page is rendered by a function after that check (`api/admin/shell.js`); there is no static `/admin` file to fetch.

## How it is put together

| File | Role |
| -- | -- |
| `vercel.json` rewrites | `/admin` and `/admin/<area>` go to `api/admin/shell.js` |
| `api/admin/shell.js` | Owner gate, then the HTML |
| `api/_admin/shell.js` | The page: areas, markup, the reason panel |
| `api/admin/[route].js` | One function for every data route under `/api/admin/`. The gate runs here, before the route's code |
| `api/_admin/people.js`, `audit.js`, `session.js` | The routes. To add one: a file here plus one line in the router's `ROUTES` |
| `api/_audit.js` | The audit helper |

## Reason side panel

`window.AdminConsole.reasonPanel({ title, before, after, linearIssue })` returns a promise: `{ reason, linearIssue }` on Save, `null` on Cancel or Escape. It lists only the fields that change. The reason is optional and Save never asks for one. When the change names a Linear issue, the field starts as that issue key and can be edited. No screen writes yet, so nothing calls it until Phase 1.

## Audit helper

`auditedWrite(actor, { rpc, args, reason, linearIssue }, { key })` in `api/_audit.js` is the one function every console write calls.

- The change and its `admin_audit` row are written **in one transaction by the database function** it calls (the FDY-252 pattern). The helper refuses any function not on its list of audited functions, so a write cannot skip the audit row.
- The actor is the signed-in person's `estate_people` id. A caller cannot pass `p_actor`, `p_actor_verified`, `p_via` or `p_reason`; the helper sets them.
- Reason: the typed text, else the Linear issue key, else null.
- A break-glass session cannot write through it.

Audited functions today: `estate_access_set`, `estate_audience_gate_set`, `estate_consent_review`, `predicts_review_recipient`. A new write needs a database function that inserts its own audit row, then one line in `AUDITED_RPCS`.

## Tests

```bash
npm test
```

`test/admin-shell.mjs` (gate, six URLs, no price strings, data routes, audit helper with a mocked client) and `test/admin-shell-page.mjs` (the shell and the reason panel in Chromium).
