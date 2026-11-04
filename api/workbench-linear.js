/* CC-WORKBENCH-NOTES-LINEAR-1.0 · open Linear issues for one product.
 *
 * GET /api/workbench-linear?project=<linear project uuid>
 * GET /api/workbench-linear?q=<title search>          (products with no project)
 *
 * Needs LINEAR_API_KEY (a personal API key from linear.app/settings/api) on the
 * Vercel project. Gated by the shared workbench secret like the other routes,
 * because the key reads a private workspace. Fails closed when either is unset.
 * Returns issues that are not completed or canceled, newest activity first.
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

module.exports = async function handler(req, res) {
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
  if (!/^[0-9a-f-]{36}$/i.test(project) && !q) return res.status(400).json({ error: 'project (uuid) or q is required' });

  const filter = { state: { type: { nin: ['completed', 'canceled'] } } };
  if (project) filter.project = { id: { eq: project } };
  else filter.title = { containsIgnoreCase: q.slice(0, 80) };

  try {
    const r = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query: QUERY, variables: { filter, first: 50 } })
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.errors) {
      const msg = (d && d.errors && d.errors[0] && d.errors[0].message) || `HTTP ${r.status}`;
      return res.status(502).json({ error: `Linear: ${msg}` });
    }
    const issues = (d.data.issues.nodes || []).map((n) => ({
      identifier: n.identifier, title: n.title, url: n.url,
      priority: n.priority, priority_label: n.priorityLabel,
      state: n.state && n.state.name, state_type: n.state && n.state.type,
      assignee: n.assignee && n.assignee.displayName,
      labels: ((n.labels && n.labels.nodes) || []).map((l) => l.name),
      updated_at: n.updatedAt
    }));
    res.setHeader('Cache-Control', 'private, max-age=120');
    return res.status(200).json({ ok: true, count: issues.length, fetched_at: new Date().toISOString(), issues });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
