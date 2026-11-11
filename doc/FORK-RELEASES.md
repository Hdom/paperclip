# Fork release candidates

This fork does not run upstream CI, scheduled jobs, npm publishers, or Docker publishers. The inherited workflow definitions are preserved under `.github/upstream-workflows/`, outside GitHub Actions discovery. Do not move them back during upstream merges.

The only active workflow is **Fork Linux release**, triggered manually from Actions. It builds a full reviewed commit SHA (not a moving branch), typechecks the workspaces, runs four focused handoff regression suites, assembles the CLI/server dependency closure, and checks relocation. It does not claim the full upstream test suite passed.

Default output is a 14-day Actions artifact. The optional `draft_release` input additionally saves the candidate as a **draft** GitHub Release. Publishing the draft and activating a release are separate operator decisions. No npm/GitHub Packages publication is needed for the native Linux installation.

Build target: Ubuntu 24.04 Linux x86_64, Node 24.22.2, pnpm 9.15.4, Rust 1.97.1. The payload includes dependencies and native build outputs, not a Node runtime. A compatible Linux/glibc target and Node runtime are required. Inspect the manifest and checksums before use. Release builds are not bit-reproducible: the locked application dependencies are used for compilation, but the upstream packaging path resolves external runtime package ranges during installation. The payload and its dependency lock are captured for auditing.

No production endpoint, SSH key, Atlas token, database credential, or GitHub PAT is needed in this workflow. Build jobs have read-only repository permission; the draft job alone has contents-write permission through the short-lived GitHub token. There are no pull-request, push, schedule, or workflow-run triggers and no self-hosted runners.

Before deployment, separately qualify startup/database migrations against a disposable fixture on the target runtime, verify backups and a rollback plan, drain admissions, and obtain deployment authorization. Artifact creation alone never deploys or restarts a service. Do not run the upstream updater expecting it to preserve this fork.
