import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const name = "0469_blue_celestials.sql";
const hash = createHash("sha256").update(await readFile(new URL(`./migrations/${name}`, import.meta.url))).digest("hex");
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("workflow handoff additive upgrade", () => {
  it("preserves existing recovery/claims and permits old-shaped writes without inventing handoffs", async () => {
    const database = await startEmbeddedPostgresTestDatabase("workflow-handoff-upgrade-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      // Reconstruct the immediately preceding schema and journal; use the real
      // migrator rather than executing selected CREATE statements by hand.
      await sql`DROP TABLE issue_workflow_handoffs`;
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      const company = randomUUID(), agent = randomUUID(), issue = randomUUID(), run = randomUUID();
      await sql`INSERT INTO companies (id,name,issue_prefix) VALUES (${company},'Upgrade fixture','WHU')`;
      await sql`INSERT INTO agents (id,company_id,name,role,adapter_type) VALUES (${agent},${company},'Researcher','engineer','codex_local')`;
      await sql`INSERT INTO issues (id,company_id,title,status,assignee_agent_id) VALUES (${issue},${company},'Retained work','blocked',${agent})`;
      await sql`INSERT INTO heartbeat_runs (id,company_id,agent_id,issue_id,runtime_mode,status,result_json)
        VALUES (${run},${company},${agent},${issue},'legacy','failed','{"workspaceRestoreFailure":"restore_failed","evidence":"synthetic-retained-source"}')`;
      await sql`UPDATE issues SET execution_run_id=${run},checkout_run_id=${run} WHERE id=${issue}`;
      const before = await sql`SELECT row_to_json(i) AS task,row_to_json(r) AS run FROM issues i JOIN heartbeat_runs r ON r.id=i.execution_run_id WHERE i.id=${issue}`;
      const receipts = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
      expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "needsMigrations", pendingMigrations: [name] });
      await applyPendingMigrations(database.connectionString);
      expect(await sql`SELECT row_to_json(i) AS task,row_to_json(r) AS run FROM issues i JOIN heartbeat_runs r ON r.id=i.execution_run_id WHERE i.id=${issue}`).toEqual(before);
      expect(await sql`SELECT count(*)::int AS count FROM issue_workflow_handoffs`).toEqual([{ count: 0 }]);
      expect(await sql`SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid='issue_workflow_handoffs'::regclass AND contype='f'`).toEqual([{ count: 6 }]);
      expect((await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`).slice(0,receipts.length)).toEqual(receipts);
      // Additive-schema compatibility only: this is not permission to run an
      // older binary while a new pending/held handoff owns a task.
      await sql`UPDATE issues SET title='Retained work after upgrade' WHERE id=${issue}`;
      expect(await sql`SELECT execution_run_id,checkout_run_id FROM issues WHERE id=${issue}`).toEqual([{execution_run_id:run,checkout_run_id:run}]);
      const upgradedReceipts = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
      await applyPendingMigrations(database.connectionString);
      expect(await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(upgradedReceipts);
      expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
    } finally { await sql.end(); await database.cleanup(); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
