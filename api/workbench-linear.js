/* CC-WORKBENCH-NOTES-LINEAR-1.0 · open Linear issues for one product.
 *
 * GET /api/workbench-linear?project=<linear project uuid>
 * GET /api/workbench-linear?q=<title search>          (products with no project)
 * GET /api/workbench-linear?keys=FDY-33,FDY-41         (explicit pinned issues)
 * GET /api/workbench-linear?label=<Product Tile label name>   (CC-WORKBENCH-TILE-LABEL-1.0)
 * label is exclusive: when present, project/q/keys are ignored and only open issues
 * carrying that child of the "Product Tile" label group are returned.
 * Otherwise any combination is unioned (CC-WORKBENCH-TILE-ISSUE-BINDING-1.0 / FDY-245).
 *
 * Needs LINEAR_API_KEY (a personal API key from linear.app/settings/api) on the
 * Vercel project. Gated by the shared workbench secret like the other routes,
 * because the key reads a private workspace. Fails closed when either is unset.
 * Returns issues that are not completed or canceled, highest priority first
 * (Urgent, High, Medium, Low, then No priority), newest activity first within a priority.
 */
'use strict';

const { refuseUnlessKeyed } = require('./_wb.js');

const QUERY = `
query WorkbenchOpenIssues($filter: IssueFilter!, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) {
    nodes {
      identifier title url priority priorityLabel updatedAt
      state { name type }
      assignee { displayName }
      labels { nodes { name } }
    }
  }
}`;

/* Linear priority: 0 = none, 1 = urgent … 4 = low. None sorts last. */
const rank = (p) => (p >= 1 && p <= 4 ? p : 5);
function sortByPriority(issues) {
  return issues.slice().sort((a, b) =>
    rank(a.priority) - rank(b.priority) ||
    String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (refuseUnlessKeyed(req, res)) return;

  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'LINEAR_API_KEY is not set on this deployment. Add it in Vercel → Settings → Environment Variables.' });
  }

  const url = new URL(req.url, 'http://x');
  const project = (url.searchParams.get('project') || '').trim();
  const q = (url.searchParams.get('q') || '').trim();
  // Pinned issue identifiers: TEAM-NUMBER, max 40, anything else dropped.
  const keys = (url.searchParams.get('keys') || '')
    .split(',').map((k) => k.trim().toUpperCase())
    .filter((k) => /^[A-Z][A-Z0-9]{0,9}-[0-9]{1,6}$/.test(k)).slice(0, 40);
  const label = (url.searchParams.get('label') || '').trim().slice(0, 60);
  const hasProject = !label && /^[0-9a-f-]{36}$/i.test(project);
  if (!label && !hasProject && !q && !keys.length) return res.status(400).json({ error: 'label, project (uuid), q, or keys is required' });

  // Union of the three bindings; the state predicate applies to all of them.
  const or = [];
  if (label) {
    // Only the Product Tile group's child of that name counts, not a same-named label elsewhere.
    or.push({ labels: { some: { name: { eq: label }, parent: { name: { eq: 'Product Tile' } } } } });
  }
  if (hasProject) or.push({ project: { id: { eq: project } } });
  if (q && !label) or.push({ title: { containsIgnoreCase: q.slice(0, 80) } });
  for (const k of (label ? [] : keys)) {
    const [team, num] = k.split('-');
    or.push({ team: { key: { eq: team } }, number: { eq: Number(num) } });
  }
  const filter = { state: { type: { nin: ['completed', 'canceled'] } }, or };

  try {
    const r = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query: QUERY, variables: { filter, first: 250 } })
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.errors) {
      const msg = (d && d.errors && d.errors[0] && d.errors[0].message) || `HTTP ${r.status}`;
      return res.status(502).json({ error: `Linear: ${msg}` });
    }
    const seen = new Set();
    const issues = sortByPriority((d.data.issues.nodes || []).filter((n) => !seen.has(n.identifier) && seen.add(n.identifier)).map((n) => ({
      identifier: n.identifier, title: n.title, url: n.url,
      priority: n.priority, priority_label: n.priorityLabel,
      state: n.state && n.state.name, state_type: n.state && n.state.type,
      assignee: n.assignee && n.assignee.displayName,
      labels: ((n.labels && n.labels.nodes) || []).map((l) => l.name),
      updated_at: n.updatedAt
    })));
    res.setHeader('Cache-Control', 'private, max-age=120');
    return res.status(200).json({ ok: true, count: issues.length, fetched_at: new Date().toISOString(), issues });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}

module.exports = handler;
module.exports.sortByPriority = sortByPriority;
