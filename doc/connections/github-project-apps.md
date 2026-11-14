# GitHub App identities and controller signing secrets

This opt-in enhancement adds three independent GitHub App identities for Hdom's personal account. It does not change existing OAuth connections or the chat/review-bot connector. It does not create Apps, keys, installations, or repositories at startup. It is disabled unless the controller sets `PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG`.

## Authority and storage

The controller operator registers and approves three private Apps, then installs each on Hdom with **Only select repositories**. Never select all repositories. Except for the explicitly pinned empty starter during provisioning, worker installation inventories must contain only repositories in this controller's protected project ledger; the broker refuses unrelated selections before creation or token delivery. The experimental inventory is bounded to 100 project bindings and 100 repositories per worker installation. Controller-only Metadata read tokens verify that inventory and are promptly revoked. Use these exact repository permissions; all account, organization, enterprise, and other repository permissions remain off:

| App | Repository permissions |
| --- | --- |
| Coordinator | Metadata read; Repository creation write; GitHub App installation repository access write |
| Implementer | Metadata read; Contents write; Pull requests write |
| Reviewer | Metadata read; Contents read; Pull requests write |

The API permission key for GitHub App installation repository access is `installation_repositories`; this was verified against GitHub's actual registration form. Repository creation uses `repository_creation`. Separate App IDs, installation IDs, agent IDs, and signing identities are required. The broker validates the registered App owner and actual installation owner, personal-account target, selected-repository mode, suspended state, and exact permissions before use. A broader or missing permission is a blocker.

GitHub's Coordinator permission is broader than two installation IDs. The broker enforces those two fixed IDs and never exports a Coordinator token. This boundary relies on the trusted controller. Worker tokens are independently narrowed by GitHub to one repository and one role's exact permissions.

Signing keys use Paperclip's native `local_encrypted` secret provider with the non-bindable `controller` scope. The provider master key remains controller-only. These records are not company, user, or plugin runtime secrets. Generic secret reads, rotation, deletion, environment references, and connection bindings cannot use them. A dedicated signer checks company, role, App ID, provider, and a pinned numeric version before decrypting; only a short-lived App JWT and public fingerprint leave that method. No API reveals or exports a PEM.

The existing protected configuration and project ledger remain service-owned controller state. The configuration holds `signingKeySecret: { secretId, version }` references, never signing material. Use mode-0700 directories and mode-0600 files. Migration accepts only the three prepared role files beside the configuration. It encrypts native versions, compares public fingerprints, verifies GitHub access, atomically switches references, and verifies again before unlinking unchanged prepared files. Verification failure restores the original references before cleanup. Changed or unremovable files remain visible as pending cleanup. It does not create a second plaintext backup.

Signing keys must never enter agent workspaces, runtime environment variables, ordinary secret scopes, tasks, repositories, logs, or transcripts. Backup policy must protect the native encrypted database records and their provider master key together. Do not mount controller state into workers.

The service rejects symlinked paths, unprotected modes, oversized files, duplicate identities, and Windows execution. File permissions protect against worker access only while agents run on the remote worker identity. Shared worker processes can still inspect or reuse each other's delivered tokens. This is not strong agent isolation. Docker remains deferred.

Configuration shape (all values below are placeholders; never put a PEM into this file):

```json
{
  "version": 1,
  "companyId": "00000000-0000-4000-8000-000000000001",
  "owner": "Hdom",
  "stateDirectory": "/var/lib/paperclip/github-project-apps",
  "apps": {
    "coordinator": { "appId": 1, "installationId": 101, "agentId": "00000000-0000-4000-8000-000000000002", "signingKeySecret": { "secretId": "00000000-0000-4000-8000-000000000011", "version": 1 } },
    "implementer": { "appId": 2, "installationId": 102, "agentId": "00000000-0000-4000-8000-000000000003", "signingKeySecret": { "secretId": "00000000-0000-4000-8000-000000000012", "version": 1 } },
    "reviewer": { "appId": 3, "installationId": 103, "agentId": "00000000-0000-4000-8000-000000000004", "signingKeySecret": { "secretId": "00000000-0000-4000-8000-000000000013", "version": 1 } }
  }
}
```

## Guarded asset materialization

Protected mode checks resolved auth/config files and skill roots **before** materialization. The Linux reader validates the opened descriptor before reading, rejects hardlinks and special files, and refuses files that change during the read. Codex's first staging pass and shared snapshots are bounded to 64 MiB per file, 256 MiB total, 10,000 entries and depth 64. Failed staging removes partial output.

Approved shared credential and skill links are materialized into private regular files. SSH asset preparation and sandbox archive creation send those checked, symlink-free snapshots without dereferencing links in the transport. Direct dereferenced transport mappings remain refused. Existing feature-off behavior is preserved.

Before enabling protection, create a service-owned mode-0700 scratch root, default `/var/lib/paperclip/controller-assets`, or set root-controlled `PAPERCLIP_CONTROLLER_ASSET_SNAPSHOT_ROOT` to a dedicated absolute path. Include it in `PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS` and keep it disjoint from every `PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS` entry. Configure the controller's `TMPDIR` to an approved private scratch root too, so intermediate archives and provider assets remain inside approved readable paths. Keep App signing keys, config and ledger out of all scratch and materialization roots. Do not add a broad ancestor to an allowlist to bypass a refusal.

These safeguards cover the reviewed Codex/Claude materialization and asset-transfer paths. They remain an application-enforced boundary and do not establish strong OS isolation. Production activation requires checked source/write/scratch roots, a clean process drain, pinned remote targets, the current reviewed release, and live GitHub permission/enrollment verification before the real run.

## Existing Paperclip UI

Open **Agent → Tools → GitHub identity** to see the assigned App role, verified bot, status, and effective authority. An instance administrator with connection-management permission can open **Manage GitHub App** there. **Secrets → Controller signing keys** opens the same controls and shows encrypted storage and pinned versions.

The dialog supports explicit access verification, role assignment, issuance pause/resume, prepared-file migration and cleanup, write-only replacement-key validation/rotation, and verification/activation of a retained encrypted version. Assignment and issuance changes require a review and confirmation. Key/version and migration changes have separate confirmations. Stale revisions, active affected runs, permission drift, or failed verification refuse the change. Former role agents remain blocked from personal fallback until explicitly released. Pausing retains managed identity selection and prevents new credentials; it does not revoke a token already delivered.

App IDs, installation IDs, the Hdom owner, and permission ceilings remain fixed to the approved identities. GitHub registration, key generation/revocation, and installation repository selection remain in GitHub, with links from each role. The Paperclip dialog reports installation inventory; it cannot grant broader access. Initial instance bootstrap and machine filesystem allowlists remain controller settings because they establish the trusted signer and host boundary. They are not agent-editable switches. Runtime issuance and role/key lifecycle are UI-controlled.

Source roots must also include only the specific managed runtime caches needed for transfers, such as `<instance>/companies/<companyId>/claude-prompt-cache`. Never allow the instance root or another ancestor of its native key, database, configuration, or backup stores. Tokens in shared worker processes do not provide strong OS isolation; Docker remains deferred.

## Additive migration and rollback

Canonical migration history through `0464` is unchanged. `0465_gifted_banshee.sql` has exactly the SQL bytes and SHA256 of the previously deployed custom worker `0375`; normal hash-only receipts therefore recognize it under its new filename without repeating column creation or rewriting old receipts. `0466_friendly_roulette` adds the controller secret scope afterward. Disposable tests cover fresh, canonical, pre-custom, and custom histories with retained synthetic rows and full catalog checks, including repeated upgrades. A nonstandard journal with a filename column requires separate compatibility proof before activation.

Do not deploy an older release that cannot use native signing references after plaintext cleanup. Configuration rollback during migration happens before any cleanup; subsequent key recovery uses retained encrypted versions through a compatible reviewed release. Keep real activation separate from source tests and only deploy artifacts produced by Hdom/paperclip's release workflow.

## Coordinator first-run operation

From its currently owned, active project task, the Coordinator requests `POST /runtime-tools/github/project` with an empty JSON object. It uses the existing GitHub runtime capability (`github_credentials` scope), not a Board credential. Browser sessions are rejected. Native session transports bind the call to their current run. The remote callback bridge permits only this exact additional POST path. Caller-supplied owner, project, repository, installation, role, permission, or credential fields cannot select authority.

The controller derives the company and project from persisted run/task records. It checks current task ownership, execution binding, source trust, effective trust preset, agent and project pause/archive state, hidden historical tasks, and ancestor pause holds. It rechecks authority around external operations. It refuses a project workspace that points at an unrelated existing repository. It never adopts an existing repository merely because its name matches.

The requested private repository name is deterministic: `Hdom/paperclip-<project UUID>`. Creation includes an initial README and disables issues, wiki, and projects. The successful response includes `repositoryId`, `repositoryUrl`, `fullName`, and `status: ready`; it contains no credential. The Coordinator then uses the normal project workspace API to attach that returned URL. No automatic project dispatch or live run is added by this enhancement.

The broker records creation intent durably before `POST /user/repos`, records the returned repository ID before enrollment, and adds only that repository to the two configured worker installations. It checks each installation can issue the required one-repository token. Temporary controller verification tokens and Coordinator tokens are revoked after use. An idempotent retry after completed creation resumes enrollment without another create call. A per-project exclusive lock serializes concurrent callers.

GitHub documents that enrollment requires repository admin access. It also lists installation tokens with `installation_repositories: write` as supported. This enhancement tries only the narrow approved token; any HTTP 403/404 remains a blocker. It never adds Administration, switches to a PAT, or borrows the owner's OAuth identity. Live disposable verification on Hdom confirmed repository creation, same-token creator access, and enrollment into both fixed worker installations using exactly the approved Coordinator permissions, without Administration. GitHub refuses removing the last selected repository with HTTP 422. Do not grant unrelated repositories to bypass that restriction.

## Worker credential delivery

Existing operation-time GitHub credential acquisition resolves configured worker roles through this broker before the OAuth path. Git/gh launchers and native transports retain their existing credential handling. A configured worker with missing, revoked, broader, or unavailable App access fails closed; it never falls back to a personal credential. Configured roles also suppress host GitHub fallback and OAuth-backed GitHub MCP selection/dispatch through the existing identity-selection seam. They use Git/gh with their project App; existing OAuth grants remain stored for other agents and users. Unconfigured agents retain the existing behavior. Managed roles that are paused or blocked do not fall back to personal credentials.

For each acquisition the controller requests an installation token with an explicit single `repository_ids` entry and exact role permissions. It validates the returned repository scope, permissions, and expiry, then checks the repository still matches its private Hdom binding and verifies the App bot's public identity. Commit author settings use the verified bot ID and login. No arbitrary token, private key, or JWT is persisted in the project ledger. The existing in-memory credential environment is delivered to the command only.

GitHub installation tokens expire after one hour. An already delivered token can remain usable until expiry even if its Paperclip run stops; stopping blocks further acquisition. No claim of immediate revocation or strong shared-worker isolation is made. Tokens used only for controller provisioning/verification are revoked promptly. Cleanup failure does not extend their one-hour maximum lifetime.

## Failure and recovery

A provider timeout during repository creation has an uncertain outcome. The ledger remains `creating`, and subsequent calls stop for controller reconciliation. Do not delete that record and blindly retry. The operator must inspect GitHub for the deterministic repository, verify its identity and approved provenance, and deliberately reconcile the protected ledger. A crash can leave a `.lock` file; remove it only after proving no provisioning operation is running. Normal failures release the lock. The feature adds no recurring polling worker.

If creation succeeded but enrollment is refused, the ledger remains `created`. Existing repositories are never deleted or modified to compensate. Correcting an approved installation and retrying resumes the fixed enrollment steps. Report the exact refusal instead of expanding access.

Before placing keys, drain existing runs and verify that no Local agents, local stdio tools, provisioning commands, browser-login helpers, or surviving descendants remain on the controller. Enable sticky `PAPERCLIP_PROTECT_CONTROLLER_GITHUB_KEYS=1` before the keys become readable by the service. This setting must stay enabled even when the broker config is removed. Protected mode refuses Local placement at heartbeat selection and actual target dispatch, host workspace tools, host provisioning/runtime commands and local stdio/browser login. It permits only remote targets. SSH requires a literal worker address, exact approved host/port/user and pinned known-hosts content with strict checking; configure the approved tuple in root-controlled `PAPERCLIP_CONTROLLER_AGENT_SSH_TARGETS` JSON.

Configure root-controlled JSON arrays `PAPERCLIP_CONTROLLER_AGENT_SOURCE_ROOTS` for approved readable workspace/artifact/credential roots and `PAPERCLIP_CONTROLLER_AGENT_WRITE_ROOTS` for mutable restore roots. Keep executable release and immutable artifact roots outside the write allowlist. All roots must be disjoint from signing-key/config/ledger storage. Additional protected roots may be listed in `PAPERCLIP_CONTROLLER_PROTECTED_PATHS`. Canonical path checks cover aliases and persisted workspace selections. Controller Git rejects executable configuration and hooks. Protected SSH synchronization excludes root and nested Git metadata; a legacy baseline without those exclusions requires isolated operator reconciliation. Do not silently resume legacy runs during activation.

Rollback to code containing these safeguards may disable the broker while retaining the sticky protection flag. **An older release ignores the new flag. Before starting any older release, quarantine all signing keys and readable copies into root-only storage inaccessible to the Paperclip service user.** Preserve ledger and repository data. Revoke or uninstall only specifically approved App identities; do not modify unrelated installations. Removing broker configuration restores existing OAuth resolver behavior, so preserve the intended agent access policy separately. This is an application-enforced controller boundary; it is not strong OS isolation.

## Validation and limits

Focused tests use synthetic RSA keys, an actual local HTTP server that verifies JWT signatures, protected temporary files, and a real embedded PostgreSQL database through Paperclip's runtime routes. Tests cover role/repository restrictions, scope drift, bot identity, stop and archive denials, uncertainty, restart, transport allowlists, token cleanup, and existing OAuth credential behavior. They do not create a GitHub repository or call GitHub with live credentials.

Official sources: [repository creation](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user), [installation enrollment](https://docs.github.com/en/rest/apps/installations#add-a-repository-to-an-app-installation), [scoped one-hour installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## Pinned starter repository

For the verified Hdom bootstrap only, protected configuration may include:

```json
"bootstrapRepository": {
  "repositoryId": 1457227143,
  "fullName": "Hdom/paperclip-app-bootstrap-verification-20261113"
}
```

These literal values are the only accepted exception. The default remains strict. The starter is installation inventory tolerance during provisioning only: it can never be a project ledger binding or an agent credential target. Metadata-only controller tokens use a fixed GitHub GraphQL query to verify the exact identity, owner, private visibility, explicit `isEmpty`, and active/unarchived status. Missing or denied proof fails closed; repository size is not used as an emptiness test. No new GitHub permission is required.

After creating and proving both worker project grants, the controller durably records `bootstrap_cleanup_pending`. It removes only this starter from the two fixed worker installations, verifies the project remains selected and starter is absent, then marks the project ready. All non-revocation DELETE operations honor the current authorization and cancellation fences. Failed or uncertain removal retains the pending project, withholds agent credentials and never repeats creation. Reconciliation checks fresh inventories and skips a starter grant already absent. The empty starter repository itself is preserved; removing its installation grants does not delete it. The Coordinator's starter grant remains until an owner-approved cleanup path can remove it safely.

The administrator can use **Verify App access** to validate registration, installation, and starter inventory. It exports no token and creates or enrolls no repository. The same broker verification remains available to protected controller maintenance. The real project run remains a separate authorized action.

GraphQL reference: https://docs.github.com/en/graphql/reference/repos#repository
