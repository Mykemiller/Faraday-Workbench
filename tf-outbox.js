/* CC-TF-NOTES-OUTBOX-1.0 · browser-side note outbox, shared by index.html and test/tf-notes.mjs.
 * UMD: window.TfOutbox in the page, require() in Node. No dependencies, no network.
 *
 * The draft lives in localStorage under tf_note_draft (one entry per tile) from the first
 * keystroke until the server answers 200. Anything that redraws the drawer, a rejected key,
 * a network error or a reload therefore keeps the text. The draft also carries the note's
 * client_id, so every retry of the same draft is the same note on the server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TfOutbox = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DRAFT_KEY = 'tf_note_draft';

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function readAll(storage) {
    try { var v = JSON.parse(storage.getItem(DRAFT_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; }
    catch (e) { return {}; }
  }
  function writeAll(storage, all) { try { storage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch (e) { /* private mode: in-memory only */ } }

  function loadDraft(storage, slug) {
    var d = readAll(storage)[slug];
    return d && typeof d.body === 'string' ? d : null;
  }

  /* Merge a change into the tile's draft. The client_id is minted once and kept until clearDraft. */
  function saveDraft(storage, slug, patch, mint) {
    var all = readAll(storage);
    var cur = all[slug] || {};
    var next = {
      body: patch.body != null ? String(patch.body) : (cur.body || ''),
      kind: patch.kind || cur.kind || 'note',
      source: patch.source || cur.source || 'typed',
      client_id: cur.client_id || (mint || uuid)()
    };
    all[slug] = next; writeAll(storage, all);
    return next;
  }

  function clearDraft(storage, slug) {
    var all = readAll(storage);
    if (all[slug]) { delete all[slug]; writeAll(storage, all); }
  }

  /* What the panel does with a save response. Only a 200 clears the draft. */
  function interpretSave(status, json) {
    if (status === 200) {
      var s = json && json.sync;
      var msg = 'Saved.';
      if (s && s.status === 'synced' && json.note && json.note.linear_identifier) msg = 'Saved · ' + json.note.linear_identifier + ' created.';
      else if (s && s.status === 'dry_run') msg = 'Saved · dry run, no Linear issue created.';
      else if (s) msg = 'Saved · Linear issue pending, it will retry automatically.';
      return { clear: true, needKey: false, message: msg };
    }
    if (status === 401) return { clear: false, needKey: true, message: 'You are signed out. Your note is still here. Sign in to save it.' };
    var err = (json && json.error) || ('HTTP ' + status);
    return { clear: false, needKey: false, message: 'Not saved: ' + err + '. Your note is still here; press Save to try again.' };
  }

  /* Short status chip for a note row. Null when the note does not sync to Linear. */
  function syncChip(n) {
    if (!n || !n.sync_status) return null;
    switch (n.sync_status) {
      case 'synced': return { cls: 'ok', text: n.linear_identifier || 'Linear', url: n.linear_url || null };
      case 'pending_sync': return { cls: 'wait', text: 'Linear pending' };
      case 'linear_pending': return { cls: 'wait', text: 'Linear retrying (' + (n.attempts || 0) + '/10)', title: n.last_error || '' };
      case 'failed': return { cls: 'bad', text: 'Linear failed', title: n.last_error || '' };
      case 'dry_run': return { cls: 'wait', text: 'Dry run' };
      default: return null;
    }
  }

  function needsRetry(notes) {
    return (notes || []).some(function (n) { return n.sync_status === 'pending_sync' || n.sync_status === 'linear_pending'; });
  }

  /* Web Speech API constructor, or null where unsupported (the mic button is hidden then). */
  function speechCtor(win) {
    if (!win) return null;
    return win.SpeechRecognition || win.webkitSpeechRecognition || null;
  }

  /* Append dictated text to what is already typed, with one space between. */
  function appendDictation(current, said) {
    var a = String(current || ''), b = String(said || '').trim();
    if (!b) return a;
    return a && !/\s$/.test(a) ? a + ' ' + b : a + b;
  }

  return { DRAFT_KEY: DRAFT_KEY, uuid: uuid, loadDraft: loadDraft, saveDraft: saveDraft, clearDraft: clearDraft,
    interpretSave: interpretSave, syncChip: syncChip, needsRetry: needsRetry, speechCtor: speechCtor, appendDictation: appendDictation };
});
