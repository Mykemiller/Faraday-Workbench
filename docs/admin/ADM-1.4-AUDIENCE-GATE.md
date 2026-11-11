# ADM-1.4 · People > Audience gate (FDY-291)

Who Predicts may email, as a setting you change here instead of a code change. Owner only. Written 2026-11-11 CT.

## What it does
- **`/admin/people?tab=gate`** shows the Predicts gate: **ARMED** (only the pinned addresses are mailed) or **LIFTED** (every approved and confirmed person is mailed). It lists the pinned addresses, how many approved and confirmed people are not pinned (who would start receiving mail if you lift it), and the gate's history from `admin_audit`.
- **Lift:** type the word `lift`, press Lift, give a reason (required). It goes through `estate_audience_gate_set` via `auditedWrite()`: one `admin_audit` row, actor = you, in the same transaction. A lift also needs a fresh sign-in (the same step-up as granting a console role).
- **Arm:** a reason, no typed word. Arming can only narrow who is mailed.
- **Takes effect within 60 seconds.** The senders (`predicts-optin-invite`, `faraday-predicts-digest`) read the gate at the start of a run and reuse one read for under 60 s. If they cannot read it they fall back to the code constant: not lifted, the two pinned owner addresses (closed).
- **The pinned list is not editable here** (there is no function for it); changing it is a migration.
- Nothing here sends email. The first run after a lift is the next scheduled one (digest 08:15 UTC; invitations 15:00 UTC).

## How the page is served
A tab on the people page: `?tab=gate`, with the markup in the same page and the browser code choosing the panel. No change to the page handler or to `vercel.json`; `/admin/people/gate` is still a bare 404.

## Files
`api/_admin/gate.js` (route) · `api/_admin/gate-logic.js` (pure) · one line in `api/admin/[route].js` · panel and tab in `api/_admin/shell.js` · browser code in `api/_admin/client.js` · `test/gate.mjs`, `test/gate-page.mjs`. `estate_audience_gate_set` was already on the audited-function list.

## Not changed
Authorization (`api/_auth.js`, `api/auth.js`, `api/admin/shell.js`), the sign-in flow, the session cookie, the break-glass key.
