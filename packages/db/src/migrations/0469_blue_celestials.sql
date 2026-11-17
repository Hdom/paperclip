CREATE TABLE "issue_workflow_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"intent" jsonb NOT NULL,
	"return_proof" jsonb,
	"failure_code" text,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_workflow_handoffs" ADD CONSTRAINT "issue_workflow_handoffs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_handoffs" ADD CONSTRAINT "issue_workflow_handoffs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_handoffs" ADD CONSTRAINT "issue_workflow_handoffs_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_handoffs" ADD CONSTRAINT "issue_workflow_handoffs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_handoffs" ADD CONSTRAINT "issue_workflow_handoffs_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_handoffs" ADD CONSTRAINT "issue_workflow_handoffs_lease_id_environment_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."environment_leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_workflow_handoffs_company_source_uq" ON "issue_workflow_handoffs" USING btree ("company_id","source_run_id");--> statement-breakpoint
CREATE INDEX "issue_workflow_handoffs_company_issue_state_idx" ON "issue_workflow_handoffs" USING btree ("company_id","issue_id","state");--> statement-breakpoint
CREATE INDEX "issue_workflow_handoffs_state_created_idx" ON "issue_workflow_handoffs" USING btree ("state","created_at","id");