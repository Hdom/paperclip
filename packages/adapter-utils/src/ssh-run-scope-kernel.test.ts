import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SSH_RUN_SUPERVISOR_SOURCE } from "./ssh-run-scope.js";

it.skipIf(process.platform!=="linux"||process.arch!=="x64")("qualifies raw clone adoption and supervisor-crash refusal with real kernel processes",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"ssh-scope-independent-"));
  await writeFile(path.join(root,"ssh-run-supervisor.py"),SSH_RUN_SUPERVISOR_SOURCE,{mode:0o600});
  await writeFile(path.join(root,"kernel-review.py"),await readFile(new URL("./__fixtures__/ssh-run-scope-kernel.py",import.meta.url)),{mode:0o600});
  // Preserve any failed fixture for explicit diagnosis; never erase uncertain
  // process ownership merely because a test timed out.
  const result=await promisify(execFile)("python3",[path.join(root,"kernel-review.py")],{timeout:45000,maxBuffer:1024*1024});
  const rows=result.stdout.trim().split("\n").map(line=>JSON.parse(line));
  expect(rows).toHaveLength(5);expect(rows.every(row=>row.passed===true)).toBe(true);
  expect(rows.at(-1)).toMatchObject({case:"supervisor_crash",noStopProof:true,noReopen:true});
  // CLONE_PARENT inherits SIGCHLD on this kernel. The separate pre-exec clone
  // case proves the genuinely zero-exit-signal wait path.
  await rm(root,{recursive:true});
},60000);
