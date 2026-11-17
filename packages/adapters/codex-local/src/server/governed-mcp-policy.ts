import { McpPolicyConflictError } from "@paperclipai/adapter-utils/mcp-policy-error";
import { parse, stringify } from "smol-toml";

type Table = Record<string, unknown>;
const table = (value: unknown): Table => value && typeof value === "object" && !Array.isArray(value) ? value as Table : {};
const policyError = () => new McpPolicyConflictError();
const policyTable = (value: unknown): Table => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw policyError();
  return value as Table;
};
const toolsByPath: Record<string, readonly string[]> = {
  "/mcp/runtime-tools": ["connections_search"],
  "/api/mcp/project-tools": ["create_project", "list_projects", "list_project_repositories"],
};
const serverPolicyKeys = ["enabled", "enabled_tools", "disabled_tools", "default_tools_approval_mode", "approvals_reviewer", "startup_timeout_sec", "tool_timeout_sec"];

/** Parse once with a bounded real TOML parser. Never report config/credential bytes on failure. */
export function governedCodexMcpPolicy(existing: string, unmanaged: string) {
  let parsed: Table, custom: Table;
  try {
    if (Buffer.byteLength(existing) > 1024 * 1024) throw policyError();
    parsed = parse(existing); custom = parse(unmanaged);
  } catch { throw policyError(); }
  const existingServers = policyTable(parsed.mcp_servers), customServers = policyTable(custom.mcp_servers);
  return {
    existingNames: new Set(Object.keys(customServers)),
    render(input: { originalName: string; baseName: string; managedName: string; endpointPath: string; apiBaseUrl: string; unattendedTools?: readonly string[] }) {
      // Preserve the existing writer behavior for unrelated integrations. This
      // policy extension applies only to server-declared governed endpoints.
      let declared: readonly string[] = [];
      try {
        const url = new URL(input.endpointPath, input.apiBaseUrl), base = new URL(input.apiBaseUrl);
        if (url.origin === base.origin && !url.search && !url.hash) declared = toolsByPath[url.pathname] ?? [];
      } catch { throw policyError(); }
      if (!(input.unattendedTools ?? []).some(name => declared.includes(name))) return [];
      const names = new Set([input.originalName, input.baseName, input.managedName]);
      // A profile may replace several nested policy fields. Without its effective
      // merge contract, do not rename a gateway around the operator's restriction.
      if (Object.values(policyTable(parsed.profiles)).some(profile => Object.keys(policyTable(policyTable(profile).mcp_servers)).some(name => names.has(name)))) throw policyError();
      const policies = [...names].filter(name => Object.hasOwn(existingServers, name)).map(name => policyTable(existingServers[name]));
      if (policies.length > 1) throw policyError();
      const policy = policies[0] ?? {}, tools: Table = structuredClone(policyTable(policy.tools));
      const restricted = policy.enabled === false || Object.hasOwn(policy, "enabled_tools") || Object.hasOwn(policy, "disabled_tools") ||
        (policy.default_tools_approval_mode !== undefined && policy.default_tools_approval_mode !== "approve") ||
        Object.values(tools).some(value => policyTable(value).enabled === false || policyTable(value).approval_mode !== undefined && policyTable(value).approval_mode !== "approve");
      if (!restricted) for (const name of input.unattendedTools ?? []) {
        if (declared.includes(name)) tools[name] = { ...table(tools[name]), approval_mode: "approve" };
      }
      const lines: string[] = [];
      for (const key of serverPolicyKeys) if (Object.hasOwn(policy, key)) lines.push(stringify({ [key]: policy[key] }).trim());
      for (const [name, value] of Object.entries(tools)) {
        const fields = policyTable(value);
        if (Object.keys(fields).some(key => !["approval_mode", "enabled", "output_token_limit"].includes(key))) throw policyError();
        lines.push("", `[mcp_servers.${JSON.stringify(input.managedName)}.tools.${JSON.stringify(name)}]`, stringify(fields).trim());
      }
      return lines;
    },
  };
}
