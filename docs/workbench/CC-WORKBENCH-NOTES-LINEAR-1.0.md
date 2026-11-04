# CC-WORKBENCH-NOTES-LINEAR-1.0 — notes, actions, update stamps, Linear drill-down

Executed 2026-11-03 19:20–19:45 CT · Supabase `ycadmmngkdhvpcsrcuaq` · migration `workbench_notes_linear_1_0`

## What shipped
1. **Notes and actions per product.** `public.workbench_product_notes` (kind note|action, status open|done). RLS on; anon and authenticated have no grants. Reads via anon RPC `workbench_product_notes()`; writes only via `/api/workbench-notes` (POST insert, PATCH status), gated by `x-workbench-key` = `WORKBENCH_REFRESH_SECRET`, service key server-side. Open actions show as an amber count on the tile's Notes button.
2. **Update stamps.** Tile payload now carries `updated_at`; each card shows `upd MM/DD/YY`, the board header shows the newest tile update, the cache sync time and the scorecard date, and the drawer shows the exact tile timestamp. All rendered in America/Chicago.
3. **Linear drill-down.** `workbench_storefront_tiles.linear_project_id` (9 products bound to their Linear project UUID) and `linear_query` (title search for the five without a project). `/api/workbench-linear?project=<uuid>|q=<text>` lists issues whose state type is not completed/canceled, newest activity first, via the Linear GraphQL API. Needs `LINEAR_API_KEY` on the Vercel project; fails closed (503 with a plain message) until it is set.

## Page
Each card gains **Notes** and **Open issues** buttons; one drawer below the board holds the selected product with two tabs. The workbench key is prompted once and kept in localStorage (`wb.refresh.key`), shared with Recompute; a 401 clears it.

## Reversal
`sql/workbench_notes_linear.sql` header. Pre-change tile snapshot: `archive.workbench_storefront_tiles_pre_scorecard_20261103`.

## Out of scope
Editing tile copy from the page; multi-user attribution (author defaults to `myke`); Linear writes.
