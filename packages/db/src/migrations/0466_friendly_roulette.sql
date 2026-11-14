ALTER TABLE "company_secrets" DROP CONSTRAINT "company_secrets_scope_shape_check";--> statement-breakpoint
CREATE UNIQUE INDEX "company_secrets_controller_key_uq" ON "company_secrets" USING btree ("company_id","key") WHERE "company_secrets"."scope" = 'controller' and "company_secrets"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_scope_shape_check" CHECK ((
        "company_secrets"."scope" in ('company', 'controller')
        and "company_secrets"."owner_user_id" is null
        and "company_secrets"."user_secret_definition_id" is null
        and "company_secrets"."owner_agent_id" is null and "company_secrets"."owner_project_id" is null and "company_secrets"."owner_plugin_id" is null
      ) or (
        "company_secrets"."scope" = 'user'
        and "company_secrets"."owner_user_id" is not null
        and "company_secrets"."user_secret_definition_id" is not null
        and "company_secrets"."owner_agent_id" is null and "company_secrets"."owner_project_id" is null and "company_secrets"."owner_plugin_id" is null
      ) or (
        "company_secrets"."scope" = 'instance'
        and "company_secrets"."owner_user_id" is null and "company_secrets"."user_secret_definition_id" is null
        and ("company_secrets"."owner_agent_id" is not null) <> ("company_secrets"."owner_project_id" is not null)
        and "company_secrets"."owner_plugin_id" is not null
      ));