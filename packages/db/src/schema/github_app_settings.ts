import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Provider configuration only. Private values stay in native encrypted secret versions. */
export const githubAppSettings = pgTable("github_app_settings", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
  revision: integer("revision").notNull().default(0),
  verification: jsonb("verification").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("github_app_settings_company_check", sql`${table.settings}->>'companyId' = ${table.companyId}::text`),
  check("github_app_settings_revision_check", sql`${table.revision} >= 0`),
  check("github_app_settings_native_refs_check", sql`
    ${table.settings} #> '{apps,coordinator,signingKeySecret}' IS NOT NULL AND
    ${table.settings} #> '{apps,implementer,signingKeySecret}' IS NOT NULL AND
    ${table.settings} #> '{apps,reviewer,signingKeySecret}' IS NOT NULL AND
    ${table.settings} #> '{apps,coordinator,privateKeyPath}' IS NULL AND
    ${table.settings} #> '{apps,implementer,privateKeyPath}' IS NULL AND
    ${table.settings} #> '{apps,reviewer,privateKeyPath}' IS NULL`),
]);
