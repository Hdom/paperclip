# Fork release candidates

Inherited workflow files stay unchanged at their upstream `.github/workflows/` paths. Their execution is disabled through GitHub workflow settings, not by moving or editing the files. This avoids workflow-file merge conflicts when updating from upstream.

The only enabled workflow is **Fork Linux release**, triggered manually from Actions. Before enabling repository Actions, verify every inherited workflow is disabled. It builds a full reviewed commit SHA (not a moving branch), typechecks the workspaces, runs four focused handoff regression suites, assembles the CLI/server dependency closure, and checks relocation. It does not claim the full upstream test suite passed.

Default output is a 14-day Actions artifact. The optional `draft_release` input additionally saves the candidate as a **draft** GitHub Release. Publishing the draft and activating a release are separate operator decisions. No npm/GitHub Packages publication is needed for the native Linux installation.

Build target: Ubuntu 24.04 Linux x86_64, Node 24.22.2, pnpm 9.15.4, Rust 1.97.1. The payload includes dependencies and native build outputs, not a Node runtime. A compatible Linux/glibc target and Node runtime are required. Inspect the manifest and checksums before use. Release builds are not bit-reproducible: the locked application dependencies are used for compilation, but the upstream packaging path resolves external runtime package ranges during installation. The payload and its sanitized resolved dependency lock are captured for auditing. Source dependency patches are preserved on every discovered installed copy; version drift or an unrecognized patch state blocks the artifact. The manifest records patch and final file hashes. The resolved npm lock records the downloaded dependency graph before source-patch materialization; it is an audit record, not a reinstall recipe.

No production endpoint, SSH key, Atlas token, database credential, or GitHub PAT is needed in this workflow. Build jobs have read-only repository permission; the draft job alone has contents-write permission through the short-lived GitHub token. There are no pull-request, push, schedule, or workflow-run triggers and no self-hosted runners.

Before deployment, separately qualify startup/database migrations against a disposable fixture on the target runtime, verify backups and a rollback plan, drain admissions, and obtain deployment authorization. Artifact creation alone never deploys or restarts a service. Do not run the upstream updater expecting it to preserve this fork.

## Qualification findings

The initial packaging attempts exposed upstream installer-path gaps: runtime skills were not staged by a plain workspace build, and bundled workspace dependency rewriting assigned the server version to the independently versioned plugin SDK. The fork packaging script explicitly stages runtime skills and uses each dependency’s actual workspace version. These are packaging changes, not application-source changes. Failed attempts remain visible in workflow history; do not treat a successful source build as proof of a complete installable release.


## Upstream updates

Keep inherited workflow contents unchanged. GitHub workflow disabled states are repository metadata, not source commits. Newly introduced upstream workflow files may register as enabled, so temporarily disable repository Actions before updating branches, enumerate all workflow definitions, disable every inherited workflow through GitHub controls, and verify the final list before re-enabling Actions. Never assume a newly added upstream workflow inherited the old disable state.


The first hosted build and typecheck passed, but the initial test invocation used a 15-second global deadline for scheduler tests containing 40-second bounded waits. It failed 3 tests (97 passed, 1 fixture skipped). The fork workflow now restores the prior qualification profile: one worker and 60-second test deadline, with every assertion unchanged. This correction is not a pass claim; inspect the succeeding run’s actual test outcome.



Packaging executes dependency lifecycle scripts. Use a fresh disposable build checkout/account, as the hosted workflow does. A temporary HOME and filtered environment reduce accidental configuration reuse but are not an operating-system security sandbox. A clean Git tree alone does not attest ignored build outputs or dependencies; the fresh frozen install and build steps are part of the artifact’s trust chain.

