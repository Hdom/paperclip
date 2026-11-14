import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { documentService } from "../services/documents.js";
import { readPlanRevisionForDecision } from "../services/issue-stage-decision-guard.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("stage decision/document serialization", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("stage-decision-lock-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => { await temporary?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Fixture", issuePrefix: `G${companyId.slice(0,6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Plan approval", status: "in_review" });
    return { companyId, issueId };
  }
  it.each(["create", "update", "restore", "delete"])("serializes plan %s against approval, including absent-plan creation", async (operation) => {
    const { companyId, issueId } = await fixture();
    const docs = documentService(db);
    const first = operation === "create" ? null : await docs.upsertIssueDocument({ issueId, key: "plan", format: "markdown", body: "rev1" });
    const second = operation === "restore" ? await docs.upsertIssueDocument({ issueId, key: "plan", format: "markdown", body: "rev2", baseRevisionId: first!.document.latestRevisionId }) : first;
    let writer: Promise<unknown> | undefined;
    let finished = false;
    await db.transaction(async tx => {
      await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} for update`);
      const revision = await readPlanRevisionForDecision(tx as unknown as typeof db, companyId, issueId);
      expect(revision).toBe(second?.document.latestRevisionId ?? null);
      writer = (operation === "delete" ? docs.deleteIssueDocument(issueId, "plan")
        : operation === "restore" ? docs.restoreIssueDocumentRevision({ issueId, key: "plan", revisionId: first!.document.latestRevisionId! })
        : docs.upsertIssueDocument({ issueId, key: "plan", format: "markdown", body: "new", baseRevisionId: first?.document.latestRevisionId ?? null }))
        .then(value => { finished = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(finished).toBe(false);
      expect(await readPlanRevisionForDecision(tx as unknown as typeof db, companyId, issueId)).toBe(revision);
    });
    await writer;
    expect(finished).toBe(true);
    const after = await readPlanRevisionForDecision(db, companyId, issueId);
    if (operation === "delete") expect(after).toBeNull();
    else expect(after).not.toBe(second?.document.latestRevisionId ?? null);
  });
  it("keeps existing non-plan document mutations responsive on the locked issue", async () => {
    const { issueId } = await fixture();
    const docs = documentService(db);
    const first = await docs.upsertIssueDocument({ issueId, key: "notes", format: "markdown", body: "notes v1" });
    // Pre-create the link: a new document's FK key-share lock is inherently
    // incompatible with FOR UPDATE, independent of our plan-specific lock.
    await db.transaction(async tx => {
      await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} for update`);
      const edited = await docs.upsertIssueDocument({ issueId, key: "notes", format: "markdown", body: "notes v2", baseRevisionId: first.document.latestRevisionId });
      expect(edited.document.latestRevisionId).not.toBe(first.document.latestRevisionId);
      const restored = await docs.restoreIssueDocumentRevision({ issueId, key: "notes", revisionId: first.document.latestRevisionId! });
      expect(restored.document.body).toBe("notes v1");
      const deleted = await docs.deleteIssueDocument(issueId, "notes");
      expect(deleted?.key).toBe("notes");
    });
  });
  it("keeps another issue's document writes responsive", async () => {
    const a = await fixture(), b = await fixture();
    await db.transaction(async tx => {
      await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${a.issueId} for update`);
      const other = await documentService(db).upsertIssueDocument({ issueId: b.issueId, key: "plan", format: "markdown", body: "independent" });
      expect(other.document.latestRevisionId).toBeTruthy();
    });
  });
});
