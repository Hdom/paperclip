# Verified SSH task handoff

Protected legacy Codex runs can request a configured task review through the existing issue API. The API accepts an authenticated workflow request with HTTP 202. It returns the current task and `pendingWorkflowHandoff`. Acceptance does not change the task owner, complete the review, or start the next agent.

The server stores the planned transition, original task claim, material document revisions, exact workspace and SSH lease scope. The original agent must return its files through the normal checked transport. The workflow owner applies the saved transition only after genuine copy-back, canonical remote stop, local owner cleanup and a checked workspace snapshot. The task transition, decision, comment and one saved successor wake commit in one database transaction. The successor must match that receipt and the resulting task revision at admission.

## Authority and failure

The saved intent grants no new execution or filesystem access. Manual Stop, arbitrary reassignment, revoked credentials, changed lease generations, changed material documents and changed workspace identity remain strict. An exact replay must still prove the original live authority. Failed or unproven returns retain a source-bound recovery obligation. Recovery preserves the old proposal for audit; it does not apply it or revive the stopped agent's credentials.

The current handoff path supports bound private, repository-free native task directories. A protected SSH run with another workspace type receives an actionable refusal before the old Stop/reassignment path. Shared and Git-backed project workspace handoffs are not supported by this path. Do not add a global filesystem exception to enable them. A separate design must cover project authority, private physical paths, concurrent writers and Git state.

No new UI configuration is required for this internal ordering rule. Agents use the existing configured workflow and issue API. Operators use the existing task execution/recovery presentation. A workspace refusal is a setup limitation, not permission to switch roots or credentials automatically.

## Upgrade and rollback

Migration 0469 adds a handoff table and indexes. It does not rewrite existing tasks, runs, recovery evidence, signing keys or prior migration receipts. The upgrade test uses the real migrator against the preceding schema and verifies repeat application.

An older binary does not understand pending/held intents or new-format successor wakes. Additive SQL compatibility is insufficient for a binary rollback. Before rollback, pause admission and verify no active publishers/owners, unresolved handoffs or unconsumed workflow successor wakes. Otherwise use a verified matching database restore that preserves all newer output, evidence and signing keys. Never delete obligations to make an older binary start. Keep one verified recovery backup and source evidence.

## Qualification

`scripts/tests/qualify-isolated-ssh.py` runs the assembled production adapter with a deterministic CLI provider, real SSH transport, actual agent-JWT HTTP calls and real returned bytes. Its role and fault matrix includes review approval, changes, human gates, cancellation, stale documents, unsafe links, restart, drain, older writers, database connection loss and unsupported workspace refusal. `--case chain --handoff-pool-max 1` shares one main connection across the changed handoff boundaries; it does not prove whole-application single-pool operation.

The fixture has no default network route. It shares the host filesystem and does not provide strong isolation. Use synthetic credentials only. Deterministic qualification is not live model or project acceptance. Full qualification, exact-commit independent review, upgrade/rollback checks and actual live handoff/copy-back remain separate release gates.
