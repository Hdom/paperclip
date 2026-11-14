# Offline SSH host-stop reconciliation

This is a root-only operator tool for historical SSH leases that were released
without canonical remote termination receipts. It has no HTTP route and is not
registered in the agent-facing CLI. Lease release, process absence, SSH exit,
guest job output and a Board assertion do not establish remote termination.

The execution-environment maintenance service owns receipt production. Existing
explicit-user continuation remains the reconciliation and admission owner. The
tool does not resolve recovery actions, infer prior action outcomes, consume
saved input, reset retry budgets or create a wake.

Successful legacy terminalization normally retains its controller boot ID and
clears lease expiry. Only the exact server post-cleanup `task.run.measured`
settlement event can explain that historical shape. Missing expiry without this
positive event remains a hold, as do failed/active or contradictory sources.
Controller settlement never replaces exact remote stop receipts.

## Trust boundary

A trusted desktop operator independently observes an authenticated host-manager
stop task and a stopped guest with no init PID. The root importer accepts that
operator attestation; the JSON is not a cryptographically signed provider
response. Do not expose this importer to an agent or accept its evidence through
a company/Board API. Root controls the attestation files, executable and database
connection. No desktop operator credential is copied into a controller or worker.

The operator must verify the SSH address maps to the exact isolated guest,
inventory unrelated workloads and restart mechanisms, preserve its workspace,
and back up the controller database/configuration before stopping anything.
Create a supported filesystem snapshot when available. A snapshot is not stop
proof. Restart preserves files; it does not authorize replay of old actions.

## Protocol

1. Stop and runtime-mask `paperclip.service`. Verify inactive/dead, MainPID zero,
   and masked unit state. Keep PostgreSQL available. An environment archive is
   not an atomic dispatch fence and is not used here.
2. As root, create a 0600 descriptor in the root-owned non-writable directory
   `/var/lib/paperclip-maintenance/ssh-host-stop`, containing `companyId`,
   `environmentId`, exact `leaseIds` and existing deferred user `requestIds`.
3. Run the compiled `maintenance/ssh-host-stop.js prepare DESCRIPTOR` using the
   existing controller DATABASE_URL in process memory. This creates a 0600
   preparation file with a fresh operation UUID and exact state fingerprint.
4. Independently recheck the guest identity and configuration, issue its supported
   host stop, await that exact UPID's successful completion, then observe stopped
   state and no init PID. Record task user, type, guest, times, UPID, unchanged
   configuration digest/root volume and verified SSH-address mapping. Never
   fabricate a historical termination receipt or substitute a numeric PID probe.
5. Copy only this nonsecret `paperclip.ssh-host-stop.v1` observation into a 0600
   root-owned file in the maintenance directory. Run `apply OBSERVATION` within
   60 seconds of the final host observation. The preparation expires after
   15 minutes. A failed or uncertain stop must be inspected using its existing
   task journal, never blindly replayed.
6. The importer locks lease, run, environment, finalizer and request writes. It
   rechecks the fence, complete preparation fingerprint, terminal source runs,
   exact SSH identities, no unreleased leases/active runs and no newer allocation.
   It atomically writes canonical lease receipts and a matching activity record.
   An identical committed import is a no-op only when canonical receipts and its
   audit record remain valid. Partial or changed evidence fails closed.
7. Verify receipt and audit readback while the guest is still stopped. Start the
   worker, verify the preserved checkpoint, then unmask/start the qualified
   controller. Let existing admission claim the saved request. Do not invoke an
   operator recovery delivery that would create an additional automation wake.
   Recheck the queue and successor count; supervise to native review/human wait.

## Failure and rollback

Keep the controller stopped/masked and preserve preparation, stop journal,
checkpoint and pending requests on uncertainty. A committed stop receipt is
historical evidence for the exact old leases and must not be erased on an
application rollback. It does not cover a lease acquired after preparation.

Retain the prior managed payload and manifest. Never downgrade while a worker
execution or controller owner is active or uncertain. Before downgrading a
checkpoint-continuation release, use supported agent runtime configuration to
disable both timer and on-demand wake policies, and supported per-run cancellation
for queued/scheduled checkpoint successors. Preserve the saved input and retry
counters. A process loss or failed restore is a hold, not permission to start
another run. Restore wake settings only after separately validating safe admission.

## Qualification

Run the focused service tests with real PostgreSQL. Set
`PAPERCLIP_SSH_STOP_BUNDLE` to the exact built standalone bundle to additionally
exercise root/non-root, stopped/masked fence, file modes, symlinks, hardlinks,
path traversal, prepare/apply and replay inside an isolated existing Node image.
The container uses a declared systemctl fixture; real controller fencing and
authenticated host-stop verification remain required operational checks.

Keep audit-write failure/transaction rollback, concurrent imports, changed
bindings, stale/future/foreign proof, newer/backdated acquisitions, and existing
explicit-continuation regressions accounted for. Test artifacts and child servers
must be removed only after shutdown. Do not claim the full application suite is
green when known baseline failures remain.
