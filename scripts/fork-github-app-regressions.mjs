import { runQualificationTasks } from "./fork-qualification-pool.mjs";
// Exact-source qualification. Each server suite has a fresh process so large
// native module graphs do not accumulate across unrelated test files.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
delete env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const tasks = [];
function test(cwd, files, extra = []) { tasks.push({ cwd, files, extra }); }
function execute({ cwd, files, extra }) {
  console.log(`Qualifying ${files.join(", ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitest, "run", "--silent", "--maxWorkers=1", "--testTimeout=60000", ...extra, ...files],
      { cwd, env, stdio: "inherit", timeout: 10 * 60 * 1000 });
    child.once("error", reject);
    child.once("close", (status, signal) => status === 0 ? resolve() : reject(new Error(`Qualification failed: ${files.join(", ")} (${status ?? signal ?? "process error"})`)));
  });
}

for (const file of [
  "src/__tests__/issue-execution-policy.test.ts",
  "src/services/isolated-task-directory.test.ts",
  "src/services/heartbeat/environment-selection.test.ts",
  "src/services/heartbeat/workspace-preparation.test.ts",
  "src/__tests__/retained-ssh-workspace-source.test.ts",
  "src/__tests__/issue-blocker-stall-wakeups.test.ts",
  "src/__tests__/heartbeat-runtime-skills.test.ts",
  "src/services/workspace-recovery-fallback.test.ts",
  "src/services/workspace-recovery-admission.test.ts",
  "src/services/workspace-recovery-preparation-proof.test.ts",
  "src/services/workspace-recovery-source.test.ts",
  "src/services/workspace-recovery-stop-proof.test.ts",
  "src/services/heartbeat/retries.test.ts", "src/services/heartbeat/run-completion.test.ts",
  "src/__tests__/heartbeat-task-context.test.ts", "src/__tests__/issue-scheduled-retry-routes.test.ts",
  "src/services/explicit-native-continuation.test.ts", "src/services/ssh-host-stop-receipt.test.ts",
  "src/services/worker-supervision.test.ts",
  "src/__tests__/closed-native-receipt-accounting.test.ts",
  "src/services/native-runtime/native-workspace-owner-restart-recovery.test.ts", "src/services/native-runtime/native-workspace-finalization-supersession.test.ts", "src/__tests__/scoped-task-workspace-authority.test.ts", "src/__tests__/controller-skill-export.test.ts", "src/__tests__/skill-package-store.test.ts", "src/__tests__/ssh-automatic-stop.test.ts", "src/__tests__/heartbeat-ssh-stop.test.ts", "src/services/remote-execution-scope.test.ts", "src/__tests__/environment-probe.test.ts", "src/__tests__/environment-runtime-driver-contract.test.ts", "src/services/native-runtime/native-ssh-command-runner.test.ts", "src/services/execution-blocker-read.test.ts", "src/__tests__/environment-retained-orphan-sandbox.test.ts", "src/services/idle-deadline-proof.test.ts",
  "src/__tests__/github-project-apps.test.ts", "src/__tests__/github-project-app-runtime.test.ts",
  "src/__tests__/github-app-connection-import.test.ts", "src/services/github-app-connections.test.ts",
  "src/__tests__/github-app-tools.test.ts", "src/services/github-app-tool-catalog.test.ts",
  "src/__tests__/git-credentials.test.ts", "src/__tests__/github-operation-credentials.test.ts",
  "src/__tests__/controller-signing-secrets.test.ts", "src/__tests__/signing-keys-routes.test.ts", "src/secrets/signing-key-material.test.ts", "src/__tests__/github-project-app-admin.test.ts",
  "src/__tests__/github-project-app-api-contract.test.ts", "src/__tests__/http-log-redaction.test.ts",
  "src/__tests__/controller-execution-protection.test.ts", "src/__tests__/controller-native-staging-protection.test.ts",
  "src/__tests__/secrets-service.test.ts", "src/__tests__/secrets-routes.test.ts",
  "src/__tests__/agent-secrets-routes.test.ts", "src/__tests__/agent-instance-secrets.test.ts",
  "src/__tests__/project-instance-secrets.test.ts", "src/__tests__/secrets-service-user-secret-owner-scoped.test.ts",
]) test(resolve(root, "server"), [file], ["--config", "vitest.config.ts"]);
// Two original Local completion-wait cases fail identically on qualified master.
// Qualify the three changed Local placement cases and preserve the baseline gap.
test(resolve(root, "server"), ["src/__tests__/heartbeat-local-environment.test.ts"], ["--config", "vitest.config.ts", "-t", "Local placement"]);
// Three unrelated completion-wait cases in this file fail on qualified master
// too. Keep that known gap explicit; this gate proves the changed protected lane.
test(resolve(root, "server"), ["src/__tests__/heartbeat-plugin-environment.test.ts"], ["--config", "vitest.config.ts", "-t", "protected"]);
test(root, ["packages/db/src/worker-supervision-upgrade.test.ts", "packages/db/src/task-workflow-handoff-migration.test.ts"]);
test(root, ["packages/adapter-utils/src/controller-workspace-archive.test.ts", "packages/adapter-utils/src/workspace-restore-merge.test.ts", "packages/adapter-utils/src/workspace-restore-unchanged.test.ts", "packages/adapter-utils/src/workspace-restore-teardown.test.ts", "packages/adapter-utils/src/controller-workspace-authority.test.ts", "packages/adapter-utils/src/controller-source-protection.test.ts", "packages/adapter-utils/src/controller-source-materialization.test.ts",
  "packages/adapters/claude-local/src/server/controller-key-materialization.test.ts", "packages/adapters/codex-local/src/server/controller-key-materialization.test.ts", "packages/adapters/codex-local/src/server/codex-home.test.ts"]);
test(root, ["ui/src/pages/apps/AppDetail.test.tsx", "ui/src/pages/apps/AppsConnect.test.tsx", "ui/src/pages/apps/app-detail/GitHubAppConnectionPermissions.test.tsx", "ui/src/pages/secrets/GitHubAppKeyLifecycle.test.tsx"]);
test(root, ["packages/shared/src/app-definitions.test.ts"]);
test(root, ["ui/src/pages/Secrets.render.test.tsx", "ui/src/pages/secrets/secret-path.test.ts", "ui/src/pages/AgentToolsTab.test.tsx", "ui/src/pages/secrets/SigningKeysTab.test.tsx", "ui/src/components/GitHubProjectAppControls.test.tsx", "ui/src/pages/agent-detail/AgentAllowedConnectors.test.tsx", "ui/src/components/AgentContextualSidebar.test.tsx", "ui/src/pages/agent-detail-navigation.test.ts"]);


test(root, ["packages/adapter-utils/src/ssh-stopped-workspace-snapshot.test.ts", "packages/adapter-utils/src/ssh-run-scope.test.ts", "packages/adapter-utils/src/ssh-run-scope-kernel.test.ts",
  "packages/adapter-utils/src/ssh-run-scope-transport.test.ts", "packages/adapter-utils/src/ssh-command-managed.test.ts",
  "packages/adapter-utils/src/ssh-fixture.test.ts"]);

// Preserve every baseline and signing-key suite plus reviewed SSH lifecycle coverage.
// Only scheduling changes; every suite retains a fresh process and serial cases.
if (process.argv.includes("--list")) {
  console.log(JSON.stringify(tasks.map(task => ({ ...task, cwd: task.cwd === root ? "." : task.cwd.slice(root.length + 1) }))));
  process.exit(0);
}
const results = await runQualificationTasks(tasks, execute, 2);
for (const result of results) console.log(JSON.stringify({ files: tasks[result.index].files, ok: result.ok, durationMs: result.durationMs }));
const failures = results.filter(result => !result.ok);
if (failures.length) throw new AggregateError(failures.map(result => result.error), `${failures.length} qualification tasks failed; every task was attempted`);
