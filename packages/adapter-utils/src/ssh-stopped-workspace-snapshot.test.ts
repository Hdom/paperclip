import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { extractControllerWorkspaceArchive } from "./controller-workspace-archive.js";
import { buildSshEnvLabFixtureConfig, startSshEnvLabFixture, stopSshEnvLabFixture, probeSshRunScope,
  prepareSshRunScope, stopSshRunScope, runSshCommand, shellQuote, downloadStoppedSshWorkspaceArchive } from "./ssh.js";

it.each(["saved", "generation", "symlink", "hardlink", "root_alias", "oversized"])("preserves only the exact stopped SSH run without reopening exec: %s", async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stopped-ssh-preservation-"));
  let fixture: Awaited<ReturnType<typeof startSshEnvLabFixture>> | undefined;
  let spec: Awaited<ReturnType<typeof buildSshEnvLabFixtureConfig>> & { remoteCwd?: string } | undefined;
  let scope: { schema: "paperclip.ssh-run-scope.v1"; companyId: string; runId: string; leaseId: string; generation: string; bootId: string } | undefined;
  try {
    fixture = await startSshEnvLabFixture({ statePath: path.join(root, "lab.json") });
    const connection = await buildSshEnvLabFixtureConfig(fixture), probe = await probeSshRunScope(connection);
    scope = { schema: "paperclip.ssh-run-scope.v1", companyId: randomUUID(), runId: randomUUID(), leaseId: randomUUID(), generation: randomUUID(), bootId: probe.bootId };
    spec = { ...connection, knownHosts: connection.knownHosts?.trim() || null, remoteCwd: probe.remoteCwd, runScope: scope };
    await prepareSshRunScope(spec, scope);
    const source = path.posix.join(probe.remoteCwd, ".paperclip-runtime", "runs", scope.runId, "workspace");
    const outside = path.posix.join(probe.remoteCwd, "outside-" + scope.runId);
    let command = `mkdir -p ${shellQuote(source)} ${shellQuote(outside)} && chmod 700 ${shellQuote(source)} && printf 'retained output' > ${shellQuote(source + "/result.txt")} && printf 'synthetic private sentinel' > ${shellQuote(outside + "/secret")}`;
    if (mode === "symlink") command += ` && ln -s ${shellQuote(outside + "/secret")} ${shellQuote(source + "/escape")}`;
    if (mode === "hardlink") command += ` && ln ${shellQuote(outside + "/secret")} ${shellQuote(source + "/escape")}`;
    if (mode === "oversized") command += ` && truncate -s 67108865 ${shellQuote(source + "/too-large")}`;
    if (mode === "root_alias") command += ` && mv ${shellQuote(source)} ${shellQuote(source + "-original")} && ln -s ${shellQuote(outside)} ${shellQuote(source)}`;
    await runSshCommand(spec, command);
    const stop = await stopSshRunScope(spec, scope);
    await expect(runSshCommand(spec, "true")).rejects.toMatchObject({ code: 125 });
    const archive = path.join(root, "download.tar");
    const snapshot = downloadStoppedSshWorkspaceArchive({ spec: { ...spec, remoteCwd: probe.remoteCwd,
      ...(mode === "generation" ? { runScope: { ...scope, generation: randomUUID() } } : {}) }, archivePath: archive, stop });
    if (mode === "saved") {
      await snapshot;
      const directory = path.join(root, "checked"); await mkdir(directory, { mode: 0o700 });
      await extractControllerWorkspaceArchive(archive, directory);
      expect(await readFile(path.join(directory, "result.txt"), "utf8")).toBe("retained output");
    } else await expect(snapshot).rejects.toThrow();
    await expect(runSshCommand(spec, "true")).rejects.toMatchObject({ code: 125 });
    expect(await stopSshRunScope(spec, scope)).toEqual(stop);
  } finally {
    if (spec && scope) await stopSshRunScope(spec, scope);
    if (fixture) await stopSshEnvLabFixture(fixture);
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
