# Persistent instance maintenance

This is instance administration, separate from company pause and agent Stop.
General settings owns the controls; task pages show a generic hold notice.
Starting maintenance preserves company settings and saved wake identities.
It does not cancel agents, replay work, expire automatically or grant recovery.

## Authority and persistence

Only an existing instance administrator may start, review or release maintenance.
An administrator recovering a source must also pass the existing issue mutation
authorization. Company board members and agents cannot change maintenance.
Private operator notes and the cross-company saved-work inventory are excluded
from task and non-administrator projections, including cached account changes.

The singleton is authoritative. Missing state, an unknown protocol or an unknown
continuation policy fails closed. Each acquisition increments its generation and
has a fresh owner. Admission/claim mutations share-lock that row in their own
transaction. Acquisition and release exclusively lock it. A statement-level wake
trigger serializes intent insertion, updates and deletion with reviewed release;
it allows preserving intent while closed, never grants execution.

`acquiring` lets exact already-admitted work settle. `held` requires no unresolved
durable callbacks, physical execution/cleanup obligations, workspace operations
or native finalization owners. A terminal run label, elapsed lease or disconnected
socket is not physical-stop evidence. Durable operation rows have no timeout
that fabricates settlement. Lost owners require positive evidence and governed
reconciliation; this feature deliberately provides no Force settled button.

Provider execution, provisioning and upload remain live-run strict. Bounded
original-source copy-back and verified cleanup may settle the original admitted
ownership after its status becomes terminal. Existing cancellation, path,
workspace and lease guards remain decisive. Source recovery never inherits
generic provider execution, upload, resume, duplex or destructive authority.

Long-lived provider channels have their own durable operation. Input is copied,
bounded, ordered and revalidated against the original lease/provider/endpoint
and execution owner. First refusal closes further input; Stop remains available.
Numeric physical exit plus joined route closure settles the obligation. Unknown
transport/open/close outcomes retain it and return an explicit uncertainty.
Valid expiry renewal does not replace execution authority; expiry must still be
future. Opaque provider metadata remains pinned rather than guessing which new
fields are harmless.

## Exact-source recovery and request receipts

An administrator reviews one persisted SSH source: company, issue, source run,
action, original lease, lease generation, descriptor fingerprint and maintenance
owner/generation. Existing stopped-scope export verifies paths and physical stop,
preserves an archive and canonically recovers that source. Completion rechecks
the capability inside its final hold-release transaction. Revocation preserves
saved bytes and cannot be mistaken for successful finalization.

Recovery does not release admission or saved successor/parent wakes. One source
run has one physical recovery intent per maintenance epoch, including after a
browser reload or a fresh request UUID. The operator UI retains the exact request
identity and reads its receipt after an uncertain response. A `settled` receipt
means the original callback joined; it is not evidence of successful copy-back
or permission to continue a task. Inspect canonical source evidence separately.
Rearming a failed request is a separate reviewed recovery decision, not an
automatic retry hidden behind a new UUID.

The current recovery HTTP operation is synchronous. Closing its browser does
not authorize cancellation, replay or a second operation. Its durable receipt
and source evidence survive uncertainty. Only dedicated SSH source preservation
is supported under the held recovery capability; sandbox recovery needs its own
separate authority design.

## Reviewed release

Generic release acknowledges the current saved-intent inventory and its task and
source bindings. It is not a readiness certificate for every future workflow.
The backend compares a semantic fingerprint under the exclusive gate. Locked
domain rows abort the review with NOWAIT; they are never skipped. Ordinary
permission, dependency, approval, workspace and physical-stop gates still apply.
The UI refuses release when its bounded saved-work view is incomplete.

`requires_readiness_decision` is an additional persisted restriction for an
incident with a known unsupported continuation. It remains unconditional even
with zero wakes or a matching review fingerprint. Normal release cannot clear
it. It is intended for the separately reviewed offline bootstrap of the current
connector incident, whose project/Git preparation remains outside this feature.
No current production policy has been changed by this local implementation.

## Separately approved operational cutover

Local implementation, test fixtures and a runtime capability marker do not
install a service interlock. An old binary does not read this new singleton.
Activation needs a separate concrete approval and the following verified steps:

1. Recheck the exact deployed source, active work, service restart policy, saved
   source/hold and both original wake identities. Record their semantic digests.
   Preserve original bytes and one independently verified usable recovery backup.
   Do not retire, cancel or recreate either wake for maintenance convenience.
2. With explicit operational approval, contain the actual service using its
   supported stop and persistent mask. Verify no pending service job, process,
   listener or automatic restart can start the unaware runtime. This is host
   containment, not a company pause that mutates lifecycle/wake obligations.
3. Prepare a verified aware release and qualify its database upgrade on an
   isolated copy. Apply additive migrations while service containment remains.
   Initialize the singleton offline with the reviewed owner/note/generation and
   restrictive readiness policy; require current source/wake digests and genuine
   quiescence. An offline initializer is an operational prerequisite, not
   authorization to run ad hoc SQL or synthesize evidence.
4. Install a protected, version-independent prestart guard outside the selected
   version directory. It must verify actual selected release provenance and
   `dist/runtime-capabilities.json` against the database before starting it.
   The local compatibility validator rejects missing/older/mismatched candidates;
   it does not constitute this installed guard. Keep the service masked until the
   initializer, guard, packaging and rollback procedure have independent review.
5. Start only the aware binary through that guard. Verify closed admission and
   recovery, unchanged source/wake payloads, zero unwanted dispatch and correct
   administrator/non-administrator UI before considering any recovery action.
   Retain the restrictive readiness decision after source recovery.
6. A rollback to an unaware binary against this fenced database must fail stopped.
   Do not unmask it, clear the row or restore an old database merely to make it
   start. An aware rollback, or an independently approved complete offline data
   restore with its source/wake implications reviewed, is a separate decision.

No stop, mask, migration, policy initialization, startup, recovery or wake release
is performed by these instructions. Publication and operational cutover require
their own approvals. Project/Git preparation is a distinct scope decision.

## Qualification and its limits

The source includes real PostgreSQL races and persistence tests, actual isolated
server startup/restart plus later owner notification, generated-key SSH source
preservation with archive/byte checks, actual Codex adapter and agent-JWT workflow
regressions, and real React/CSS browser checks at desktop and phone widths.
Startup notifications exercised by that fixture are same-process production-owner
delivery, not the optional cross-process PostgreSQL bridge. Generated fixtures
share the host filesystem; network namespaces are not strong process isolation.
Component browser tests use synthetic HTTP/router context and do not claim full
application or production acceptance. Existing qualification coverage is retained.
