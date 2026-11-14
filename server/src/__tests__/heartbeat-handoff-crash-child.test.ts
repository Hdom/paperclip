import { and, eq } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import { agents, createDb, heartbeatRuns } from "@paperclipai/db";
import { handoffWakeWork } from "../services/heartbeat/handoff-wake.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.js";
import { instanceSettingsService } from "../services/instance-settings.js";

// A child of the owning test process only. No server, provider, or model starts.
it.skipIf(!process.env.PAPERCLIP_BACKPORT_CRASH_DB)("isolated admission crash child", async () => {
  const db = createDb(process.env.PAPERCLIP_BACKPORT_CRASH_DB!);
  const companyId = process.env.PAPERCLIP_BACKPORT_CRASH_COMPANY!;
  const issueId = process.env.PAPERCLIP_BACKPORT_CRASH_ISSUE!;
  const reviewerId = process.env.PAPERCLIP_BACKPORT_CRASH_REVIEWER!;
  const mode = process.env.PAPERCLIP_BACKPORT_CRASH_MODE!;
  const ready = async () => {
    process.stdout.write("BACKPORT_CRASH_BOUNDARY_READY\n");
    await new Promise(() => {});
  };
  const successors = async (q: typeof db) => (await q.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, reviewerId))))
    .filter(row => row.contextSnapshot?.issueId === issueId);
  const deps = createHeartbeatQueueTestDependencies(db);
  deps.getAgent.mockImplementation(async id => {
    if (mode === "postcommit" && (await successors(db)).length) await ready();
    return (await db.select().from(agents).where(eq(agents.id, id)))[0] ?? null;
  });
  deps.getAgentInvokability.mockImplementation(agent => evaluateAgentInvokabilityFromDb(db, agent));
  deps.instanceSettings.getExperimental.mockImplementation(() => instanceSettingsService(db).getExperimental());
  if (mode === "precommit") {
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation((async (fn: any, options: any) =>
      transaction(async tx => {
        const result = await fn(tx);
        if ((await successors(tx as unknown as typeof db)).length) await ready();
        return result;
      }, options)) as any);
  }
  const work = handoffWakeWork(db, createHeartbeatQueue(db, deps).enqueueWakeup);
  for (const entry of await work.load(companyId)) await work.check(entry);
  expect.fail("Child admission did not reach requested boundary");
}, 90_000);
