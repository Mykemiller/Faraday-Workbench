/* The Admin console shell (FDY-287, ADM-0.4): one HTML page, six areas, each with its own URL
 * under /admin. Rendered on the server by api/admin/shell.js AFTER the Owner gate, so the markup
 * never reaches anyone else. People and Audit have content; the rest say which phase brings them.
 *
 * The page carries the reason side panel every write will use (window.AdminConsole.reasonPanel):
 * before and after, an optional reason, Save. Reason is never required; when the change names a
 * Linear issue the field starts with that issue key.
 */
'use strict';

const AREAS = Object.freeze([
  { id: 'home', path: '/admin', label: 'Home', phase: 1, blurb: 'A summary of people, access and recent changes.' },
  { id: 'people', path: '/admin/people', label: 'People', content: true },
  { id: 'apps', path: '/admin/apps', label: 'Apps', phase: 2, blurb: 'Settings for each app, changed here without a redeploy.' },
  { id: 'plans', path: '/admin/plans', label: 'Plans and billing', phase: 3, blurb: 'Plans, seats and billing.' },
  { id: 'audit', path: '/admin/audit', label: 'Audit', content: true },
  { id: 'console', path: '/admin/console', label: 'Console', phase: 2, blurb: 'Who may use this console, and in what role.' }
]);

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The area for a URL segment ('' or undefined = Home), or null when there is no such screen. */
function areaFor(segment) {
  const id = String(segment || '').toLowerCase() || 'home';
  return AREAS.find((a) => a.id === id) || null;
}

const STATE_OPTIONS = '<option value="">Any status</option><option value="active">Active</option><option value="paused">Paused</option><option value="expired">Expired</option><option value="revoked">Revoked</option><option value="none">No access</option>';
const EXPIRY_OPTIONS = '<option value="">Any expiry</option><option value="7d">Expires within 7 days</option><option value="30d">Expires within 30 days</option><option value="none">Never expires</option><option value="expired">Expired</option>';

const PEOPLE_TABS = (cur) => `<p class="tabs"><a href="/admin/people"${cur === 'directory' ? ' aria-current="page"' : ''}>Directory</a><a href="/admin/people/access"${cur === 'access' ? ' aria-current="page"' : ''}>Access</a></p>`;

function body(area, id) {
  if (area.id === 'people' && id === 'access') {
    return `<h1>People</h1>
${PEOPLE_TABS('access')}
<div class="bar"><label for="acc-app">App</label><select id="acc-app" aria-label="App"></select>
<input id="acc-q" type="search" placeholder="Search email, role or status" aria-label="Search access">
<span class="count" id="acc-count"></span></div>
<p class="count" id="acc-note"></p>
<form id="acc-form" class="bar"><input id="acc-email" type="email" placeholder="Add by email" aria-label="Email to add" autocapitalize="off" spellcheck="false" required>
<select id="acc-role" aria-label="Role"></select><input id="acc-exp" type="date" aria-label="Expiry (optional)"><button type="submit" class="gold">Add</button></form>
<div id="acc-msg" class="msg" role="status" aria-live="polite">Loading…</div>
<div class="scroll"><table id="acc-table" hidden><thead><tr><th>Email</th><th>Role</th><th>State</th><th>Expires</th><th>Added by</th><th>Change</th></tr></thead><tbody></tbody></table></div>`;
  }
  if (area.id === 'people' && id) {
    return `<p class="crumb"><a href="/admin/people">← People</a></p>
<h1 id="person-email">Person</h1>
<p class="count" id="person-meta"></p>
<div id="person-msg" class="msg" role="status" aria-live="polite">Loading…</div>
<div id="person-body" hidden>
<section><h2>Access</h2>
<div class="scroll"><table id="access-table"><thead><tr><th>App</th><th>Role</th><th>State</th><th>Expires</th><th>Change</th></tr></thead><tbody></tbody></table></div>
<form id="grant-form" class="bar" hidden><label for="grant-app">Grant</label><select id="grant-app" aria-label="App to grant"></select><select id="grant-role" aria-label="Role"></select><input id="grant-exp" type="date" aria-label="Expiry (optional)"><button type="submit" class="gold">Grant access</button></form></section>
<section><h2>Persona</h2><div class="bar"><select id="persona" aria-label="Persona preset"></select><button type="button" id="persona-save">Save persona</button></div></section>
<section><h2>Plan</h2><p id="person-plan">None yet</p></section>
<section><h2>Consent</h2>
<div class="scroll"><table id="consent-table"><thead><tr><th>App</th><th>Channel</th><th>Status</th><th>Confirmed</th></tr></thead><tbody></tbody></table></div></section>
<section><h2>History</h2>
<div class="scroll"><table id="history-table"><thead><tr><th>When (CT)</th><th>Who</th><th>App</th><th>Action</th><th>Change</th><th>Reason</th></tr></thead><tbody></tbody></table></div></section>
</div>`;
  }
  if (area.id === 'people') {
    return `<h1>People</h1>
${PEOPLE_TABS('directory')}
<div class="bar"><input id="f-q" type="search" placeholder="Search name or email" aria-label="Search name or email">
<select id="f-app" aria-label="Filter by app"><option value="">Any app</option></select>
<select id="f-status" aria-label="Filter by status">${STATE_OPTIONS}</select>
<select id="f-expiry" aria-label="Filter by expiry">${EXPIRY_OPTIONS}</select>
<select id="f-persona" aria-label="Filter by persona preset"><option value="">Any persona</option></select>
<span class="count" id="people-count"></span></div>
<div id="people-msg" class="msg" role="status" aria-live="polite">Loading people…</div>
<div class="scroll"><table id="people-table" hidden><thead><tr><th>Email</th><th>Name</th><th>Apps</th><th>Plan</th><th>Consent</th><th>Persona</th></tr></thead><tbody></tbody></table></div>
<section><h2>Add a person</h2>
<form id="add-form" class="bar"><input id="add-email" type="email" placeholder="email@example.com" aria-label="Email" autocapitalize="off" spellcheck="false" required>
<select id="add-app" aria-label="App"></select><select id="add-role" aria-label="Role"></select><input id="add-exp" type="date" aria-label="Expiry (optional)"><button type="submit" class="gold">Add person</button></form>
<div id="add-msg" class="msg" role="status" aria-live="polite"></div></section>`;
  }
  if (area.id === 'audit') {
    return `<h1>Audit</h1>
<div class="bar"><input id="audit-q" type="search" placeholder="Filter by subject email" aria-label="Filter by subject email"><span class="count" id="audit-count"></span></div>
<div id="audit-msg" class="msg" role="status" aria-live="polite">Loading the audit trail…</div>
<div class="scroll"><table id="audit-table" hidden><thead><tr><th>When (CT)</th><th>Who</th><th>App</th><th>Subject</th><th>Action</th><th>Reason</th></tr></thead><tbody></tbody></table></div>`;
  }
  return `<h1>${esc(area.label)}</h1>
<div class="soon"><p class="soon-tag">Coming in Phase ${area.phase}</p><p>${esc(area.blurb)}</p></div>`;
}

const CSS = `
:root{--forest-deep:#12241A;--panel:#17281e;--line:rgba(196,146,42,.28);--gold:#C4922A;--gold-bright:#E0B054;--warm:#F8F5F0;--dim:#CFC9BD;--bad:#e08a7a}
*{box-sizing:border-box}
body{margin:0;background:var(--forest-deep);color:var(--warm);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}
:focus-visible{outline:2px solid var(--gold-bright);outline-offset:2px}
.top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}
.top .brand{font-weight:600;letter-spacing:.02em}
.top .brand small{display:block;font:500 10px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.2em;text-transform:uppercase;color:var(--gold)}
.top .who{margin-left:auto;font-size:12px;color:var(--dim);overflow-wrap:anywhere}
.top .back{font-size:12px;color:var(--gold)}
.layout{display:grid;grid-template-columns:200px minmax(0,1fr);min-height:calc(100vh - 58px)}
nav.areas{border-right:1px solid var(--line);padding:12px 8px}
nav.areas a{display:block;padding:9px 10px;border-radius:3px;text-decoration:none;color:var(--dim);font-size:14px}
nav.areas a:hover{color:var(--warm)}
nav.areas a[aria-current="page"]{color:var(--gold-bright);background:rgba(196,146,42,.1)}
main{padding:20px 16px 48px;min-width:0}
h1{font:600 24px/1.2 Georgia,"Times New Roman",serif;margin:0 0 16px}
h2{font:500 12px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);margin:0 0 10px}
section{margin:28px 0 0}
.crumb{margin:0 0 8px;font-size:13px}.crumb a{color:var(--gold)}
.tabs{display:flex;gap:18px;margin:-6px 0 16px;border-bottom:1px solid var(--line)}.tabs a{padding:8px 0;font-size:14px;color:var(--dim);text-decoration:none;border-bottom:2px solid transparent}.tabs a[aria-current="page"]{color:var(--gold-bright);border-bottom-color:var(--gold)}
select{background:#0d1a13;color:inherit;border:1px solid var(--line);border-radius:3px;padding:8px 10px;font:inherit;font-size:16px;max-width:100%}
td select,td input{padding:5px 8px;font-size:14px}
td.acts{white-space:nowrap}td.acts button{padding:7px 9px;margin:0 6px 4px 0}
.msg.ok{color:var(--gold-bright)}
.bar label{font-size:13px;color:var(--dim)}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 12px}
input,textarea{background:#0d1a13;color:inherit;border:1px solid var(--line);border-radius:3px;padding:8px 10px;font:inherit;font-size:16px}
.bar input{flex:0 1 320px;min-width:0}
.count,.msg{font-size:13px;color:var(--dim)}
.msg.err{color:var(--bad)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid rgba(248,245,240,.08);vertical-align:top}
th{font:500 11px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--gold);white-space:nowrap}
td.wrap{overflow-wrap:anywhere}
.tag{display:inline-block;font:500 11px/1.5 ui-monospace,Menlo,monospace;border:1px solid var(--line);border-radius:2px;padding:0 6px;margin:0 4px 4px 0;white-space:nowrap}
.tag.off{opacity:.55;text-decoration:line-through}
.unverified{color:var(--bad)}
.soon{border:1px dashed var(--line);border-radius:4px;padding:28px 20px;max-width:560px}
.soon-tag{font:500 12px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);margin:0 0 8px}
.soon p{margin:0}
button{font:500 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;background:transparent;color:var(--dim);border:1px solid var(--line);border-radius:3px;padding:10px 14px;cursor:pointer}
button.gold{color:var(--gold-bright);border-color:var(--gold)}
#reason-scrim{position:fixed;inset:0;background:rgba(0,0,0,.55)}
#reason-panel{position:fixed;top:0;right:0;bottom:0;width:min(440px,100vw);background:var(--panel);border-left:1px solid var(--gold);padding:20px;overflow-y:auto;display:flex;flex-direction:column;gap:12px}
#reason-panel[hidden],#reason-scrim[hidden]{display:none}
#reason-panel h2{font:600 19px/1.25 Georgia,serif;margin:0}
#reason-panel table{font-size:13px}
#reason-panel td.was{color:var(--dim)}
#reason-panel td.now{color:var(--gold-bright)}
#reason-panel label{font-size:13px;color:var(--dim)}
#reason-panel textarea{width:100%;min-height:84px;resize:vertical}
#reason-panel .acts{display:flex;gap:10px;justify-content:flex-end;margin-top:auto}
@media (max-width:720px){.layout{grid-template-columns:1fr}nav.areas{border-right:0;border-bottom:1px solid var(--line);display:flex;overflow-x:auto;padding:6px 8px}nav.areas a{white-space:nowrap}}
`;

/* The browser code is api/_admin/client.js, printed into the page as source. */
const JS = '(' + require('./client.js').toString() + ')();';

/** The whole page for one area. `actor` is what requireOwner() returned. */
function renderShell(area, actor, id) {
  const pid = area.id === 'people' && id ? String(id) : '';
  const nav = AREAS.map((a) => `<a href="${a.path}"${a.id === area.id ? ' aria-current="page"' : ''}>${esc(a.label)}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${esc(area.label)} · Faraday Admin</title>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<style>${CSS}</style>
</head>
<body data-area="${area.id}"${pid ? ` data-id="${esc(pid)}"` : ''}>
<header class="top">
  <div class="brand">Faraday Admin<small>Owner console</small></div>
  <a class="back" href="/">← Workbench</a>
  <span class="who" id="who">${esc(actor && actor.email)}</span>
</header>
<div class="layout">
  <nav class="areas" aria-label="Admin areas">${nav}</nav>
  <main id="main">
${body(area, pid)}
  </main>
</div>
<div id="reason-scrim" hidden></div>
<aside id="reason-panel" role="dialog" aria-modal="true" aria-labelledby="reason-title" hidden>
  <h2 id="reason-title">Confirm change</h2>
  <div class="scroll"><table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody id="reason-diff"></tbody></table></div>
  <label for="reason-text">Reason <span id="reason-hint">Optional.</span></label>
  <textarea id="reason-text" maxlength="500"></textarea>
  <div class="acts"><button type="button" id="reason-cancel">Cancel</button><button type="button" class="gold" id="reason-save">Save</button></div>
</aside>
<script>${JS}</script>
</body>
</html>`;
}

module.exports = { AREAS, areaFor, renderShell };
