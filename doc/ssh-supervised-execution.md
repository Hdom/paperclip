# Supervised SSH execution and Stop receipts

New SSH run leases use a per-lease Linux process supervisor. The SSH account
needs Python 3, Linux child-subreaper support, pidfds, and a private persistent
state directory under its passwd home. Environment **Test** checks these kernel
and runtime prerequisites and the workspace. It does not certify arbitrary
login scripts as harmless.

This is a required ownership mechanism, not an optional permission or a new
agent tool. Agent Pause, Stop, state and errors stay in their existing UI.
There is no switch that turns an SSH-client exit into remote stop evidence.
Host prerequisites are managed by the host operator; Paperclip does not grant
administrator rights or change SSH login configuration.

## Supported host boundary

SSHD, the configured login shell, `.ssh/rc` and other authentication/session
startup are trusted transport bootstrap. They must not dispatch agent workload
outside the supervised tree. An SSH login shell can run startup code before our
command is reached. Omitting explicit profile sourcing in a control RPC does
not eliminate that SSHD boundary. Configure non-spawning transport startup. Keep protocol stdout clean.

Explicit runtime profile sourcing, native commands, legacy adapter launches,
managed-runtime preparation and SSH file transfers enter the same run scope.
Commands must not delegate run execution to an independent external daemon or
service. Such execution needs a provider with a separate verifiable lifecycle.

The stop receipt proves that this exact supervised tree closed admission and
settled its owned descendants. It does not prove whole-host quiet, reverse
external actions, or provide isolation against a hostile process sharing the
SSH user. A nonce is not an isolation boundary. Docker isolation is separate.

## Ownership and protocol

The environment service allocates the lease ID and constructs its complete
opaque `remoteExecutionScope` in the same database insertion. The SSH owner
contains company, run, lease, generation, worker boot and protocol identities.
The owning run is locked and checked after the slow prerequisite probe, before
allocation. Empty control-owner preparation may finish after cancellation only
to allow cleanup; run and lease admission are checked before any workspace or
runtime-profile command is admitted.

The remote supervisor establishes `PR_SET_CHILD_SUBREAPER` before a command.
It serializes command admission and Stop on one event loop. Stop permanently
closes and persists the launch gate before signalling. The sole waiter uses
`waitpid(-1, WNOHANG | __WALL)`, with controlled signal handling. PID discovery is
used only to signal verified owned children through pidfds. Only final kernel
`ECHILD` permits the positive acknowledgement. Detached sessions, double forks
and nested adoption remain owned descendants. Linux clone children can suppress
SIGCHLD, so an active Stop reconciles at a bounded 50 ms cadence for 15 seconds.
After that deadline it reports pending and waits for a child event or explicit
retry. An idle supervisor does not poll the database or network.

The authenticated control acknowledgement must match the exact owner and the
typed stopped proof. The transport and the persistence boundary both validate
it. Persistence compares current resource identity and scope under the lease
row lock. A stale acknowledgement cannot certify changed authority. A late
failed Stop cannot erase another call's matching committed receipt.

Canonical receipts carry `resourceScope`. If either the lease or receipt has a
scope, both must contain the same valid opaque identity. The runtime validator
and SQL admission, idle and accounting predicates enforce this rule. The required-scope marker
prevents missing ownership from silently becoming unscoped execution. Generic
metadata updates preserve controller-owned scope and existing stop proof; they
cannot supply replacements. Existing providers with neither field keep their
established contract.

Scope state contains no command, environment, credential, key or agent output.
It lives in the SSH user's private `.local/state/paperclip/ssh-scopes-v1` directory,
not a temporary directory or project workspace. Stopped tombstones prevent
delayed commands or preparation from reopening an old scope. History is bounded
at 10,000 scope directories; acquisition refuses capacity instead of deleting a
fence. Do not remove live or stopped authority records as ordinary temp cleanup.

## Failure, compatibility and rollback

Missing or crashed supervision, wrong boot identity, lost acknowledgement,
unsupported primitives and uncertain database writes remain a hold. The existing
durable cleanup owner retries Stop for the same scope. It never creates a new
scope or infers termination from an absent PID, SSH exit or released row.
Work is not replayed by cleanup.

Historical unscoped SSH leases retain their prior bookkeeping release contract.
It produces no canonical termination receipt. Cancelled historical work still
requires the [offline verified host-stop procedure](ssh-host-stop-maintenance.md).
That importer preserves any scoped lease identity when it records a verified
physical guest stop. Neither path resumes an agent or creates a wakeup.

No schema migration or signing-key migration is required. Preserve committed
receipts during rollback. Stop dispatch and settle all new scoped leases before
running an older application that cannot manage them. Do not restore a database
from before committed physical-stop evidence.

## Verification

`ssh-run-scope.test.ts` exercises real kernel ownership, double-fork/setsid,
zero-signal clone waiting, transport-client loss, unrelated process survival,
concurrent admission/Stop, persistent closure, stdin and a deliberately spawning
shell-rc fixture that demonstrates the unsupported transport-bootstrap boundary.
The zero-signal fixture stays before exec because exec resets the exit signal.

`ssh-run-scope-kernel.test.ts` retains independently developed raw clone and
supervisor-crash fixtures. CLONE_PARENT inherits SIGCHLD on the tested kernel;
those cases are not claimed as zero-signal notification evidence.

`ssh-run-scope-transport.test.ts` requires an actual isolated authenticated SSH
server. It uses both command-managed and legacy execution, kills the local
client, verifies the remote child is still alive, then verifies positive Stop
and closed admission. No model, production agent, real repository or App key is
used. `ssh-automatic-stop.test.ts` checks database receipts, cancellation/startup
races, scope changes, concurrent cleanup orderings and no wakeup creation.
`remote-execution-scope.test.ts` checks runtime/PostgreSQL predicate parity.

The release qualification retains all previous suites and includes these tests.
Linux SSH fixture qualification requires sshd on PATH; concurrent Git history
restoration also requires Git with `merge-tree --write-tree` support.

Kernel contracts: [child subreapers](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html)
and [waitpid / __WALL](https://man7.org/linux/man-pages/man2/waitpid.2.html).
