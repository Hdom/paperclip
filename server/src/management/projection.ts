export type Projection = {
  schema: "paperclip.management.v1";
  source: { instanceId: string; capturedAt: string; projectionId: string };
  company: { id: string; name: string; issuePrefix: string };
  projects: { id: string; name: string; status: string }[];
  issues: { id: string; identifier: string; title: string; status: string; projectId: string | null; assigneeId: string | null }[];
  agents: { id: string; name: string; status: string }[];
  work: { id: string; issueId: string; agentId: string; status: string; recoveryStatus: string }[];
};
export function need(value: unknown): asserts value {
  if (!value) throw new Error("management_input_refused");
}
export function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  need(value && typeof value === "object" && !Array.isArray(value));
  need(Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}
export function text(value: unknown, max = 240): asserts value is string {
  need(typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value));
}
export function identifier(value: unknown): asserts value is string {
  text(value, 80); need(/^[a-zA-Z0-9_-]+$/.test(value));
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  const result = JSON.stringify(value); need(result !== undefined); return result;
}
export function strictJson(raw: Uint8Array, bound: number): unknown {
  need(raw.byteLength > 0 && raw.byteLength <= bound);
  const input = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const value: unknown = JSON.parse(input); need(canonical(value) === input); return value;
}
export function parseProjection(raw: Uint8Array): Projection {
  const p = strictJson(raw, 1024 * 1024);
  object(p, ["schema", "source", "company", "projects", "issues", "agents", "work"]);
  need(p.schema === "paperclip.management.v1");
  object(p.source, ["instanceId", "capturedAt", "projectionId"]);
  identifier(p.source.instanceId); identifier(p.source.projectionId); text(p.source.capturedAt, 32);
  need(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.source.capturedAt) && new Date(p.source.capturedAt).toISOString() === p.source.capturedAt);
  object(p.company, ["id", "name", "issuePrefix"]); identifier(p.company.id); text(p.company.name); text(p.company.issuePrefix, 12); need(/^[A-Z][A-Z0-9]{0,11}$/.test(p.company.issuePrefix));
  const defs = {
    projects: { keys: ["id", "name", "status"], max: 200, statuses: ["backlog", "planned", "in_progress", "active", "paused", "completed", "cancelled"] },
    issues: { keys: ["id", "identifier", "title", "status", "projectId", "assigneeId"], max: 2000, statuses: ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"] },
    agents: { keys: ["id", "name", "status"], max: 200, statuses: ["active", "idle", "running", "paused", "pausing", "error", "terminated", "pending_approval", "offline"] },
    work: { keys: ["id", "issueId", "agentId", "status", "recoveryStatus"], max: 2000, statuses: ["queued", "running", "succeeded", "failed", "cancelled", "timed_out", "scheduled_retry", "stopped"] },
  };
  const ids: Record<string, Set<string>> = {};
  for (const [kind, def] of Object.entries(defs)) {
    const rows = p[kind]; need(Array.isArray(rows) && rows.length <= def.max); const seen = new Set<string>();
    for (const row of rows) {
      object(row, def.keys); identifier(row.id); need(!seen.has(row.id)); seen.add(row.id);
      text(row.status, 32); need(def.statuses.includes(row.status));
      if (kind === "projects" || kind === "agents") text(row.name);
      if (kind === "issues") {
        text(row.title); text(row.identifier, 32); need(new RegExp(`^${p.company.issuePrefix}-[1-9][0-9]*$`).test(row.identifier));
        if (row.projectId !== null) identifier(row.projectId);
        if (row.assigneeId !== null) identifier(row.assigneeId);
      }
      if (kind === "work") { identifier(row.issueId); identifier(row.agentId); need(["none", "pending", "held", "completed"].includes(row.recoveryStatus as string)); }
    }
    ids[kind] = seen;
  }
  const result = p as unknown as Projection;
  need(new Set(result.issues.map(i => i.identifier)).size === result.issues.length);
  for (const issue of result.issues) need((issue.projectId === null || ids.projects.has(issue.projectId)) && (issue.assigneeId === null || ids.agents.has(issue.assigneeId)));
  for (const work of result.work) need(ids.issues.has(work.issueId) && ids.agents.has(work.agentId));
  return result;
}
