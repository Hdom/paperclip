import { updateIssueSchema } from "@paperclipai/shared";
import { parseIssueAssigneeAdapterOverrides } from "../services/execution-workspace-policy.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertControllerHostProcessAllowed, assertControllerHostWorkspaceAccessAllowed, assertControllerSafeEnvironment, assertControllerSafeExecutionTarget } from "../services/controller-execution-protection.js";
const worker = { host: "10.235.1.195", port: 22, username: "worker", knownHosts: "10.235.1.195 ssh-ed25519 TEST", strictHostKeyChecking: true };
afterEach(() => vi.unstubAllEnvs());
function protect() { vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", "1"); vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS", JSON.stringify([worker])); }
describe("controller signing-key execution protection", () => {
 it("preserves Local behavior when disabled", () => { vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", ""); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", ""); expect(() => assertControllerSafeEnvironment(null)).not.toThrow(); expect(() => assertControllerHostProcessAllowed()).not.toThrow(); });
 it("stays protected when broker configuration is removed", () => { protect(); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", ""); expect(() => assertControllerSafeEnvironment({ driver: "local" })).toThrow(/signing-key protection/); });
 it("protects automatically whenever broker configuration is present", () => { vi.stubEnv("PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS", ""); vi.stubEnv("PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG", "/controller/config"); expect(() => assertControllerSafeEnvironment(null)).toThrow(); });
 it("blocks Local tools and workspace file access", () => { protect(); expect(() => assertControllerHostProcessAllowed()).toThrow(); expect(() => assertControllerHostWorkspaceAccessAllowed()).toThrow(); expect(() => assertControllerSafeExecutionTarget({ kind: "local" })).toThrow(); });
 it("permits only the pinned remote SSH worker", () => { protect(); expect(() => assertControllerSafeEnvironment({ driver: "ssh", config: worker })).not.toThrow(); expect(() => assertControllerSafeExecutionTarget({ kind: "remote", transport: "ssh", spec: worker })).not.toThrow(); });
 it.each([{ username: "root" }, { host: "127.0.0.1" }, { host: "localhost" }, { knownHosts: "" }, { knownHosts: "substituted" }, { strictHostKeyChecking: false }, { port: 2222 }])("refuses changed SSH identity %j", change => { protect(); expect(() => assertControllerSafeEnvironment({ driver: "ssh", config: { ...worker, ...change } })).toThrow(); });
 it("rejects DNS targets even if operator-listed", () => { protect(); const config = { ...worker, host: "worker.internal" }; vi.stubEnv("PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS", JSON.stringify([config])); expect(() => assertControllerSafeEnvironment({ driver: "ssh", config })).toThrow(); });
 it("retains remote plugin execution", () => { protect(); expect(() => assertControllerSafeEnvironment({ driver: "plugin" })).not.toThrow(); expect(() => assertControllerSafeExecutionTarget({ kind: "remote", transport: "sandbox" })).not.toThrow(); });
});

describe("task instruction paths", () => {
 it.each(["homeMode", "instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile", "instructionsFilePath", "agentsMdPath"])("refuses %s at admission and strips persisted overrides", key => {
   expect(updateIssueSchema.safeParse({ assigneeAdapterOverrides: { adapterConfig: { [key]: "/protected/key", model: "existing-model" } } }).success).toBe(false);
   expect(parseIssueAssigneeAdapterOverrides({ adapterConfig: { [key]: "/protected/key", model: "existing-model" } })?.adapterConfig).toEqual({ model: "existing-model" });
 });
});
