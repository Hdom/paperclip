import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeMcpRepositoryMetadata, probeMcpCatalog, readBoundedJson, revokeVerificationToken, validateMetadataToken, verifyGitHubAppMcp } from './verify-github-app-mcp.mjs';

test('verification tokens require exact metadata-only scope, approved starter and one-hour maximum', () => {
  const now = Date.now(), value = { token: 'synthetic-token', permissions: { metadata: 'read' }, expires_at: new Date(now + 3_600_000).toISOString(), repositories: [{ id: 1457227143 }] };
  assert.equal(validateMetadataToken(value, now), true);
  for (const patch of [{ permissions: { metadata: 'read', contents: 'read' } }, { repositories: [{ id: 99 }] },
    { repositories: [] }, { repositories: [{ id: 1457227143 }, { id: 99 }] }, { expires_at: new Date(now + 7_200_000).toISOString() }, { token: '' }])
    assert.equal(validateMetadataToken({ ...value, ...patch }, now), false);
});

test('protocol probe sends only fixed-endpoint initialize/tools-list and never returns credentials or claims tool invocation', async () => {
  const token = 'synthetic-iat-canary', seen = [];
  const transport = {
    initializeMcpHttpSession: async ({ send, headers }) => { await send({ method: 'POST', headers, body: JSON.stringify({ method: 'initialize' }) }); return headers; },
    mcpHttpRequestHeaders: headers => headers,
    readMcpHttpResponse: response => response.json(),
  };
  const result = await probeMcpCatalog(token, transport, async (url, init) => {
    seen.push({ url, method: JSON.parse(init.body).method, redirect: init.redirect });
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    return new Response(JSON.stringify({ result: { tools: [{ name: 'synthetic-read' }] } }), { status: 200 });
  });
  assert.equal(result.catalogAccepted, true); assert.equal(result.toolInvocationVerified, false);
  assert.deepEqual(seen.map(row => row.method), ['initialize', 'tools/list']);
  assert.ok(seen.every(row => row.url === 'https://api.githubcopilot.com/mcp/' && row.redirect === 'manual'));
  assert.ok(!JSON.stringify(result).includes(token));
});

test('provider failure is sanitized without switching identity or interpreting metadata rejection as full-token incompatibility', async () => {
  const result = await probeMcpCatalog('synthetic-token', { initializeMcpHttpSession: async ({ send }) => {
    const response = await send({ method: 'POST' }); assert.equal(response.status, 401); throw Error('synthetic-provider-secret-canary');
  } }, async () => new Response('synthetic-provider-secret-canary', { status: 401 }));
  assert.equal(result.catalogAccepted, false); assert.deepEqual(result.statuses, [401]);
  assert.ok(!JSON.stringify(result).includes('secret-canary'));
});

test('cleanup accepts revoked/expired tokens, retries boundedly and reports unsettled cleanup', async () => {
  let calls = 0;
  assert.equal(await revokeVerificationToken('synthetic-token', async (url, init) => {
    assert.equal(url, 'https://api.github.com/installation/token'); assert.equal(init.method, 'DELETE'); assert.equal(init.redirect, 'manual');
    calls++; return new Response(null, { status: calls === 1 ? 503 : 204 });
  }), true); assert.equal(calls, 2);
  assert.equal(await revokeVerificationToken('synthetic-token', async () => new Response(null, { status: 401 })), true);
  calls = 0; assert.equal(await revokeVerificationToken('synthetic-token', async () => { calls++; throw Error('synthetic-network-error'); }), false);
  assert.equal(calls, 3);
});

test('JSON response bounds are enforced while streaming and cancel the reader', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readBoundedJson(response, 8), /bound/); assert.equal(cancelled, true);
  assert.deepEqual(await readBoundedJson(new Response('{"safe":true}')), { safe: true });
});

test('failed released-module import restores the prior master-file environment without touching actual keys', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-mcp-verifier-test-'));
  const previousUid = process.getuid, previousFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, previousInline = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  const instanceConfig = path.join(directory, 'config.json'), appConfig = path.join(directory, 'apps.json'), master = path.join(directory, 'master.key');
  try {
    const dist = path.join(directory, 'node_modules/@paperclipai/server/dist'); fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'build-info.json'), JSON.stringify({ commit: 'a'.repeat(40) }));
    fs.writeFileSync(master, 'synthetic-nonproduction-master', { mode: 0o600 });
    fs.writeFileSync(instanceConfig, JSON.stringify({ secrets: { localEncrypted: { keyFilePath: master } }, database: { connectionString: 'unused' } }));
    fs.writeFileSync(appConfig, JSON.stringify({ companyId: '20aa0a36-57f6-4efe-b04c-b6e69ae81dfd', owner: 'Hdom', bootstrapRepository: { repositoryId: 1457227143 }, apps: {
      implementer: { appId: 5751896, installationId: 181764479, signingKeySecret: { secretId: 'synthetic', version: 1 } },
      reviewer: { appId: 5751898, installationId: 181764510, signingKeySecret: { secretId: 'synthetic', version: 1 } },
    } }));
    process.getuid = () => 0; delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = 'synthetic-previous-path';
    await assert.rejects(verifyGitHubAppMcp({ payload: directory, sourceCommit: 'a'.repeat(40), instanceConfig, appConfig, receipt: path.join(directory, 'unused-receipt.json') }));
    assert.equal(process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, 'synthetic-previous-path');
    assert.equal(fs.readFileSync(master, 'utf8'), 'synthetic-nonproduction-master');
  } finally {
    process.getuid = previousUid;
    if (previousFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousFile;
    if (previousInline === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousInline;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('separately reviewed metadata mode invokes only the literal read-only fixture search and checks its exact identity', async () => {
  const seen = [], token = 'synthetic-token';
  const transport = { initializeMcpHttpSession: async ({ headers }) => headers, mcpHttpRequestHeaders: headers => headers, readMcpHttpResponse: response => response.json() };
  const result = await probeMcpRepositoryMetadata(token, transport, async (url, init) => {
    const body = JSON.parse(init.body); seen.push(body); assert.equal(url, 'https://api.githubcopilot.com/mcp/'); assert.equal(init.redirect, 'manual');
    const result = body.method === 'tools/list' ? { tools: [{ name: 'search_repositories', annotations: { readOnlyHint: true }, inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] } }] }
      : { content: [{ type: 'text', text: JSON.stringify({ total_count: 1, items: [{ id: 1457227143, full_name: 'Hdom/paperclip-app-bootstrap-verification-20261113' }] }) }] };
    return new Response(JSON.stringify({ result }));
  });
  assert.equal(result.toolInvocationVerified, true); assert.equal(result.repositoryMetadataMatched, true);
  assert.deepEqual(seen.map(row => row.method), ['tools/list', 'tools/call']);
  assert.deepEqual(seen[1].params, { name: 'search_repositories', arguments: { query: 'repo:Hdom/paperclip-app-bootstrap-verification-20261113' } });
  assert.ok(!JSON.stringify(result).includes(token));
});
test('metadata probe refuses an unreviewed schema or writable tool before invocation and rejects wrong results', async () => {
  const transport = { initializeMcpHttpSession: async ({ headers }) => headers, mcpHttpRequestHeaders: headers => headers, readMcpHttpResponse: response => response.json() };
  for (const variant of ['write', 'schema', 'wrong-result', 'provider-error']) {
    const seen = [];
    const result = await probeMcpRepositoryMetadata('synthetic', transport, async (_url, init) => {
      const body = JSON.parse(init.body); seen.push(body.method);
      if (body.method === 'tools/list') return new Response(JSON.stringify({ result: { tools: [{ name: 'search_repositories', annotations: { readOnlyHint: variant !== 'write' }, inputSchema: { properties: { query: { type: 'string' } }, required: variant === 'schema' ? ['query', 'unexpected'] : ['query'] } }] } }));
      return new Response(JSON.stringify({ result: variant === 'provider-error' ? { isError: true, content: [{ text: 'secret-error-canary' }] } : { structuredContent: { total_count: 1, items: [{ id: 99, full_name: 'other/repo' }] } } }));
    });
    assert.equal(result.toolInvocationVerified, false); assert.ok(!JSON.stringify(result).includes('secret-error-canary'));
    assert.deepEqual(seen, variant === 'write' || variant === 'schema' ? ['tools/list'] : ['tools/list', 'tools/call']);
  }
});
