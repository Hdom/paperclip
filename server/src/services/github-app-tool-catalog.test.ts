import { describe, expect, it } from "vitest";
import { GITHUB_APP_API_URL, GITHUB_APP_TOOLS, gitHubAppRoleTools, gitHubAppToolRequest, isGitHubAppApiConnection } from "./github-app-tool-catalog.js";
import { nativeProviderCatalogFor } from "./native-provider-catalogs.js";
describe("current-project GitHub App API catalog", () => {
  it("keeps Coordinator provisioning separate and gives Reviewer no content/PR mutation actions", () => {
    expect(gitHubAppRoleTools("coordinator")).toEqual([]);
    expect(gitHubAppRoleTools("reviewer").filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name)).toEqual(["github_project_submit_review"]);
    expect(gitHubAppRoleTools("implementer").some(tool => tool.name === "github_project_submit_review")).toBe(false);
    expect(GITHUB_APP_TOOLS.some(tool => /merge|search|graphql|fork|delete/.test(tool.name))).toBe(false);
  });
  it("recognizes only the fixed native method and preserves compatibility with the existing GitHub application", () => {
    const connection = { authKind: "github_app", transport: "rest_api", config: { sourceTemplateKey: "github", connectionMethodKey: "app-installation", url: GITHUB_APP_API_URL, githubApp: { role: "reviewer" } } };
    expect(isGitHubAppApiConnection(connection)).toBe(true);
    expect(isGitHubAppApiConnection({ ...connection, authKind: "oauth" })).toBe(false);
    const provider = nativeProviderCatalogFor(connection)!;
    expect(provider.acceptsApplication?.({ type: "mcp_http", applicationKey: "github" })).toBe(true);
    expect(provider.acceptsApplication?.({ type: "mcp_http", applicationKey: "other" })).toBe(false);
    expect(provider.toolsForConnection?.(connection).map(tool => tool.name)).toEqual(gitHubAppRoleTools("reviewer").map(tool => tool.name));
  });
  it.each(["owner", "repo", "repositoryId", "url", "headers", "installationId"])("rejects caller-controlled %s overrides", field => {
    expect(() => gitHubAppToolRequest("github_project_list_pull_requests", { [field]: "other" }, "Hdom/paperclip-project")).toThrow();
  });
  it.each(["../outside", "/absolute", "a/../outside", "a\\outside", "a//b", "a\u0000b"])("rejects unsafe file paths %j", path => {
    expect(() => gitHubAppToolRequest("github_project_read_file", { path }, "Hdom/paperclip-project")).toThrow();
  });
  it.each(["other:branch", "a..b", "a//b", ".hidden", "branch.lock", "branch/", "x@{y}"])("rejects fork-qualified or unsafe branch %j", head => {
    expect(() => gitHubAppToolRequest("github_project_open_pull_request", { title: "PR", head, base: "main" }, "Hdom/paperclip-project")).toThrow();
  });
  it("encodes file path segments as data and restricts file content size/encoding", () => {
    const read = gitHubAppToolRequest("github_project_read_file", { path: "src/a?b#c.ts", ref: "feature/review" }, "Hdom/paperclip-project");
    expect(read.url).toBe("https://api.github.com/repos/Hdom/paperclip-project/contents/src/a%3Fb%23c.ts?ref=feature%2Freview");
    expect(() => gitHubAppToolRequest("github_project_write_file", { path: "src/a", branch: "feature", message: "change", contentBase64: "not base64" }, "Hdom/paperclip-project")).toThrow();
  });
  it("requires an explicit commit for reviews and never sends identity or target overrides", () => {
    const plan = gitHubAppToolRequest("github_project_submit_review", { number: 7, commitSha: "a".repeat(40), event: "APPROVE", body: "Reviewed" }, "Hdom/paperclip-project");
    expect(plan.url).toBe("https://api.github.com/repos/Hdom/paperclip-project/pulls/7/reviews");
    expect(JSON.parse(plan.init.body! as string)).toEqual({ commit_id: "a".repeat(40), event: "APPROVE", body: "Reviewed" });
    expect(() => gitHubAppToolRequest("github_project_submit_review", { number: 7, event: "APPROVE" }, "Hdom/paperclip-project")).toThrow();
  });
  it("does not offer workflow writes outside the approved App permissions", () => {
    expect(() => gitHubAppToolRequest("github_project_write_file", { path: ".github/workflows/ci.yml", branch: "feature", message: "change", contentBase64: "" }, "Hdom/paperclip-project")).toThrow("approved scope");
  });

});
