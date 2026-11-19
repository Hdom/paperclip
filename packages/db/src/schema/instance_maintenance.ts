import { pgTable, text, integer, uuid, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Instance administration, deliberately separate from company/agent lifecycle.
export const instanceMaintenance = pgTable("instance_maintenance", {
  singletonKey: text("singleton_key").primaryKey().default("default"),
  protocolVersion: integer("protocol_version").notNull().default(1),
  generation: integer("generation").notNull().default(0),
  state: text("state").notNull().default("released"),
  ownerId: uuid("owner_id"),
  operatorNote: text("operator_note"),
  actorId: text("actor_id"),
  requestId: uuid("request_id"),
  continuationPolicy: text("continuation_policy").notNull().default("review_all"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [check("instance_maintenance_singleton", sql`${table.singletonKey} = 'default'`),
  check("instance_maintenance_state", sql`${table.state} in ('released', 'acquiring', 'held')`),
  check("instance_maintenance_continuation_policy", sql`${table.continuationPolicy} in ('review_all', 'requires_readiness_decision')`)]);

/** Never expires a physical callback by time/connection loss. A lost owner's
 * unresolved row remains a blocker until positive, source-bound reconciliation. */
export const instanceMaintenanceOperations = pgTable("instance_maintenance_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  generation: integer("generation").notNull(),
  kind: text("kind").notNull(),
  owner: jsonb("owner").$type<Record<string, unknown>>().notNull(),
  authority: jsonb("authority").$type<Record<string, unknown>>(),
  state: text("state").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, table => [index("instance_maintenance_operations_active").on(table.state),
  uniqueIndex("instance_maintenance_source_request").on(sql`(${table.authority}->>'requestId')`).where(sql`${table.kind} = 'source_recovery'`),
  check("instance_maintenance_operation_state", sql`${table.state} in ('active', 'settled')`)]);

export const instanceMaintenanceEvents = pgTable("instance_maintenance_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  generation: integer("generation").notNull(),
  action: text("action").notNull(),
  actorId: text("actor_id").notNull(),
  requestId: uuid("request_id").notNull().unique(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
