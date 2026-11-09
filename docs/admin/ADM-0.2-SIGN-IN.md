# ADM-0.2 · Workbench sign-in (FDY-285, revised)

The owner signs in with the Workbench key, typed once. There is no email code and no separate
session secret. This revises the first version of ADM-0.2, which used an email one-time code and a
break-glass key. The owner asked for the simpler flow.
Decisions applied: D4 (Owner is the only console role through Phase 1). D2 is superseded by this revision.

## How it works

| Piece | Behaviour |
| -- | -- |
| Sign-in | `POST /api/auth` with `{ action: 'sign_in', key }`. The key must equal `WORKBENCH_REFRESH_SECRET`, and `WORKBENCH_OWNER_EMAIL` must hold an active, unexpired `product_access` row with `product = workbench` and `role = owner`. |
| Entry rule re-check | The access row is re-read through `estate_access_for()` on every request, so a revoke or expiry in Supabase ends a live session at once. |
| Session | Cookie `wb_session`: httpOnly, Secure, SameSite=Strict, 8 hours. Signed with an HMAC derived from the Workbench key, so rotating the key ends every session. It holds the person id, email and timestamps. Nothing secret is kept in the browser. |
| Audit | Each sign-in writes one `admin_audit` row: `actor` = the owner's `estate_people.id`, `actor_verified = true`, `action = workbench.sign_in`, `via = workbench:key`. A sign-in that cannot be recorded is refused. |
| Step-up | `requireFresh()` in `api/_auth.js`: a sign-in under 10 minutes old. Price changes and console-role grants (later tickets) must call it. Signing in again while signed in is audited as `workbench.step_up`. |
| `/api/admin/*` | Every route calls `requireAdmin()` first. Without a valid session the answer is a bare 404 on every method. |
| `/api/workbench-*` | Subscribers, ISpyaDC access, recompute, Linear and the ThoughtForge retry need a signed-in owner session. The `x-workbench-key` header is not accepted. |

For ISpyaDC access, the signed-in owner is recorded as the actor. The typed "Acting as" field is read-only.

## Removed in this revision

- The email one-time code (`request_code`, `verify_code`) and its Supabase Auth calls.
- The break-glass path and its per-use alert email (Resend). Every sign-in is still audited.
- `WORKBENCH_SESSION_SECRET`. The session no longer needs a 32-character secret.

## Fail-closed rules

- `WORKBENCH_REFRESH_SECRET` unset: sign-in refused (503), every session refused.
- `WORKBENCH_OWNER_EMAIL` unset: sign-in refused (503) with a message that names the variable.
- Access row unreadable (Supabase down): session refused.
- Wrong key, or an owner email without owner access: 401, and nothing is written.

## Environment variables (names only; values live in Vercel)

| Name | Purpose | Status |
| -- | -- | -- |
| `WORKBENCH_REFRESH_SECRET` | The Workbench key. Signs in the owner and signs the session. | existing |
| `WORKBENCH_OWNER_EMAIL` | The owner's address. Kept out of the repo. | new |
| `FARADAY_SERVICE_ROLE_KEY` | Server-side Supabase calls. | existing |

Retired: `WORKBENCH_SESSION_SECRET`, `WORKBENCH_RESEND_API_KEY`, `WORKBENCH_ALERT_FROM`, `WORKBENCH_ALERT_TO`. They can be deleted in Vercel after this deploys.

## Tests

```bash
npm test                      # includes test/auth.mjs and test/auth-page.mjs
```

The database test needs an empty local Postgres database. It loads `test/fixtures/estate-phase1-subset.sql` and refuses a hosted URL:

```bash
createdb wb_fdy285
WB_PG_URL='dbname=wb_fdy285' node test/auth-localdb.mjs
```

Supabase REST is faked in the server tests. The browser test intercepts `/api/auth`. No test sends email or reaches a network.
