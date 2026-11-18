# Persistent maintenance: prepared cutover and rollback

This is a preparation plan, not permission to execute it. No production service,
database, source workspace, wake, signing key, or installation has been changed
by these tools' qualification. Publication and live cutover need separate approval.

## Ownership and release contract

The application owns persisted maintenance state, transaction locks, exact-source
recovery and the existing Settings → General maintenance UI. The shared
`maintenance-state-core.ts` is the same canonical read/start/readiness implementation
used by the live service and offline initializer. It does not load providers or
the application server. Live callers additionally count their real adapter map;
the offline caller must independently prove physical service containment.

The root-protected host guard is deliberately outside the application's editable
settings. It protects against launching an old binary that cannot honor the UI's
saved maintenance state. An API setting cannot safely replace this boundary.
Neither the guard nor initializer resolves signing secrets. Native secret rows
are inventoried as hashes inside PostgreSQL, without exporting encrypted material.

`build-maintenance-runtime.mjs` packages the narrow DB client, canonical state
core, every SQL migration, reviewed Node binary and host launcher independently
of any selected application. Non-builtin external package imports are refused.
Release builds require a clean exact commit. `--qualification` outputs are visibly
marked and the production launcher refuses them. Retain the operator bundle and
external manifest outside managed install pruning, under root-owned storage.

The application must be a standalone physical release capsule containing its
complete dependencies and reviewed Node at `operator-node`. Preserve contained
package symlinks; reject escaping links, hard-linked files, device/FIFO/socket
entries, group/world writes, setuid/setgid and file capabilities.
`manifest-maintenance-capsule.py` inventories this already prepared tree; it
does not establish GitHub release provenance. Verify the original CI asset SHA,
repository, source/workflow commit, run and release receipt first. Retain the
external capsule manifest and SHA under protected policy storage.

No `ExecStartPre` plus mutable `current` shim is used: the protected launcher
verifies the capsule and database epoch, drops all supplementary groups and
real/effective/saved IDs to `paperclip`, enables NoNewPrivileges, and execs fixed
physical Node/CLI paths. Candidate/provider code never runs as root. The unit
starts only the protected Python launcher as root, with CAP_SETUID/CAP_SETGID,
no app EnvironmentFile, no ambient capabilities and no automatic restart.
This service/security change requires explicit live approval.

## Policy and prerequisites (all must be verified before stopping)

1. Approved final source, exact-commit independent review and required final CI;
   qualified Hdom/paperclip release assets and operator bundle. No pending
   publication is implied by local implementation approval.
2. Fresh read-only production inventory: release/DB floor, service and all
   drop-ins, enablement, other service-identity processes, sessions, active runs,
   retained source/lease descriptor and two original deferred wakes. Preserve
   IDs, evidence, bytes and payloads. Do not retry or resolve either obligation.
3. One verified usable recovery backup plus old active release; verified disk
   capacity for new active capsule, independent operator runtime and that one
   recovery path. Do not prune source, keys, project data or unique history.
4. Protected staging of exact new payload and independent runtime, with complete
   provenance and reproducible hashes. No dependency fallback to current, cwd,
   NODE_PATH, writable package hooks or another checkout.
5. Root-owned ancestors for policy, capsule, runtime and trusted config files;
   read-only app access to capsule/necessary config. Existing app `.env` is data,
   never evaluated by a root shell. Unsupported/ambiguous quoting is a refusal.
   Root protection of existing config directories/ownership is a proposed change,
   not something the tooling has already done; review app write requirements.
6. An exact private `/etc/paperclip/maintenance/host-policy.json` containing:
   `schema=paperclip.maintenance-host-policy.v1`, physical `operatorRoot`, external
   `operatorManifest` and SHA, physical `capsule`, external `capsuleManifest` and
   SHA, exact `sourceCommit`, `identity={database,databaseOid,instanceId}` from the
   real DB, original `expectedGeneration`, stable `requestId`, `approvalReference`,
   private `operatorNote`, exact trusted config digests (`environment/config/dotenv`),
   `baseline`, and exact persistent `interlockServiceFiles` / `guardedServiceFiles`
   path-to-SHA maps. Never include a connection string, password, key or token.
   The baseline is captured after physical containment by `inspect`, then reviewed
   and placed in this private policy. Plan assembly is an explicit operator step.
7. Render and independently review exact interlock/guarded drop-in bytes. The
   committed files under deployment-examples/controller are templates, not live
   configuration. No unreviewed lifecycle commands or `/run` overrides allowed.

## Ordered cutover (requires separate approval)

All commands run on controller113 as the authorized root operator, never an agent.
`OPERATOR_ROOT` below means the exact reviewed, root-protected runtime directory;
it is not an untrusted shell variable or a path supplied to the host CLI.

1. Save and hash the original `/etc/systemd/system/paperclip.service`, all drop-ins
   and enablement in the single protected recovery record. Inspect pending jobs
   and active work. If any callback/provider ownership is uncertain, stop here.
2. Stop `paperclip.service` through systemd and verify physical settlement. Install
   the exact persistent deny-start drop-in, daemon-reload, verify manager properties:
   inactive/dead, MainPID0, ExecStart `/usr/bin/false`, Restart=no, no lifecycle
   hooks/jobs/cgroup members, no other `paperclip` UID process and no other DB
   client. This is an **interlock**, not a mask. If the service cannot settle,
   preserve evidence and stop; do not force success or erase obligations.
3. With interlock revalidated, run `/usr/bin/python3 -I -S OPERATOR_ROOT/maintenance-host.py inspect`.
   It reads only the verified fixed instance, reports DB identity, pending
   migrations and count/hash per retained public domain. Inventory is bounded to
   1,000 tables and 250,000 rows per table. On excess, stop and design a reviewed
   streaming inventory; do not remove bounds. Capture/review the exact baseline
   into the protected policy, preserving the same request/approval identity.
4. Run `/usr/bin/python3 -I -S OPERATOR_ROOT/maintenance-host.py initialize`.
   It verifies persistent interlock before/after, physical quiescence, DB identity
   and baseline, applies only reviewed migrations0468–0471 through the canonical
   migrator, permits only empty new `github_app_settings` and
   `issue_workflow_handoffs`, and preserves every pre-existing domain exactly.
   It audits `offline-root:<approvalReference>`, starts canonical maintenance with
   `requires_readiness_decision`, and reconciles only genuine zero blockers.
   Blockers retain acquiring; no forced settlement, fabricated JWT or source repair.
   On verified held it atomically records the root-private `epoch.json` receipt.
   Same exact request safely replays a lost response; changed inputs are refused.
5. Run `/usr/bin/python3 -I -S OPERATOR_ROOT/maintenance-host.py guard`.
   Guard is read-only and requires exact DB/instance/generation/owner/strict-held
   receipt and authenticated compatible candidate. It must refuse the old475
   candidate, tampering, missing capabilities and older/wrong databases.
6. Replace the interlock with the exact reviewed guarded unit configuration,
   daemon-reload, inspect effective files/properties, then start through systemd.
   Never restore the old current-shim ExecStart between these steps. The wrapper
   rechecks unit provenance, full protected closure and persisted epoch itself.
7. Verify health, deployed stamp, maintenance UI, held strict policy, unchanged
   source/review/parent wake rows, zero new execution and native key metadata only.
   Check actual service UID/NNP and loaded release path. Do not print secrets.
   Keep maintenance held and report; recovery and connector continuation remain
   separate pending actions. This is not live end-to-end connector acceptance.

## Failure and rollback

- Before any schema/fence change: keep interlock, inspect uncertainty. Returning
  to the original service still requires an explicit reviewed decision because
  its startup can reconsider saved recovery/wakes.
- After any migration/held epoch: **never automatically start old475**. Preserve
  the durable fence, original DB/source/wakes, operator runtime, policy and epoch.
  A compatible previously qualified capsule may be selected only with new exact
  protected provenance, guard compatibility and approved policy adjustment.
- If no compatible binary is available, leave the service stopped/interlocked.
  This is the fail-closed rollback. Do not disable the guard, drop fence tables,
  release maintenance or overwrite the live DB with a stale backup to get uptime.
- A complete restore to the pre-fence backup would discard later DB state and
  still leave the old runtime startup hazard. It needs a separate reconciliation
  and approval; it is not this plan's ordinary rollback.
- Keep exact source and original wake identities/payloads throughout. No retry,
  cancelled-credential reuse, forced source merge or Git workspace expansion.

## Evidence and limits

Qualification uses a real populated PostgreSQL TEMPLATE clone of synthetic
old467 state: five role records, stopped source/lease evidence, original-shaped
review/parent wakes and three synthetic encrypted signing-key version records.
It verifies canonical upgrade, strict hold, unchanged retained domains, lost
response replay, partially committed migration recovery, changed identity,
competing DB client, changed baseline, acquiring blockers and rejected old schema.
Actual server startup/restart and later owner notification are separate existing
tests; an actual root→unprivileged Node/entry/dependency exec verifies fixed-path
launch independently of `current` selection.

These are synthetic qualifications, not a production DB clone or real project
run. Systemd manager observations are tested as synthetic fixtures; the exact
live manager, full assembled release capsule and host config protection still
need preflight verification. Network namespace separation shares the host FS,
not strong isolation; Docker remains deferred. CI/package qualification for the
new final revision and live UI acceptance remain pending publication permission.
Synthetic timings cannot establish production downtime: backup verification,
real database inventory, file protection, capsule validation and systemd/health
checks have not been timed on controller113. Reserve an attended maintenance
window and keep it stopped on uncertainty; do not promise a measured outage.

## Remaining approval requests

First: publish the exact independently reviewed final revision, open/update its
PR, run required CI, merge and produce the verified Hdom/paperclip release.
Second, after release/preflight evidence is presented: approve the exact service
stop, persistent interlock, protected config/capsule/operator ownership, unit
root-launch/drop-privilege security settings, offline migration/fence/epoch and
guarded restart above. Live recovery and real connector continuation are **not**
included; the distinct unsupported project/Git preparation decision remains open.
