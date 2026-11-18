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
  assert.equal(actual.length, 66);
  assert.equal(expected.baselineTasks.length, 26);
  for (const baseline of expected.baselineTasks) assert.ok(actual.some(task => task.cwd === baseline.cwd
    && JSON.stringify(task.extra) === JSON.stringify(baseline.extra)
    && baseline.files.every(file => task.files.includes(file))), `Missing baseline coverage: ${baseline.files.join(', ')}`);
  for (const file of expected.reviewedAdditions) assert.ok(actual.some(task => task.files.includes(file)), `Missing reviewed feature coverage: ${file}`);
  assert.deepEqual(actual.filter(task => task.extra.includes('-t')).map(task => task.extra.at(-1)), ['Local placement', 'protected']);
});

test('retains assembled protected SSH qualification with its unchanged target guard',()=>{
 const inventory=JSON.parse(fs.readFileSync(new URL('./fork-qualification-inventory.json',import.meta.url),'utf8'));
 assert.deepEqual(inventory.isolatedQualification.files,['server/src/__tests__/retained-ssh-workspace-integration.test.ts']);
 const workflow=fs.readFileSync(new URL('../.github/workflows/fork-linux-release.yml',import.meta.url),'utf8');
 assert.ok(workflow.includes('sudo -n python3 scripts/tests/qualify-isolated-ssh.py --user'));
 const harness=fs.readFileSync(new URL('./tests/qualify-isolated-ssh.py',import.meta.url),'utf8');
 assert.ok(harness.includes('retained-ssh-workspace-integration.test.ts'));
});

test('retains actual adapter workflow roles, failures, recovery races and one-connection qualification',()=>{
 const fixture=fs.readFileSync(new URL('../server/src/__tests__/retained-ssh-workspace-integration.test.ts',import.meta.url),'utf8');
 for(const role of ['Coordinator','Researcher','Planner','Implementer','Reviewer']) assert.ok(fixture.includes(`role:"${role}"`),`Missing real-adapter role ${role}`);
 for(const action of ['submit','approve','changes','human','next_human','chain','cancel','provider_failed','doc_changed','unsafe_link','restart','drain','older_writer','db_disconnect','unsupported_workspace'])
   assert.ok(fixture.includes(`action:"${action}"`),`Missing actual workflow boundary ${action}`);
 const workflow=fs.readFileSync(new URL('../.github/workflows/fork-linux-release.yml',import.meta.url),'utf8');
 assert.ok(workflow.includes('--case chain --handoff-pool-max 1'));
 assert.match(workflow,/name: Qualify single-connection handoff boundaries\n\s+working-directory: source/);
});

test('retains actual maintenance startup and component-browser coverage',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/fork-linux-release.yml',import.meta.url),'utf8');
 assert.ok(workflow.includes('sudo -n python3 scripts/tests/qualify-maintenance-startup.py --user'));
 assert.ok(workflow.includes('node scripts/tests/qualify-maintenance-ui.mjs'));
 const fixture=fs.readFileSync(new URL('../server/src/__tests__/retained-ssh-workspace-integration.test.ts',import.meta.url),'utf8');
 assert.ok(fixture.includes('maintenance exact source recovery preserves real SSH bytes'));
});
