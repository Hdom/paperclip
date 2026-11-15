import { nativeCatalog, nativeRestFailure, type NativeCatalogEntry } from "./native-rest-client.js";

export const GITHUB_APP_API_URL = "https://api.github.com";
export const GITHUB_APP_METHOD = "app-installation";
export const GITHUB_APP_BINDING = "paperclipProjectBinding";
const text = (maxLength = 20000) => ({ type: "string", maxLength });
const branch = { type: "string", minLength: 1, maxLength: 255, pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]*$" };
const sha = { type: "string", pattern: "^[a-fA-F0-9]{40}$" };
const number = { type: "integer", minimum: 1, maximum: 2147483647 };
const pagination = { page: { type: "integer", minimum: 1, maximum: 1000 }, perPage: { type: "integer", minimum: 1, maximum: 30 } };
const binding = { type: "object", additionalProperties: false,
  description: "Paperclip supplies this reviewed project binding. It is not a repository selector.", readOnly: true,
  required: ["revision", "connectionId", "grantId", "role", "runId", "issueId", "projectId", "repositoryId"],
  properties: { revision: text(64), connectionId: text(36), grantId: text(36), role: { enum: ["implementer", "reviewer"] }, runId: text(36), issueId: text(36), projectId: text(36), repositoryId: { type: "integer", minimum: 1 } } };
function operation(name: string, title: string, description: string, properties: Record<string, unknown>, required: string[] = [], write = false) {
  return { name, title, description: `${description} Uses only the current project's enrolled repository.`,
    inputSchema: { type: "object", additionalProperties: false, required, properties: { ...properties, [GITHUB_APP_BINDING]: binding } },
    annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: !write, openWorldHint: true, requiresActiveProjectRun: true } };
}
const contract = nativeCatalog([
  operation("github_project_read_file", "Read project file", "Read a file or directory through GitHub's contents API.", { path: text(2048), ref: text(255) }),
  operation("github_project_list_commits", "List project commits", "List a bounded page of commits.", { ref: text(255), ...pagination }),
  operation("github_project_list_pull_requests", "List project pull requests", "List a bounded page of pull requests.", { state: { enum: ["open", "closed", "all"] }, ...pagination }),
  operation("github_project_read_pull_request", "Read project pull request", "Read a pull request, including its current head commit.", { number }, ["number"]),
  operation("github_project_pull_request_files", "Read pull request changes", "Read a bounded page of changed files and patches.", { number, ...pagination }, ["number"]),
  operation("github_project_create_branch", "Create project branch", "Create a branch at an existing commit in this repository.", { branch, commitSha: sha }, ["branch", "commitSha"], true),
  operation("github_project_write_file", "Write project file", "Create or update one file. Supply its current blob SHA when updating.", { path: { ...text(2048), minLength: 1 }, branch, message: { ...text(2000), minLength: 1 }, contentBase64: text(1400000), sha }, ["path", "branch", "message", "contentBase64"], true),
  operation("github_project_open_pull_request", "Open project pull request", "Open a pull request between two branches in this repository.", { title: { ...text(200), minLength: 1 }, body: text(), head: branch, base: branch, draft: { type: "boolean" } }, ["title", "head", "base"], true),
  operation("github_project_submit_review", "Submit project pull request review", "Submit a review against the specified head commit. Does not merge or edit the pull request.", { number, commitSha: sha, event: { enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"] }, body: text() }, ["number", "commitSha", "event"], true),
]);
export const GITHUB_APP_TOOLS = contract.tools;
export const githubAppToolRisk = contract.risk;
export const isCurrentGitHubAppTool = (entry: NativeCatalogEntry) => contract.isCurrentEntry(entry);
export const isGitHubAppToolName = contract.isToolName;
export function isGitHubAppApiConnection(connection: { authKind?: string; transport: string; config?: Record<string, unknown> }) {
  return connection.authKind === "github_app" && connection.transport === "rest_api"
    && connection.config?.sourceTemplateKey === "github" && connection.config.connectionMethodKey === GITHUB_APP_METHOD
    && connection.config.url === GITHUB_APP_API_URL;
}
export function gitHubAppRoleTools(role: string) {
  if (role !== "implementer" && role !== "reviewer") return [];
  return GITHUB_APP_TOOLS.filter(tool => contract.risk(tool.name) === "read"
    || (role === "reviewer" ? tool.name === "github_project_submit_review" : tool.name !== "github_project_submit_review"));
}
const invalid = () => nativeRestFailure(422, "github_app_arguments_invalid", "This GitHub action accepts only its reviewed current-project arguments.");
function checkedBranch(value: unknown) {
  const name = String(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(name) || name.includes("..") || name.includes("//") || name.includes("@{")
    || name.endsWith("/") || name.endsWith(".") || name.split("/").some(part => part.startsWith(".") || part.endsWith(".lock"))) throw invalid();
  return name;
}
function checkedPath(value: unknown) {
  if (value === "" || value === undefined) return "";
  const path = String(value);
  if (path.startsWith("/") || path.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(path)
    || path.split("/").some(part => !part || part === "." || part === "..")) throw invalid();
  return path.split("/").map(encodeURIComponent).join("/");
}
export function validateGitHubAppToolArguments(name: string, parameters: unknown): Record<string, unknown> {
  if (!contract.validate(name, parameters)) throw invalid();
  return parameters as Record<string, unknown>;
}
/** No caller-controlled owner, repository, API path, URL or identity. */
export function gitHubAppToolRequest(name: string, parameters: unknown, fullName: string) {
  const args = validateGitHubAppToolArguments(name, parameters);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw invalid();
  const base = `${GITHUB_APP_API_URL}/repos/${fullName.split("/").map(encodeURIComponent).join("/")}`;
  let route = "", method = "GET", body: Record<string, unknown> | undefined;
  const paging = () => new URLSearchParams({ page: String(args.page ?? 1), per_page: String(args.perPage ?? 30) });
  switch (name) {
    case "github_project_read_file": route = `/contents/${checkedPath(args.path)}`; if (args.ref) route += `?ref=${encodeURIComponent(checkedBranch(args.ref))}`; break;
    case "github_project_list_commits": { const query = paging(); if (args.ref) query.set("sha", checkedBranch(args.ref)); route = `/commits?${query}`; break; }
    case "github_project_list_pull_requests": { const query = paging(); query.set("state", String(args.state ?? "open")); route = `/pulls?${query}`; break; }
    case "github_project_read_pull_request": route = `/pulls/${args.number}`; break;
    case "github_project_pull_request_files": route = `/pulls/${args.number}/files?${paging()}`; break;
    case "github_project_create_branch": method = "POST"; route = "/git/refs"; body = { ref: `refs/heads/${checkedBranch(args.branch)}`, sha: args.commitSha }; break;
    case "github_project_write_file": {
      if (String(args.path) === ".github/workflows" || String(args.path).startsWith(".github/workflows/"))
        throw nativeRestFailure(403, "github_app_workflows_not_permitted", "Workflow files require a permission outside this App's approved scope and are unavailable through this connection.");
      const encoded = String(args.contentBase64), bytes = Buffer.from(encoded, "base64");
      if (bytes.length > 1024 * 1024 || bytes.toString("base64") !== encoded) throw invalid();
      method = "PUT"; route = `/contents/${checkedPath(args.path)}`;
      body = { message: args.message, content: encoded, branch: checkedBranch(args.branch), ...(args.sha ? { sha: args.sha } : {}) }; break;
    }
    case "github_project_open_pull_request": method = "POST"; route = "/pulls"; body = { title: args.title, body: args.body ?? "", head: checkedBranch(args.head), base: checkedBranch(args.base), draft: args.draft ?? false }; break;
    case "github_project_submit_review": method = "POST"; route = `/pulls/${args.number}/reviews`; body = { commit_id: args.commitSha, event: args.event, body: args.body ?? "" }; break;
    default: throw invalid();
  }
  return { url: `${base}${route}`, init: { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) } satisfies RequestInit };
}
