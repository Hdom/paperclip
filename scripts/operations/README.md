# Operator utilities and deployed-source provenance

These tools are for an authorized desktop or host operator. They are not agent tools.
A committed script or `--execute` / `-ConfirmChange` flag does not grant approval,
root access, a credential, or permission to start a project.

GitHub App identity assignment, issuance, verification and key lifecycle belong in
Agent > Tools > GitHub identity and Secrets. Use those UI controls. These utilities
cover host release handling, recovery qualification and source inspection. They
never replace the UI with a second App configuration system.

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
