// UI acceptance uses synthetic status responses. Real signer, encryption,
// authorization, migration/rollback and scope tests run in the server suites.
// This fixture creates only paused process agents in a disposable local instance.
import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";
import type { GitHubProjectAppSettings } from "@paperclipai/shared";
async function json(response: APIResponse) { expect(response.ok(), `${response.status()}: ${await response.text()}`).toBeTruthy(); return response.json(); }
for (const mobile of [false, true]) {
  test(`GitHub Apps in existing Tools and Secrets ${mobile ? "phone" : "desktop"}`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const company = await json(await request.post("/api/companies", { data: { name: `App identity UI ${randomUUID()}` } }));
    const agents = [];
    for (const name of ["Coordinator fixture", "Implementer fixture", "Reviewer fixture", "Replacement fixture"]) {
      const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: { name, role: "engineer", adapterType: "process", adapterConfig: { command: "/usr/bin/false" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } } }));
      await json(await request.post(`/api/agents/${agent.id}/pause`)); agents.push(agent);
    }
    let data: GitHubProjectAppSettings = { available: true, canManage: true, enabled: true, revision: "a".repeat(64), checkedAt: "2026-11-14T00:00:00Z", blockedAgentIds: [],
      roles: (["coordinator", "implementer", "reviewer"] as const).map((role, i) => ({ role, agentId: agents[i].id, appId: i+11, installationId: i+101,
        installationUrl: `https://github.com/settings/installations/${i+101}`, appUrl: `https://github.com/settings/apps/fixture-${role}`, login: `fixture-${role}[bot]`, status: "verified", message: null,
        repositories: [{ id: 1001, fullName: "Hdom/synthetic-ui-fixture", starter: false }], publicFingerprint: "SHA256:synthetic-public-fingerprint",
        keyStorage: "native_encrypted", secretId: randomUUID(), pinnedVersion: 1, latestVersion: 2, keyStatus: "active" })) };
    const changes: unknown[] = [];
    await page.route(`**/api/companies/${company.id}/github-project-apps`, async route => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        expect(body).toEqual({ revision: "a".repeat(64), confirmed: true, enabled: false,
          bindings: { coordinator: agents[0].id, implementer: agents[3].id, reviewer: agents[2].id } });
        changes.push(body);
        data = { ...data, revision: "b".repeat(64), enabled: false, blockedAgentIds: [agents[1].id],
          roles: data.roles.map(row => ({ ...row, agentId: row.role === "implementer" ? agents[3].id : row.agentId, status: "paused" })) };
      } else expect(route.request().method()).toBe("GET");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(`/${company.issuePrefix}/agents/${agents[1].urlKey ?? agents[1].id}/tools`);
    await expect(page.getByRole("heading", { name: "GitHub identity", exact: true })).toBeVisible();
    await expect(page.getByText("implementer GitHub App · fixture-implementer[bot]", { exact: true })).toBeVisible();
    await expect(page.getByText("Connect my GitHub", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Manage GitHub App", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "GitHub App identities", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Owner: Hdom · Selected repositories only · No Administration permission", { exact: true })).toBeVisible();
    await dialog.getByLabel("Implementer agent", { exact: true }).selectOption(agents[3].id);
    await dialog.getByLabel("Allow App issuance", { exact: true }).uncheck();
    await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
    const apply = dialog.getByRole("button", { name: "Apply confirmed changes", exact: true });
    await expect(apply).toBeDisabled(); expect(changes).toHaveLength(0);
    await dialog.getByLabel("I confirm these GitHub identity changes.", { exact: true }).check();
    await page.screenshot({ path: testInfo.outputPath("github-app-confirmation.png"), fullPage: !mobile });
    await apply.click(); await expect.poll(() => changes.length).toBe(1);
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(page.getByText("Managed GitHub access paused", { exact: true })).toBeVisible();
    await expect(page.getByText("Connect my GitHub", { exact: true })).toHaveCount(0);
    await page.goto(`/${company.issuePrefix}/company/settings/secrets`);
    await expect(page.getByRole("heading", { name: "Controller signing keys", exact: true })).toBeVisible();
    await expect(page.getByText("Coordinator: encrypted native secret · version 1 · active", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Manage App signing keys", exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.locator("summary").filter({ hasText: "Signing key" }).nth(1).click();
    await expect(dialog.getByText("Controller signing only. The key value cannot be revealed or bound to an agent.", { exact: true }).nth(1)).toBeVisible();
    await expect(dialog.getByLabel("Replacement Implementer signing key", { exact: true })).toHaveAttribute("type", "file");
    await dialog.getByLabel("Replacement Implementer signing key", { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.content()).not.toContain("-----BEGIN PRIVATE KEY-----");
    await page.screenshot({ path: testInfo.outputPath("github-app-native-secrets.png"), fullPage: !mobile });
  });
}
