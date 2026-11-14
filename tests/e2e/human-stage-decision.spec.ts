// Run with the standard disposable local_trusted Playwright server. This verifies
// native stage decisions, not password-login or external provider execution.
// The paused process agent never invokes a model. Only the first decision PATCH
// is mocked (409) to exercise draft retention; both subsequent decisions are real.
import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

for (const mobile of [false, true]) {
  test(`guarded human decision ${mobile ? "phone" : "desktop"}`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    page.setDefaultTimeout(10_000);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const company = await json(await request.post("/api/companies", { data: { name: `Approval browser ${randomUUID()}` } }));
    const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "No execution fixture", role: "engineer", adapterType: "process",
      adapterConfig: { command: "/usr/bin/false" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    } }));
    await json(await request.post(`/api/agents/${agent.id}/pause`));
    const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
      title: "Review pinned browser plan", status: "todo", assigneeAgentId: agent.id,
      executionPolicy: { stages: [{ type: "approval", participants: [{ type: "user", userId: "local-board" }] }] },
    } }));
    const plan = await json(await request.put(`/api/issues/${issue.id}/documents/plan`, { data: {
      format: "markdown", title: "Fixture plan", body: "Exact revision one: local browser fixture only.", baseRevisionId: null,
    } }));
    await json(await request.patch(`/api/issues/${issue.id}`, { data: { status: "in_review", comment: "Ready for human approval." } }));
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
    await expect(page.getByText(issue.title, { exact: true }).first()).toBeVisible();
    // Current task detail opens with its sidebar collapsed. Open the saved
    // plan through the user's entry point before switching to Properties.
    await page.getByRole("link", { name: /^Open Plan revision 1(?: in task sidebar)?$/ }).click();
    await expect(page.getByRole("tabpanel", { name: "Fixture plan", exact: true })).toBeVisible();
    await expect(page.getByText("Exact revision one: local browser fixture only.", { exact: true })).toBeVisible();
    const openDecision = async () => {
      const dismiss = page.getByRole("button", { name: "Dismiss announcement" });
      if (await dismiss.isVisible()) await dismiss.click();
      if (mobile) {
        const closePanel = page.getByRole("button", { name: "Close side panel", exact: true });
        if (await closePanel.isVisible()) await closePanel.click();
        await expect(page.getByRole("dialog", { name: "Task side panel", exact: true })).not.toBeVisible();
      }
      await page.getByRole("button", { name: "Change status (current: In Review)", exact: true }).first().click();
      await page.getByRole("button", { name: /^Done(?: Done)?$/ }).click();
    };
    await openDecision();
    const note = page.getByRole("textbox", { name: "Decision note", exact: true }).locator("visible=true");
    await expect(note).toBeVisible();
    if (mobile) {
      await expect(note).toBeFocused();
      // A consumed Done request must not override a later explicit Plan choice
      // when the mobile sheet unmounts and opens again.
      await page.getByRole("button", { name: "Switch tabs, 2 open", exact: true }).click();
      await page.getByRole("button", { name: "Fixture plan", exact: true }).click();
      await page.getByRole("button", { name: "Close side panel", exact: true }).click();
      await page.getByRole("link", { name: /^Open Plan revision 1(?: in task sidebar)?$/ }).click();
      await expect(page.getByRole("tabpanel", { name: "Fixture plan", exact: true })).toBeVisible();
      await expect(note).toHaveCount(0);
      await page.getByRole("button", { name: "Close side panel", exact: true }).click();
      await openDecision();
      await expect(note).toBeFocused();
    }
    const approve = page.getByRole("button", { name: "Approve", exact: true }).locator("visible=true");
    const changes = page.getByRole("button", { name: "Request changes", exact: true }).locator("visible=true");
    await expect(approve).toBeDisabled();
    await expect(changes).toBeDisabled();
    await page.getByText("Read plan revision 1", { exact: true }).locator("visible=true").click();
    await expect(page.getByTestId("stage-decision").getByText("Exact revision one: local browser fixture only.", { exact: true }).locator("visible=true")).toBeVisible();
    let intercepted = 0;
    await page.route(`**/api/issues/${issue.identifier}`, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      const body = route.request().postDataJSON();
      if (!body.expectedExecutionStageId) return route.continue();
      intercepted += 1;
      expect(body.expectedPlanRevisionId).toBe(plan.latestRevisionId);
      expect(body.expectedDecisionLastDecisionId).toBeNull();
      expect(typeof body.expectedDecisionStatusVersion).toBe("number");
      await new Promise(resolve => setTimeout(resolve, 250));
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Fixture decision conflict" }) });
    });
    await note.fill("I reviewed this exact plan.");
    await approve.dblclick();
    await expect(approve).toBeDisabled();
    await expect(note).toHaveValue("I reviewed this exact plan.");
    await expect(approve).toBeEnabled();
    expect(intercepted).toBe(1);
    await expect(note).toHaveValue("I reviewed this exact plan.");
    await page.screenshot({ path: testInfo.outputPath("decision-error-retains-note.png"), fullPage: true });
    await page.unroute(`**/api/issues/${issue.identifier}`);
    await changes.click();
    await expect(note).toHaveCount(0);
    const after = await json(await request.get(`/api/issues/${issue.id}`));
    expect(after.status).toBe("in_progress");
    expect(after.executionState.lastDecisionOutcome).toBe("changes_requested");
    const revision2 = await json(await request.put(`/api/issues/${issue.id}/documents/plan`, { data: {
      format: "markdown", title: "Fixture plan", body: "Exact revision two: correction complete.", baseRevisionId: plan.latestRevisionId,
    } }));
    await json(await request.patch(`/api/issues/${issue.id}`, { data: { status: "in_review", comment: "Correction ready." } }));
    await page.reload();
    if (mobile) await expect(page.getByRole("tabpanel", { name: "Fixture plan", exact: true })).toBeVisible();
    await openDecision();
    await expect(note).toBeVisible();
    await expect(note).toHaveValue("");
    await note.fill("Approve corrected revision two.");
    await approve.click();
    await expect(note).toHaveCount(0);
    const completed = await json(await request.get(`/api/issues/${issue.id}`));
    expect(completed.status).toBe("done");
    expect(completed.executionState.lastDecisionOutcome).toBe("approved");
    expect(revision2.latestRevisionId).not.toBe(plan.latestRevisionId);
    await page.screenshot({ path: testInfo.outputPath("approved-revision-two.png"), fullPage: true });
    await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
  });
}
