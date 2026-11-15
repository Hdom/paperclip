// Synthetic UI acceptance: no real signing key, GitHub token or project execution.
// Server suites separately qualify signer, authorization and migration boundaries.
import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";
import type { GitHubProjectAppSettings } from "@paperclipai/shared";
import { gitHubAppRoleTools } from "../../server/src/services/github-app-tool-catalog.js";
async function json(response: APIResponse) { expect(response.ok(), `${response.status()}: ${await response.text()}`).toBeTruthy(); return response.json(); }
for (const mobile of [false, true]) {
  test(`GitHub connection identities and Secrets ${mobile ? "phone" : "desktop"}`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const company = await json(await request.post("/api/companies", { data: { name: `App identity UI ${randomUUID()}` } }));
    const agents = [];
    for (const name of ["Coordinator fixture", "Implementer fixture", "Reviewer fixture", "Replacement fixture"]) {
      const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: { name, role: "engineer", adapterType: "process", adapterConfig: { command: "/usr/bin/false" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } } }));
      await json(await request.post(`/api/agents/${agent.id}/pause`)); agents.push(agent);
    }
    const connectionIds = [randomUUID(), randomUUID(), randomUUID()];
    let data: GitHubProjectAppSettings = { available: true, canManage: true, enabled: true, revision: "a".repeat(64), checkedAt: "2026-11-14T00:00:00Z", blockedAgentIds: [],
      roles: (["coordinator", "implementer", "reviewer"] as const).map((role, i) => ({ role, agentId: agents[i].id, connectionId: connectionIds[i], appId: i+11, installationId: i+101,
        installationUrl: `https://github.com/settings/installations/${i+101}`, appUrl: `https://github.com/settings/apps/fixture-${role}`, login: `fixture-${role}[bot]`, status: "verified", message: null,
        repositories: [{ id: 1001, fullName: "Hdom/synthetic-ui-fixture", starter: true }], publicFingerprint: "SHA256:synthetic-public-fingerprint",
        keyStorage: "native_encrypted", secretId: randomUUID(), pinnedVersion: 1, latestVersion: 2, keyStatus: "active" })) };
    const applicationId = randomUUID();
    function connections() { return data.roles.map(row => ({ id: row.connectionId, uid: `github/project-app-${row.role}`, companyId: company.id, applicationId,
      name: `GitHub · ${row.role}`, connectionKind: "managed", connectionPurpose: "tool", transport: "rest_api", authKind: "github_app", credentialPolicy: "per_agent",
      status: "active", enabled: data.enabled, healthStatus: "healthy", ownership: "customer", credentialSource: "paperclip_vault", credentialSecretRefs: [], credentialRefs: [],
      config: { sourceTemplateKey: "github", connectionMethodKey: "app-installation", url: "https://api.github.com", githubApp: { role: row.role, appId: row.appId, installationId: row.installationId, scope: "current_project" } },
      createdAt: "2026-11-14T00:00:00Z", updatedAt: "2026-11-14T00:00:00Z" })); }
    const changes: unknown[] = [];
    const fulfill = (route: import("@playwright/test").Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    // Registered first so exact synthetic handlers below run before this fence.
    // A missed fixture must never mutate the disposable server's connection/key state.
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.includes("/tool-connections/") || path.includes("/tools/") || path.includes("/github-project-apps") || path.includes("/signing-keys")) {
        expect(route.request().method()).toMatch(/^(GET|HEAD)$/);
      }
      await route.fallback();
    });
    await page.route(`**/api/companies/${company.id}/github-project-apps`, async route => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        if (changes.length === 0) {
          expect(body).toEqual({ revision: "a".repeat(64), confirmed: true,
            bindings: { coordinator: agents[0].id, implementer: agents[3].id, reviewer: agents[2].id } });
          data = { ...data, revision: "b".repeat(64), blockedAgentIds: [agents[1].id], roles: data.roles.map(row => ({ ...row, agentId: row.role === "implementer" ? agents[3].id : row.agentId })) };
        } else {
          expect(changes).toHaveLength(1);
          expect(body).toEqual({ revision: "b".repeat(64), confirmed: true, enabled: false });
          data = { ...data, revision: "c".repeat(64), enabled: false, roles: data.roles.map(row => ({ ...row, status: "paused" })) };
        }
        changes.push(body);
      } else expect(route.request().method()).toBe("GET");
      await fulfill(route, data);
    });
    await page.route(`**/api/companies/${company.id}/tools/**`, async route => {
      expect(route.request().method()).toBe("GET");
      const path = new URL(route.request().url()).pathname;
      if (path.includes("/profiles/effective/agents/")) {
        const agentId = path.split("/").at(-1);
        return fulfill(route, { allowedTools: [], installedConnections: connections().filter(row => data.roles.some(role => role.connectionId === row.id && role.agentId === agentId)) });
      }
      if (path.endsWith("/connections")) return fulfill(route, { connections: connections() });
      if (path.endsWith("/applications")) return fulfill(route, { applications: [{ id: applicationId, applicationKey: "github", type: "mcp_http", name: "GitHub", status: "active" }] });
      if (path.endsWith("/gallery")) return fulfill(route, { apps: [], capabilities: {}, credentialSources: { vercelConnect: { available: false, enabled: false } } });
      if (path.endsWith("/policies")) return fulfill(route, { policies: [] });
      return route.fallback();
    });
    await page.route("**/api/tool-connections/**", async route => {
      const parts = new URL(route.request().url()).pathname.split("/");
      const row = connections().find(connection => connection.id === parts[3]);
      if (!row) return route.fallback();
      expect(route.request().method()).toBe("GET");
      const role = data.roles.find(role => role.connectionId === row.id)!;
      if (parts.length === 4) return fulfill(route, row);
      if (parts[4] === "installs") return fulfill(route, { connectionId: row.id, installs: [{ targetType: "agent", targetId: role.agentId }] });
      if (parts[4] === "grants") return fulfill(route, { connection: { id: row.id, uid: row.uid }, grants: [{ id: `grant-${row.id}`, companyId: company.id, connectionId: row.id, kind: "agent", status: "active", subjectAgentId: role.agentId, subjectUserId: null, credentialSecretRefs: [], externalCredential: null, isDefault: false, providerTenant: { githubApp: { role: role.role, appId: role.appId, installationId: role.installationId, login: role.login, scope: "current_project", tools: "unverified" } } }], capabilities: { canConfigure: true, canManageAgentInstalls: true, editableAgentIds: agents.map(agent => agent.id) }, currentUserId: null, members: [] });
      if (parts[4] === "profile-configuration") return fulfill(route, { profiles: [] });
      if (parts[4] === "catalog") return fulfill(route, { catalog: gitHubAppRoleTools(role.role).filter(tool => tool.name === "github_project_read_file").map(tool => ({ ...tool, id: `catalog-${row.id}`, companyId: company.id, connectionId: row.id, toolName: tool.name, status: "active", isReadOnly: true, riskLevel: "read" })) });
      return route.fallback();
    });
    await page.route(`**/api/companies/${company.id}/signing-keys`, async route => {
      expect(route.request().method()).toBe("GET");
      await fulfill(route, { canManage: true, keys: data.roles.map(row => ({ id: row.secretId, name: `GitHub App ${row.role} signing key`, description: "Synthetic native signing key",
        status: "active", type: "github_app", algorithm: null, publicFingerprint: null, latestVersion: row.latestVersion, revision: null, githubApp: { role: row.role, appId: row.appId }, createdAt: "2026-11-14T00:00:00Z", updatedAt: "2026-11-14T00:00:00Z" })) });
    });
    await page.route(`**/api/companies/${company.id}/signing-keys/*/versions`, async route => {
      expect(route.request().method()).toBe("GET");
      await fulfill(route, [{ id: "fixture-2", version: 2, status: "current", createdAt: "2026-11-14T00:00:00Z" }, { id: "fixture-1", version: 1, status: "previous", createdAt: "2026-11-13T00:00:00Z" }]);
    });
    await page.route(`**/api/companies/${company.id}/signing-keys/*/access-events`, async route => {
      expect(route.request().method()).toBe("GET");
      await fulfill(route, [{ id: "synthetic-access-event", version: 1, outcome: "allowed", createdAt: "2026-11-14T00:00:00Z" }]);
    });
    await page.goto(`/${company.issuePrefix}/agents/${agents[1].urlKey ?? agents[1].id}/permissions`);
    const identity = page.getByRole("region", { name: "GitHub · implementer", exact: true });
    await expect(identity.getByText("fixture-implementer[bot]", { exact: true })).toBeVisible();
    await expect(page.getByText("No connector tools are allowed yet.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Manage GitHub App", exact: true })).toHaveCount(0);
    await expect(page.getByText("Connect my GitHub", { exact: true })).toHaveCount(0);
    await identity.getByRole("link", { name: "GitHub · implementer ↗", exact: true }).click();
    await expect(page.getByRole("heading", { name: "GitHub identity", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Actions", exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Read project file: Off", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Test from an active project task", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Test", exact: true })).toHaveCount(0);
    await expect(page.getByText("Bootstrap only; never an agent project token target", { exact: false })).toBeVisible();
    // Exercise the actual company-aware deep link. A legacy /settings URL
    // silently redirects to General and drops the selected signing key.
    await page.getByRole("link", { name: "Signing key in Secrets", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/company/settings/secrets\\?signingKey=${data.roles[1].secretId}$`));
    const linkedKey = page.getByRole("dialog", { name: "GitHub App implementer signing key", exact: true });
    await expect(linkedKey.getByText("Active version: 1", { exact: false })).toBeVisible();
    await expect(linkedKey.getByText("Latest stored version", { exact: true })).toBeVisible();
    await expect(linkedKey.getByRole("textbox", { name: "Signing key name", exact: true })).toHaveValue("GitHub App implementer signing key");
    await page.screenshot({ path: testInfo.outputPath("github-app-connection-secret-roundtrip.png"), fullPage: !mobile });
    await linkedKey.getByRole("link", { name: "View GitHub connection", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/apps/${connectionIds[1]}/permissions$`));
    await expect(page.getByRole("heading", { name: "GitHub identity", exact: true })).toBeVisible();
    expect(changes).toHaveLength(0);
    await page.getByLabel("Assigned GitHub App agent", { exact: true }).selectOption(agents[3].id);
    await page.getByRole("button", { name: "Review assignment", exact: true }).click();
    const assign = page.getByRole("button", { name: "Assign identity", exact: true });
    await expect(assign).toBeDisabled(); expect(changes).toHaveLength(0);
    await page.getByLabel("I confirm this identity assignment.", { exact: true }).check();
    await page.screenshot({ path: testInfo.outputPath("github-app-confirmation.png"), fullPage: !mobile });
    await assign.click(); await expect.poll(() => changes.length).toBe(1);
    await page.getByRole("link", { name: "Coordinator connection", exact: true }).click();
    await page.getByRole("button", { name: "Pause issuance…", exact: true }).click();
    const apply = page.getByRole("button", { name: "Apply access change", exact: true });
    await expect(apply).toBeDisabled();
    await page.getByLabel("I confirm this access change.", { exact: true }).check();
    await apply.click(); await expect.poll(() => changes.length).toBe(2);
    await expect(page.getByText("Paused for all three GitHub App identities", { exact: true })).toBeVisible();
    await page.goto(`/${company.issuePrefix}/agents/${agents[1].urlKey ?? agents[1].id}/permissions`);
    await expect(page.getByText("Managed GitHub access paused. This former assignment remains blocked; personal GitHub credentials are not substituted.", { exact: true })).toBeVisible();
    await expect(page.getByText("Connect my GitHub", { exact: true })).toHaveCount(0);
    await page.goto(`/${company.issuePrefix}/company/settings/secrets`);
    if (mobile) await page.getByLabel("Secrets section", { exact: true }).selectOption("signing-keys");
    else await page.getByRole("tab", { name: "Signing keys", exact: true }).click();
    await expect(page.getByRole("table")).toBeVisible();
    await page.getByRole("button", { name: "Actions for GitHub App implementer signing key", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open details", exact: true }).click();
    const details = page.getByRole("dialog", { name: "GitHub App implementer signing key", exact: true });
    await expect(details.getByText("Active version: 1", { exact: false })).toBeVisible();
    await expect(details.getByText("Latest stored version", { exact: true })).toBeVisible();
    await expect(details.getByLabel("Replacement GitHub App signing key", { exact: true })).toHaveAttribute("type", "file");
    await expect(details.getByRole("button", { name: "Verify replacement", exact: true })).toBeDisabled();
    // This browser fixture verifies presentation and navigation only. Separate
    // lifecycle/server tests cover staging, activation and private-key handling.
    await details.getByRole("tab", { name: "Usage", exact: true }).click();
    await expect(details.getByText("GitHub · implementer · Active version 1", { exact: true })).toBeVisible();
    await details.getByRole("tab", { name: "Versions", exact: true }).click();
    await expect(details.getByRole("cell", { name: "Stored · Active in GitHub connection", exact: true })).toBeVisible();
    await expect(details.getByRole("cell", { name: "Latest stored", exact: true })).toBeVisible();
    await details.getByRole("tab", { name: "Access events", exact: true }).click();
    await expect(details.getByText("allowed · v1", { exact: true })).toBeVisible();
    await details.getByRole("tab", { name: "Details", exact: true }).click();
    expect(await page.content()).not.toContain("-----BEGIN PRIVATE KEY-----");
    await page.screenshot({ path: testInfo.outputPath("github-app-native-secrets.png"), fullPage: !mobile });
    await details.getByRole("link", { name: "View GitHub connection", exact: true }).click();
    await expect(page.getByRole("heading", { name: "GitHub identity", exact: true })).toBeVisible();
  });
}
