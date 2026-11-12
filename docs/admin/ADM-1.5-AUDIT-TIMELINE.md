# ADM-1.5 · Audit timeline (FDY-292)

One list of every change, from both logs, with a safe way to undo the ones that can be undone. Owner only. Written 2026-11-11 CT.

## What it does
- **`/admin/audit`** merges `admin_audit` (console and estate functions) and `lo_audit_log` (League Office) into one timeline, newest first, 100 rows per page ("Older rows" loads the next page).
- **Filters:** person (the subject), who did it (an email, a person id, or a League Office staff address), app, setting (`CODE.key` or just the key), and which log. They combine.
- **Each row shows** when (Central), who, app, subject, action, **before**, **after** and the optional **reason**.
- **Revert** appears only on rows that can be reverted. It opens the same reason panel (before and after of the change it will make), then makes a **new change** through the audited function that made the original. That writes a **new audit row** whose reason starts `Revert of audit #<id>`. The old row is never edited; it is marked **Reverted**.

## What can be reverted (and what refuses)
| Row | Revert does | Refuses when |
|---|---|---|
| `access.add / update / pause / resume / revoke / restore` | puts the access row back to its earlier role, status, expiry and note (reverting an **add** ends the access; the row stays) | the access has changed since the row |
| `gate.lift` | arms the gate | the gate has changed since the row |
| `app.setting` | sets the earlier value | the setting has changed since the row |
| `person.persona` | sets the earlier persona (or clears it) | the persona has changed since the row |
| `gate.arm` | **never** (that would lift the gate) | always: lift deliberately in Audience gate |
| `consent.*` | never | decide again in the review queue |
| `app.promote`, `app.state`, `person.create`, `person.seed`, `gate.seed`, any unknown action | never | always |
| League Office rows | never from here | always: revert in League Office |

**State check:** a revert runs only while the current state still equals what the row left behind. Anything that moved since is left alone and the revert is refused with 409, so an old revert can never overwrite a newer change. That also makes a second revert of the same row refuse.

**Step-up:** restoring a console (`workbench`) role is a console-role grant and needs the fresh sign-in, like granting one. Arming the gate narrows who is mailed and needs none.

## Files
`api/_admin/audit.js` (route, GET + POST) · `api/_admin/audit-logic.js` (pure) · audit page markup in `api/_admin/shell.js` · browser code in `api/_admin/client.js` · `test/audit.mjs`, `test/audit-page.mjs` · fake database gained `lo_audit_log`, id/action/actor/at filters on `admin_audit`. No new route registration (`audit` was already in `api/admin/[route].js`), no `vercel.json` change.

## Not changed
Authorization (`api/_auth.js`, `api/auth.js`, `api/admin/shell.js`), the sign-in flow, the session cookie, the break-glass key. No database change: `admin_audit` stays append-only and every write goes through functions already on the audited list (`estate_access_set`, `estate_audience_gate_set`, `app_setting_set`, `estate_person_set_persona`).

## Known limits
- `admin_audit` has no `reverts_id`, so "Reverted" is read from the reason text (`Revert of audit #id`) plus the state check; League Office rows use their own `reverted_by`.
- The older parameters still work (`q` = person, `product` = app). Person, app, source and who-did-it are filtered in the database; the **setting** filter is applied to the setting rows of the newest page-and-one, so a very old setting change may need "Older rows" before it shows.
