import { describe, expect, it } from "vitest";
import { appConnectionConfig, assertAppConnectionGrant, assertAppConnectionIdentity, assertNotAppConnection } from "./github-app-connections.js";
import type { ProjectAppsConfig } from "./github-project-apps.js";

const config = { companyId: "company", apps: { reviewer: { appId: 13, installationId: 23, agentId: "reviewer" } } } as unknown as ProjectAppsConfig;
function connection() {
  return { id: "connection", companyId: "company", authKind: "github_app", credentialPolicy: "per_agent", transport: "rest_api",
    connectionPurpose: "tool", transportConfig: { url: "https://api.github.com" },
    credentialSource: "paperclip_vault", externalCredential: null, credentialRefs: [], credentialSecretRefs: [],
    config: appConnectionConfig(config, "reviewer") } as unknown as Parameters<typeof assertAppConnectionIdentity>[0];
}
function grant() {
  return { companyId: "company", connectionId: "connection", kind: "agent", subjectAgentId: "reviewer", subjectUserId: null,
    status: "active", credentialSecretRefs: [], externalCredential: null,
    providerTenant: { githubApp: { role: "reviewer", appId: 13, installationId: 23, scope: "current_project", tools: "unverified" } } } as unknown as Parameters<typeof assertAppConnectionGrant>[0];
}
describe("dedicated GitHub App connection authority", () => {
  it("keeps App principals separate from user OAuth and contains no signing material or credential projections", () => {
    expect(() => assertAppConnectionIdentity(connection(), config, "reviewer")).not.toThrow();
    expect(() => assertAppConnectionGrant(grant(), connection(), config, "reviewer")).not.toThrow();
    expect(JSON.stringify(appConnectionConfig(config, "reviewer"))).not.toMatch(/secretId|privateKey|token|signingKey/);
  });
  it("accepts the same identity after PostgreSQL JSONB key reordering", () => {
    const row = connection(); row.config.githubApp = { scope: "current_project", installationId: 23, appId: 13, role: "reviewer" };
    expect(() => assertAppConnectionIdentity(row, config, "reviewer")).not.toThrow();
  });
  it.each(["companyId", "transport", "authKind", "credentialPolicy", "credentialSource"] as const)("rejects changed %s", field => {
    const row = connection(); Object.assign(row, { [field]: "other" });
    expect(() => assertAppConnectionIdentity(row, config, "reviewer")).toThrow();
  });
  it("rejects alternate endpoints, installation IDs and raw secret projections", () => {
    for (const patch of [{ url: "https://example.org/mcp" }, { githubApp: { role: "reviewer", appId: 13, installationId: 99 } }]) {
      const row = connection(); row.config = { ...row.config, ...patch };
      expect(() => assertAppConnectionIdentity(row, config, "reviewer")).toThrow();
    }
    const row = connection(); row.credentialSecretRefs = [{ secretId: "protected-key", configPath: "authorization" }];
    expect(() => assertAppConnectionIdentity(row, config, "reviewer")).toThrow();
  });
  it("rejects another agent, revoked grant and a user identity substituted into the App grant", () => {
    for (const patch of [{ subjectAgentId: "implementer" }, { status: "revoked" }, { subjectUserId: "operator" },
      { providerTenant: { github: { userId: "human" } } }]) {
      const row = { ...grant(), ...patch } as Parameters<typeof assertAppConnectionGrant>[0];
      expect(() => assertAppConnectionGrant(row, connection(), config, "reviewer")).toThrow();
    }
  });
  it("blocks generic mutations and fabricated App setup while leaving ordinary OAuth connections unchanged", () => {
    expect(() => assertNotAppConnection(connection())).toThrow();
    expect(() => assertNotAppConnection({ authKind: "oauth" }, { authKind: "github_app" })).toThrow();
    expect(() => assertNotAppConnection({ authKind: "none" }, { config: { githubApp: { role: "reviewer" } } })).toThrow();
    expect(() => assertNotAppConnection({ authKind: "oauth" })).not.toThrow();
  });
});
