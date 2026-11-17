/** Provider delivery refuses an existing policy; retries cannot grant authority. */
export const MCP_POLICY_CONFLICT_CODE = "mcp_policy_conflict";
export class McpPolicyConflictError extends Error {
  readonly code = MCP_POLICY_CONFLICT_CODE;
  constructor() {
    super("MCP delivery policy requires review in the selected agent configuration; no policy was rewritten");
    this.name = "McpPolicyConflictError";
  }
}
