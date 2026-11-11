import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueExecutionDecisions, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native review checkout", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("review-checkout-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    await temporary?.cleanup();
  });
  async function fixture(human = false) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const producerId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Fixture", issuePrefix: `R${companyId.slice(0,6)}` });
    await db.insert(agents).values([agentId, producerId].map(id => ({ id, companyId, name: id, role: "engineer", status: "idle", adapterType: "codex_local" })));
    const participant = human ? { type: "user" as const, userId: "human" } : { type: "agent" as const, agentId };
    const policy = normalizeIssueExecutionPolicy({ stages: [{ type: human ? "approval" : "review", participants: [participant] }] })!;
    const state = {
      status: "pending" as const,
      currentStageId: policy.stages[0].id,
      currentStageType: policy.stages[0].type,
      currentStageIndex: 0,
      currentParticipant: participant,
      returnAssignee: { type: "agent" as const, agentId: producerId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      changesRequestedCount: 0,
    };
    await db.insert(issues).values({ id: issueId, companyId, title: "Review", status: "in_review", assigneeAgentId: human ? null : agentId, assigneeUserId: human ? "human" : null, executionPolicy: policy, executionState: state });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", scopeKind: "issue", issueId });
    return { companyId, issueId, agentId, producerId, runId, state };
  }
  it("acquires and repeats a reviewer lease without leaving the pending gate", async () => {
    const f = await fixture();
    const svc = issueService(db);
    const startedAt = new Date("2026-01-01T00:00:00Z");
    await db.update(issues).set({ startedAt }).where(eq(issues.id, f.issueId));
    const first = await svc.checkout(f.issueId, f.agentId, ["in_review"], f.runId);
    expect(first.status).toBe("in_review");
    expect(first.executionState).toEqual(f.state);
    expect(first.checkoutRunId).toBe(f.runId);
    expect(first.startedAt).toEqual(startedAt);
    const again = await svc.checkout(f.issueId, f.agentId, ["todo"], f.runId);
    expect(again.status).toBe("in_review");
    expect(again.executionState).toEqual(f.state);
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))).toHaveLength(0);
  });
  it("refuses to claim a human approval stage", async () => {
    const f = await fixture(true);
    await expect(issueService(db).checkout(f.issueId, f.agentId, ["in_review"], f.runId)).rejects.toThrow();
    const saved = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(saved[0].status).toBe("in_review");
    expect(saved[0].assigneeUserId).toBe("human");
    expect(saved[0].executionState).toEqual(f.state);
    expect(saved[0].checkoutRunId).toBeNull();
  });
  it("refuses an agent other than the active reviewer", async () => {
    const f = await fixture();
    await expect(issueService(db).checkout(f.issueId, f.producerId, ["in_review"], null)).rejects.toThrow();
  });
  it("does not take another active run's lease", async () => {
    const f = await fixture();
    const svc = issueService(db);
    const otherRun = randomUUID();
    await svc.checkout(f.issueId, f.agentId, ["in_review"], f.runId);
    await db.insert(heartbeatRuns).values({ id: otherRun, companyId: f.companyId, agentId: f.agentId, status: "running", scopeKind: "issue", issueId: f.issueId });
    await expect(svc.checkout(f.issueId, f.agentId, ["in_review"], otherRun)).rejects.toThrow();
    expect((await svc.getById(f.issueId))?.checkoutRunId).toBe(f.runId);
  });
  it("reclaims a terminal run lease without changing the pending gate", async () => {
    const f = await fixture();
    const svc = issueService(db);
    const nextRun = randomUUID();
    await svc.checkout(f.issueId, f.agentId, ["in_review"], f.runId);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(heartbeatRuns).values({ id: nextRun, companyId: f.companyId, agentId: f.agentId, status: "running", scopeKind: "issue", issueId: f.issueId });
    const next = await svc.checkout(f.issueId, f.agentId, ["in_review"], nextRun);
    expect(next.status).toBe("in_review");
    expect(next.executionState).toEqual(f.state);
    expect(next.checkoutRunId).toBe(nextRun);
  });
  it("retains ordinary in_review checkout semantics without a native gate", async () => {
    const f = await fixture();
    await db.update(issues).set({ executionPolicy: null, executionState: null }).where(eq(issues.id, f.issueId));
    expect((await issueService(db).checkout(f.issueId, f.agentId, ["in_review"], f.runId)).status).toBe("in_progress");
  });
  it("does not repair an inconsistent native gate through checkout", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    await expect(issueService(db).checkout(f.issueId, f.agentId, ["in_progress"], f.runId)).rejects.toThrow();
    expect((await issueService(db).getById(f.issueId))?.checkoutRunId).toBeNull();
  });
  it("respects expected status before acquiring a review lease", async () => {
    const f = await fixture();
    await expect(issueService(db).checkout(f.issueId, f.agentId, ["todo"], f.runId)).rejects.toThrow();
  });

});
