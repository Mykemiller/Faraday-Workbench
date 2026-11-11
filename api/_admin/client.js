/* The console's browser code (FDY-287, FDY-288). This function is NOT run on the server:
 * api/_admin/shell.js prints its source into the page, inside the Owner gate, so it must be
 * self-contained (no require, no outer variables). The only server values it reads are
 * document.body.dataset.area and document.body.dataset.id.
 */
'use strict';

module.exports = function adminClient() {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ct = function (ts) { var d = new Date(ts); return isNaN(d) ? '—' : d.toLocaleString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); };
  var day = function (ts) { var d = new Date(ts); return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }); };
  var show = function (v) { if (v === null || v === undefined || v === '') return '—'; return typeof v === 'object' ? JSON.stringify(v) : String(v); };
  var say = function (id, text, kind) { var m = $(id); if (m) { m.textContent = text || ''; m.className = 'msg' + (kind ? ' ' + kind : ''); } };

  async function api(path, body) {
    var init = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: { Accept: 'application/json' } };
    var r = await fetch(path, init);
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      var e = new Error(r.status === 404 && d.error === 'Not found' ? 'You are signed out. Sign in on the Workbench and reload.' : (d.message || d.error || ('HTTP ' + r.status)));
      e.status = r.status; e.data = d; throw e;
    }
    return d;
  }

  /* ---- reason side panel -------------------------------------------------------------------
     open({title, before, after, linearIssue}) resolves to {reason, linearIssue} on Save and to
     null on Cancel. The reason is optional: Save never refuses an empty field. */
  var LINEAR = /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$/;
  var pending = null;
  function panelClose(result) {
    $('reason-panel').hidden = true; $('reason-scrim').hidden = true;
    var p = pending; pending = null;
    if (p) { if (p.focus && p.focus.focus) p.focus.focus(); p.resolve(result); }
  }
  function reasonPanel(opts) {
    opts = opts || {};
    if (pending) panelClose(null);
    var before = opts.before || {}, after = opts.after || {};
    var keys = Object.keys(Object.assign({}, before, after)).filter(function (k) { return show(before[k]) !== show(after[k]); });
    $('reason-title').textContent = opts.title || 'Confirm change';
    $('reason-diff').innerHTML = keys.length
      ? keys.map(function (k) { return '<tr><th scope="row">' + esc(k) + '</th><td class="was">' + esc(show(before[k])) + '</td><td class="now">' + esc(show(after[k])) + '</td></tr>'; }).join('')
      : '<tr><td colspan="3">Nothing changes.</td></tr>';
    var issue = String(opts.linearIssue || '').trim().toUpperCase(); if (!LINEAR.test(issue)) issue = '';
    var field = $('reason-text'); field.value = issue;
    $('reason-hint').textContent = issue ? 'Optional. Starts as the Linear issue this change names.' : 'Optional.';
    $('reason-save').disabled = !keys.length;
    $('reason-scrim').hidden = false; $('reason-panel').hidden = false;
    var focus = document.activeElement; field.focus();
    return new Promise(function (resolve) { pending = { resolve: resolve, focus: focus, issue: issue }; });
  }
  $('reason-save').addEventListener('click', function () { var issue = pending ? pending.issue : ''; panelClose({ reason: $('reason-text').value.trim(), linearIssue: issue || null }); });
  $('reason-cancel').addEventListener('click', function () { panelClose(null); });
  $('reason-scrim').addEventListener('click', function () { panelClose(null); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pending) panelClose(null); });
  window.AdminConsole = { reasonPanel: reasonPanel };

  /* A link from a Linear issue can carry ?issue=FDY-123; every change made on that visit then
     starts its reason as that issue. */
  var ISSUE = (new URLSearchParams(location.search).get('issue') || '').toUpperCase();
  if (!LINEAR.test(ISSUE)) ISSUE = '';
  var withIssue = function (path) { return ISSUE ? path + (path.indexOf('?') < 0 ? '?' : '&') + 'issue=' + encodeURIComponent(ISSUE) : path; };

  var tag = function (a) { return '<span class="tag' + (a.state === 'active' ? '' : ' off') + '" title="' + esc(a.state) + (a.expiresAt ? ' · until ' + esc(day(a.expiresAt)) : '') + '">' + esc(a.label || a.product) + ' · ' + esc(a.role) + (a.state === 'active' ? '' : ' · ' + esc(a.state)) + '</span>'; };
  var fillSelect = function (el, items, first) { el.innerHTML = (first ? '<option value="">' + esc(first) + '</option>' : '') + items.map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(o.label) + '</option>'; }).join(''); };
  var daysFromNow = function (n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); };

  var area = document.body.dataset.area, subview = document.body.dataset.id || '';
  var personId = subview === 'access' ? '' : subview;
  /* /admin/people/review is served by the same page as the directory (vercel.json rewrites it to /admin/people);
     the path tells this code which panel to show. */
  var isReview = area === 'people' && !subview && location.pathname.replace(/\/+$/, '') === '/admin/people/review';

  /* ---- People directory -------------------------------------------------------------------- */
  if (area === 'people' && !subview && !isReview) {
    var F = ['q', 'app', 'status', 'expiry', 'persona'], OPTS = null, timer = null;
    var params = new URLSearchParams(location.search);
    /* Filters arrive in the URL. Status and expiry have fixed options; app and persona get theirs
       from the first response, so until then their wanted value is carried in dataset.want. */
    F.forEach(function (k) { if (params.get(k)) $('f-' + k).dataset.want = params.get(k); });
    $('f-q').value = params.get('q') || ''; $('f-status').value = params.get('status') || ''; $('f-expiry').value = params.get('expiry') || '';
    var query = function () { var p = new URLSearchParams(); F.forEach(function (k) { var el = $('f-' + k), v = el.value.trim() || (OPTS ? '' : (el.dataset.want || '')); if (v) p.set(k, v); }); return p; };
    var setRoles = function () {
      var prod = (OPTS.products.filter(function (x) { return x.id === $('add-app').value; })[0]) || { roles: [] };
      fillSelect($('add-role'), prod.roles.map(function (r) { return { id: r, label: r }; }));
      setExpiry();
    };
    var setExpiry = function () { if (!$('add-exp').dataset.touched) $('add-exp').value = $('add-role').value === 'tester' ? daysFromNow(14) : ''; };
    var loadPeople = function () {
      var p = query(), qs = p.toString();
      if (ISSUE) p.set('issue', ISSUE);
      history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p.toString() : ''));
      return api('/api/admin/people' + (qs ? '?' + qs : '')).then(function (d) {
        if (!OPTS) {
          OPTS = d.options;
          fillSelect($('f-app'), OPTS.products, 'Any app'); fillSelect($('add-app'), OPTS.products);
          fillSelect($('f-persona'), [{ id: 'unset', label: 'Not set' }].concat(OPTS.personas.map(function (m) { return { id: m, label: m }; })), 'Any persona');
          ['app', 'status', 'expiry', 'persona'].forEach(function (k) { var w = $('f-' + k).dataset.want; if (w) $('f-' + k).value = w; });
          setRoles();
        }
        say('people-msg', d.people.length ? '' : 'Nobody matches.');
        $('people-count').textContent = d.count + ' of ' + d.total + (d.total === 1 ? ' person' : ' people');
        $('people-table').hidden = !d.people.length;
        document.querySelector('#people-table tbody').innerHTML = d.people.map(function (p) {
          return '<tr data-id="' + esc(p.id) + '"><td class="wrap"><a href="' + esc(withIssue('/admin/people/' + p.id)) + '">' + esc(p.email) + '</a></td><td>' + esc(p.displayName || '—') + '</td><td>'
            + ((p.access || []).map(tag).join('') || '—') + '</td><td>' + esc(p.plan || 'None yet') + '</td><td>'
            + ((p.consent || []).map(function (c) { return '<span class="tag">' + esc(c.product) + ' ' + esc(c.channel) + ': ' + esc(c.label) + '</span>'; }).join('') || '—')
            + '</td><td>' + esc(p.persona || 'Not set') + '</td></tr>';
        }).join('');
      }).catch(function (e) { say('people-msg', e.message, 'err'); });
    };
    F.forEach(function (k) { $('f-' + k).addEventListener(k === 'q' ? 'input' : 'change', function () { clearTimeout(timer); timer = setTimeout(loadPeople, k === 'q' ? 250 : 0); }); });
    $('add-app').addEventListener('change', setRoles);
    $('add-role').addEventListener('change', setExpiry);
    $('add-exp').addEventListener('input', function () { $('add-exp').dataset.touched = '1'; });
    $('add-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = $('add-email').value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('add-msg', 'That does not look like an email address.', 'err'); return; }
      var product = $('add-app').value, role = $('add-role').value, exp = $('add-exp').value;
      var ok = await reasonPanel({ title: 'Add ' + email, before: {}, after: { email: email, app: product, role: role, status: 'active', expires: exp || 'never' }, linearIssue: ISSUE });
      if (!ok) return;
      say('add-msg', 'Saving…');
      try {
        var d = await api('/api/admin/people', { email: email, product: product, role: role, expiresAt: exp, reason: ok.reason, linearIssue: ok.linearIssue });
        say('add-msg', d.message, 'ok');
        if (d.url) location.href = withIssue(d.url); else loadPeople();
      } catch (err) {
        var m = $('add-msg'); m.className = 'msg err'; m.textContent = err.message + ' ';
        if (err.data && err.data.url) { var a = document.createElement('a'); a.href = withIssue(err.data.url); a.textContent = 'Open their page'; m.appendChild(a); }
      }
    });
    loadPeople();
  }


  /* ---- People > Review (FDY-290): the Predicts review queue ------------------------------------ */
  if (isReview) {
    $('dir-panel').hidden = true; $('rev-panel').hidden = false;
    document.title = 'Review · Faraday Admin';
    Array.prototype.forEach.call(document.querySelectorAll('.tabs a'), function (a) {
      if (a.getAttribute('href') === '/admin/people/review') a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var REV = [];
    var revWord = { pending_review: 'Pending review', approved: 'Approved', rejected: 'Rejected' };
    var optWord = { not_invited: 'Not invited', invited: 'Invited', confirmed: 'Confirmed', unsubscribed: 'Unsubscribed' };
    var revDraw = function () {
      var pending = REV.filter(function (r) { return r.reviewStatus === 'pending_review'; }).length;
      $('rev-count').textContent = REV.length + (REV.length === 1 ? ' person' : ' people') + ' · ' + pending + ' pending';
      $('rev-table').hidden = !REV.length;
      document.querySelector('#rev-table tbody').innerHTML = REV.map(function (r) {
        var decide = r.reviewStatus === 'pending_review'
          ? '<button type="button" class="gold" data-act="approve">Approve</button><button type="button" data-act="reject">Reject</button>'
          : esc(r.reviewedBy ? 'by ' + r.reviewedBy : '—');
        return '<tr data-email="' + esc(r.email) + '"><td class="wrap">' + esc(r.email) + '</td><td>' + esc(r.source || '—') + '</td><td>' + esc(r.createdAt ? day(r.createdAt) : '—')
          + '</td><td>' + esc(r.lastSeenAt ? day(r.lastSeenAt) : '—') + '</td><td>' + esc(optWord[r.optinStatus] || r.optinStatus) + '</td><td><span class="tag' + (r.reviewStatus === 'pending_review' ? '' : ' off') + '">'
          + esc(revWord[r.reviewStatus] || r.reviewStatus) + '</span></td><td class="acts">' + decide + '</td></tr>';
      }).join('');
    };
    var revLoad = function () {
      return api('/api/admin/review').then(function (d) {
        if (d.waiting) { REV = []; revDraw(); $('rev-table').hidden = true; $('rev-count').textContent = ''; say('rev-msg', d.message || 'Waiting on FDY-252 migration', 'err'); return; }
        REV = d.rows; say('rev-msg', REV.length ? '' : 'Nobody is waiting for a decision.'); revDraw();
      }).catch(function (e) { say('rev-msg', e.message, 'err'); });
    };
    $('rev-table').addEventListener('click', async function (e) {
      var btn = e.target.closest('button[data-act]'); if (!btn) return;
      var email = btn.closest('tr').dataset.email, act = btn.dataset.act;
      var to = act === 'approve' ? 'Approved' : 'Rejected';
      var ok = await reasonPanel({
        title: (act === 'approve' ? 'Approve ' : 'Reject ') + email,
        before: { review: 'Pending review', 'invitation email': 'not sent' },
        after: { review: to, 'invitation email': act === 'approve' ? 'not sent now; the FDY-112 job sends it later' : 'never sent' },
        linearIssue: ISSUE
      });
      if (!ok) return;
      say('rev-msg', 'Saving…');
      try {
        var d = await api('/api/admin/review', { email: email, decision: act, confirm: true, reason: ok.reason, linearIssue: ok.linearIssue });
        await revLoad(); say('rev-msg', d.message, 'ok');
      } catch (err) { say('rev-msg', err.message, 'err'); await revLoad().then(function () { say('rev-msg', err.message, 'err'); }); }
    });
    revLoad();
  } else if (area === 'people' && !subview) {
    $('rev-panel').hidden = true;
  }

  /* ---- People > Access (FDY-289): who holds access to one app ---------------------------------- */
  if (area === 'people' && subview === 'access') {
    var ACC = null, accApp = new URLSearchParams(location.search).get('app') || '';
    var accRow = function (id) { return ACC.rows.filter(function (x) { return x.personId === id; })[0]; };
    var accBefore = function (a) { return { role: a.role, status: a.status, expires: a.expiresAt ? day(a.expiresAt) : 'never' }; };
    var accExpiry = function () { if (!$('acc-exp').dataset.touched) $('acc-exp').value = $('acc-role').value === 'tester' ? daysFromNow(ACC.testerDefaultDays) : ''; };
    var accDraw = function () {
      var n = $('acc-q').value.trim().toLowerCase();
      var rows = ACC.rows.filter(function (a) { return !n || String(a.email).toLowerCase().indexOf(n) >= 0 || a.role.indexOf(n) >= 0 || a.state.indexOf(n) >= 0; });
      $('acc-count').textContent = rows.length + (rows.length === 1 ? ' grant' : ' grants');
      $('acc-table').hidden = !rows.length;
      say('acc-msg', rows.length ? '' : (n ? 'No grants match.' : 'Nobody has access to ' + ACC.label + ' yet.'));
      document.querySelector('#acc-table tbody').innerHTML = rows.map(function (a) {
        var roles = ACC.roles.indexOf(a.role) < 0 ? [a.role].concat(ACC.roles) : ACC.roles;
        var b = function (act, label, cls) { return '<button type="button" data-act="' + act + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + label + '</button>'; };
        var acts = a.status === 'revoked' ? b('restore', 'Restore') : (a.status === 'paused' ? b('resume', 'Resume', 'gold') : b('pause', 'Pause')) + b('revoke', 'Revoke');
        return '<tr data-id="' + esc(a.personId) + '"><td class="wrap"><a href="' + esc(withIssue('/admin/people/' + a.personId)) + '">' + esc(a.email) + '</a></td><td><select data-f="role" aria-label="Role for ' + esc(a.email) + '">'
          + roles.map(function (r) { return '<option' + (r === a.role ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') + '</select></td><td><span class="tag' + (a.state === 'active' ? '' : ' off') + '">' + esc(a.state) + '</span></td><td><input type="date" data-f="exp" aria-label="Expiry for ' + esc(a.email) + '" value="' + esc(a.expiresAt ? a.expiresAt.slice(0, 10) : '') + '"></td><td class="wrap">' + esc(a.addedBy || '—') + '</td><td class="acts">' + acts + '</td></tr>';
      }).join('');
    };
    var accLoad = function () {
      return api('/api/admin/access' + (accApp ? '?app=' + encodeURIComponent(accApp) : '')).then(function (d) {
        var first = !ACC; ACC = d; accApp = d.app;
        if (first) { fillSelect($('acc-app'), d.apps); }
        $('acc-app').value = d.app;
        fillSelect($('acc-role'), d.roles.map(function (r) { return { id: r, label: r }; }));
        if (d.roles.indexOf('tester') >= 0) $('acc-role').value = 'tester';
        $('acc-note').textContent = d.label + ' reads this list itself. A change here is live there within 60 seconds, with no deploy. Testers default to ' + d.testerDefaultDays + ' days.';
        accExpiry(); accDraw();
      }).catch(function (e) { say('acc-msg', e.message, 'err'); });
    };
    var accWrite = async function (title, before, after, path, body) {
      var ok = await reasonPanel({ title: title, before: before, after: after, linearIssue: ISSUE });
      if (!ok) { accDraw(); return; }
      say('acc-msg', 'Saving…');
      try {
        var d = await api(path, Object.assign({ reason: ok.reason, linearIssue: ok.linearIssue }, body));
        await accLoad(); say('acc-msg', d.message, 'ok');
      } catch (err) {
        accDraw();
        var m = $('acc-msg'); m.className = 'msg err'; m.textContent = err.message + ' ';
        if (err.data && err.data.url) { var l = document.createElement('a'); l.href = withIssue(err.data.url); l.textContent = 'Open their page'; m.appendChild(l); }
      }
    };
    $('acc-app').addEventListener('change', function () {
      accApp = $('acc-app').value; delete $('acc-exp').dataset.touched;
      history.replaceState(null, '', withIssue(location.pathname + '?app=' + encodeURIComponent(accApp)));
      accLoad();
    });
    $('acc-q').addEventListener('input', accDraw);
    $('acc-role').addEventListener('change', accExpiry);
    $('acc-exp').addEventListener('input', function () { $('acc-exp').dataset.touched = '1'; });
    $('acc-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = $('acc-email').value.trim().toLowerCase(), role = $('acc-role').value, exp = $('acc-exp').value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('acc-msg', 'That does not look like an email address.', 'err'); return; }
      accWrite('Add ' + email + ' to ' + ACC.label, {}, { email: email, role: role, status: 'active', expires: exp || 'never' }, '/api/admin/access', { app: ACC.app, email: email, role: role, expiresAt: exp })
        .then(function () { if ($('acc-msg').className.indexOf('ok') >= 0) { $('acc-email').value = ''; delete $('acc-exp').dataset.touched; accExpiry(); } });
    });
    $('acc-table').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]'); if (!btn) return;
      var id = btn.closest('tr').dataset.id, a = accRow(id), act = btn.dataset.act, before = accBefore(a);
      var to = { pause: 'paused', resume: 'active', revoke: 'revoked', restore: 'active' }[act];
      accWrite(act.charAt(0).toUpperCase() + act.slice(1) + ' ' + ACC.label + ' for ' + a.email, before, Object.assign({}, before, { status: to }), '/api/admin/person', { id: id, action: act, product: ACC.app });
    });
    $('acc-table').addEventListener('change', function (e) {
      var f = e.target.dataset && e.target.dataset.f; if (!f) return;
      var id = e.target.closest('tr').dataset.id, a = accRow(id), before = accBefore(a), v = e.target.value;
      if (f === 'role') accWrite('Change role: ' + a.email, before, Object.assign({}, before, { role: v }), '/api/admin/person', { id: id, action: 'set_role', product: ACC.app, role: v });
      if (f === 'exp') accWrite('Change expiry: ' + a.email, before, Object.assign({}, before, { expires: v ? day(v + 'T23:59:59Z') : 'never' }), '/api/admin/person', { id: id, action: 'set_expiry', product: ACC.app, expiresAt: v });
    });
    accLoad();
  }

  /* ---- Person page ---------------------------------------------------------------------------- */
  if (area === 'people' && personId) {
    var P = null, POPTS = null;
    var rowBefore = function (a) { return { role: a.role, status: a.status, expires: a.expiresAt ? day(a.expiresAt) : 'never' }; };
    var writeChange = async function (title, before, after, body) {
      var ok = await reasonPanel({ title: title, before: before, after: after, linearIssue: ISSUE });
      if (!ok) return;
      say('person-msg', 'Saving…');
      try {
        var d = await api('/api/admin/person', Object.assign({ id: personId, reason: ok.reason, linearIssue: ok.linearIssue }, body));
        await loadPerson(); say('person-msg', d.message, 'ok');
      } catch (err) { say('person-msg', err.message, 'err'); }
    };
    var draw = function () {
      $('person-email').textContent = P.email;
      document.title = P.email + ' · Faraday Admin';
      $('person-meta').textContent = (P.displayName ? P.displayName + ' · ' : '') + 'source ' + P.source + ' · added ' + day(P.createdAt);
      fillSelect($('persona'), POPTS.personas.map(function (m) { return { id: m, label: m }; }), 'Not set'); $('persona').value = P.persona || '';
      document.querySelector('#access-table tbody').innerHTML = P.access.map(function (a) {
        var prod = POPTS.products.filter(function (x) { return x.id === a.product; })[0] || { roles: [a.role] };
        var roles = prod.roles.indexOf(a.role) < 0 ? [a.role].concat(prod.roles) : prod.roles;
        var b = function (act, label, cls) { return '<button type="button" data-act="' + act + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + label + '</button>'; };
        var acts = a.status === 'revoked' ? b('restore', 'Restore')
          : (a.status === 'paused' ? b('resume', 'Resume', 'gold') : b('pause', 'Pause')) + b('expire', 'Expire now') + b('revoke', 'Revoke');
        return '<tr data-product="' + esc(a.product) + '"><td>' + esc(a.label) + '</td><td><select data-f="role" aria-label="Role for ' + esc(a.label) + '">'
          + roles.map(function (r) { return '<option' + (r === a.role ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') + '</select></td><td><span class="tag' + (a.state === 'active' ? '' : ' off') + '">' + esc(a.state) + '</span></td><td><input type="date" data-f="exp" aria-label="Expiry for ' + esc(a.label) + '" value="' + esc(a.expiresAt ? a.expiresAt.slice(0, 10) : '') + '"></td><td class="acts">' + acts + '</td></tr>';
      }).join('') || '<tr><td colspan="5">No access to any app.</td></tr>';
      var free = POPTS.products.filter(function (x) { return !P.access.some(function (a) { return a.product === x.id; }); });
      $('grant-form').hidden = !free.length;
      if (free.length) { fillSelect($('grant-app'), free); grantRoles(); }
      document.querySelector('#consent-table tbody').innerHTML = P.consent.map(function (c) {
        return '<tr><td>' + esc(c.product) + '</td><td>' + esc(c.channel) + '</td><td>' + esc(c.label) + '</td><td>' + esc(c.confirmedAt ? day(c.confirmedAt) : '—') + '</td></tr>';
      }).join('') || '<tr><td colspan="4">No consent on record.</td></tr>';
      $('person-plan').textContent = P.plan || 'None yet';
    };
    var grantRoles = function () {
      var prod = POPTS.products.filter(function (x) { return x.id === $('grant-app').value; })[0] || { roles: [] };
      fillSelect($('grant-role'), prod.roles.map(function (r) { return { id: r, label: r }; }));
      $('grant-exp').value = $('grant-role').value === 'tester' ? daysFromNow(14) : '';
    };
    var loadPerson = function () {
      return api('/api/admin/person?id=' + encodeURIComponent(personId)).then(function (d) {
        P = d.person; POPTS = d.options; $('person-body').hidden = false; say('person-msg', ''); draw();
        document.querySelector('#history-table tbody').innerHTML = d.audit.map(function (r) {
          var who = esc(r.actorEmail || r.actor) + (r.actorVerified ? '' : ' <span class="unverified">(unverified)</span>');
          return '<tr><td>' + esc(ct(r.at)) + '</td><td class="wrap">' + who + '</td><td>' + esc(r.product) + '</td><td>' + esc(r.action) + '</td><td class="wrap">' + esc(show(r.before)) + ' → ' + esc(show(r.after)) + '</td><td class="wrap">' + esc(r.reason || '—') + '</td></tr>';
        }).join('') || '<tr><td colspan="6">No changes recorded.</td></tr>';
      }).catch(function (e) { say('person-msg', e.status === 404 ? 'No person with that id.' : e.message, 'err'); });
    };
    $('grant-app').addEventListener('change', grantRoles);
    $('grant-role').addEventListener('change', function () { $('grant-exp').value = $('grant-role').value === 'tester' ? daysFromNow(14) : ''; });
    $('grant-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var product = $('grant-app').value, role = $('grant-role').value, exp = $('grant-exp').value;
      writeChange('Grant ' + product + ' to ' + P.email, {}, { app: product, role: role, status: 'active', expires: exp || 'never' }, { action: 'grant', product: product, role: role, expiresAt: exp });
    });
    $('persona-save').addEventListener('click', function () {
      var v = $('persona').value;
      writeChange('Persona for ' + P.email, { persona: P.persona || 'Not set' }, { persona: v || 'Not set' }, { action: 'set_persona', persona: v });
    });
    $('access-table').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]'); if (!btn) return;
      var product = btn.closest('tr').dataset.product, a = P.access.filter(function (x) { return x.product === product; })[0], act = btn.dataset.act;
      var before = rowBefore(a), title = a.label + ' for ' + P.email;
      if (act === 'pause') writeChange('Pause ' + title, before, Object.assign({}, before, { status: 'paused' }), { action: 'pause', product: product });
      if (act === 'resume') writeChange('Resume ' + title, before, Object.assign({}, before, { status: 'active' }), { action: 'resume', product: product });
      if (act === 'revoke') writeChange('Revoke ' + title, before, Object.assign({}, before, { status: 'revoked' }), { action: 'revoke', product: product });
      if (act === 'restore') writeChange('Restore ' + title, before, Object.assign({}, before, { status: 'active' }), { action: 'restore', product: product });
      if (act === 'expire') writeChange('Expire ' + title + ' now', before, Object.assign({}, before, { expires: 'now' }), { action: 'set_expiry', product: product, expiresAt: 'now' });
    });
    $('access-table').addEventListener('change', function (e) {
      var f = e.target.dataset && e.target.dataset.f; if (!f) return;
      var product = e.target.closest('tr').dataset.product, a = P.access.filter(function (x) { return x.product === product; })[0];
      var before = rowBefore(a), title = a.label + ' for ' + P.email, v = e.target.value;
      var undo = function () { draw(); };
      if (f === 'role') writeChange('Change role: ' + title, before, Object.assign({}, before, { role: v }), { action: 'set_role', product: product, role: v }).then(undo);
      if (f === 'exp') writeChange('Change expiry: ' + title, before, Object.assign({}, before, { expires: v ? day(v + 'T23:59:59Z') : 'never' }), { action: 'set_expiry', product: product, expiresAt: v }).then(undo);
    });
    loadPerson();
  }

  /* ---- Audit --------------------------------------------------------------------------------- */
  if (area === 'audit') {
    var atimer = null;
    var loadAudit = function () {
      var q = $('audit-q').value.trim();
      api('/api/admin/audit' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (d) {
        var rows = d.rows || []; say('audit-msg', rows.length ? '' : 'No audit rows match.');
        $('audit-count').textContent = rows.length + (rows.length === 1 ? ' row' : ' rows') + ' (newest 100)';
        $('audit-table').hidden = !rows.length;
        document.querySelector('#audit-table tbody').innerHTML = rows.map(function (r) {
          var who = esc(r.actorEmail || r.actor) + (r.actorVerified ? '' : ' <span class="unverified">(unverified)</span>');
          return '<tr><td>' + esc(ct(r.at)) + '</td><td class="wrap">' + who + '</td><td>' + esc(r.product) + '</td><td class="wrap">' + esc(r.subject) + '</td><td>' + esc(r.action) + '</td><td class="wrap">' + esc(r.reason || '—') + '</td></tr>';
        }).join('');
      }).catch(function (e) { say('audit-msg', e.message, 'err'); });
    };
    $('audit-q').addEventListener('input', function () { clearTimeout(atimer); atimer = setTimeout(loadAudit, 250); });
    loadAudit();
  }
};
