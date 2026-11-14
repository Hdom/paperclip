import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, ensurePostgresDatabase, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

// This fixture never accepts a connection URL or an external/admin database.
if (process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL?.trim()) {
  throw new Error("Worker upgrade compatibility requires its own disposable embedded PostgreSQL cluster");
}
const support = await getEmbeddedPostgresTestSupport();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const HISTORICAL_PREFIX_HASH = "d35f35abf35f368f2eed8ab2813010e1ecf8d6494cc9f8f9555a0dd30e0a2328";
const HISTORICAL_WORKER_HASH = "2d3a8df60c6188a07c2d08cfc258e6b9bd2d0e53fae7c5160e0742ccb4d3ab10";
const HISTORICAL_WORKER_WHEN = 1794447429865;
// Exact bytes of ee36e054:0375_dapper_the_professor.sql, including no trailing newline.
const HISTORICAL_WORKER_SQL = 'ALTER TABLE "heartbeat_runs" ADD COLUMN "worker_supervision" jsonb;--> statement-breakpoint\n'
  + 'ALTER TABLE "heartbeat_runs" ADD COLUMN "worker_check_in_deadline_at" timestamp with time zone;--> statement-breakpoint\n'
  + 'CREATE INDEX "heartbeat_runs_worker_check_in_deadline_idx" ON "heartbeat_runs" USING btree ("worker_check_in_deadline_at") WHERE "heartbeat_runs"."worker_check_in_deadline_at" IS NOT NULL;';
type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Loaded = { entry: Entry; content: string; hash: string };
const sqlFile = (tag: string) => new URL(`./migrations/${tag}.sql`, import.meta.url);
type Sql = ReturnType<typeof postgres>;

async function history(sql: Sql) {
  return Array.from(await sql`SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
}

async function shape(sql: Sql) {
  // Physical column order differs when worker columns existed before canonical 0375..0464.
  const columns = await sql`SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`;
  const indexes = await sql`SELECT t.relname AS table_name, c.relname AS index_name,
    pg_get_indexdef(c.oid) AS definition, i.indisvalid, i.indisready
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public'
    ORDER BY t.relname, c.relname`;
  const constraints = await sql`SELECT t.relname AS table_name, c.conname,
    pg_get_constraintdef(c.oid, true) AS definition FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' ORDER BY t.relname, c.conname`;
  return { columns: Array.from(columns), indexes: Array.from(indexes), constraints: Array.from(constraints) };
}

async function replay(sql: Sql, files: Loaded[]) {
  await sql`CREATE SCHEMA drizzle`;
  await sql`CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
  let createdAt = 0;
  for (const { entry, content, hash } of files) {
    createdAt = Math.max(createdAt + 1, entry.when);
    const apply = async (executor: Pick<Sql, "unsafe">) => {
      for (const statement of content.split("--> statement-breakpoint")) {
        if (statement.trim()) await executor.unsafe(statement.replace(
          /^(\s*ALTER TABLE "[^"]+" DROP CONSTRAINT) (?!IF EXISTS\b)/i, "$1 IF EXISTS "));
      }
      await executor.unsafe("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [hash, createdAt]);
    };
    if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(content) || /^\s*COMMIT\s*;/im.test(content)) await apply(sql);
    else await sql.begin(async tx => { await apply(tx); });
  }
}

async function seed(sql: Sql, worker: boolean) {
  const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Worker upgrade retained', 'WUP') RETURNING id`;
  const [agent] = await sql`INSERT INTO agents (company_id, name, adapter_type)
    VALUES (${company.id}, 'Synthetic retained worker', 'codex_local') RETURNING id`;
  const [issue] = await sql`INSERT INTO issues (company_id, title, status, assignee_agent_id)
    VALUES (${company.id}, 'Retained upgrade task', 'in_progress', ${agent.id}) RETURNING id`;
  const [run] = await sql`INSERT INTO heartbeat_runs (company_id, agent_id, invocation_source, trigger_detail, status, runtime_mode, context_snapshot)
    VALUES (${company.id}, ${agent.id}, 'assignment', 'system', 'succeeded', 'legacy',
      '{"upgradeFixture":"retained","checkpointContinuationAttempts":2}'::jsonb) RETURNING id`;
  if (worker) await sql`UPDATE heartbeat_runs SET worker_supervision = '{"version":1,"fixture":"retained"}'::jsonb,
    worker_check_in_deadline_at = '2026-11-11T00:00:00Z' WHERE id = ${run.id}`;
  return async () => {
    const [c] = await sql`SELECT to_jsonb(c) AS row FROM companies c WHERE id = ${company.id}`;
    const [a] = await sql`SELECT to_jsonb(a) AS row FROM agents a WHERE id = ${agent.id}`;
    const [i] = await sql`SELECT to_jsonb(i) AS row FROM issues i WHERE id = ${issue.id}`;
    const [r] = await sql`SELECT to_jsonb(r) AS row FROM heartbeat_runs r WHERE id = ${run.id}`;
    return { company: c.row, agent: a.row, issue: i.row, run: r.row } as Record<string, Record<string, unknown>>;
  };
}

describe.skipIf(!support.supported)("worker supervision retained-history upgrade", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let reference: Sql;
  let loaded: Loaded[];
  let referenceShape: Awaited<ReturnType<typeof shape>>;
  beforeAll(async () => {
    const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Entry[] };
    loaded = await Promise.all(journal.entries.map(async entry => {
      const content = await readFile(sqlFile(entry.tag), "utf8");
      return { entry, content, hash: sha(content) };
    }));
    const prefix = loaded.filter(({ entry }) => entry.idx < 375);
    expect(prefix).toHaveLength(373);
    expect(sha(JSON.stringify(prefix.map(({ entry: e, hash }) => [e.idx, e.version, e.when, e.tag, e.breakpoints, hash]))))
      .toBe(HISTORICAL_PREFIX_HASH);
    expect(sha(HISTORICAL_WORKER_SQL)).toBe(HISTORICAL_WORKER_HASH);
    expect(loaded.find(({ entry }) => entry.idx === 465)).toMatchObject({
      entry: { tag: "0465_gifted_banshee" }, content: HISTORICAL_WORKER_SQL, hash: HISTORICAL_WORKER_HASH,
    });
    expect(Math.max(...loaded.filter(({ entry }) => entry.idx <= 464).map(({ entry }) => entry.when)))
      .toBeLessThan(HISTORICAL_WORKER_WHEN);
    database = await startEmbeddedPostgresTestDatabase("paperclip-worker-upgrade-");
    reference = postgres(database.connectionString, { max: 1, onnotice() {} });
    referenceShape = await shape(reference);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await reference?.end(); await database?.cleanup(); }, 30_000);

  it.each(["fresh", "canonical0464", "oldprecustom", "oldcustom0375"] as const)(
    "upgrades %s with exact retained receipts, data and catalog definitions", async baseline => {
      const admin = new URL(database.connectionString);
      admin.pathname = "/postgres";
      const name = `worker_upgrade_${baseline.toLowerCase()}`;
      await ensurePostgresDatabase(admin.toString(), name);
      admin.pathname = `/${name}`;
      const connectionString = admin.toString();
      const sql = postgres(connectionString, { max: 1, onnotice() {} });
      try {
        if (baseline !== "fresh") {
          const cutoff = baseline === "canonical0464" ? 464 : 374;
          const files = loaded.filter(({ entry }) => entry.idx <= cutoff);
          if (baseline === "oldcustom0375") files.push({
            entry: { idx: 375, version: "7", when: HISTORICAL_WORKER_WHEN,
              tag: "0375_dapper_the_professor", breakpoints: true },
            content: HISTORICAL_WORKER_SQL, hash: HISTORICAL_WORKER_HASH,
          });
          await replay(sql, files);
        }
        const beforeHistory = baseline === "fresh" ? [] : await history(sql);
        const retained = baseline === "fresh" ? undefined : await seed(sql, baseline === "oldcustom0375");
        const beforeRows = await retained?.();
        const state = await inspectMigrations(connectionString);
        expect(state.status).toBe("needsMigrations");
        if (state.status !== "needsMigrations") throw new Error("Expected fixture migrations to remain pending");
        const expectedPending = loaded.filter(({ entry, hash }) =>
          baseline === "fresh" || (entry.idx > (baseline === "canonical0464" ? 464 : 374)
            && !(baseline === "oldcustom0375" && hash === HISTORICAL_WORKER_HASH)))
          .map(({ entry }) => `${entry.tag}.sql`);
        expect(state.pendingMigrations).toEqual(expectedPending);
        if (baseline === "oldcustom0375") {
          expect(beforeHistory.at(-1)).toMatchObject({ hash: HISTORICAL_WORKER_HASH, created_at: String(HISTORICAL_WORKER_WHEN) });
          expect(expectedPending).toContain("0375_short_mercury.sql");
          expect(expectedPending).toContain("0464_project_environment.sql");
          expect(expectedPending).not.toContain("0465_gifted_banshee.sql");
        }
        await applyPendingMigrations(connectionString);
        expect((await inspectMigrations(connectionString)).status).toBe("upToDate");
        const afterHistory = await history(sql);
        expect(afterHistory.slice(0, beforeHistory.length)).toEqual(beforeHistory);
        expect(afterHistory).toHaveLength(loaded.length);
        for (const { hash } of loaded) expect(afterHistory.filter(row => row.hash === hash)).toHaveLength(1);
        if (beforeRows && retained) {
          const after = await retained();
          for (const [table, row] of Object.entries(beforeRows)) {
            expect(Object.fromEntries(Object.keys(row).map(key => [key, after[table][key]]))).toEqual(row);
          }
          expect(after.run.worker_supervision).toEqual(baseline === "oldcustom0375" ? { version: 1, fixture: "retained" } : null);
          expect(after.run.worker_check_in_deadline_at === null ? null : new Date(String(after.run.worker_check_in_deadline_at)).toISOString())
            .toBe(baseline === "oldcustom0375" ? "2026-11-11T00:00:00.000Z" : null);
        }
        const finalShape = await shape(sql);
        expect(finalShape).toEqual(referenceShape);
        expect(finalShape.indexes.find(index => index.index_name === "heartbeat_runs_worker_check_in_deadline_idx"))
          .toMatchObject({ indisvalid: true, indisready: true });
        const afterRows = await retained?.();
        await applyPendingMigrations(connectionString);
        expect((await inspectMigrations(connectionString)).status).toBe("upToDate");
        expect(await history(sql)).toEqual(afterHistory);
        expect(await shape(sql)).toEqual(finalShape);
        expect(await retained?.()).toEqual(afterRows);
      } finally { await sql.end(); }
    }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
