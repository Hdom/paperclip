#!/usr/bin/env node
// Fork-only native payload packaging. Requires a clean, already built and
// typechecked source checkout. Never activates an install or publishes packages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [sourceArg, outputArg, sha] = process.argv.slice(2);
if (!sourceArg || !outputArg || !/^[a-f0-9]{40}$/.test(sha ?? '')) {
  throw new Error('Usage: node fork-package-linux.mjs SOURCE_CHECKOUT EMPTY_OUTPUT_DIR FULL_SOURCE_SHA');
}
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux x64 only');
const source = fs.realpathSync(sourceArg);
const output = path.resolve(outputArg);
if (fs.existsSync(output)) throw new Error('Output must not already exist');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const run = (command, args, cwd = source, capture = false) => execFileSync(command, args, {
  cwd, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000,
});
// No production credentials or GitHub write token are needed by build scripts.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_ALL|TMPDIR|CI|COREPACK_HOME|PNPM_HOME|CARGO_HOME|RUSTUP_HOME|npm_config_workspace_concurrency|CARGO_BUILD_JOBS|GOMAXPROCS)$/.test(key)));
env.PAPERCLIP_BUILD_COMMIT = sha;
env.PAPERCLIP_RELEASE_REUSE_UI_DIST = '1';
env.PAPERCLIP_TELEMETRY_DISABLED = '1';
env.UPDATE_CHECK = '0';
env.npm_config_registry = 'https://registry.npmjs.org';
env.npm_config_userconfig = '/dev/null';
const actual = run('git', ['rev-parse', 'HEAD'], source, true).toString().trim();
if (actual !== sha) throw new Error('Source SHA differs from requested SHA');
if (run('git', ['status', '--porcelain', '--untracked-files=all'], source, true).toString().trim()) {
  throw new Error('Source checkout has tracked changes or untracked files; use a clean build checkout');
}
const stamp = json(path.join(source, 'server/dist/build-info.json'));
if (stamp.commit !== sha) throw new Error('Prebuilt server commit stamp mismatch');

// Match the official installGitPayload workspace closure, failing on unknown
// package dependencies rather than silently pulling an upstream replacement.
const manifest = json(path.join(source, 'scripts/release-package-manifest.json'));
const byName = new Map(manifest.map((entry) => [entry.name, entry]));
const ordered = [], visiting = new Set(), visited = new Set();
function visit(name) {
  if (visited.has(name)) return;
  if (visiting.has(name)) throw new Error(`Workspace dependency cycle: ${name}`);
  const entry = byName.get(name);
  if (!entry) throw new Error(`Unmapped workspace package: ${name}`);
  const dir = path.resolve(source, entry.dir);
  if (!dir.startsWith(source + path.sep)) throw new Error('Package path escapes checkout');
  visiting.add(name);
  const pkg = json(path.join(dir, 'package.json'));
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(pkg[section] ?? {})) {
      if (dependency.startsWith('@paperclipai/')) visit(dependency);
    }
  }
  visiting.delete(name); visited.add(name); ordered.push(entry);
}
visit('@paperclipai/server');
const workspaceVersions = new Map(ordered.map((entry) => [entry.name,
  json(path.join(source, entry.dir, 'package.json')).version]));
const sourcePnpm = json(path.join(source, 'package.json')).pnpm ?? {};
const patchDefinitions = new Map();
for (const [key, patchRelativePath] of Object.entries(sourcePnpm.patchedDependencies ?? {})) {
  const separator = key.lastIndexOf('@');
  const name = key.slice(0, separator), version = key.slice(separator + 1);
  const patchFile = path.resolve(source, patchRelativePath);
  if (!patchFile.startsWith(source + path.sep)) throw new Error('Patch escapes checkout');
  if (!patchDefinitions.has(name)) patchDefinitions.set(name, new Map());
  patchDefinitions.get(name).set(version, patchFile);
}
// Translate the source's ordinary pnpm selectors to npm's nested form. Reject
// unfamiliar selector grammar rather than silently ignoring a source constraint.
const npmOverrides = {};
for (const [selector, version] of Object.entries(sourcePnpm.overrides ?? {})) {
  if (selector.includes('||') || typeof version !== 'string' || version.startsWith('$')) {
    throw new Error(`Unsupported source override: ${selector}`);
  }
  const selectors = selector.split('>');
  let container = npmOverrides;
  for (const part of selectors.slice(0, -1)) {
    if (typeof container[part] === 'string') container[part] = { '.': container[part] };
    container = container[part] ??= {};
  }
  const last = selectors.at(-1);
  if (typeof container[last] === 'object') container[last]['.'] = version;
  else container[last] = version;
}
for (const [name, versions] of patchDefinitions) {
  if (versions.size !== 1) continue;
  const version = versions.keys().next().value;
  if (typeof npmOverrides[name] === 'object') npmOverrides[name]['.'] = version;
  else npmOverrides[name] = version;
}
// Multiple source-patched versions (acpx 0.12 and 0.13) deliberately retain
// their existing per-parent requirements. The postinstall gate rejects any
// unqualified third version; never flatten these distinct provider bridges.

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-fork-package-'));
// Separate ordinary user configuration from the packaging subprocesses.
// This is hygiene, not an OS sandbox: run only reviewed sources/dependencies.
env.HOME = path.join(staging, 'home');
fs.mkdirSync(env.HOME);
env.npm_config_cache = path.join(staging, 'npm-cache');
const packs = path.join(staging, 'packages');
const payload = path.join(staging, 'payload');
fs.mkdirSync(packs);
const cliManifest = path.join(source, 'cli/package.json');
const originalCliManifest = fs.readFileSync(cliManifest);
const cliReadme = path.join(source, 'cli/README.md');
const originalCliReadme = fs.existsSync(cliReadme) ? fs.readFileSync(cliReadme) : null;
const skillDestinations = ['server', 'packages/adapters/claude-local', 'packages/adapters/codex-local']
  .map((dir) => ({ dir: path.join(source, dir, 'skills'), existed: fs.existsSync(path.join(source, dir, 'skills')) }));
if (fs.existsSync(path.join(source, 'cli/package.dev.json'))) throw new Error('Existing CLI backup must be resolved before packaging');
let version, succeeded = false;
try {
  // Typecheck has its own CI gate. The upstream token checker has no private
  // forbidden-token list in this public fork, hence the explicit skip-checks.
  run('bash', ['scripts/build-npm.sh', '--skip-checks', '--skip-typecheck']);
  run('bash', ['scripts/prepare-server-ui-dist.sh']);
  // release.sh stages runtime skills separately from the workspace build.
  // installGitPayload omits this preparation and cannot pack a fresh checkout.
  for (const destination of skillDestinations) {
    if (!destination.existed) fs.cpSync(path.join(source, 'skills'), destination.dir, { recursive: true });
  }
  version = json(cliManifest).version;
  for (const [index, entry] of ordered.entries()) {
    const dir = path.join(source, entry.dir);
    const pkg = json(path.join(dir, 'package.json'));
    if ((pkg.bundleDependencies ?? pkg.bundledDependencies ?? []).length) {
      const staged = path.join(staging, `workspace-package-${index}`);
      run(process.execPath, [path.join(source, 'scripts/prepare-bundled-package.mjs'), dir, staged]);
      // The upstream staging helper substitutes the parent version for every
      // workspace dependency. That is incorrect when plugin-sdk is versioned
      // independently. Resolve from the actual source workspace, as pnpm does.
      const stagedManifestPath = path.join(staged, 'package.json');
      const stagedManifest = json(stagedManifestPath);
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, specifier] of Object.entries(pkg[section] ?? {})) {
          if (typeof specifier !== 'string' || !specifier.startsWith('workspace:')) continue;
          const dependencyVersion = workspaceVersions.get(name);
          if (!dependencyVersion) throw new Error(`Unmapped staged workspace dependency: ${name}`);
          const range = specifier.slice('workspace:'.length);
          const prefix = range === '^' || range === '~' ? range : '';
          stagedManifest[section][name] = prefix + dependencyVersion;
        }
      }
      fs.writeFileSync(stagedManifestPath, JSON.stringify(stagedManifest, null, 2) + '\n');
      // Staging copied already-built outputs and materialized publishConfig.
      // Its source-only prepack scripts must not be re-executed there.
      run('npm', ['pack', staged, '--ignore-scripts', '--pack-destination', packs]);
    } else {
      run('corepack', ['pnpm', '--dir', entry.dir, 'pack', '--pack-destination', packs]);
    }
  }
  run('npm', ['pack', '--pack-destination', packs], path.join(source, 'cli'));
  const tarballs = fs.readdirSync(packs).filter((file) => file.endsWith('.tgz')).sort();
  if (tarballs.length !== ordered.length + 1 || !tarballs.includes(`paperclipai-${version}.tgz`)) {
    throw new Error('Unexpected package closure');
  }
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({
    name: 'paperclip-fork-payload-producer', private: true, overrides: npmOverrides,
  }, null, 2) + '\n');
  run('npm', ['install', '--prefix', payload, ...tarballs.map((file) => path.join(packs, file)), '--no-audit', '--no-fund'], staging);
  const packedPackages = new Map(tarballs.map((file) => {
    const pkg = JSON.parse(run('tar', ['-xOf', path.join(packs, file), 'package/package.json'], staging, true).toString());
    return [pkg.name, { version: pkg.version,
      integrity: 'sha512-' + createHash('sha512').update(fs.readFileSync(path.join(packs, file))).digest('base64') }];
  }));
  const installedLock = json(path.join(payload, 'package-lock.json'));
  const observedWorkspacePackages = new Set();
  for (const [location, pkg] of Object.entries(installedLock.packages ?? {})) {
    const name = location.match(/(?:^|\/)node_modules\/(\@paperclipai\/[^/]+|paperclipai)$/)?.[1];
    if (!name) continue;
    const expected = packedPackages.get(name);
    if (!expected || pkg.version !== expected.version || pkg.integrity !== expected.integrity) {
      throw new Error(`Unexpected or registry-shadowed workspace package: ${location}`);
    }
    observedWorkspacePackages.add(name);
  }
  for (const name of packedPackages.keys()) {
    if (!observedWorkspacePackages.has(name)) throw new Error(`Missing local package in installed lock: ${name}`);
  }
  // pnpm patchedDependencies do not automatically survive npm installation.
  // Preserve each source patch on every installed copy of the relevant package.
  // A changed version or unrecognizable file state blocks the artifact instead
  // of silently substituting registry behavior (notably postgres transactions).
  const patches = [], visitedPackages = new Set();
  function inspectInstalledPackage(packageDir) {
    const realDir = fs.realpathSync(packageDir);
    if (visitedPackages.has(realDir)) return;
    visitedPackages.add(realDir);
    if (!realDir.startsWith(payload + path.sep)) throw new Error('Installed package escapes payload');
    const manifestPath = path.join(realDir, 'package.json');
    if (!fs.existsSync(manifestPath)) return;
    const pkg = json(manifestPath), versions = patchDefinitions.get(pkg.name);
    if (versions) {
      const patchFile = versions.get(pkg.version);
      if (!patchFile) throw new Error(`Patched dependency version drift: ${pkg.name}@${pkg.version}`);
      // --force disables patch's interactive/automatic reverse guessing.
      // Otherwise a reverse dry-run could succeed by silently applying forward.
      const patchArgs = ['--force', '--fuzz=0', '--strip=1', '--input', patchFile];
      function patchCheck(reverse) {
        try { run('patch', [...patchArgs, '--dry-run', ...(reverse ? ['--reverse'] : [])], realDir, true); return true; }
        catch { return false; }
      }
      const alreadyApplied = patchCheck(true);
      if (!alreadyApplied) {
        if (!patchCheck(false)) throw new Error(`Cannot preserve exact source patch: ${pkg.name}@${pkg.version}`);
        run('patch', patchArgs, realDir);
      }
      if (!patchCheck(true)) throw new Error(`Patch verification failed: ${pkg.name}@${pkg.version}`);
      const fileHashes = {};
      for (const match of fs.readFileSync(patchFile, 'utf8').matchAll(/^\+\+\+ b\/(.+?)(?:\t.*)?$/gm)) {
        const relativeFile = match[1].trim(), file = path.resolve(realDir, relativeFile);
        if (!file.startsWith(realDir + path.sep)) throw new Error('Patch file escapes package');
        fileHashes[relativeFile] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      }
      patches.push({ name: pkg.name, version: pkg.version, location: path.relative(payload, realDir),
        alreadyApplied, sourcePatchSha256: createHash('sha256').update(fs.readFileSync(patchFile)).digest('hex'), fileHashes });
    }
    inspectNodeModules(path.join(realDir, 'node_modules'));
  }
  function inspectNodeModules(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      const location = path.join(dir, entry);
      if (!fs.statSync(location).isDirectory()) continue;
      if (entry.startsWith('@')) {
        for (const name of fs.readdirSync(location)) inspectInstalledPackage(path.join(location, name));
      } else inspectInstalledPackage(location);
    }
  }
  inspectNodeModules(path.join(payload, 'node_modules'));
  // npm external ranges are resolved at packaging time, not locked by pnpm's
  // workspace lock. Retain the actual install lock for audit, with temporary
  // producer path replaced by a stable marker. Not an npm reinstall recipe.
  const resolvedLock = JSON.stringify(installedLock, null, 2).replaceAll(staging, '<packaging-staging>') + '\n';
  // Remove producer-local tarball references from the transport root. Installed
  // packages and their lock are not a registry republish or npm-install recipe.
  fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({
    name: 'paperclip-fork-native-payload', private: true, version,
    description: 'Preinstalled Linux x64 payload; do not run npm install in this directory',
  }, null, 2) + '\n');
  for (const file of ['package-lock.json', 'node_modules/.package-lock.json']) {
    fs.rmSync(path.join(payload, file), { force: true });
  }
  // Move, rather than copy, to expose accidental dependencies on staging paths.
  const relocated = path.join(staging, 'relocated', 'payload');
  fs.mkdirSync(path.dirname(relocated));
  fs.renameSync(payload, relocated);
  function verifyTree(dir, root = dir) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        if (path.isAbsolute(fs.readlinkSync(file))) throw new Error(`Absolute symlink: ${file}`);
        const target = fs.realpathSync(file);
        if (!target.startsWith(root + path.sep)) throw new Error(`Escaping symlink: ${file}`);
      } else if (stat.isDirectory()) verifyTree(file, root);
      else if (!stat.isFile()) throw new Error(`Special file in payload: ${file}`);
    }
  }
  verifyTree(relocated);
  const cli = path.join(relocated, 'node_modules/paperclipai/dist/index.js');
  const reported = run(process.execPath, [cli, '--version'], relocated, true).toString().trim().split(/\s+/)[0];
  if (reported !== version) throw new Error('Relocated CLI version mismatch');
  const server = path.join(relocated, 'node_modules/@paperclipai/server');
  if (json(path.join(server, 'dist/build-info.json')).commit !== sha) throw new Error('Packaged stamp mismatch');
  for (const required of ['ui-dist/index.html', 'dist/vendor/paperclip-runner/index.js', 'dist/app.js']) {
    if (!fs.existsSync(path.join(server, required))) throw new Error(`Missing server asset: ${required}`);
  }
  const db = path.join(relocated, 'node_modules/@paperclipai/db');
  if (!fs.existsSync(path.join(db, 'dist/migrations'))) throw new Error('Missing database migrations');
  for (const pkg of ['server', 'adapter-claude-local', 'adapter-codex-local']) {
    if (!fs.existsSync(path.join(relocated, 'node_modules/@paperclipai', pkg, 'skills/paperclip/SKILL.md'))) {
      throw new Error(`Missing bundled runtime skills: ${pkg}`);
    }
  }
  const nativeRunner = path.join(server, 'dist/vendor/paperclip-runner/bin/paperclip-runnerd');
  fs.accessSync(nativeRunner, fs.constants.X_OK);
  const header = Buffer.alloc(20), fd = fs.openSync(nativeRunner, 'r');
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) {
    throw new Error('Runner must be a native ELF64 little-endian x86-64 executable');
  }
  const dynamicLibraries = run('ldd', [nativeRunner], relocated, true).toString();
  if (dynamicLibraries.includes('not found')) throw new Error('Runner has missing native library dependencies');
  // app.js exports the server factory without starting the production listener.
  // Explicit exit bounds background import handles. This is NOT a live DB/E2E test.
  run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(server, 'dist/app.js')).href)}); process.exit(0)`], relocated);
  const packageChecksums = Object.fromEntries(tarballs.map((file) => [file,
    createHash('sha256').update(fs.readFileSync(path.join(packs, file))).digest('hex')]));
  fs.mkdirSync(output, { recursive: true });
  const archive = `paperclip-${sha.slice(0, 12)}-linux-x64.tar.gz`;
  run('tar', ['-czf', path.join(output, archive), '-C', path.dirname(relocated), 'payload'], staging);
  if (fs.statSync(path.join(output, archive)).size >= 2 * 1024 ** 3) throw new Error('Archive exceeds GitHub release asset limit');
  const extraction = path.join(staging, 'archive-smoke');
  fs.mkdirSync(extraction);
  run('tar', ['-xzf', path.join(output, archive), '-C', extraction], staging);
  const extractedPayload = path.join(extraction, 'payload');
  verifyTree(extractedPayload);
  const extractedCli = path.join(extractedPayload, 'node_modules/paperclipai/dist/index.js');
  if (run(process.execPath, [extractedCli, '--version'], extractedPayload, true).toString().trim().split(/\s+/)[0] !== version) {
    throw new Error('Archive CLI smoke failed');
  }
  const extractedServer = path.join(extractedPayload, 'node_modules/@paperclipai/server');
  run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(extractedServer, 'dist/app.js')).href)}); process.exit(0)`], extractedPayload);
  fs.accessSync(path.join(extractedServer, 'dist/vendor/paperclip-runner/bin/paperclip-runnerd'), fs.constants.X_OK);
  const provenance = {
    repository: 'Hdom/paperclip', sourceCommit: sha, packageVersion: version,
    packagingScriptSha256: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    workflowCommit: process.env.GITHUB_SHA ?? null,
    workflowRun: process.env.GITHUB_RUN_ID ?? null,
    platform: process.platform, architecture: process.arch, node: process.version,
    glibc: process.report.getReport().header.glibcVersionRuntime,
    packages: ordered.map((entry) => entry.name), packageTarballSha256: packageChecksums,
    sourceDependencyPatches: patches,
    producerNpmOverrides: npmOverrides,
    resolvedPackageLockSha256: createHash('sha256').update(resolvedLock).digest('hex'),
    verified: ['workspace package closure', 'server commit stamp', 'contained relative symlinks',
      'relocated CLI version', 'relocated server module import', 'UI and migration assets',
      'native executable ELF64 x86-64 and library resolution', 'archive re-extraction CLI and server import'],
    limitations: ['Not a live database or model-provider test', 'Not a production deployment',
      'Requires compatible Linux x64 glibc and Node runtime', 'Does not activate the managed install'],
  };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(provenance, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'resolved-package-lock.json'), resolvedLock);
  const hashes = [];
  for (const file of [archive, 'manifest.json', 'resolved-package-lock.json']) {
    // Stream through sha256sum instead of buffering the large runtime archive.
    hashes.push(run('sha256sum', [file], output, true).toString().trim());
  }
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), hashes.join('\n') + '\n');
  succeeded = true;
  console.log(`Native payload packaged: ${archive}`);
} finally {
  fs.writeFileSync(cliManifest, originalCliManifest);
  if (originalCliReadme !== null) fs.writeFileSync(cliReadme, originalCliReadme);
  else fs.rmSync(cliReadme, { force: true });
  for (const destination of skillDestinations) {
    if (!destination.existed) fs.rmSync(destination.dir, { recursive: true, force: true });
  }
  fs.rmSync(path.join(source, 'cli/package.dev.json'), { force: true });
  // Only this script-created temporary directory is removed.
  if (succeeded) fs.rmSync(staging, { recursive: true, force: true });
  else console.error(`Packaging failed; retained diagnostic staging: ${staging}`);
}


