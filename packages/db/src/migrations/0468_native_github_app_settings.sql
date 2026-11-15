CREATE TABLE "github_app_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"verification" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_settings_company_check" CHECK ("github_app_settings"."settings"->>'companyId' = "github_app_settings"."company_id"::text),
	CONSTRAINT "github_app_settings_revision_check" CHECK ("github_app_settings"."revision" >= 0),
	CONSTRAINT "github_app_settings_native_refs_check" CHECK (
    "github_app_settings"."settings" #> '{apps,coordinator,signingKeySecret}' IS NOT NULL AND
    "github_app_settings"."settings" #> '{apps,implementer,signingKeySecret}' IS NOT NULL AND
    "github_app_settings"."settings" #> '{apps,reviewer,signingKeySecret}' IS NOT NULL AND
    "github_app_settings"."settings" #> '{apps,coordinator,privateKeyPath}' IS NULL AND
    "github_app_settings"."settings" #> '{apps,implementer,privateKeyPath}' IS NULL AND
    "github_app_settings"."settings" #> '{apps,reviewer,privateKeyPath}' IS NULL)
);
--> statement-breakpoint
ALTER TABLE "github_app_settings" ADD CONSTRAINT "github_app_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;