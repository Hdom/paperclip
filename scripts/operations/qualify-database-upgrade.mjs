import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function cloneUrl(connectionString, cloneDatabase, restore) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.search || url.hash || !/^paperclip_(?:gitops|upgrade|qualify)_[a-z0-9_]+$/.test(cloneDatabase)
      || url.pathname === '/' + cloneDatabase || restore.cloneDatabase !== cloneDatabase || restore.restoreVerified !== true
      || restore.liveDatabaseModified !== false || !/^[a-f0-9]{64}$/.test(restore.sha256 ?? '')) {
    throw new Error('Unverified isolated database target');
  }
  url.pathname = '/' + cloneDatabase;
  return url.href;
}
export async function requireCloneIdentity(client, expected) {
  const [row] = await client`SELECT current_database() AS name`;
  if (row?.name !== expected) throw new Error('Database identity differs from the restored clone');
}
export function requireUpToDate(state) {
  // The upToDate union intentionally has no pendingMigrations member.
  if (state.status !== 'upToDate') throw new Error('Migration remains pending');
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const quote = value => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Unexpected SQL identifier');
  return '"' + value + '"';
};
const retainedTables = ['companies','agents','projects','issues','issue_comments','company_secrets','company_secret_versions'];
export function validateInvariants(invariants) {
  if (!invariants || typeof invariants !== 'object' || Array.isArray(invariants)
      || Object.keys(invariants).sort().join(',') !== [...retainedTables].sort().join(',')) throw new Error('Complete retained-data baseline required');
  for (const baseline of Object.values(invariants)) {
    if (!baseline || Object.keys(baseline).sort().join(',') !== 'columns,count,digest'
        || !Array.isArray(baseline.columns) || !baseline.columns.includes('id') || new Set(baseline.columns).size !== baseline.columns.length
        || baseline.columns.some(column => typeof column !== 'string' || !/^[a-z][a-z0-9_]*$/.test(column))
        || !Number.isSafeInteger(baseline.count) || baseline.count < 0 || !/^[a-f0-9]{32}$/.test(baseline.digest)) throw new Error('Invalid retained-data baseline');
  }
  return invariants;
}
export async function qualify(options) {
  const invariants = validateInvariants(readJson(options.invariants));
  let client;
  const root = fs.realpathSync(options.payload);
  if (!/^[a-f0-9]{40}$/.test(options.sourceCommit) || readJson(path.join(root, 'node_modules/@paperclipai/server/dist/build-info.json')).commit !== options.sourceCommit)
    throw new Error('Release stamp mismatch');
  const restore = readJson(options.restoreReceipt);
  const url = cloneUrl(readJson(options.config).database.connectionString, options.cloneDatabase, restore);
  const dbEntry = path.join(root, 'node_modules/@paperclipai/db/dist/index.js');
  const require = createRequire(dbEntry);
  const postgres = require('postgres');
  client = postgres(url, { max: 1 });
  try {
    // Check the actual startup identity, before even inspecting migration state.
    await requireCloneIdentity(client, options.cloneDatabase);
    const history = await client`SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
    if (history.length !== options.expectedJournalCount || history.filter(row => row.hash === options.expectedBridgeHash).length !== 1)
      throw new Error('Restored history does not match the approved baseline');
    const db = await import(pathToFileURL(dbEntry).href);
    const before = await db.inspectMigrations(url);
    if (before.status !== 'needsMigrations' || before.pendingMigrations.some(name => name.includes('0465_')))
      throw new Error('Unexpected historical migration plan');
    await db.applyPendingMigrations(url);
    requireUpToDate(await db.inspectMigrations(url));
    const updated = await client`SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
    if (digest(updated.slice(0, history.length)) !== digest(history)
        || updated.filter(row => row.hash === options.expectedBridgeHash).length !== 1)
      throw new Error('Historical receipts changed');
    const preserved = [];
    const tables = new Set(retainedTables);
    for (const [table, baseline] of Object.entries(invariants)) {
      if (!tables.has(table)) throw new Error('Unexpected baseline table');
      const projection = baseline.columns.map(quote).join(',');
      const [actual] = await client.unsafe(`SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY id),'')) AS digest FROM (SELECT ${projection} FROM ${quote(table)}) t`);
      if (actual.count !== baseline.count || actual.digest !== baseline.digest) throw new Error('Retained data changed in ' + table);
      preserved.push(table);
    }
    const constraints = await client`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='company_secrets'::regclass AND contype='c'`;
    if (!constraints.some(row => row.definition.includes('controller'))) throw new Error('Controller secret scope is absent');
    await db.applyPendingMigrations(url);
    requireUpToDate(await db.inspectMigrations(url));
    const again = await client`SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
    if (digest(again) !== digest(updated)) throw new Error('Second migration changed receipts');
    const result = { sourceCommit: options.sourceCommit, cloneDatabase: options.cloneDatabase,
      pendingBefore: before.pendingMigrations, pendingAfter: [], retainedReceiptCount: history.length,
      upgradedReceiptCount: updated.length, preservedTables: preserved, secondApplyNoOp: true,
      liveDatabaseModified: false, serverWorkersStarted: false };
    const fd = fs.openSync(options.receipt, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(result,null,2)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return result;
  } finally { await client?.end({ timeout: 5 }); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected a non-secret options JSON file');
    console.log(JSON.stringify(await qualify(readJson(process.argv[2]))));
  } catch (error) {
    // JSON and PostgreSQL errors can include configuration/data fragments.
    console.error(JSON.stringify({ error: 'Isolated upgrade qualification failed', type: error?.name ?? 'Error' }));
    process.exitCode = 1;
  }
}
