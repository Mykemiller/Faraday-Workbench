// CC-WORKBENCH-TILE-LABEL-1.0 · priority ordering for the Linear drawer (no network).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { sortByPriority } = require('../api/workbench-linear.js');
const mk = (identifier, priority, updated_at) => ({ identifier, priority, updated_at });
const out = sortByPriority([
  mk('A', 0, '2026-11-05'), mk('B', 4, '2026-11-05'), mk('C', 2, '2026-11-01'),
  mk('D', 1, '2026-10-01'), mk('E', 2, '2026-11-04'), mk('F', 3, '2026-11-05')
]).map((i) => i.identifier).join('');
assert.equal(out, 'DECFBA'); // Urgent, High (newest first), Medium, Low, None last
console.log('linear-label-sort: ok');
