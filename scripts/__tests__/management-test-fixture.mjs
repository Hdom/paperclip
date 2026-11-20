import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const fixtureBase = path.dirname(fileURLToPath(import.meta.url));
export function canonical(v) { return Array.isArray(v) ? `[${v.map(canonical)}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`)}}` : JSON.stringify(v); }
export function fixture({ issueCount = 2 } = {}) {
  const root = mkdtempSync(path.join(fixtureBase, ".management-test-")); chmodSync(root, 0o700);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const projection = { schema: "paperclip.management.v1", source: { instanceId: "test-instance", capturedAt: "2026-11-20T00:00:00.000Z", projectionId: "test-generation" }, company: { id: "company-a", name: "Test company", issuePrefix: "TEST" }, projects: [{ id: "project-a", name: "Connector project", status: "paused" }], issues: [{ id: "issue-a", identifier: "TEST-1", title: "Retained research <img src=x onerror=alert(1)>", status: "in_review", projectId: "project-a", assigneeId: "researcher" }, { id: "issue-b", identifier: "TEST-2", title: "Coordinate implementation", status: "blocked", projectId: "project-a", assigneeId: "coordinator" }], agents: [{ id: "researcher", name: "Researcher", status: "idle" }, { id: "coordinator", name: "Coordinator", status: "paused" }], work: [{ id: "run-a", issueId: "issue-a", agentId: "researcher", status: "stopped", recoveryStatus: "held" }] };
  const auth = { schema: "paperclip.management-auth.v1", issuer: "test-human-gateway", audience: "test-management", publicKeyJwk: publicKey.export({ format: "jwk" }), humans: [{ subject: "test-human", companyId: "company-a" }] };
  for(let i=3;i<=issueCount;i++)projection.issues.push({id:`issue-extra-${i}`,identifier:`TEST-${i}`,title:`Additional task ${i}`,status:"todo",projectId:"project-a",assigneeId:"coordinator"});
  const projectionPath = path.join(root, "projection.json"), authPath = path.join(root, "auth.json");
  const save = () => { writeFileSync(projectionPath, canonical(projection), { mode: 0o600 }); writeFileSync(authPath, canonical(auth), { mode: 0o600 }); };
  save(); const digest = createHash("sha256").update(canonical(projection)).digest("hex");
  function token(change = {}, headerChange = {}, key = privateKey, encodedHeader) {
    const now = Math.floor(Date.now() / 1000), header = { alg: "EdDSA", typ: "JWT", ...headerChange };
    const claims = { iss: auth.issuer, aud: auth.audience, sub: "test-human", principalType: "human", companyId: "company-a", projectionSha256: digest, iat: now, nbf: now, exp: now + 60, ...change };
    const input = `${Buffer.from(encodedHeader ?? canonical(header)).toString("base64url")}.${Buffer.from(canonical(claims)).toString("base64url")}`;
    return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
  }
  return { root, projection, auth, projectionPath, authPath, digest, save, token, cleanup() { if (!root.startsWith(path.join(fixtureBase, ".management-test-"))) throw Error("fixture cleanup refused"); rmSync(root, { recursive: true, force: true }); } };
}
