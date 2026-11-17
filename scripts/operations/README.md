# Operator utilities and deployed-source provenance

These tools are for an authorized desktop or host operator. They are not agent tools.
A committed script or `--execute` / `-ConfirmChange` flag does not grant approval,
root access, a credential, or permission to start a project.

GitHub App identity assignment, issuance, verification and key lifecycle belong in
Agent > Permissions / Trust > Allowed connectors > GitHub identity and
Settings > Secrets > Signing keys. Use those UI controls. These utilities
cover host release handling, recovery qualification and source inspection. They
never replace the UI with a second App configuration system.

Protected repository-free SSH tasks with no explicit workspace, source, setup,
or existing binding now receive a private per-run task directory on initial
assignment. The server persists its normal task/workspace/lease ownership and
uses the existing exact scoped transfer checks. This is visible through the
existing task workspace controls; no second configuration surface is added.
Explicit workspace or setup choices remain unchanged and must satisfy normal
source protection. A private directory does not imply OS/process isolation.

## Source inventory

`observed-deployment-inventory.json` records the 2026-11-14 controller, worker and
command gateway observations. Seven files under `deployment-examples/` preserve
exact deployed source bytes. They are examples, not an installer. Do not enable a
service/timer, copy a root gateway or change sudoers merely because it is committed.
The gateway's existing guest allowlist is infrastructure authority, separate from
GitHub App permissions. The desktop transport only targets controller 113 and
worker 124. Installing any privileged gateway requires its own approval.

The old controller `github-apps-offline-activation.mjs` hash is recorded as an
untracked historical bundle. It matches the preserved desktop copies, but has no
standalone source in the former fork history. Do not use that bundle for new
activation. `activate-prepared-release.ts` now reuses the canonical CLI install-store
source, adds the approved Hdom workflow identity check and is bundled reproducibly.
The launcher and service examples reflect an observed installation; customize paths
in an explicitly reviewed change rather than silently installing them elsewhere.

Read-only source verification:

```sh
python3 scripts/operations/verify-utility-provenance.py --root .
# On the appropriate host, compare observed deployed bytes/owners/modes:
python3 scripts/operations/verify-utility-provenance.py --root / --surface worker
```

The controller's historical activation bundle deliberately remains an unmatched
retired entry. A source check must not imply it has current release provenance.
This inventory excludes keys, configuration values, `.managed-install`, databases,
logs, npm versions, package payloads, agent workspaces and project files. Generated
shims are captured as source examples; generated runtime state is not committed.

The development inventory also examined 575 existing repository utility, CLI,
maintenance and worker-helper source files. Canonical source already owns install
and service lifecycle, backup/migration, audited SSH-stop maintenance, check-ins,
release packaging and regressions. Do not copy those implementations into ad hoc
scripts. Historical `.tools/*checkpoint*`, `copy_paperclip_*`, dispatch setup and
`tmp/github-app-enhancement/{stage,activate,prepare}-*` local-build helpers are
retired development scaffolding, not the deployment path. Some older desktop
helpers refer to retired credential names; never execute them as a fallback.
One-off patch generators and copied checkouts are superseded by committed changes.
No historical files or recovery data were deleted during this inventory.

## Credentials and transport

`Invoke-PaperclipOperator.ps1` reads only the authorized Windows User variables
`PAPERCLIP_OPERATOR_API_URL` and `PAPERCLIP_OPERATOR_API_TOKEN`. It uses native HTTPS
certificate/hostname validation, rejects redirects, limits supported endpoints and
prints metadata only. It does not support signing-key values. `-ValidateOnly`
validates a request without retrieving credentials or opening a connection.

`guest-exec.py` requires an externally installed Paramiko, the existing trusted SSH
host-key file and `PROXMOX_OPERATOR_USER` / `PROXMOX_OPERATOR_PASSWORD` User variables.
Its non-secret options JSON supplies `sshHost`, `guest`, `command` (an argument
array) and optional `knownHosts` / `timeoutSeconds` (1–900 seconds). Allow an adequate
transfer timeout, such as 600 seconds for a large release. No credential values belong in
that file. It rejects unknown/changed keys and disables SSH key/agent fallback.
It sends a sudo password only after a real prompt. A readiness handshake prevents
that password from becoming command stdin when sudo is cached or passwordless.
It never forwards desktop credentials into the guest environment. Do not use it to
print keys, tokens or sensitive files. Do not invoke it from an execution agent.
For a release transfer, `stdinFile` may name one supported release asset and
`stdinSha256` must match its previously verified GitHub asset digest. The file is
streamed only after guest readiness, separately from sudo authentication. The
transport does not authorize any command or bypass a rejected action.

`stage-release.py ACTION OPTIONS_JSON` is controller-root-only. `receive` requires
a pre-created root-only `cacheDirectory` under `/var/cache/paperclip-releases`,
named for the first 12 source SHA characters with a root-owned non-writable ancestor chain, plus `sourceCommit`, `assetName`, `assetSizeBytes` and `assetSha256`.
It commits received bytes exclusively after size/hash checks. `verify` requires
`workflowRun` and `assetDigests` from the authenticated GitHub release response;
it also verifies SHA256SUMS and the Hdom source/workflow manifest. `stage` adds
`payloadStore` (the conventional `/opt/paperclip-data/cli/installs/git`) and optional `minimumRemainingBytes` (at least 1.5 GB). It rejects escaping archive
paths/links/special files, checks disk headroom, and creates a new payload owned by
paperclip. It never overwrites an install or changes `current` / `install.json`.
Keep the asset cache separate from options files and helper source. These options
contain paths, sizes and public hashes, never credentials. Copy only the reviewed
source or generated Hdom operator artifact for isolated qualification. Permanent
helper deployment and application activation require the reviewed merged release.

## Release and activation

Deploy only a release generated by `Hdom/paperclip`. Verify the successful workflow,
reviewed merged source SHA, release assets, SHA256SUMS and manifest before staging.
Never relabel a locally built payload as a GitHub release. The release packager also
emits an operator-tools archive with per-file hashes and source commit metadata.
Generated bundles, archives, extracted payloads and machine state stay out of git.

`activate-prepared-release.mjs` is the generated release operator helper. Its
`PAPERCLIP_OFFLINE_ACTIVATION` JSON contains only non-secret paths/identities:
`paperclipHome`, `homeDir`, `expectedCurrentSha`, `newSourceSha`,
`releaseManifestPath`, and `expectedWorkflowRun`. It requires an already prepared
physical payload in the canonical install store. It validates release/stamp/version,
uses the manager lock and compares the expected current identity. It only changes
managed selection metadata. It does not stop/start services, apply migrations,
prune releases, change key scope, grant access or launch work.

Before activation, obtain any required maintenance-pause approval. Drain execution
and fence new admission with the supported company pause; disabled heartbeat alone
is insufficient. An automatic rejection must not be retried through another tool.
Keep the previous status recorded. Resume only when explicitly appropriate and do
not start the real connector run as a side effect.

## Protected backup and isolated upgrade

Run `prepare-database-upgrade.py OPTIONS.json` on the controller as its authorized
root operator. Options name `database`, a distinct `paperclip_gitops_*`,
`paperclip_upgrade_*` or `paperclip_qualify_*` `cloneDatabase`, `databaseOwner`, a
new absolute `backupDirectory` under an existing root-owned protected parent, and
optional `configurationSnapshots` / `minimumFreeBytes`. Snapshot paths are restricted
to the four conventional controller configuration files in the source policy. Opened
FD checks reject links, special files, mutable/oversize sources and key-bearing content. Confirm the local PostgreSQL
peer cluster is the intended live cluster first. It does not copy PEM/master-key
files or create credentials. The dump and configuration remain root-only on the
controller. Restore uses stdin so PostgreSQL need not read a root-only directory.
It creates a clone but never starts Paperclip against that clone. Existing clone
names are an error, not permission to drop or overwrite a database.

Run `qualify-database-upgrade.mjs OPTIONS.json` with a verified staged release.
Options are `payload`, `sourceCommit`, `config`, `restoreReceipt`, `cloneDatabase`,
`expectedJournalCount`, `expectedBridgeHash`, `invariants` and a new `receipt` path.
The configuration is read in controller memory. The tool rejects URL search/hash
startup overrides, proves the actual database identity before migration, checks
historical receipts and compares original-column data digests. It checks native
controller-secret scope and a no-op second apply. It never starts server workers.
If qualification fails, inspect the clone and protected receipts before retrying;
do not infer that the production database was upgraded.

Before native key cleanup, keep the matched pre-upgrade DB/config/environment and
existing protected PEMs. After cleanup, retain a consistent post-migration encrypted
DB/native-config pair with pinned IDs/versions, the unchanged master key and sticky
controller protection. Exclude concurrent rotation/configuration changes while
capturing that pair. Verify restored native signing using public fingerprints only.
`verify-native-key-recovery.mjs OPTIONS.json` imports the released dedicated signer
against a verified restored clone, without starting a server or workers. It requires
`payload`, `sourceCommit`, `config`, `restoreReceipt`, `cloneDatabase`, `nativeConfig`,
`masterKeyFile`, the three `expectedFingerprints` and a new `receipt` path. The
native configuration must contain pinned secret IDs/versions for all three roles;
legacy key paths are refused. The existing private master file is never copied or
created. The signer uses controller-only Secrets access; neither PEMs nor JWTs are
printed, saved or returned by this utility. Its only mutation is the clone's normal
secret-access audit trail. No installation token or GitHub API request is needed.
An old binary alone is not a rollback after PEM cleanup. An unpublished local
binary is not an allowed recovery release under the release-only rule. Stop and
report if a compliant, tested recovery path is unavailable.

## Checks

```sh
node --test scripts/operations/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/operations -p '*_test.py'
python3 scripts/operations/verify-utility-provenance.py --root .
```

These source checks do not prove a live rollout, real-key migration, safe model
execution or strong worker isolation. Docker isolation remains deferred.


## Direct GitHub App MCP compatibility probe

`verify-github-app-mcp.mjs` uses an already released server's native signer in a
protected controller process. It verifies the two fixed Hdom worker App
registrations/installations and requests metadata-read-only tokens restricted to
the known bootstrap repository. It sends only protocol initialization and
`tools/list` to GitHub's fixed hosted endpoint, plus an invalid-bearer negative
control. It does not use Paperclip Cloud, dispatch an agent or tool, create a
repository, change installation access, export a key or deliver a token.

Run only with explicit operator authorization. Pass one protected non-secret JSON
options file containing `payload`, `sourceCommit`, `instanceConfig`, `appConfig`
and a new `receipt` path. Existing key material stays in native Secrets; use the
existing instance master, never a copied master or inline environment value.
The native signer may append its normal secret-access audit records.

The receipt distinguishes catalog acceptance, the negative authentication control,
scope verification and token revocation. A successful catalog is not a successful
tool invocation. Metadata-only rejection does not establish that a full worker
token is unsupported, or that Paperclip Cloud is required. Cleanup is retried
within a fixed budget; uncertain cleanup or scope stops later token mints and is
reported without retaining or printing credentials.

```sh
node --test scripts/operations/verify-github-app-mcp.test.mjs
# On the protected controller, using its released runtime:
node verify-github-app-mcp.mjs /protected/operator-options.json
```


The MCP verifier defaults to catalog-only behavior. A separately reviewed and
explicitly authorized `probe: "repository-metadata"` option permits exactly one
`search_repositories` call for the known private bootstrap fixture, after checking
its metadata identity with GitHub REST. It requires the advertised tool to be
read-only and its query schema to match the fixed call, validates the exact
repository result, and keeps the same metadata-only token scope and revocation
budget. It cannot verify contents or PR operations and never grants installation
access or creates repositories. Catalog-only approval does not authorize this mode.


## Retained stopped SSH output

`recover-retained-ssh-workspace.mjs` is a compatibility operator tool for an
already-terminal legacy SSH run with a required return-files recovery hold. It
never runs an agent, opens a stopped SSH execution scope, merges without a
durable baseline, creates a project, or changes GitHub access.

Use an exact reviewed deployed release and non-secret options JSON. Every
command requires `confirm: true`, `sourceCommit`, `payload`, the fixed instance
`config` path, `companyId`, `issueId`, `runId`, `actionId`, operator attribution
`actorId`, and a fresh `receipt` under
`/var/lib/paperclip/operator-receipts/<uuid>.json`. The dedicated root entry
captures only the running service's named protection settings, then drops to
the Paperclip service identity. Signing keys and desktop API tokens are never
inputs. A started receipt is written before mutation; on uncertainty inspect
that receipt and the exact recorded database state before attempting anything
again. There is no automatic cleanup/drop/reuse fallback.

Commands, in order when applicable:

1. `attest`: needed only for old source receipts lacking a public host-policy
   digest. Supply a new `cloneDatabase` matching
   `paperclip_qualify_<12 lower hex>`, `historicalBackup` under
   `/var/backups/paperclip/`, its independently verified `expectedRestoreSha256`,
   and `expectedHostKeyPolicySha256`. The root-owned private physical dump is
   opened once, bounded to 256 MiB, and hashed before and after the same open FD
   is passed to `pg_restore`. An exclusive new clone is made; existing or
   uncertain clone names are refused. The read-only clone must show the same
   environment before this run started and match the current strict host key
   policy. The attestation records the actual dump SHA. An old receipt for a
   reused qualification database is insufficient. Preserve the clone on an
   uncertain outcome; remove it later through a verified separate operation.
2. `preserve`: under the original finalization ownership, copy only that run's
   deterministic stopped worker directory into the existing immutable snapshot
   ledger/storage. Source company, task, run, lease, generation, boot, endpoint,
   canonical stop and filesystem identity must match. Another SSH lease for the
   same run is ambiguous even with a different hostname. Historical different
   runs sharing a host URI do not themselves confer access or invalidate this
   per-run source. The archive/manifest are read back and verified. The original
   worker output and required repair hold remain intact; preservation is not a
   successful copy-back or provider result.
3. `retire-wake`: only when an exact pending old system blocker-stall wake would
   otherwise conflict with continuation. Supply `wakeId`, `stalledIssueId`, and
   `stalledActionId`. It requires a genuine source-bound saved snapshot, the
   existing repair hold, unchanged incident/assignee, and no active task run.
   The queue owner records cancellation plus an exact operator audit. A magic
   error string alone is never a receipt. The audit suppresses only that exact
   notification; a later incident still wakes. No turn is dispatched.
4. Request **Recover workspace** through the existing task recovery flow.
   Normal system recovery reuses the verified snapshot and writes its existing
   finalization/completion proof. A still-pending stall notification fails
   closed as `effect_unresolved / user_action_required`, retaining the source
   rather than consuming automatic provider retries. Only genuine completion
   releases the hold. The `verify` operator command is read-only and reports the
   existing execution blocker without dispatching anything.

Keep company admission paused through source recovery and continuation setup.
After verified completion, persist one canonical public Retry for the original
Coordinator task, bound to the observed source run, while admission is still
paused. Persist the intended specialist Retry through the same supported flow.
An attempted dispatch while paused must remain refused; do not alter wake JSON
or launch an extra parent turn. SSH snapshot proof settles preservation, not a
merge into the old directory: the canonical Retry must select a fresh attempt
and attach the immutable archive through its committed source ancestry.
Before restoring the previously active company, verify the exact specialist-to-
Coordinator blocks relation and the canonical Retry source/generation receipt.
After restoration, confirm the parent Retry remains deferred with zero new
parent runs while the specialist is unresolved; observe dependency continuation
and Retry suppression/coalescing after specialist completion. Do not additionally launch
its parent or duplicate a queued wake. These rare legacy provenance and
incident dispositions stay in the reviewed operator tool; normal agent
environment, Secrets, skill version and task recovery controls retain their
existing UI. A rollback during this operation must remain operationally paused
until the previous release's understanding of the saved recovery proof has been
verified. Keep the original worker output and one verified release/data rollback.

Protected linked local skills use their latest **committed** saved version at
execution. External edits require the existing explicit import/save action;
execution never implicitly broadens filesystem access to recapture a link.
Explicit version pins retain precedence. Governed MCP delivery approves only
the server-declared same-origin project tools and `connections_search`; backend
authority and stricter operator per-server/tool/profile restrictions remain
enforced. Ambiguous or malformed MCP policy is a permanent configuration error.

### Qualification

The release workflow retains all prior qualification suites and adds source,
historical attestation, deferred-wake and affected generic recovery regressions.
`scripts/tests/qualify-isolated-ssh.py` additionally exercises real SSH transport
with a temporary worker network namespace and no default route. Run as root
with an unprivileged `--user` and supported `--node-bin`. Only synthetic SSH
credentials and temporary databases/output are used; the production protected
target guard is unchanged. Cleanup pins processes with pidfds and verifies the
exact namespace before signalling. This is network separation, not strong
filesystem or shared-UID isolation. Docker remains deferred.

The provider executable in assembled fresh-role tests is deterministic test
code, not an external model. Distinguish this admission/return/recovery evidence
from a real connector run and actual GitHub tool/provider acceptance. Live
continuation remains a separate verified step after deployment and source repair.

### Reconcile a lifecycle-cancelled stall notification

Public company Pause normally cancels unclaimed stall notifications. Such a
cancellation is not the explicit source-preservation disposition described
above. Keep its status, error and timestamps intact. Ordinary cancelled stalls
remain retryable; do not reset one to deferred or forge a retirement marker.

For this retained-output recovery only, while the company and original agent
are fully paused, use `inspect-cancelled-wake` with the exact `wakeId`,
`stalledIssueId` and `stalledActionId`. It returns a SHA-256 fingerprint of the
whole cancellation row (timestamps are timezone independent). After `preserve`
has verified the immutable source snapshot, use `reconcile-cancelled-wake`
with the same identity, `cancellationSha256`, actual public company-Pause
`pauseActivityId` and verified `snapshotOperationId`.

The operation checks current operator task authority, exact company/run/action,
source hold, stopped source/lease evidence, current stalled dependency and
absence of competing execution or notification ownership. It records
`issue.stall_cancellation_reconciled`, including separate pause and recovery
operator attribution; it does not modify the original wake or dispatch work.
Changed cancellation/source/snapshot/stop evidence invalidates the receipt.
Both later stall sweeps and locked task admission honor only that exact
incident. An ordinary cancellation or a new recovery incident still follows
normal delivery. Recovery completion remains held without this evidence.

Reconciliation is not copy-back. Complete the existing recovery through its
public action only after verifying the snapshot bytes. Then queue the approved
canonical task continuations under pause, recheck dependencies/ownership,
resume through the public company control and monitor the actual specialist
handoff and return-file finalization. Never infer live acceptance from an
immutable archive or deterministic qualification alone.
