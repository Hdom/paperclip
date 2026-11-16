# Native GitHub App connections

GitHub's **App installation** connection method is separate from the managed
human OAuth method. An operator can import the three prepared role identities
without connecting Paperclip to Paperclip Cloud. App verification, Git/gh
credentials and repository enrollment use the local Paperclip service and
GitHub's API. The hosted MCP compatibility verifier is a separate operator test of GitHub's
service. Production App actions use a bounded native REST catalog and do not
depend on hosted MCP or Paperclip Cloud.

## Setup and access

Open Apps → GitHub → Connect and choose App installation. The current setup
imports the three prepared, verified identities together. It preserves the
existing App IDs, installations, signing-key secret IDs/versions and repository
ledger. Creating/registering other Apps and changing their permissions or
installation repository selection still require the GitHub owner's actions;
Paperclip links to those GitHub settings and verifies the expected permission
boundary. No account or repository Administration permission is added.

Each connection's Permissions screen shows its dedicated agent, external bot,
installation, repository selection, signing-key link and separate capabilities.
The Coordinator connection owns company-wide issuance pause/resume and explicit
release of former assigned agents. Other role connections link there.
Assignment requires both old and new agents to be paused with no queued/running
runs. Releasing a former agent requires that agent paused and drained: release
restores the ordinary GitHub credential rules already configured for it.
Resuming issuance requires all three assigned agents paused and drained.
Pausing new issuance does not require pausing agents, does not grant fallback,
and does not revoke already delivered tokens at GitHub.

Protected signing keys appear under Settings → Secrets → Signing keys in the
existing table/sidebar pattern. Public metadata, usage, version history and
bounded access events are visible to authorized board users. An instance
administrator with connection management authority can stage and verify a
replacement for its exact App, then separately verify/activate a version.
Staging never changes the active pin. Old GitHub keys must be revoked separately
after a verified cutover. Generic RSA, EC and Ed25519 signing keys remain
service-neutral; they cannot be revealed, exported or bound to agents.

## Authority and security

After explicit import, `github_app_settings` is the active policy authority.
Configuration, dedicated grants and agent installations change in one database
transaction. References in this table are not private key material. Private keys
remain encrypted native Secrets and the dedicated signer does not expose values
or a general signing API to agents. The protected instance master key and
operational ledger location remain host configuration, not agent controls.

Every project credential operation rechecks policy, its native connection,
grant, installation and live run/task/project authorization. Missing or stale
native authority fails closed for intended principals without disabling other
agents' existing GitHub connections. Generic connection, grant, install, OAuth,
secret-reference and deletion APIs cannot rewrite these dedicated identities.

GitHub installation selection is the ceiling; worker tokens are downscoped to
the current provisioned project repository and role permissions. The known empty
starter is only an installation inventory/bootstrap exception, never a worker
project token target. The Coordinator keeps provisioning credentials inside
Paperclip and uses the typed creation/enrollment operation. It does not receive
a raw provisioning token or generic MCP repository creation authority.

GitHub API actions publish from a role-specific static catalog without reading
credentials or selecting a background project. New actions are quarantined/off
until reviewed through the existing Actions controls. Calls bind signed approval
to the native policy revision, role, connection, grant, run, issue, project and
repository ID. Dispatch rechecks that authority before every outbound request,
uses a fresh scoped token and revokes it afterward. The action/mint/verification
budget is at most 30 seconds; known-token cleanup has a separate bounded 10-second
budget so it remains available after Stop or an action deadline. Cleanup failure
is reported separately from an already successful write, never as a safe reason
to repeat it. An interrupted mint can leave an unobserved provider token until
its at-most-one-hour expiry; no such token is delivered to an agent. No token or MCP session cache
is shared between calls. Only current-project file/commit/branch/PR/review
operations are available; workflow-file writes remain outside the approved
permissions. There are no owner/repo/URL overrides, global search,
GraphQL, fork or merge action. Coordinator stays provisioning-only. Ask-first
tool rules do not constrain shell Git or gh. Reviewer
Pull requests write is broader than reviews-only at GitHub. Shared worker OS
identity remains an accepted limitation; this integration does not provide
strong process isolation.

## Migration and rollback

Migrations 0467 and 0468 add the auth kind and native policy table. Import is an
explicit confirmed operator action after verifying all three Apps and draining
the assigned agents. Reads never repair mismatched identities. Existing native
Secrets, versions and GitHub installation selection are retained.

The retained protected legacy configuration becomes a pre-import recovery
artifact, **not** an active mirrored policy. Once native assignments, blocked
history, enabled state or signing pins diverge, deploying an older binary alone
is unsafe: it would read stale policy. Rollback must use either a qualified
native-settings-aware release or the matching pre-import database and protected
legacy configuration, with operation admission paused and all intervening
changes reconciled. Key decryption/fingerprint parity alone is insufficient to
qualify rollback. Preserve encrypted backups and the instance master without
creating plaintext key backups. Never silently substitute the legacy file for a
missing native connection or policy.

Before production import/deployment, verify a synthetic database upgrade,
transaction failure recovery, audience isolation, assignment/release admission
fences and both sides of the chosen rollback boundary. Do not launch a project
or change repository access merely to prove the UI.

## Qualification

The fork qualification inventory retains every baseline suite/filter and adds
native import/authority, ordinary GitHub selection, connection setup and key
lifecycle coverage. Operator helpers in `scripts/operations` have separate
offline tests in the release workflow. The bounded MCP verifier defaults to catalog-only behavior. Its separately
reviewed metadata mode tests exactly one private-bootstrap search per worker
identity with metadata-only tokens. Neither mode qualifies contents or PR
operations, and neither changes production API action permissions. Real provider probes require an explicit
reviewed scope and must revoke their short-lived tokens.

## GitHub identity choice and shared Secrets collection

GitHub Add account first asks which actor will be used: a GitHub user account
through managed sign-in, or a GitHub App installation. Personal access tokens
remain under Advanced. Only managed sign-in requires Paperclip enrollment.
The App path stays local and retains the requesting agent and completion context.
Reconnects and enrollment returns retain the selected method. The three prepared
App identities show existing connections instead of offering a repeat import.

Signing keys reuse the regular Secrets toolbar, responsive row/card, status,
relative-time, folder row and details components. Search is global and temporarily
uses flat view. Empty folders are navigation paths until a key is added or moved,
as in regular Secrets. Key-specific filters are Status and Type. Versions is an
extra details tab because stored and active service versions differ. Import,
rotation and generic lifecycle changes require explicit action and fresh review;
the default sidebar contains public metadata only.

Display folders use dedicated signingFolderPath/signingOrganizationRevision
provider metadata. They never rename a stored key or alter its scope, consumer,
App/role binding, ciphertext, versions, signing pins or grants. The dedicated
organization endpoint accepts only a folder path and fresh concurrency guards.
It requires Board/company access, instance administration and the existing
same-origin check. Generic secret APIs remain unable to mutate signing keys.
Managed keys retain their verified connected-service lifecycle. No data migration,
key re-import, App installation change or agent execution is required for this UX.

Older native-settings-aware releases ignore the additional presentation metadata;
their signing authority and active pins remain compatible. Qualify rollback against
the same native database and master key; older pre-native releases remain unsafe
as described above. Do not restore a pre-receipt database for a UI rollback.
