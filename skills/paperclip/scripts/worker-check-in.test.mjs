import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
const runId = "b1e9803c-c8a5-4a81-9937-18b8846a5fc7";
const generation = "ae034153-49ef-43a4-b477-6b8f75f7bbc7";
async function execute(url, extra = {}) {
  const child = spawn(process.execPath, [new URL("./worker-check-in.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, PAPERCLIP_API_URL: url, PAPERCLIP_API_KEY: "synthetic-private-test-token",
      PAPERCLIP_RUN_ID: runId, PAPERCLIP_WORKER_CHECK_IN_GENERATION: generation, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", x => output += x); child.stderr.on("data", x => output += x);
  const [code] = await once(child, "exit"); assert.ok(!output.includes("synthetic-private-test-token")); return { code, output };
}
for (const kind of ["accepted", "foreign_generation", "terminal", "redirect", "denied", "ambiguous"]) {
  test(`explicit helper ${kind}: no credential output, redirect, background retries or extra requests`, async () => {
    const calls = [];
    const server = http.createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      calls.push({ method: req.method, path: req.url, body, auth: req.headers.authorization });
      if (req.method === "GET") {
        if (kind === "redirect") { res.writeHead(302, { location: "/elsewhere" }); res.end(); return; }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: kind === "terminal" ? "succeeded" : "running",
          workerSupervision: { generation: kind === "foreign_generation" ? runId : generation, sequence: 7 } })); return;
      }
      if (kind === "ambiguous") { req.socket.destroy(); return; }
      res.writeHead(kind === "denied" ? 403 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true, sequence: 8, deadlineAt: "2026-11-12T02:00:00Z", state: "healthy" }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const result = await execute(`http://127.0.0.1:${server.address().port}`);
      assert.equal(result.code, kind === "accepted" ? 0 : 1);
      assert.equal(calls.length, ["foreign_generation", "terminal", "redirect"].includes(kind) ? 1 : 2);
      assert.ok(calls.every(x => x.auth === "Bearer synthetic-private-test-token"));
      if (calls.length === 2) assert.deepEqual(JSON.parse(calls[1].body), { version: 1, generation, sequence: 8 });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
}
test("missing controller generation fails before any request", async () => {
  const result = await execute("http://127.0.0.1:1", { PAPERCLIP_WORKER_CHECK_IN_GENERATION: "" });
  assert.equal(result.code, 1); assert.match(result.output, /credentials and generation/);
});
