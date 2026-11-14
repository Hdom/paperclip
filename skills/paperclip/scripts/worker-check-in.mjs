#!/usr/bin/env node
// An explicit worker action, never an independent background heartbeat loop.
const { PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID, PAPERCLIP_WORKER_CHECK_IN_GENERATION } = process.env;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
try {
  if (!PAPERCLIP_API_URL || !PAPERCLIP_API_KEY || !uuid.test(PAPERCLIP_RUN_ID ?? "")
    || !uuid.test(PAPERCLIP_WORKER_CHECK_IN_GENERATION ?? "")) throw Error("Current worker check-in credentials and generation are required");
  const base = new URL(PAPERCLIP_API_URL);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw Error("Invalid worker API URL");
  const path = `${base.href.replace(/\/+$/, "")}/api/heartbeat-runs/${PAPERCLIP_RUN_ID}`;
  const headers = { authorization: `Bearer ${PAPERCLIP_API_KEY}`, "x-paperclip-run-id": PAPERCLIP_RUN_ID, "content-type": "application/json" };
  const current = await fetch(path, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!current.ok) throw Error(`Worker state lookup failed: HTTP ${current.status}`);
  const run = await current.json(), state = run.workerSupervision;
  if (run.status !== "running" || state?.generation !== PAPERCLIP_WORKER_CHECK_IN_GENERATION
    || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || state.sequence >= Number.MAX_SAFE_INTEGER)
    throw Error("Worker execution or generation is no longer current");
  const response = await fetch(path + "/check-in", { method: "POST", headers, redirect: "error",
    body: JSON.stringify({ version: 1, generation: state.generation, sequence: state.sequence + 1 }),
    signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw Error(`Worker check-in refused: HTTP ${response.status}`);
  const receipt = await response.json();
  console.log(JSON.stringify({ accepted: receipt.accepted, sequence: receipt.sequence, deadlineAt: receipt.deadlineAt, state: receipt.state }));
} catch (error) { console.error(error instanceof Error ? error.message : "Worker check-in failed"); process.exitCode = 1; }
