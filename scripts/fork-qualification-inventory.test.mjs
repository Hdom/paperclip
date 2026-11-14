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
  assert.equal(actual.length, 26);
  assert.deepEqual(actual.filter(task => task.extra.includes('-t')).map(task => task.extra.at(-1)), ['Local placement', 'protected']);
});
