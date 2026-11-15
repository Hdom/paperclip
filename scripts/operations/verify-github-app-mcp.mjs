import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const companyId = '20aa0a36-57f6-4efe-b04c-b6e69ae81dfd';
const approved = {
  implementer: { appId: 5751896, installationId: 181764479, permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } },
  reviewer: { appId: 5751898, installationId: 181764510, permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } },
};
const starterId = 1457227143;
const endpoint = 'https://api.githubcopilot.com/mcp/';
const same = (a, b) => a && Object.keys(a).sort().join(',') === Object.keys(b).sort().join(',') && Object.entries(b).every(([key, value]) => a[key] === value);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function validateMetadataToken(value, now = Date.now()) {
  return typeof value?.token === 'string' && value.token.length > 0 && same(value.permissions, { metadata: 'read' })
    && Date.parse(value.expires_at) > now && Date.parse(value.expires_at) <= now + 3610000
    && value.repositories?.length === 1 && value.repositories[0].id === starterId;
}

/** Token stays inside this process and is sent only to the fixed GitHub MCP endpoint. No tools/call. */
export async function probeMcpCatalog(token, transport, fetchImpl = fetch) {
  const statuses = [], requestId = 'paperclip-app-mcp-verification';
  const send = async init => {
    const response = await fetchImpl(endpoint, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    statuses.push(response.status);
    return response;
  };
  try {
    const headers = await transport.initializeMcpHttpSession({ send, headers: { Authorization: `Bearer ${token}` }, requestId });
    const response = await send({ method: 'POST', headers: transport.mcpHttpRequestHeaders(headers),
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/list', params: {} }) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return { catalogAccepted: false, statuses, reason: 'provider_rejected_catalog' }; }
    const message = await transport.readMcpHttpResponse(response, requestId, { maxBytes: 2 * 1024 * 1024 });
    const tools = message?.result?.tools;
    if (!Array.isArray(tools) || tools.length > 1000) return { catalogAccepted: false, statuses, reason: 'unexpected_catalog' };
    return { catalogAccepted: true, statuses, toolCount: tools.length, toolInvocationVerified: false };
  } catch { return { catalogAccepted: false, statuses, reason: 'provider_or_protocol_rejected', toolInvocationVerified: false }; }
}

/** Stop after three cleanup attempts; a 401 means the provider already invalidated it. */
export async function revokeVerificationToken(token, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl('https://api.github.com/installation/token', {
        method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
      });
      await response.body?.cancel().catch(() => {});
      if (response.status === 204 || response.status === 401) return true;
    } catch { /* Retry within the fixed cleanup budget; never print response/error contents. */ }
  }
  return false;
}

export async function readBoundedJson(response, maximum = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Verification response has no readable body');
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maximum) throw Error('Verification response exceeded its bound');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function verifyGitHubAppMcp(options) {
  if (process.getuid?.() !== 0) throw Error('Protected controller operator required');
  const root = fs.realpathSync(options.payload), instance = read(options.instanceConfig), config = read(options.appConfig);
  if (!/^[a-f0-9]{40}$/.test(options.sourceCommit) || read(path.join(root, 'node_modules/@paperclipai/server/dist/build-info.json')).commit !== options.sourceCommit)
    throw Error('Released source identity mismatch');
  if (config.companyId !== companyId || config.owner !== 'Hdom' || config.bootstrapRepository?.repositoryId !== starterId)
    throw Error('Approved company and bootstrap inventory required');
  for (const [role, expected] of Object.entries(approved)) {
    const app = config.apps?.[role];
    if (app?.appId !== expected.appId || app.installationId !== expected.installationId || app.privateKeyPath || !app.signingKeySecret)
      throw Error('Approved native signing identity required');
  }
  const master = path.resolve(instance.secrets?.localEncrypted?.keyFilePath ?? path.join(path.dirname(options.instanceConfig), 'secrets/master.key'));
  const info = fs.lstatSync(master);
  if (fs.realpathSync(master) !== master || !info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size > 256 || process.env.PAPERCLIP_SECRETS_MASTER_KEY)
    throw Error('Existing protected native master required');
  const previousMaster = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  let dbModule;
  try {
  process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = master;
  dbModule = await import(pathToFileURL(path.join(root, 'node_modules/@paperclipai/db/dist/index.js')).href);
  const { secretService } = await import(pathToFileURL(path.join(root, 'node_modules/@paperclipai/server/dist/services/secrets.js')).href);
  const transport = await import(pathToFileURL(path.join(root, 'node_modules/@paperclipai/server/dist/services/mcp-http.js')).href);
  const db = dbModule.createDb(instance.database.connectionString), secrets = secretService(db), results = [];
  async function request(token, route, method = 'GET', body) {
    const response = await fetch(`https://api.github.com${route}`, { method, redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw Error('GitHub verification request refused'); }
    if (response.status === 204) return null;
    return readBoundedJson(response);
  }
  const negativeControl = await probeMcpCatalog('paperclip-synthetic-invalid-bearer', transport);
    for (const [role, expected] of Object.entries(approved)) {
      let jwt = '', token = '', revoked = false, scopeVerified = false, tokenIssued = false, expiresAt = null, result;
      try {
        const app = config.apps[role], ref = app.signingKeySecret;
        const signed = await secrets.signControllerGitHubAppJwt(companyId, ref.secretId, ref.version, role, app.appId);
        jwt = signed.jwt; signed.jwt = '';
        const registration = await request(jwt, '/app');
        const installation = await request(jwt, `/app/installations/${app.installationId}`);
        if (registration.id !== app.appId || registration.owner?.login !== 'Hdom' || registration.owner?.type !== 'User'
          || !same(registration.permissions, expected.permissions) || installation.id !== app.installationId || installation.app_id !== app.appId
          || installation.account?.login !== 'Hdom' || installation.target_type !== 'User' || installation.suspended_at
          || installation.repository_selection !== 'selected' || !same(installation.permissions, expected.permissions)) throw Error('Unexpected App authority');
        const issued = await request(jwt, `/app/installations/${app.installationId}/access_tokens`, 'POST', { permissions: { metadata: 'read' }, repository_ids: [starterId] });
        if (typeof issued?.token === 'string' && issued.token) { token = issued.token; tokenIssued = true; }
        if (Number.isFinite(Date.parse(issued?.expires_at))) expiresAt = new Date(issued.expires_at).toISOString();
        if (!validateMetadataToken(issued)) throw Error('Unexpected verification token scope');
        scopeVerified = true;
        result = await probeMcpCatalog(token, transport);
      } catch { result = { catalogAccepted: false, reason: 'identity_or_scope_verification_failed', toolInvocationVerified: false }; }
      finally {
        if (token) revoked = await revokeVerificationToken(token);
        jwt = ''; token = '';
      }
      results.push({ role, ...result, authenticationDistinguished: result.catalogAccepted === true && negativeControl.catalogAccepted === false && negativeControl.statuses.some(status => status === 401 || status === 403), scopeVerified, metadataOnly: scopeVerified, starterOnly: scopeVerified, tokenIssued, tokenExpiresAt: expiresAt, credentialDeliveredToAgent: false, tokenRevoked: tokenIssued ? revoked : null, ...((tokenIssued && !revoked) ? { cleanup: 'cleanup_incomplete' } : {}) });
      if (!scopeVerified || (tokenIssued && !revoked)) break; // Stop before any subsequent mint on scope/cleanup uncertainty.
    }
    const receipt = { sourceCommit: options.sourceCommit, results, negativeControl, proofLimit: 'Metadata-only installation token; initialize and tools/list only; no tool invocation or full worker-token qualification.', nativeSecretAccessAuditMayBeRecorded: true, paperclipCloudUsed: false, serverOrAgentsStarted: false,
      projectRepositoryCreated: false, installationAccessChanged: false, keyValuesDisclosed: false, jwtOrTokenDisclosed: false };
    const fd = fs.openSync(options.receipt, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return receipt;
  } finally {
    if (previousMaster === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousMaster;
    if (dbModule) await dbModule.closeRegisteredClients(instance.database.connectionString, { scope: 'database' });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { if (process.argv.length !== 3) throw Error('Non-secret options file required'); console.log(JSON.stringify(await verifyGitHubAppMcp(read(process.argv[2])))); }
  catch { console.error(JSON.stringify({ error: 'GitHub App MCP compatibility verification failed; no credentials are returned' })); process.exitCode = 1; }
}
