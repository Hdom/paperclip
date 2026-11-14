# Fork qualification and package performance

The qualified `43634728673` run took about 38 minutes: workspace build 502 s,
typecheck 287 s, handoff regressions 204 s, scoped App/native Secrets regressions
610 s, browser install/acceptance 94 s, and package/relocation 367 s. Dependency
installation was 63 s. These are observations of that run, not a promised budget.

`fork-github-app-regressions.mjs` retains one fresh Vitest process per server
suite and serial execution within each process. At most two top-level tasks run
at once. All tasks are attempted after a failure; any failure rejects the gate.
`--list` prints a side-effect-free inventory. The committed inventory test guards
the qualified files, working directories and the two explicitly documented
baseline-gap filters. The integrated inventory retains all 26 baseline tasks and
adds the two generic signing-key server/parser suites plus the signing-key UI
suite, for 28 tasks in total. Add new coverage deliberately to both the script and
inventory. This is not a claim that the unrelated full server suite is green.

The workflow caches public pnpm downloads, Cargo registry/git/compiler target
inputs, and npm's `_cacache`, keyed by platform, architecture, pinned toolchain
and relevant lock/patch inputs. It still runs frozen dependency installation,
all workspace builds and typechecks, every prior regression/browser gate,
package graph and patch integrity verification, relocation and smoke checks.
No `node_modules`, Paperclip home, operator credentials, signing keys, live
configuration, databases, or release payloads enter those caches. Caches are
reusable build inputs, never proof that a check passed.

The packager optionally accepts an absolute public npm cache directory as its
fourth argument. It rejects symlinked paths, builder ownership/mode violations,
and overlap with source/output. Its default remains a fresh cache. Subprocesses
still use a separate temporary HOME, public registry, no npm user configuration,
and the existing environment allowlist. All package/install checks still run.

Use exact-source GitHub Actions cold and warm runs to measure actual improvement
and validate resource contention. The scheduler/cache unit tests establish
bounds and failure semantics, not production timing. No active CI run is
cancelled by these changes; release concurrency keeps `cancel-in-progress: false`.
Candidate upload and draft-release creation still require every preceding gate.

GitHub's [cache reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
documents key scope, immutable cache entries, and why credentials must be excluded.
The official cache action is pinned to an immutable commit in the workflow.
