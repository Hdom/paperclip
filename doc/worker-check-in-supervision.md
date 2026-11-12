# Worker check-in supervision

Opt in a new local or SSH legacy Codex CLI execution with
`runtimeConfig.workerSupervision = {"mode":"check_in"}` and explicit
`adapterConfig.engine = "cli"`, `runner = "legacy"`. Native, sandbox/plugin and other engines are rejected
rather than silently changing their execution contract. Existing runs and agents
without this policy retain their recorded behavior. This does not change models,
permissions, timer wakes or the separately blocked historical predecessor.

The controller snapshots a generation and a 180-second check-in deadline when
execution is admitted. Healthy workers explicitly run
`node "$CODEX_HOME/skills/paperclip/scripts/worker-check-in.mjs"` about every 60 seconds
while making progress. The helper uses the existing signed run-bound JWT credential and
controller generation. It does not create a background heartbeat: process
existence or arbitrary stdout/stderr is not a healthy check-in.

For opted-in executions, adapter elapsed-runtime termination and the Codex
output-inactivity killer are disabled. The platform output-silence watchdog
also defers to the durable check-in owner, so a quiet but checking-in worker is
not stopped by the 15-minute critical-output threshold. There is no total
runtime cap in this mode. Explicit Stop, cancellation, pause, budget and current
execution authority retain their existing owners and behavior.

`POST /api/heartbeat-runs/:runId/check-in` accepts only version 1, the exact
controller generation and the next positive safe-integer sequence. Server time
sets the next deadline. A duplicate sequence returns its original deadline;
stale/out-of-order sequences, client timestamps, foreign runs, changed task
ownership, cancellation and terminal runs are rejected. Static agent keys with a supplied run header cannot check in. Authentication alone
cannot change the generation or enable supervision.

A missed deadline records `suspected_disconnected`, one warning and an audit
entry. It does not kill a process, change run status, release the task or queue
another run. A fresh late check-in may restore health on the same still-admitted
execution. The missed-check-in history remains durable. Restart does not reset
its grace window. The existing deadline coordinator owns the concrete obligation;
there is no new periodic idle scan.

Controller settlement is not a physical stop receipt. If check-ins were missed,
or controller settlement was lost, retries and recovery require existing
canonical local or remote stop proof. Released SSH leases, local SSH-client exit,
PID absence and job-written markers remain insufficient. Stop uncertainty and
workspace/action-outcome recovery remain separate gates even after health resumes.
A check-in never authorizes duplicate execution.

Rollback requires drain, verified execution settlement and the previously
qualified persistent wake fence before downgrading to a release which does not
understand this policy. Keep timer/on-demand wakes disabled until separately
reviewing configuration restoration. Do not use agent/task pause to preserve
saved messages: its asynchronous cleanup cancels unbound requests. Do not drop
the additive liveness columns or rewrite pending source/counter evidence.

Validation scope must name whether it covers the durable service, authenticated
HTTP, adapter timers, platform watchdog, restart/retry barriers, or the exact
packaged local/SSH mock worker. A passing callback is not remote process-tree
termination proof and does not reconcile an older untracked SSH predecessor.
