CREATE TABLE "instance_maintenance" (
	"singleton_key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"protocol_version" integer DEFAULT 1 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'released' NOT NULL,
	"owner_id" uuid,
	"operator_note" text,
	"actor_id" text,
	"request_id" uuid,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_maintenance_singleton" CHECK ("instance_maintenance"."singleton_key" = 'default'),
	CONSTRAINT "instance_maintenance_state" CHECK ("instance_maintenance"."state" in ('released', 'acquiring', 'held'))
);
--> statement-breakpoint
CREATE TABLE "instance_maintenance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation" integer NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_maintenance_events_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "instance_maintenance_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation" integer NOT NULL,
	"kind" text NOT NULL,
	"owner" jsonb NOT NULL,
	"authority" jsonb,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "instance_maintenance_operation_state" CHECK ("instance_maintenance_operations"."state" in ('active', 'settled'))
);
--> statement-breakpoint
CREATE INDEX "instance_maintenance_operations_active" ON "instance_maintenance_operations" USING btree ("state");
--> statement-breakpoint
INSERT INTO "instance_maintenance" ("singleton_key") VALUES ('default');
