import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('retains the qualified baseline inventory, working directories and known-gap filters exactly', () => {
  const expected = JSON.parse(fs.readFileSync(new URL('./fork-qualification-inventory.json', import.meta.url), 'utf8'));
  const actual = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./fork-github-app-regressions.mjs', import.meta.url)), '--list'], { encoding: 'utf8' }));
  assert.equal(expected.baseline, '37767b35e5a142c957c8eeda55da163527443c58');
  assert.deepEqual(actual, expected.tasks);
  assert.equal(actual.length, 28);
  assert.equal(expected.baselineTasks.length, 26);
  for (const baseline of expected.baselineTasks) assert.ok(actual.some(task => task.cwd === baseline.cwd
    && JSON.stringify(task.extra) === JSON.stringify(baseline.extra)
    && baseline.files.every(file => task.files.includes(file))), `Missing baseline coverage: ${baseline.files.join(', ')}`);
  for (const file of expected.reviewedAdditions) assert.ok(actual.some(task => task.files.includes(file)), `Missing signing-key coverage: ${file}`);
  assert.deepEqual(actual.filter(task => task.extra.includes('-t')).map(task => task.extra.at(-1)), ['Local placement', 'protected']);
});
