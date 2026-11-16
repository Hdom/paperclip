# Protected native SSH task workspaces

Protected-controller mode keeps signing keys, configuration, databases and backups outside agent transfer roots. Repository-free task directories are nevertheless legitimate mutable inputs: the server creates them beneath the native instance namespace and records their owners in the issue, run, execution workspace and SSH lease.

The server service `scoped-task-workspace-authority.ts` validates those persisted bindings and creates an invocation-local, revocable capability. Agent/config JSON cannot supply it. It binds the prepared local CWD and physical directory inode to the company, assigned agent, issue, run, workspace, environment, canonical SSH lease handle, endpoint and remote scope generation/boot. It accepts the existing fresh-attempt and authoritative retained-task namespaces. Native secret/Git exclusions and static source-root disjointness still apply.

The capability is active only for explicit read or publication operations. It does not add a global filesystem root. Upload and baseline come from the same bounded, checked flat snapshot; links are refused and safe original file permissions are preserved. Generic assets and additional sources receive no workspace exception. The remote destination is derived from the exact run beneath the prepared remote CWD.

Copy-back downloads a bounded plain archive and validates every header/member before extraction (paths, links, types, sparse/oversized files, duplicate/ancestor collisions and privilege bits). It downloads and validates output before taking publication locks. It then acquires the existing directory merge lock, captures a checked current tree, and enters the server-owned publication fence. Company/agent/environment/issue/run/workspace/lease rows use nonwaiting shared locks to avoid waiting in inconsistent lock orders. Filesystem mutation remains bounded by the materialization limits. Each destructive mutation rechecks the physical root and the nonreconnecting transaction. The transaction disables its idle timeout locally; it performs no SSH or provider waits.

The existing durable workspace-finalization owner receipt additionally fences successors across connection loss. Its live-legacy option is used only for this publication phase. Nested transaction callbacks are explicitly joined before the owner receipt can be removed; a rejected transaction promise alone does not establish that filesystem work stopped. Existing native callers keep their original admission behavior.

Cancellation, expired leases, changed generations, holds, changed ownership and unsafe files fail closed. New reads stop on abort. If copy-back cannot safely publish, the original run gets a durable required-workspace-recovery receipt, including its original endpoint, remote directory and exact scope identity. No stopped run is replayed or granted write access by that receipt. SSH scope stop closes execution admission without deleting the remote run directory. New runs stage in separate run directories.

## Recovery limitations

An SSH recovery receipt preserves an obligation; it does not implement automatic SSH file repair through the sandbox repair UI. Recover the original source only after independently verifying its exact stop receipt and authority. Likewise, a legacy durable-owner residue after a controller crash remains fail-closed and may require operator proof; this change does not broaden native-only resume/recovery readers. Preserve remote output and owner evidence until that proof and recovery are complete.

Shared worker Unix identities remain a limitation. Separate run paths and GitHub App identities do not establish strong process or filesystem isolation. Docker isolation remains deferred.

## Verification and prior regression

The new fixtures use synthetic secrets and the actual native directory layout, real PostgreSQL ownership records and authenticated SSH. They combine native pinned package-store skill export with workspace upload and cover deterministic execution, deletion/chmod, serialized copy-back, stop proof, cancellation and generation refusal, durable pending recovery, inherited async-context revocation, aliases/hardlinks, connection loss, and a one-connection pool with a small idle timeout. The existing source, Git, merge, archive, lease and physical-stop suites remain release gates.

The local SSH fixture is loopback and is called directly at the transfer/authority seam. Production execution still passes the unchanged approved-target guard, which rejects controller/loopback targets. This fixture does not prove full production heartbeat admission, skill resolution, model execution or connector acceptance. Those distinctions must remain explicit in release verification and the monitored real task.

The historical representative success used a shared workspace; the later failing retry selected a fresh native attempt directory with the same agent, SSH environment and five pinned skill versions. Our subsequently added path guards omitted native skill-source and mutable-workspace contracts. A later strict SSH ownership change also omitted one leaseId transport handoff. These were fork integration regressions. Separate component tests did not prove the assembled fresh protected SSH task lifecycle before deployment. The historical run's exact deployed revision is not retained in its run metadata and remains unverified; cached skill source locators are not deployment provenance.

These checks are internal ownership invariants rather than a new UI permission switch. Existing workspace, environment and trust controls remain the operator configuration surfaces; there is no bypass setting for arbitrary controller paths.
