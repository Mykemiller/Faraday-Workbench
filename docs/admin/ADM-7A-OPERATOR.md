# ADM-7a · Operator role, Workbench half (FDY-298, partial)

Who may run which apps from the console, decided in one place. Owner only to manage. Written 2026-11-12 CT.
Database half: Faraday `docs/subscriber-admin/CLOSEOUT-ITEM7A-OPERATOR.md` (migration `20261112120000_fdy298_operator_role.sql`, **must be applied first**; until then the Operators tab says "Waiting on FDY-298 migration").

## The rights decision: `api/_rights.js`
One pure function, `decide(actor, action, ctx, now)`, called by every write route **after the existing session check and before any database call**. Unknown actions are refused for everyone (a typo can never become permission).

| | Owner | Operator |
|---|---|---|
| Review people (`people.review`) | yes | yes, in scope |
| Grant access (`access.grant`: grant, restore, resume, set role) | yes | yes, in scope |
| Expire access (`access.expire`: pause, revoke, expiry) | yes | yes, in scope |
| Draft and promote settings (`setting.draft`, `setting.promote`) | yes | yes, in scope |
| Send broadcasts (`broadcast.send`) | yes | yes, in scope (no console route yet) |
| Change prices · lock config · grant console roles · see secrets | yes | **no** |
| Promote a release, set an app state, the audience gate, audit revert, persona, manage operators | yes | **no** |

**Scope:** an operator grant is `workbench / operator` with a scope: empty = all apps, otherwise one app key. A paused, revoked or expired grant decides nothing. An app with no scope key (ThoughtForge, Academy, …) needs an all-apps grant. Any write on the console itself (`workbench`) is a console-role grant, which an operator can never do.

## Console entry is NOT changed
Entry stays **Owner-only** (`api/_auth.js` is untouched; `estate_access_for` ignores operator rows). Adding an operator does not let them in; the tab says so. Because of that, no operator can reach a write route today, so the route tests call the route modules directly with an operator actor to prove each one consults the rights decision first. Phase 2 wires entry and then passes operator actors to `decide`; `auditedWrite` still requires an Owner actor and will be extended then.

## The Operators tab: `/admin/people?tab=operators`
Owner only, fresh sign-in required (granting an operator is granting a console role). List, add (email, scope, optional expiry), pause, resume, revoke, restore. Every change goes through `estate_operator_set` via `auditedWrite()`: one `admin_audit` row in the same transaction (`operator.add / pause / resume / revoke / restore / update`, scope recorded). The person page shows an operator row read-only and points here; the Access list shows console owners only.

## Files
`api/_rights.js` · `api/_admin/operators.js` + `operators-logic.js` · one line in `api/admin/[route].js` · `estate_operator_set` on the audited list in `api/_audit.js` · rights calls in `access.js`, `person.js`, `review.js`, `apps.js`, `gate.js`, `audit.js` · Operators panel in `shell.js` and `client.js` · `test/rights.mjs`, `test/operators.mjs`, `test/operators-page.mjs`.

## Not changed
`api/_auth.js`, `api/auth.js`, `api/admin/shell.js`, `vercel.json`, sign-in, the session cookie, the break-glass key. League Office session trust is **not** in this PR: it stays in FDY-298 for Phase 2.

## Manual actions for Myke
After the Faraday migration is applied and this is deployed: **People › Operators › add your own row, scope All apps.**
