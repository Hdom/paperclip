# Controller-managed GitHub project Apps (fork experiment)

This opt-in enhancement adds three independent GitHub App identities for Hdom's personal account. It does not change existing OAuth connections or the chat/review-bot connector. It does not create Apps, keys, installations, or repositories at startup. It is disabled unless the controller sets `PAPERCLIP_GITHUB_PROJECT_APPS_CONFIG`.

## Authority and storage

The controller operator registers and approves three private Apps, then installs each on Hdom with **Only select repositories**. Never select all repositories. Worker installation inventories must contain only repositories in this controller's protected project ledger; the broker refuses unrelated selections before creation or token delivery. The experimental inventory is bounded to 100 project bindings and 100 repositories per worker installation. Controller-only Metadata read tokens verify that inventory and are promptly revoked. Use these exact repository permissions; all account, organization, enterprise, and other repository permissions remain off:

| App | Repository permissions |
| --- | --- |
| Coordinator | Metadata read; Repository creation write; GitHub App installation repository access write |
| Implementer | Metadata read; Contents write; Pull requests write |
| Reviewer | Metadata read; Contents read; Pull requests write |

The API permission key for GitHub App installation repository access is `installation_repositories`; this was verified against GitHub's actual registration form. Repository creation uses `repository_creation`. Separate App IDs, installation IDs, agent IDs, and key paths are required. The broker validates the actual installation owner, personal-account target, selected-repository mode, suspended state, and exact permissions before use. A broader or missing permission is a blocker.

GitHub's Coordinator permission is broader than two installation IDs. The broker enforces those two fixed IDs and never exports a Coordinator token. This boundary relies on the trusted controller. Worker tokens are independently narrowed by GitHub to one repository and one role's exact permissions.

On the Linux controller, prepare a dedicated directory such as `/etc/paperclip/github-project-apps` with mode 0700. Store the operator-managed configuration and the three PEM files with mode 0600, owned by root or the controller service user. PEMs must never enter agent workspaces, agent environment variables, company secrets, task bodies, source repositories, logs, or desktop transcripts. Keep the mutable ledger in a separate mode-0700 controller directory such as `/var/lib/paperclip/github-project-apps`. The service user needs write access there. Do not mount either directory into a worker. Existing instance backup procedures must cover these directories without exposing their contents.

The service rejects symlinked paths, unprotected modes, oversized files, duplicate identities, and Windows execution. File permissions protect against worker access only while agents run on the remote worker identity. Shared worker processes can still inspect or reuse each other's delivered tokens. This is not strong agent isolation. Docker remains deferred.

Configuration shape (all values below are placeholders; never put a PEM into this file):

```json
{
  "version": 1,
  "companyId": "00000000-0000-4000-8000-000000000001",
  "owner": "Hdom",
  "stateDirectory": "/var/lib/paperclip/github-project-apps",
  "apps": {
    "coordinator": { "appId": 1, "installationId": 101, "agentId": "00000000-0000-4000-8000-000000000002", "privateKeyPath": "/etc/paperclip/github-project-apps/coordinator.pem" },
    "implementer": { "appId": 2, "installationId": 102, "agentId": "00000000-0000-4000-8000-000000000003", "privateKeyPath": "/etc/paperclip/github-project-apps/implementer.pem" },
    "reviewer": { "appId": 3, "installationId": 103, "agentId": "00000000-0000-4000-8000-000000000004", "privateKeyPath": "/etc/paperclip/github-project-apps/reviewer.pem" }
  }
}
```

## Coordinator first-run operation

From its currently owned, active project task, the Coordinator requests `POST /runtime-tools/github/project` with an empty JSON object. It uses the existing GitHub runtime capability (`github_credentials` scope), not a Board credential. Browser sessions are rejected. Native session transports bind the call to their current run. The remote callback bridge permits only this exact additional POST path. Caller-supplied owner, project, repository, installation, role, permission, or credential fields cannot select authority.

The controller derives the company and project from persisted run/task records. It checks current task ownership, execution binding, source trust, effective trust preset, agent and project pause/archive state, hidden historical tasks, and ancestor pause holds. It rechecks authority around external operations. It refuses a project workspace that points at an unrelated existing repository. It never adopts an existing repository merely because its name matches.

The requested private repository name is deterministic: `Hdom/paperclip-<project UUID>`. Creation includes an initial README and disables issues, wiki, and projects. The successful response includes `repositoryId`, `repositoryUrl`, `fullName`, and `status: ready`; it contains no credential. The Coordinator then uses the normal project workspace API to attach that returned URL. No automatic project dispatch or live run is added by this enhancement.

The broker records creation intent durably before `POST /user/repos`, records the returned repository ID before enrollment, and adds only that repository to the two configured worker installations. It checks each installation can issue the required one-repository token. Temporary controller verification tokens and Coordinator tokens are revoked after use. An idempotent retry after completed creation resumes enrollment without another create call. A per-project exclusive lock serializes concurrent callers.

GitHub documents that enrollment requires repository admin access. It also lists installation tokens with `installation_repositories: write` as supported. This enhancement tries only the narrow approved token; any HTTP 403/404 remains a blocker. It never adds Administration, switches to a PAT, or borrows the owner's OAuth identity. The sandbox tests prove this refusal behavior, not that GitHub accepts narrow enrollment in Hdom's live account. Live enrollment remains to be verified after App setup. Whether GitHub permits an initially empty selected-repository worker installation also remains an account-UI bootstrap check. Do not grant unrelated repositories to bypass it.

## Worker credential delivery

Existing operation-time GitHub credential acquisition resolves configured worker roles through this broker before the OAuth path. Git/gh launchers and native transports retain their existing credential handling. A configured worker with missing, revoked, broader, or unavailable App access fails closed; it never falls back to a personal credential. Configured roles also suppress host GitHub fallback and OAuth-backed GitHub MCP selection/dispatch through the existing identity-selection seam. They use Git/gh with their project App; existing OAuth grants remain stored for other agents and users. Unconfigured agents and a disabled feature retain the existing behavior.

For each acquisition the controller requests an installation token with an explicit single `repository_ids` entry and exact role permissions. It validates the returned repository scope, permissions, and expiry, then checks the repository still matches its private Hdom binding and verifies the App bot's public identity. Commit author settings use the verified bot ID and login. No arbitrary token, private key, or JWT is persisted in the project ledger. The existing in-memory credential environment is delivered to the command only.

GitHub installation tokens expire after one hour. An already delivered token can remain usable until expiry even if its Paperclip run stops; stopping blocks further acquisition. No claim of immediate revocation or strong shared-worker isolation is made. Tokens used only for controller provisioning/verification are revoked promptly. Cleanup failure does not extend their one-hour maximum lifetime.

## Failure and recovery

A provider timeout during repository creation has an uncertain outcome. The ledger remains `creating`, and subsequent calls stop for controller reconciliation. Do not delete that record and blindly retry. The operator must inspect GitHub for the deterministic repository, verify its identity and approved provenance, and deliberately reconcile the protected ledger. A crash can leave a `.lock` file; remove it only after proving no provisioning operation is running. Normal failures release the lock. The feature adds no recurring polling worker.

If creation succeeded but enrollment is refused, the ledger remains `created`. Existing repositories are never deleted or modified to compensate. Correcting an approved installation and retrying resumes the fixed enrollment steps. Report the exact refusal instead of expanding access.

For rollback, unset the feature's controller environment variable and restart the service using the existing release workflow. Preserve the ledger and key directory for recovery. Revoke or uninstall only specifically approved App identities; do not modify existing unrelated GitHub installations. Disabling the feature restores existing resolver behavior, so separately remove any role's personal access if that fallback would violate the operator's intended policy.

## Validation and limits

Focused tests use synthetic RSA keys, an actual local HTTP server that verifies JWT signatures, protected temporary files, and a real embedded PostgreSQL database through Paperclip's runtime routes. Tests cover role/repository restrictions, scope drift, bot identity, stop and archive denials, uncertainty, restart, transport allowlists, token cleanup, and existing OAuth credential behavior. They do not create a GitHub repository or call GitHub with live credentials.

Official sources: [repository creation](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user), [installation enrollment](https://docs.github.com/en/rest/apps/installations#add-a-repository-to-an-app-installation), [scoped one-hour installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
