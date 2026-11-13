import { isIP } from "node:net";
import { networkInterfaces, hostname } from "node:os";
import { forbidden } from "../errors.js";

/** Root-controlled protection remains set while signing keys or readable copies exist. */
export function controllerExecutionProtected(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS || env.PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG);
}

export function assertControllerHostProcessAllowed() {
  if (controllerExecutionProtected())
    throw forbidden("Controller signing-key protection forbids Local agent commands and local stdio tools; use the approved remote worker");
}

export function assertControllerHostWorkspaceAccessAllowed() {
  if (controllerExecutionProtected())
    throw forbidden("Controller signing-key protection forbids agent access to controller workspace files; use the approved remote worker");
}

function assertApprovedSshTarget(value: unknown) {
  const spec = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const host = typeof spec.host === "string" ? spec.host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "").replace(/^::ffff:/, "") : "";
  const localAddresses = Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? []);
  if (!isIP(host) || host === "localhost" || host === hostname().toLowerCase() || host === "::1" || host === "0.0.0.0" || /^127\./.test(host) || localAddresses.includes(host))
    throw forbidden("Controller signing-key protection forbids SSH execution on the controller or loopback");
  let approved: unknown;
  const raw = process.env.PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS ?? "";
  try { if (raw.length > 8192) throw new Error(); approved = JSON.parse(raw); }
  catch { throw forbidden("Controller signing-key protection requires operator-approved SSH worker targets"); }
  const port = spec.port ?? 22;
  if (!Array.isArray(approved) || approved.length > 32 || !approved.some(entry => entry && typeof entry === "object" &&
      entry.host === spec.host && (entry.port ?? 22) === port && entry.username === spec.username &&
      typeof entry.knownHosts === "string" && entry.knownHosts.length > 0 && entry.knownHosts === spec.knownHosts && spec.strictHostKeyChecking !== false))
    throw forbidden("This SSH target is not an operator-approved controller-key-safe worker");
}

export function assertControllerSafeEnvironment(environment: { driver: string; config?: unknown } | null | undefined) {
  if (!controllerExecutionProtected()) return;
  if (!environment || !["ssh", "sandbox", "plugin"].includes(environment.driver))
    assertControllerHostProcessAllowed();
  if (environment?.driver === "ssh") assertApprovedSshTarget(environment.config);
}

export function assertControllerSafeExecutionTarget(target: { kind: string; transport?: string; spec?: unknown } | null | undefined) {
  if (!controllerExecutionProtected()) return;
  if (!target || target.kind !== "remote" || !["ssh", "sandbox"].includes(target.transport ?? ""))
    assertControllerHostProcessAllowed();
  if (target?.transport === "ssh") assertApprovedSshTarget(target.spec);
}
