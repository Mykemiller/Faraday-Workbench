# ADM-0.2 · Workbench sign-in (FDY-285)

Email-code sign-in with an Owner-only console role. The shared Workbench key is now break-glass only.
Decisions applied: D2, D4. Depends on FDY-252 Phase 1 being applied (ADM-0.1).

## How it works

| Piece | Behaviour |
| -- | -- |
| Entry rule | An active, unexpired `product_access` row with `product = workbench` and `role = owner`, read through `estate_access_for()`. Re-checked on every request, so a revoke takes effect at once. |
| Sign-in | `POST /api/auth` `request_code` then `verify_code`. Supabase Auth on the Faraday project mails the code. The reply to `request_code` is the same whether or not the address has access, and no code is mailed to an address without it. |
| Session | Cookie `wb_session`: httpOnly, Secure, SameSite=Strict, 8 hours, signed with `WORKBENCH_SESSION_SECRET`. It holds the person id, email and timestamps. No secret is kept in the browser; the old key in `localStorage` is deleted on load. |
| Audit | Each sign-in writes one `admin_audit` row: `actor` = the person's `estate_people.id`, `actor_verified = true`, `action = workbench.sign_in`, `via = workbench:email-code`. A sign-in that cannot be recorded is refused. |
| Step-up | `requireFresh()` in `api/_auth.js`: an Owner whose last code is under 10 minutes old. Price changes and console-role grants (later tickets) must call it. A second `verify_code` while signed in refreshes it and is audited as `workbench.step_up`. |
| Break-glass | `POST /api/auth` `break_glass` with the shared key (`WORKBENCH_REFRESH_SECRET`). Each use emails the owner, writes `admin_audit` (`actor = break-glass:shared-key`, `actor_verified = false`), and gives a 1-hour session. It never satisfies step-up. Rotating the key ends its sessions. |
| `/api/admin/*` | Every route calls `requireAdmin()` first. Without a valid session the answer is a bare 404 on every method. `test/auth.mjs` walks the folder and fails if any route answers otherwise. |
| `/api/workbench-*` | Subscribers, ISpyaDC access, recompute, Linear and the ThoughtForge retry now need a session (Owner or break-glass). The `x-workbench-key` header is no longer accepted. The ThoughtForge cron (`CRON_SECRET`) and the notes route are unchanged. |

For ISpyaDC access, a signed-in Owner is recorded as the actor; the typed "Acting as" email is used only in a break-glass session.

## Fail-closed rules

- `WORKBENCH_SESSION_SECRET` unset or shorter than 32 characters: operator routes 503, `/api/admin/*` 404.
- Access row unreadable (Supabase down): session refused.
- Break-glass with no alert-email settings: refused (503 names the missing variables). If the mail provider fails at send time, the session is still granted and the audit row records `alert_email_sent: false`.

## Environment variables (names only)

| Name | Purpose | New |
| -- | -- | -- |
| `WORKBENCH_SESSION_SECRET` | Signs the session cookie. 32+ random characters. | yes |
| `WORKBENCH_RESEND_API_KEY` | Sends the break-glass alert. | yes |
| `WORKBENCH_ALERT_FROM` | From address for the alert (a verified Resend sender). | yes |
| `WORKBENCH_ALERT_TO` | Where the alert goes (the owner). | yes |
| `WORKBENCH_REFRESH_SECRET` | Now the break-glass key only. | existing |
| `FARADAY_SERVICE_ROLE_KEY` | Server-side Supabase calls. | existing |

## Tests

```bash
npm test                      # includes test/auth.mjs and test/auth-page.mjs
```

The database test needs an empty local Postgres database. It loads `test/fixtures/estate-phase1-subset.sql` (copied from the Phase 1 migration) and refuses a hosted URL:

```bash
createdb wb_fdy285
```

```bash
WB_PG_URL='dbname=wb_fdy285' node test/auth-localdb.mjs
```

Supabase Auth (the code email) and Resend are faked in every test. No test sends email or reaches a network.
