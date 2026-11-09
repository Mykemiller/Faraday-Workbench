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

function body(area) {
  if (area.id === 'people') {
    return `<div class="bar"><input id="people-q" type="search" placeholder="Search email or name" aria-label="Search people"><span class="count" id="people-count"></span></div>
<div id="people-msg" class="msg" role="status" aria-live="polite">Loading people…</div>
<div class="scroll"><table id="people-table" hidden><thead><tr><th>Email</th><th>Name</th><th>Access</th><th>Source</th><th>Added</th></tr></thead><tbody></tbody></table></div>`;
  }
  if (area.id === 'audit') {
    return `<div class="bar"><input id="audit-q" type="search" placeholder="Filter by subject email" aria-label="Filter by subject email"><span class="count" id="audit-count"></span></div>
<div id="audit-msg" class="msg" role="status" aria-live="polite">Loading the audit trail…</div>
<div class="scroll"><table id="audit-table" hidden><thead><tr><th>When (CT)</th><th>Who</th><th>App</th><th>Subject</th><th>Action</th><th>Reason</th></tr></thead><tbody></tbody></table></div>`;
  }
  return `<div class="soon"><p class="soon-tag">Coming in Phase ${area.phase}</p><p>${esc(area.blurb)}</p></div>`;
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

/* Runs in the browser. Kept free of template placeholders: the only server value it reads is
 * document.body.dataset.area. */
const JS = `
(function(){
  var esc=function(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});};
  var ct=function(ts){var d=new Date(ts);return isNaN(d)?"—":d.toLocaleString("en-US",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});};
  var day=function(ts){var d=new Date(ts);return isNaN(d)?"—":d.toLocaleDateString("en-US",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit"});};
  async function get(path){
    var r=await fetch(path,{headers:{"Accept":"application/json"}});
    if(r.status===404) throw new Error("You are signed out. Sign in on the Workbench and reload.");
    var d=await r.json().catch(function(){return {};});
    if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
    return d;
  }
  function show(val){ if(val===null||val===undefined||val==="") return "—"; return typeof val==="object"?JSON.stringify(val):String(val); }

  /* Reason side panel. open({title, before, after, linearIssue}) resolves to {reason, linearIssue}
     on Save and to null on Cancel. The reason is optional: Save never refuses an empty field. */
  var LINEAR=/^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$/;
  var pending=null;
  function panelClose(result){
    document.getElementById("reason-panel").hidden=true; document.getElementById("reason-scrim").hidden=true;
    var p=pending; pending=null; if(p){ if(p.focus&&p.focus.focus) p.focus.focus(); p.resolve(result); }
  }
  function reasonPanel(opts){
    opts=opts||{};
    if(pending) panelClose(null);
    var before=opts.before||{}, after=opts.after||{};
    var keys=Object.keys(Object.assign({},before,after)).filter(function(k){return show(before[k])!==show(after[k]);});
    document.getElementById("reason-title").textContent=opts.title||"Confirm change";
    document.getElementById("reason-diff").innerHTML=keys.length
      ? keys.map(function(k){return "<tr><th scope=\\"row\\">"+esc(k)+"</th><td class=\\"was\\">"+esc(show(before[k]))+"</td><td class=\\"now\\">"+esc(show(after[k]))+"</td></tr>";}).join("")
      : "<tr><td colspan=\\"3\\">Nothing changes.</td></tr>";
    var issue=String(opts.linearIssue||"").trim().toUpperCase(); if(!LINEAR.test(issue)) issue="";
    var field=document.getElementById("reason-text"); field.value=issue;
    document.getElementById("reason-hint").textContent=issue?"Optional. Starts as the Linear issue this change names.":"Optional.";
    document.getElementById("reason-save").disabled=!keys.length;
    document.getElementById("reason-scrim").hidden=false; document.getElementById("reason-panel").hidden=false;
    var focus=document.activeElement; field.focus();
    return new Promise(function(resolve){ pending={resolve:resolve,focus:focus,issue:issue}; });
  }
  document.getElementById("reason-save").addEventListener("click",function(){
    var issue=pending?pending.issue:""; panelClose({reason:document.getElementById("reason-text").value.trim(),linearIssue:issue||null});
  });
  document.getElementById("reason-cancel").addEventListener("click",function(){panelClose(null);});
  document.getElementById("reason-scrim").addEventListener("click",function(){panelClose(null);});
  document.addEventListener("keydown",function(e){ if(e.key==="Escape"&&pending) panelClose(null); });
  window.AdminConsole={reasonPanel:reasonPanel};

  var area=document.body.dataset.area;
  if(area==="people"){
    var PEOPLE=[];
    var drawPeople=function(){
      var n=document.getElementById("people-q").value.trim().toLowerCase();
      var rows=PEOPLE.filter(function(p){return !n||String(p.email).toLowerCase().indexOf(n)>=0||String(p.displayName||"").toLowerCase().indexOf(n)>=0;});
      document.getElementById("people-count").textContent=rows.length+(rows.length===1?" person":" people");
      document.querySelector("#people-table tbody").innerHTML=rows.map(function(p){
        var acc=(p.access||[]).map(function(a){return "<span class=\\"tag"+(a.state==="active"?"":" off")+"\\" title=\\""+esc(a.state)+(a.expiresAt?" · until "+esc(day(a.expiresAt)):"")+"\\">"+esc(a.product)+" · "+esc(a.role)+"</span>";}).join("")||"—";
        return "<tr><td class=\\"wrap\\">"+esc(p.email)+"</td><td>"+esc(p.displayName||"—")+"</td><td>"+acc+"</td><td>"+esc(p.source)+"</td><td>"+esc(day(p.createdAt))+"</td></tr>";
      }).join("");
    };
    document.getElementById("people-q").addEventListener("input",drawPeople);
    get("/api/admin/people").then(function(d){ PEOPLE=d.people||[]; document.getElementById("people-msg").textContent=""; document.getElementById("people-table").hidden=false; drawPeople(); })
      .catch(function(e){ var m=document.getElementById("people-msg"); m.textContent=e.message; m.className="msg err"; });
  }
  if(area==="audit"){
    var timer=null;
    var loadAudit=function(){
      var q=document.getElementById("audit-q").value.trim(), m=document.getElementById("audit-msg");
      get("/api/admin/audit"+(q?"?q="+encodeURIComponent(q):"")).then(function(d){
        var rows=d.rows||[]; m.textContent=rows.length?"":"No audit rows match."; m.className="msg";
        document.getElementById("audit-count").textContent=rows.length+(rows.length===1?" row":" rows")+" (newest 100)";
        document.getElementById("audit-table").hidden=!rows.length;
        document.querySelector("#audit-table tbody").innerHTML=rows.map(function(r){
          var who=esc(r.actorEmail||r.actor)+(r.actorVerified?"":" <span class=\\"unverified\\">(unverified)</span>");
          return "<tr><td>"+esc(ct(r.at))+"</td><td class=\\"wrap\\">"+who+"</td><td>"+esc(r.product)+"</td><td class=\\"wrap\\">"+esc(r.subject)+"</td><td>"+esc(r.action)+"</td><td class=\\"wrap\\">"+esc(r.reason||"—")+"</td></tr>";
        }).join("");
      }).catch(function(e){ m.textContent=e.message; m.className="msg err"; });
    };
    document.getElementById("audit-q").addEventListener("input",function(){ clearTimeout(timer); timer=setTimeout(loadAudit,250); });
    loadAudit();
  }
})();
`;

/** The whole page for one area. `actor` is what requireOwner() returned. */
function renderShell(area, actor) {
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
<body data-area="${area.id}">
<header class="top">
  <div class="brand">Faraday Admin<small>Owner console</small></div>
  <a class="back" href="/">← Workbench</a>
  <span class="who" id="who">${esc(actor && actor.email)}</span>
</header>
<div class="layout">
  <nav class="areas" aria-label="Admin areas">${nav}</nav>
  <main id="main"><h1>${esc(area.label)}</h1>
${body(area)}
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
