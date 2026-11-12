ALTER TABLE "heartbeat_runs" ADD COLUMN "worker_supervision" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "worker_check_in_deadline_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "heartbeat_runs_worker_check_in_deadline_idx" ON "heartbeat_runs" USING btree ("worker_check_in_deadline_at") WHERE "heartbeat_runs"."worker_check_in_deadline_at" IS NOT NULL;