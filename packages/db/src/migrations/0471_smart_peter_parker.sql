ALTER TABLE "instance_maintenance" ADD COLUMN "continuation_policy" text DEFAULT 'review_all' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "instance_maintenance_source_request" ON "instance_maintenance_operations" USING btree (("authority"->>'requestId')) WHERE "instance_maintenance_operations"."kind" = 'source_recovery';--> statement-breakpoint
ALTER TABLE "instance_maintenance" ADD CONSTRAINT "instance_maintenance_continuation_policy" CHECK ("instance_maintenance"."continuation_policy" in ('review_all', 'requires_readiness_decision'));
--> statement-breakpoint
-- Saving intent remains allowed while held. Serialize its semantic mutation
-- with a reviewed release, without granting execution or recovery authority.
CREATE FUNCTION public.maintenance_saved_intent_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maintenance_protocol integer;
BEGIN
  SELECT protocol_version INTO maintenance_protocol FROM public.instance_maintenance
    WHERE singleton_key = 'default' FOR SHARE;
  IF NOT FOUND OR maintenance_protocol <> 1 THEN
    RAISE EXCEPTION 'Maintenance authority cannot be verified' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER maintenance_saved_intent_gate BEFORE INSERT OR UPDATE OR DELETE
  ON public.agent_wakeup_requests FOR EACH STATEMENT EXECUTE FUNCTION public.maintenance_saved_intent_gate();
