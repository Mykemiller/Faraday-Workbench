# ADM-1.3 · People > Review (FDY-290)

The Predicts review queue, in the console. Owner only. Written 2026-11-11 CT.

## What it does
- **`/admin/people/review`** lists everyone in `v_predicts_recipient_review`, **pending first** (oldest first), then the decided rows. Columns: email, source, created date, last seen, opt-in status, review status.
- **Approve** and **Reject** appear only on pending rows. Each opens the reason side panel (the confirm step), then calls `predicts_review_recipient(p_email, p_decision, p_actor, p_reason)` through `auditedWrite()`. The function writes one `admin_audit` row in the same transaction; the actor is the signed-in Owner's person id.
- **Approving sends no email.** The page says so, and so does the message after every decision. The FDY-112 invitation job sends the invitation later. Nothing in this route can send mail.
- A person who is no longer pending cannot be decided here (an approved owner cannot be rejected by a stray click). Reversing a decision is a separate change.
- If the view or the function does not exist, the page shows **"Waiting on FDY-252 migration"**. The console never creates either.

## How the page is served
`vercel.json` rewrites `/admin/people/review` to `/api/admin/shell?area=people`, ahead of the generic `/admin/:area/:id` rule. The page handler (`api/admin/shell.js`) is **unchanged**: it still treats `review` as an unknown page id and returns the bare 404 for it. The people page carries both panels and the browser code shows the review panel when the path is `/admin/people/review`.

## Files
`api/_admin/review.js` (route) · `api/_admin/review-logic.js` (pure) · one line in `api/admin/[route].js` · the Review tab and panel in `api/_admin/shell.js` · browser code in `api/_admin/client.js` · `vercel.json` (one rewrite) · `test/review.mjs`, `test/review-page.mjs`. `predicts_review_recipient` was already in the audited-function list.

## Not changed
Authorization (`api/_auth.js`, `api/auth.js`, `api/admin/shell.js`), the sign-in flow, the session cookie, the break-glass key.
