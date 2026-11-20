# Management-only entry

This is a maintained, separate Paperclip entry for **read-only browsing** of an
approved saved projection. It uses the existing UI tokens, Button, Input, Badge,
StatusBadge and Sheet components with the company's project, task and work-status
paths. It deliberately does not mount the normal App/Layout or normal API routers:
those construct writable hooks, lifecycle owners and background execution.

It restores browsing and navigation, not edits, current telemetry, task contents,
tool use, recovery, dispatch or the full normal application. The source timestamp
and saved-snapshot status remain visible. No live refresh exists. An authenticated
restart can load a newly approved generation; that does not resume any job.

## Build and qualification

Use the repository's supported Node version and existing dependencies:

```
pnpm management:build
pnpm management:typecheck
pnpm management:test
pnpm management:test:browser
```

The build independently assembles `server/dist-management/entry.mjs` and
`ui/dist-management`. Its server closure permits only the four management source
modules and Node built-ins. The UI closure permits the management UI and listed
pure native components; normal App, contexts, API hooks and service-worker code
are excluded. Generic `ui/public` copying is disabled. Only the entry HTML,
emitted JS/CSS and three named native fonts are hashed into the exact asset map.
Unlisted paths and ordinary API/MCP routes are unavailable.

The browser qualification starts the **actual compiled CLI** with synthetic data
and synthetic human assertions. It checks desktop and phone navigation,
project → task → run details, search, deep reload, Sheet close, strict CSP,
all asset requests, restart, denied anonymous/expired access and absence of
unexpected requests. It neither starts the normal app nor calls real providers.
The tests also exercise human/company/digest/signature/time refusals, immutable
data, file replacement, unsafe ancestors/links, asset tampering and write denial.

## Exact archive qualification

The fork's Linux qualification workflow retains its existing coverage and adds
management build/type/integrity checks. After the normal package qualification,
it assembles a separate `paperclip-management-<source>.tar.gz` and checks that
exact archive. This archive contains only the management entry, reviewed static
assets and generic closure/source manifests. It contains no data or auth config.

`scripts/package-management.mjs` requires a clean exact source revision and
rebuilds its inputs. `scripts/qualify-management-archive.mjs` checks the archive
digest through a stable descriptor, bounded decompression, file-only inventory
and every extracted file digest before
running the negative tests and real CLI/browser acceptance from the extraction.
The same immutable verified tar bytes feed listing and extraction; replacement
or in-place archive mutation during capture is refused before execution.
The hosted artifact records the exact source/archive digest and synthetic test
evidence. It does not publish or activate a release, configure live access or
start the normal runtime. The ordinary app/operator packages remain unchanged.

## Projection and file authority

`server/src/management/projection.ts` owns the exact bounded v1 schema. It accepts
one company, project IDs/names/statuses, task IDs/identifiers/titles/statuses and
relations, agent IDs/names/statuses and run IDs/status/recovery classifications.
No bodies, comments, instructions, logs, tool configuration, private notes,
documents, credentials, signing keys or arbitrary metadata fields are accepted.
Relations must stay inside the projection. All display strings are inert text.

Inputs must be exact UTF-8 canonical JSON: object keys sorted recursively,
compact separators and ordinary JSON string/number encoding, with no trailing
newline. This rejects duplicate fields and alternate encodings. The source
timestamp is a round-trippable UTC ISO timestamp with milliseconds. Maximum
projection size is 1 MiB; maximum configuration size is 16 KiB.

The Linux loader pins every physical ancestor with metadata-only O_PATH handles;
all must be owned by root or the service UID and deny group/other writes. It
refuses symlinks, hard-linked files, writable files, changed identity/owner/group,
nanosecond metadata changes and named-path replacement. Configured file reads
use O_NOATIME, so an unprivileged launcher must own the readable files; do not
grant capabilities as a workaround. A deployment should mount these files
read-only in the isolated process. It copies validated bytes once into memory,
never opens the database or discovers native configuration/Secrets, and has no
file write, export or dynamic source refresh path. This does not prove isolation
from hostile root or another process with the same UID.

The configured projection, auth and asset tree must be published as one finished,
immutable approved generation before launch. The loader stably reads each file;
it does not provide an atomic multi-file snapshot while a publisher edits them.
Pin exact generation paths/hashes and mount them read-only, rather than update
inputs under a running or starting process.

## Human authentication

There is **no anonymous, local-trusted or demo bypass** in deployable code.
Startup requires explicit projection, auth and asset paths. Auth config has only:

```
schema: paperclip.management-auth.v1
issuer: exact trusted human gateway issuer
audience: exact management-only audience
publicKeyJwk: { kty: OKP, crv: Ed25519, x: public key }
humans: [{ subject: exact authenticated human subject, companyId: projected company }]
```

No private signing key is accepted. The service only verifies; it cannot mint a
credential or contact JWKS/OIDC servers. A trusted authenticated human gateway
must strip client-supplied authority headers and inject a fresh `Authorization:
Bearer` assertion on every page, asset and API request. Ordinary Board/agent API
keys and arbitrary native JWTs are not transparently accepted by this protocol.

The signed header is exactly `{alg: EdDSA, typ: JWT}`. Signed claims are exactly
`iss`, `aud`, `sub`, `principalType: human`, `companyId`, `projectionSha256`,
`iat`, `nbf`, `exp`. Both header and payload require the canonical JSON encoding
above before base64url encoding. `projectionSha256` is the SHA-256 of the exact
canonical approved projection. Times are integer seconds; `nbf == iat`, lifetime
must be positive and at most 60 seconds, future skew at most two seconds, and
expiry has no grace. The subject must be explicitly granted for that company.
Unknown claims, token-provided keys/URLs, non-EdDSA algorithms, absent or duplicate
authorization and wrong generation/company/human identity all fail closed.

Assertions are replayable during their short validity. There is no immediate
logout/revocation subsystem: stop the management process or rotate its approved
auth generation if emergency invalidation is required. Assertions must never
enter URLs, browser storage, logs or static assets. Browser tests generate keys
only in memory in test helpers; no test issuer or signing code is in the entry.

GET/HEAD are the only admitted methods. Writes, upgrades, CONNECT, request bodies,
queries, arbitrary paths and untrusted Host/Origin are denied. The CLI binds
127.0.0.1 only and the handler rechecks the actual listener address. No permissive
CORS exists. Normal reverse-proxy Host rewriting is required; Origin policy is
not silently extended to arbitrary external origins. A per-response style nonce
allows the existing Sheet's reviewed style singleton without unsafe-inline;
scripts remain self-only. There is no service worker or persistent browser cache.

## Operational boundary

The explicit, separate entry syntax is:

```
node server/dist-management/entry.mjs --projection /approved/projection.json --auth /approved/public-auth.json --ui /approved/ui --port 3201
```

This is a syntax example, not authority to launch a production listener. The
normal CLI, guarded launcher, service unit, maintenance state, stop receipts,
database, recovery holds and wakes are unchanged. No runtime rollback is needed
to serve this entry, and it must never be used to evade the normal launch guard.

**One deployment gate remains:** approve and verify the exact human-authenticated
ingress plus approved immutable data delivery and isolated process launch as one
bounded management-access change. That gate must prove real issuer/session
authority, all-path protection, TLS/private ingress, no anonymous fallback,
read-only mounts, no access to native env/Secrets/workspaces/database, and denied
outbound execution. The implementation alone does not create that gateway,
copy live data, grant permissions, publish a release or deploy anything. Keep
the original runtime interlocked and both saved job obligations held throughout.
