// CC-WORKBENCH-NOTES-SAVE-FIX-1.0 · schema contract for public.workbench_product_notes.
// Offline: no network, no database. Every column the notes API selects, writes or filters on
// must be declared for the table somewhere in sql/*.sql. This catches code that names a column
// no provenance file creates. It cannot tell whether that SQL was applied to the database:
// docs/change-control/SQL-MIGRATION-RULE.md covers that half.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLE = 'workbench_product_notes';

// ---------- columns declared in sql/*.sql ----------
function declaredColumns(sql) {
  const out = new Set();
  const text = sql.replace(/--[^\n]*/g, '');
  const create = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${TABLE}\\s*\\(([\\s\\S]*?)\\n\\s*\\)\\s*;`, 'gi');
  for (const m of text.matchAll(create)) {
    for (const line of m[1].split('\n')) {
      const c = /^\s*([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(line);
      if (c && !/^(constraint|primary|unique|check|foreign)$/i.test(c[1])) out.add(c[1]);
    }
  }
  const alter = new RegExp(`alter\\s+table\\s+(?:only\\s+)?(?:public\\.)?${TABLE}\\b([^;]*);`, 'gi');
  for (const m of text.matchAll(alter)) {
    for (const c of m[1].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) out.add(c[1]);
  }
  return out;
}

const sqlDir = path.join(root, 'sql');
const declared = new Set();
const declaredIn = {};
for (const f of fs.readdirSync(sqlDir).filter((n) => n.endsWith('.sql')).sort()) {
  for (const c of declaredColumns(fs.readFileSync(path.join(sqlDir, f), 'utf8'))) {
    declared.add(c);
    (declaredIn[c] = declaredIn[c] || []).push(f);
  }
}
assert.ok(declared.has('id') && declared.has('body'), `sql/*.sql declares the base ${TABLE} table`);

// ---------- columns the API uses ----------
const { COLS } = require('../api/_tfsync.js');
assert.equal(typeof COLS, 'string', 'api/_tfsync.js exports COLS');
const selected = COLS.split(',').map((s) => s.trim()).filter(Boolean);
assert.ok(selected.length >= 8, 'COLS lists the table columns');

const objectKeys = (literal) => {
  const keys = [];
  for (const part of literal.split(',')) {
    const k = /^\s*(?:\.\.\.)?['"]?([a-z_][a-z0-9_]*)['"]?\s*(?::|$)/i.exec(part);
    if (k && !part.trim().startsWith('...')) keys.push(k[1]);
  }
  return keys;
};
const ALIAS = { text: 'body' }; // `body: text` is written as a key; shorthand keys are column names

function writtenKeys(src) {
  const keys = new Set();
  // const row = { slug, kind, body: text, ... }
  for (const m of src.matchAll(/\b(?:const|let)\s+row\s*=\s*\{([^}]*)\}/g)) objectKeys(m[1]).forEach((k) => keys.add(k));
  // row.client_id = ...
  for (const m of src.matchAll(/\brow\.([a-z_][a-z0-9_]*)\s*=[^=]/gi)) keys.add(m[1]);
  // body: JSON.stringify({ status, done_at: ... }) on a table request
  for (const m of src.matchAll(/JSON\.stringify\(\s*\{([^}]*)\}\s*\)/g)) objectKeys(m[1]).forEach((k) => keys.add(k));
  // on_conflict=col and col=eq. / col=is. / col=in. / col=lt. filters in the request path
  for (const m of src.matchAll(/on_conflict=([a-z_][a-z0-9_]*)/gi)) keys.add(m[1]);
  for (const m of src.matchAll(/[?&]([a-z_][a-z0-9_]*)=(?:eq|is|in|lt|gt|lte|gte|neq)\./gi)) keys.add(m[1]);
  return [...keys].map((k) => ALIAS[k] || k);
}

const notesSrc = fs.readFileSync(path.join(root, 'api', 'workbench-notes.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(root, 'api', '_tfsync.js'), 'utf8');
assert.ok(notesSrc.includes(TABLE), `api/workbench-notes.js talks to ${TABLE}`);
const written = writtenKeys(notesSrc);
for (const must of ['slug', 'kind', 'body', 'source', 'sync_status', 'client_id', 'status', 'done_at']) {
  assert.ok(written.includes(must), `parser found the "${must}" key api/workbench-notes.js writes`);
}
// _tfsync.js filters and patches the same table; its filter columns count too.
const syncFilters = [...syncSrc.matchAll(/[?&]([a-z_][a-z0-9_]*)=(?:eq|is|in|lt|gt|lte|gte|neq)\./gi)].map((m) => m[1]);

// ---------- the contract ----------
const used = new Map();
const note = (col, where) => used.set(col, [...(used.get(col) || []), where]);
selected.forEach((c) => note(c, 'COLS in api/_tfsync.js'));
written.forEach((c) => note(c, 'api/workbench-notes.js'));
syncFilters.forEach((c) => note(c, 'filter in api/_tfsync.js'));

const missing = [...used.keys()].filter((c) => !declared.has(c)).sort();
assert.deepEqual(missing, [],
  `columns used by the notes API but not declared for ${TABLE} in sql/*.sql: `
  + missing.map((c) => `${c} (${[...new Set(used.get(c))].join(', ')})`).join('; '));

// A missing column must surface as a plain-language error, with the status code kept.
assert.ok(notesSrc.includes("rows.code === 'PGRST204'")
  && notesSrc.includes('The database is missing a column this page needs. A migration has not been applied.'),
  'api/workbench-notes.js names the missing-migration case for PGRST204');

console.log(`PASS  notes schema contract: ${used.size} columns used, all declared in sql/ (${declared.size} declared)`);
