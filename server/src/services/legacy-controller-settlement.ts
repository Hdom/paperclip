import { and, eq, isNull } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db/schema/index";
import type { Db } from "@paperclipai/db/client";

type Run = typeof heartbeatRuns.$inferSelect;
/** Normal successful cleanup clears expiry but retains the historical boot ID.
 * Absence of expiry alone proves nothing: require the server's post-cleanup
 * settlement event. This only settles controller ownership, never the provider.
 */
export async function hasSuccessfulLegacyControllerSettlement(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode !== "legacy" || run.status !== "succeeded" || !run.startedAt || !run.finishedAt ||
      !run.controllerBootId || run.controllerLeaseExpiresAt !== null) return false;
  const events = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.agentId, run.agentId), eq(heartbeatRunEvents.eventType, "lifecycle"),
    eq(heartbeatRunEvents.stream, "system"), eq(heartbeatRunEvents.level, "info"),
    eq(heartbeatRunEvents.message, "task.run.measured"), isNull(heartbeatRunEvents.sourceEventId),
  ));
  return events.some(event => event.createdAt >= run.finishedAt! && event.payload?.phase === "task.run.measured" &&
    event.payload.outcome === "succeeded" && event.payload.durableSettlement === true &&
    typeof event.payload.durationMs === "number" && Number.isFinite(event.payload.durationMs) && event.payload.durationMs >= 0);
}
