/* The console's rights decision (FDY-298, ADM-7a). ONE function decides who may do what; every write route calls it
 * AFTER the existing session check. Pure: no I/O, no clock of its own (now is passed), so every allowed and refused
 * action is unit-tested.
 *
 *   Owner      may do every action listed here.
 *   Operator   may: review people (people.review), grant and expire access in scope (access.grant, access.expire),
 *              draft and promote settings (setting.draft, setting.promote), send broadcasts (broadcast.send).
 *              may NOT: change prices (price.change), lock config (config.lock), grant console roles
 *              (console_role.grant, operator.manage), see secrets (secrets.view) — and nothing else either.
 *   Scope      an operator grant carries a scope: null = all apps, otherwise one app key. It decides the app-specific
 *              actions above. A paused, revoked or expired grant decides nothing.
 *
 * Fail closed: an action not in ACTIONS is refused for EVERYONE (a typo can never become permission); an operator
 * with no grant, an app-specific action with no app named, an unknown kind of actor — all refused.
 *
 * NOT WIRED INTO CONSOLE ENTRY. Entry stays Owner-only (api/_auth.js, unchanged): an operator cannot reach a route
 * today. Phase 2 wires entry and then passes operator actors here; until then this guards the writes.
 */
'use strict';

/* operator: whether an in-scope operator may do it. product: the action is about one app, so scope is checked. */
const ACTIONS = Object.freeze({
  'people.review': { operator: true, product: true },
  'access.grant': { operator: true, product: true },
  'access.expire': { operator: true, product: true },
  'setting.draft': { operator: true, product: true },
  'setting.promote': { operator: true, product: true },
  'broadcast.send': { operator: true, product: true },
  // Owner only — named so a typo is refused rather than guessed at.
  'price.change': { operator: false },
  'config.lock': { operator: false },
  'console_role.grant': { operator: false },
  'operator.manage': { operator: false },
  'secrets.view': { operator: false },
  'registry.promote': { operator: false },
  'registry.set_state': { operator: false },
  'registry.set_live_url': { operator: false },
  'gate.set': { operator: false },
  'audit.revert': { operator: false },
  'person.persona': { operator: false }
});

/* The Workbench apps that map to a product_access scope key. An app with no key (ThoughtForge, Academy, …) is 'other':
 * only an all-apps operator may run it. */
const APP_PRODUCT = Object.freeze({ IS: 'ispyadc', JW: 'jw', FP: 'predicts', DC: 'dailychallenge', WB: 'workbench' });
const productForApp = (code) => APP_PRODUCT[String(code || '').trim().toUpperCase()] || 'other';

/** The action name for a write on one app's access row. Anything on the console itself is a console-role grant. */
function accessAction(kind, product) {
  return product === 'workbench' ? 'console_role.grant' : kind;   // kind: 'access.grant' | 'access.expire'
}

/** Live operator grants from product_access rows (role operator). Only an active, unexpired grant counts. */
function operatorGrants(rows, now) {
  return (rows || [])
    .filter((r) => r && r.role === 'operator' && r.status === 'active' && (!r.expires_at || Date.parse(r.expires_at) > now))
    .map((r) => ({ scope: r.scope_product ? String(r.scope_product) : null }));
}

/**
 * decide(actor, action, ctx, now) -> { ok: true } | { ok: false, why }
 *   actor  { kind: 'owner' } | { kind: 'operator', grants: [{ scope: null | 'app' }] }
 *   ctx    { product }   the app the action is about (required for app-specific actions)
 */
function decide(actor, action, ctx, now) {
  const spec = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!spec) return { ok: false, why: 'unknown_action' };
  if (!actor || typeof actor !== 'object') return { ok: false, why: 'no_actor' };
  if (actor.kind === 'owner') return { ok: true };
  if (actor.kind !== 'operator') return { ok: false, why: 'unknown_actor' };
  if (!spec.operator) return { ok: false, why: 'owner_only' };
  const grants = Array.isArray(actor.grants) ? actor.grants : [];
  if (!grants.length) return { ok: false, why: 'no_grant' };
  const product = ctx && typeof ctx.product === 'string' && ctx.product ? ctx.product : null;
  if (spec.product && !product) return { ok: false, why: 'app_required' };
  const inScope = grants.some((g) => g && (g.scope === null || g.scope === undefined || g.scope === product));
  return inScope ? { ok: true } : { ok: false, why: 'out_of_scope' };
}

const MESSAGES = Object.freeze({
  unknown_action: 'That action is not one the console knows.',
  no_actor: 'No signed-in person.',
  unknown_actor: 'That kind of sign-in is not allowed to do this.',
  owner_only: 'Only the Owner can do this.',
  no_grant: 'You have no active Operator grant.',
  app_required: 'This action must name an app.',
  out_of_scope: 'Your Operator grant does not cover this app.'
});

/** Route helper: true when allowed; otherwise answers 403 not_permitted and returns false. */
function guard(actor, action, ctx, res, now) {
  const d = decide(actor, action, ctx, now === undefined ? Date.now() : now);
  if (d.ok) return true;
  res.status(403).json({ error: 'not_permitted', message: MESSAGES[d.why] || 'Not permitted.' });
  return false;
}

module.exports = { ACTIONS, APP_PRODUCT, productForApp, accessAction, operatorGrants, decide, guard, MESSAGES };
