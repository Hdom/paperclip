import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQualificationTasks } from './fork-qualification-pool.mjs';
test('runs every task once with at most two processes and preserves ordering of results', async () => {
  let active = 0, peak = 0; const seen = [];
  const result = await runQualificationTasks([0, 1, 2, 3, 4], async task => {
    active++; peak = Math.max(peak, active); seen.push(task);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
  });
  assert.equal(peak, 2); assert.deepEqual(seen.sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(result.map(row => [row.index, row.ok]), [[0, true], [1, true], [2, true], [3, true], [4, true]]);
});
test('does not cancel or drop queued tasks after a peer fails', async () => {
  const seen = [];
  const result = await runQualificationTasks([0, 1, 2, 3], async task => { seen.push(task); if (task === 1) throw new Error('synthetic failure'); });
  assert.deepEqual(seen.sort(), [0, 1, 2, 3]); assert.deepEqual(result.map(row => row.ok), [true, false, true, true]);
});
test('allows serial qualification and rejects unbounded concurrency', async () => {
  const result = await runQualificationTasks(['one'], async () => {}, 1); assert.equal(result[0].ok, true);
  for (const concurrency of [0, 3, Infinity, NaN]) await assert.rejects(runQualificationTasks([], async () => {}, concurrency));
});
