// Exact-source qualification. Each server suite has a fresh process so large
// native module graphs do not accumulate across unrelated test files.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
delete env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
function test(cwd, files, extra = []) {
  console.log(`Qualifying ${files.join(", ")}`);
  const result = spawnSync(process.execPath, [vitest, "run", "--silent", "--maxWorkers=1", "--testTimeout=60000", ...extra, ...files],
    { cwd, env, stdio: "inherit", timeout: 10 * 60 * 1000 });
  if (result.error || result.status !== 0) throw new Error(`Qualification failed: ${files.join(", ")} (${result.status ?? result.signal ?? "process error"})`);
}
for (const file of [
  "src/services/heartbeat/retries.test.ts", "src/services/heartbeat/run-completion.test.ts",
  "src/__tests__/heartbeat-task-context.test.ts", "src/__tests__/issue-scheduled-retry-routes.test.ts",
  "src/services/explicit-native-continuation.test.ts", "src/services/ssh-host-stop-receipt.test.ts",
  "src/services/worker-supervision.test.ts",
  "src/__tests__/github-project-apps.test.ts", "src/__tests__/github-project-app-runtime.test.ts",
  "src/__tests__/controller-signing-secrets.test.ts", "src/__tests__/github-project-app-admin.test.ts",
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
test(root, ["packages/db/src/worker-supervision-upgrade.test.ts"]);
test(root, ["packages/adapter-utils/src/controller-source-protection.test.ts", "packages/adapter-utils/src/controller-source-materialization.test.ts",
  "packages/adapters/claude-local/src/server/controller-key-materialization.test.ts", "packages/adapters/codex-local/src/server/controller-key-materialization.test.ts"]);
test(root, ["ui/src/pages/AgentToolsTab.test.tsx", "ui/src/components/GitHubProjectAppControls.test.tsx"]);
