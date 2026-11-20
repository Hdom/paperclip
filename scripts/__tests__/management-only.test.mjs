import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import fs, { readFileSync, writeFileSync, chmodSync, symlinkSync, mkdirSync, copyFileSync, linkSync, realpathSync, renameSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonical, fixture } from "./management-test-fixture.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot=process.env.MANAGEMENT_PACKAGE_DIR;
const ui = packageRoot ? path.join(packageRoot,"ui") : path.join(root, "ui/dist-management");
const {loadManagement}=await import(pathToFileURL(packageRoot ? path.join(packageRoot,"entry.mjs") : path.join(root,"server/dist-management/entry.mjs")));
async function setup(t) {
  const f = fixture(); t.after(() => f.cleanup()); const { server, projectionSha256 } = loadManagement(f.projectionPath, f.authPath, ui);
  await new Promise(ok => server.listen(0, "127.0.0.1", ok)); t.after(() => new Promise(ok => { server.close(ok); server.closeAllConnections(); }));
  const port = server.address().port;
  const get = (url = "/", options = {}) => new Promise((ok, fail) => {
    const headers = options.noAuth ? {} : { Authorization: `Bearer ${options.token ?? f.token()}` };
    const req = request({ host: "127.0.0.1", port, path: url, method: options.method ?? "GET", headers: { ...headers, ...options.headers } }, res => { const data = []; res.on("data", b => data.push(b)); res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(data) })); }); req.on("error", fail); req.end();
  });
  return { ...f, get, port, projectionSha256, server };
}
test("compiled entry serves native management routes and immutable snapshot", async t => {
  const f = await setup(t); assert.equal(f.projectionSha256, f.digest);
  for (const route of ["/", "/TEST/projects", "/TEST/projects/project-a", "/TEST/issues", "/TEST/issues/TEST-1", "/TEST/work", "/TEST/work/run-a"]) assert.equal((await f.get(route)).status, 200);
  const before = await f.get("/api/management/projection"); assert.equal(before.status, 200); assert.equal(before.headers["cache-control"], "no-store"); assert.equal(before.headers["access-control-allow-origin"], undefined);
  f.projection.issues[0].title = "changed on disk"; f.save(); assert.deepEqual((await f.get("/api/management/projection")).body, before.body);
  assert.equal((await f.get("/api/management/projection", { method: "HEAD" })).body.length, 0);
});
test("every page and emitted asset requires human authorization", async t => {
  const f = await setup(t), manifest = JSON.parse(readFileSync(path.join(ui, "management-assets.json")));
  for (const route of ["/", "/api/management/projection", "/TEST/issues", ...manifest.assets.filter(a => a.file !== "management.html").map(a => a.file.startsWith("fonts/") ? `/${a.file}` : `/management-assets/${a.file}`)]) { assert.equal((await f.get(route, { noAuth: true })).status, 401); assert.equal((await f.get(route)).status,200); }
});
test("fail closed for agent, foreign company, subject, issuer, audience and generation", async t => {
  const f = await setup(t);
  for (const change of [{ principalType: "agent" }, { companyId: "company-b" }, { sub: "other-human" }, { iss: "other" }, { aud: "other" }, { projectionSha256: "0".repeat(64) }, { admin: true }]) assert.equal((await f.get("/", { token: f.token(change) })).status, 401);
});
test("strict short-lived signed assertion checks", async t => {
  const f = await setup(t), now = Math.floor(Date.now() / 1000);
  for (const change of [{ iat: now - 120, nbf: now - 120, exp: now - 60 }, { iat: now, nbf: now, exp: now + 61 }, { iat: now + 20, nbf: now + 20, exp: now + 60 }, { iat: "0" }, { exp: Infinity }, { nbf: now - 1 }]) assert.equal((await f.get("/", { token: f.token(change) })).status, 401);
  for (const header of [{ alg: "none" }, { alg: "HS256" }, { jku: "https://untrusted.invalid/key" }]) assert.equal((await f.get("/", { token: f.token({}, header) })).status, 401);
  assert.equal((await f.get("/", { token: f.token({}, {}, generateKeyPairSync("ed25519").privateKey) })).status, 401);
  for (const token of ["", "a.b.c", f.token()+"=", f.token().replace(/.$/, "!")]) assert.equal((await f.get("/", { token })).status, 401);
});
test("no writable, MCP, recovery, retry or generic filesystem routes", async t => {
  const f = await setup(t);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) { assert.equal((await f.get("/api/management/projection", { method, noAuth: true })).status, 401); assert.equal((await f.get("/api/management/projection", { method })).status, 405); }
  for (const url of ["/api/issues", "/api/health", "/mcp", "/api/maintenance", "/TEST/issues/TEST-1/retry", "/TEST/issues?company=b", "/../auth.json", "/%2e%2e/auth.json", "/management-assets/../management-assets.json", "/management.html", "//TEST/issues"]) assert.equal((await f.get(url)).status, 404);
});
test("reject confused hosts, origins and request bodies", async t => {
  const f = await setup(t);
  for (const [headers, status] of [[{ Host: "untrusted.invalid" },400], [{ Origin:"https://untrusted.invalid" },403], [{"Content-Length":"1"},400], [{"Transfer-Encoding":"chunked"},400], [{ Authorization: [`Bearer ${f.token()}`, `Bearer ${f.token()}`]},401]]) assert.equal((await f.get("/", { headers })).status, status);
});
test("projection rejects unapproved bodies, unknown fields and broken relations", () => {
  const f = fixture(); try {
    for (const mutate of [p => p.secrets = [], p => p.issues[0].description = "not allowed", p => p.issues[0].assigneeId = "other", p => p.work[0].issueId = "other", p => p.issues.push(p.issues[0]), p => p.source.capturedAt = "yesterday"]) { const p = structuredClone(f.projection); mutate(p); writeFileSync(f.projectionPath, canonical(p)); assert.throws(() => loadManagement(f.projectionPath, f.authPath, ui)); }
  } finally { f.cleanup(); }
});
test("no anonymous configuration, private signing key or duplicate JSON bypass", () => {
  const f = fixture(); try {
    for (const auth of [{ ...f.auth, humans: [] }, { ...f.auth, publicKeyJwk: { ...f.auth.publicKeyJwk, d: "forbidden" } }, { ...f.auth, humans: [{ subject:"other",companyId:"other" }] }]) { writeFileSync(f.authPath, canonical(auth)); assert.throws(() => loadManagement(f.projectionPath,f.authPath,ui)); }
    f.save(); writeFileSync(f.projectionPath, canonical(f.projection).replace('"schema":', '"schema":"duplicate","schema":')); assert.throws(() => loadManagement(f.projectionPath,f.authPath,ui));
  } finally { f.cleanup(); }
});
test("loader refuses unsafe files, aliases, asset tampering and oversized inputs", () => {
  const f = fixture(); try {
    chmodSync(f.authPath, 0o666); assert.throws(() => loadManagement(f.projectionPath,f.authPath,ui)); chmodSync(f.authPath,0o600);
    symlinkSync(f.authPath,path.join(f.root,"alias")); assert.throws(() => loadManagement(f.projectionPath,path.join(f.root,"alias"),ui));
    const copied = path.join(f.root,"ui"); mkdirSync(copied); const manifest = JSON.parse(readFileSync(path.join(ui,"management-assets.json"))); writeFileSync(path.join(copied,"management-assets.json"),canonical({schema:manifest.schema,assets:[manifest.assets.find(a=>a.file==="management.html")]})); copyFileSync(path.join(ui,"management.html"),path.join(copied,"management.html")); writeFileSync(path.join(copied,"management.html"),"tampered"); assert.throws(()=>loadManagement(f.projectionPath,f.authPath,copied));
    writeFileSync(f.projectionPath,Buffer.alloc(1024*1024+1)); assert.throws(()=>loadManagement(f.projectionPath,f.authPath,ui));
  } finally { f.cleanup(); }
});
test("assembled server contains only management code and node builtins", () => {
  const meta = JSON.parse(readFileSync(packageRoot ? path.join(packageRoot,"server-closure.json") : path.join(root,"server/dist-management/closure.json")));
  assert.equal(Object.keys(meta.inputs).length,4); for(const file of Object.keys(meta.inputs)) assert.match(file,/server\/src\/management\//);
  for(const output of Object.values(meta.outputs))for(const imp of output.imports)assert.match(imp.path,/^node:(http|crypto|fs|path|url)$/);
});
test("fresh style nonce is confined to each HTML response under strict CSP", async t => {
  const f = await setup(t), a=await f.get("/TEST/issues"),b=await f.get("/TEST/issues",{method:"HEAD"});
  const nonce = a.body.toString().match(/name="paperclip-style-nonce" content="([A-Za-z0-9_-]{32})"/)[1];
  assert.ok(a.headers["content-security-policy"].includes(`'nonce-${nonce}'`));assert.notEqual(a.headers["content-security-policy"],b.headers["content-security-policy"]);
  assert.ok(!a.headers["content-security-policy"].includes("unsafe-inline"));assert.ok(a.headers["content-security-policy"].includes("script-src 'self'"));assert.ok(!(await f.get("/api/management/projection")).body.includes(nonce));
});
test("actual listener-address guard refuses a mismatched bind", async t => {
  const f=await setup(t), original=f.server.address;f.server.address=()=>({address:"0.0.0.0",port:f.port,family:"IPv4"});
  try{assert.equal((await f.get("/")).status,503)}finally{f.server.address=original}
});
test("loader refuses writable ancestors and hard-linked input", () => {
  const f=fixture();try{
    const parent=path.join(f.root,"parent"),child=path.join(parent,"child");mkdirSync(parent);mkdirSync(child);copyFileSync(f.projectionPath,path.join(child,"projection.json"));chmodSync(parent,0o775);assert.throws(()=>loadManagement(path.join(child,"projection.json"),f.authPath,ui));chmodSync(parent,0o755);
    linkSync(f.projectionPath,path.join(f.root,"hardlink"));assert.throws(()=>loadManagement(f.projectionPath,f.authPath,ui));
  }finally{f.cleanup()}
});
test("loader detects named-file replacement during an actual FD read", () => {
  const f=fixture(), original=fs.readSync;let replaced=false;
  fs.readSync=function(fd,...args){const n=original(fd,...args);if(!replaced&&realpathSync(`/proc/self/fd/${fd}`)===f.projectionPath){replaced=true;renameSync(f.projectionPath,f.projectionPath+".old");writeFileSync(f.projectionPath,canonical(f.projection),{mode:0o600})}return n};syncBuiltinESMExports();
  try{assert.throws(()=>loadManagement(f.projectionPath,f.authPath,ui));assert.equal(replaced,true)}finally{fs.readSync=original;syncBuiltinESMExports();f.cleanup()}
});
test("noncanonical signed JWT JSON is deliberately refused", async t => {
  const f=await setup(t); const signed=f.token({}, {}, undefined, '{"typ":"JWT","alg":"EdDSA"}');
  const parts=signed.split('.');assert.equal(verify(null,Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:f.auth.publicKeyJwk,format:'jwk'}),Buffer.from(parts[2],'base64url')),true);
  assert.equal((await f.get('/',{token:signed})).status,401);
});
