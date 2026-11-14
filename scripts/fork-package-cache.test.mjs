import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preparePackageCache } from './fork-package-cache.mjs';
test('allows an isolated builder-owned public cache without touching source or output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-cache-test-'));
  try { const source = path.join(root, 'source'), output = path.join(root, 'out'), cache = path.join(root, 'cache'); fs.mkdirSync(source);
    assert.equal(preparePackageCache(cache, source, output), cache); assert.equal(fs.existsSync(output), false);
    for (const input of ['relative-cache', source, root, path.join(source, 'cache'), path.join(output, 'cache')]) assert.throws(() => preparePackageCache(input, source, output));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('rejects symlink aliases and caches writable by other users', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-cache-test-'));
  try { const source = path.join(root, 'source'), output = path.join(root, 'out'), cache = path.join(root, 'cache'); fs.mkdirSync(source); fs.mkdirSync(cache);
    const alias = path.join(root, 'alias'); fs.symlinkSync(cache, alias); assert.throws(() => preparePackageCache(alias, source, output));
    assert.throws(() => preparePackageCache(path.join(alias, 'nested'), source, output));
    fs.chmodSync(cache, 0o777); assert.throws(() => preparePackageCache(cache, source, output));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
