import { conflict } from "../errors.js";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { nativeSha256 } from "./native-runtime/canonical.js";

type Reader = Pick<Db,"execute">;
/** All semantic saved-intent/source/binding facts; never transient updated_at.
 * NOWAIT prevents gate->task inspection from deadlocking a task-first writer.
 * Wake writers take the singleton shared gate via the database trigger. */
export async function maintenanceContinuationReview(db: Reader, policy: string, lock = false) {
  try {
  const lockRows = lock ? sql`for share nowait` : sql``;
  const wakes = await db.execute(sql`select to_jsonb(w) - 'updated_at' - 'created_at' as intent
    from agent_wakeup_requests w where status in ('queued','deferred_issue_execution') and run_id is null
    order by id ${lockRows}`);
  const tasks = await db.execute(sql`select i.id,i.company_id,i.project_id,i.project_workspace_id,i.status,
    i.assignee_agent_id,i.assignee_user_id,i.execution_workspace_id,i.workspace_binding_revision,i.execution_policy,i.execution_state
    from issues i where exists (select 1 from agent_wakeup_requests w where w.company_id=i.company_id
      and w.payload->>'issueId'=i.id::text and w.status in ('queued','deferred_issue_execution') and w.run_id is null)
    order by i.id ${lockRows}`);
  const actions = await db.execute(sql`select a.id,a.company_id,a.source_issue_id,a.status,a.owner_type,a.evidence
    from issue_recovery_actions a where exists (select 1 from agent_wakeup_requests w where w.company_id=a.company_id
      and w.payload->>'issueId'=a.source_issue_id::text and w.status in ('queued','deferred_issue_execution') and w.run_id is null)
    order by a.id ${lockRows}`);
  const sources = await db.execute(sql`select r.id,r.company_id,r.status,r.result_json,r.runner_profile_json
    from heartbeat_runs r where exists (select 1 from issue_recovery_actions a join agent_wakeup_requests w
      on w.company_id=a.company_id and w.payload->>'issueId'=a.source_issue_id::text
      where a.company_id=r.company_id and a.evidence->>'runId'=r.id::text
        and w.status in ('queued','deferred_issue_execution') and w.run_id is null)
    order by r.id ${lockRows}`);
  return { fingerprint: nativeSha256({schema:"paperclip.maintenance-continuation-review.v1",policy,wakes,tasks,actions,sources}),
    savedIntentCount:wakes.length,
    blockedReason:policy !== "review_all"
      ? "This maintenance protects a continuation whose project workflow is not qualified. A separately approved readiness decision is required; reviewing saved intents alone cannot release it." : null };
  } catch(error) {
    const cause=error as {code?:string;cause?:{code?:string}};
    if(cause.code === "55P03" || cause.cause?.code === "55P03")
      throw conflict("Saved work is changing. Refresh its review before resuming.");
    throw error;
  }
}
