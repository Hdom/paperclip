import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { agents } from "./agents.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { environmentLeases } from "./environment_leases.js";

/** Server-owned workflow intent. Never contains credentials or executable requests. */
export const issueWorkflowHandoffs = pgTable("issue_workflow_handoffs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  sourceRunId: uuid("source_run_id").notNull().references(() => heartbeatRuns.id),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  workspaceId: uuid("workspace_id").notNull().references(() => executionWorkspaces.id),
  leaseId: uuid("lease_id").notNull().references(() => environmentLeases.id),
  state: text("state").notNull().default("pending"),
  intent: jsonb("intent").$type<Record<string, unknown>>().notNull(),
  returnProof: jsonb("return_proof").$type<Record<string, unknown>>(),
  failureCode: text("failure_code"),
  committedAt: timestamp("committed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  sourceUq: uniqueIndex("issue_workflow_handoffs_company_source_uq").on(t.companyId, t.sourceRunId),
  issueStateIdx: index("issue_workflow_handoffs_company_issue_state_idx").on(t.companyId, t.issueId, t.state),
  stateIdx: index("issue_workflow_handoffs_state_created_idx").on(t.state, t.createdAt, t.id),
}));
