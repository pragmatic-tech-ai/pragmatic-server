# SP-GRAPH-4 — Runtime loads a promoted graph (Development → Runtime promotion)

**Parent design:** `docs/superpowers/specs/2026-10-20-environments-graphs-admin-design.md` (approved). This spec covers Milestone-1 sub-project 4 only. SP-GRAPH-1/2/3a/3b already shipped (typed environments, admin-created container-owned graphs, maker-authenticated additive contribution, Plexus contribute client).

## Intent

A development environment is the system of record for a named graph and its accumulated packages. SP-GRAPH-4 adds the spine that carries that graph into a runtime environment where it can run: the admin center promotes a chosen development-environment graph's current manifest into a chosen runtime environment. The runtime pulls the compiled packages the manifest names, initializes a single live graph instance, exposes it for reads on the environment's endpoint, and the admin panel shows the runtime's loaded graph. SP-GRAPH-5 (next) adds the remote-target application that reads that instance, closing the loop; this slice stops at "promoted, loaded, exposed, shown."

Promotion is an admin-center action against stored artifacts, relayed by the control plane. The two containers never reach each other: the control plane reads the packages out of the development container (as that environment's Owner) and writes them into the runtime container (as that environment's Owner). Plexus never pushes to a runtime.

## Functional requirements

- **FR1 — Admin promotes a dev graph into a runtime.** The admin center, viewing a development environment's graphs, promotes a chosen graph's current manifest into a chosen runtime environment. One route, operator-authenticated, CSRF/Origin-gated like every other control-plane mutation.
- **FR2 — Type enforcement, fail-closed.** The source environment must be Development and the target must be Runtime. A non-Development source or non-Runtime target is rejected before any package is moved (new `EnvironmentNotRuntimeError` mirrors `EnvironmentNotDevelopmentError`). A missing environment is a 404; a missing graph is a 404.
- **FR3 — Dev-side export.** The control plane reads the chosen graph's current *effective* package set (the union/dedupe already computed by `DevGraphService.EffectivePackages`) and each package's compiled `model.json` content out of the development container. This is a read-only operation against the dev container's packages volume; it does not mutate the dev graph.
- **FR4 — Runtime-side load, replace-on-promote.** The runtime container ingests the promoted packages immutably into its own packages volume (byte-identical re-ingest is a no-op; a differing re-ingest of the same `{id,version}` is a conflict, matching existing package-immutability discipline), then initializes exactly one environment-scoped graph instance built from the promoted package set. Promoting again replaces the instance (one graph per runtime environment; no versioning, no per-app pinning). The runtime records the loaded manifest (graph name, package refs, promoted-at).
- **FR5 — Exposed on the endpoint.** The loaded environment graph is queryable (reads) over the runtime environment's existing per-tenant transport, selected without a bound application. It is a new read target beside the per-app graph machinery — bundled apps keep their per-app graph; nothing about app serving changes. Authoring operations (graph create/contribute, cypher execute, dev model-scoped reads) remain closed on a runtime environment.
- **FR6 — Admin shows the loaded graph.** The admin panel, viewing a runtime environment, shows its loaded graph: name, package count (or refs), and promoted-at — read back from the runtime's recorded loaded manifest. A runtime with nothing promoted shows "no graph loaded."
- **FR7 — Secret hygiene.** Owner credentials and any issued tokens used for the relay are never logged, echoed, returned in a DTO, or surfaced in an error message. The promotion result DTO carries only non-secret status (graph name, package count, target environment).

## Non-goals (this slice)

- The Plexus remote-application build target and the end-to-end app-reads-the-graph proof (that is SP-GRAPH-5).
- Writes against the environment graph (the milestone's proof is a read; data/write against the env graph is deferred). The RBAC read-authorization refinement for remote apps (general read-grant vs fail-closed) is SP-GRAPH-5's concern; SP-GRAPH-4 exposes reads to an authenticated runtime principal under the existing RBAC `readTenant` gate, verified in the smoke as the Owner.
- Multi-graph-per-runtime, graph versioning/rollback UX, blue/green promotion, cross-environment package dedup.
- Provisioned databases/connectors (Postgres) — later milestone.

## Design-detail rulings (made here; confirm at plan review)

- **R1 — Dedicated protocol ops, not app-deploy reuse.** A graph is not an application (no UI bundle, no servable manifest), so promotion uses dedicated ops rather than overloading `ApplicationDeployProtocol.Deploy`: a dev-side `graph/export` (returns the effective packages with `modelJson`) and a runtime-side `graph/load` (accepts graph name + packages, builds+stores the instance), plus a runtime `graph/loaded` read (returns the recorded loaded manifest or none). All on the existing `GraphProtocol`/a sibling contract, with `PragmaticClient` wrappers.
- **R2 — Promotion is dev-side, graph-scoped.** Route `POST /api/environments/:devEnv/graphs/:graph/promote` with body `{ targetEnv }`. The admin is looking at a dev graph and chooses where it lands. (Not a runtime-side "load from" route.)
- **R3 — Export read path on the dev container.** `GraphPackageIngest` is write-only today; SP-GRAPH-4 adds a sibling read (e.g. `GraphPackageReader.Read(ref)`/`ReadAll(refs)`) over the same packages `IStorage` + `<id>/<version>/model.json` layout, and `DevGraphService.ExportGraph(params)` composes `EffectivePackages` (promoted from private) with that read to yield `ContributedPackageDto[]`. The `graph/export` handler is `EnsureDevelopment`, policy-gated `readTenant` (reading content is a read).
- **R4 — Env-graph instance lives on `PragmaticServer`.** A new per-tenant holder beside `appGraphs`/`devGraphService`, built via the same `RuntimeAppGraph.BuildDomain(new StoragePackageSource(PackagesStorage()), { packages })` path apps use; replace-on-promote. Ingest reuses the immutable-write discipline (an `AppIngestService`-style package writer, or `GraphPackageIngest` pointed at the runtime packages volume). The `graph/load` handler is `EnsureRuntime`, policy-gated `administer` (matching `application/deploy` and graph create/delete).
- **R5 — Env-graph read target.** `RunCypherQuery` on a Runtime tenant, with no bound app and no model id, resolves to the environment graph via a new `envGraphProvider` threaded through `RuntimeAttachArgs` → `Attach`; RBAC applies through the existing gate (`readTenant`). The today-only `RequireBoundAppGraph` path for bound apps is unchanged. Authoring gates (`EnsureDevelopment` on create/contribute/execute, model-scoped read rejection on Runtime) are unchanged.
- **R6 — Loaded-manifest record.** The runtime persists a small loaded-manifest record (graph name, package refs, promoted-at) in its tenant volume so `graph/loaded` and the portal can read it back after a restart; replace-on-promote overwrites it.
- **R7 — Control-plane orchestration.** `GraphService.Promote(sourceEnv, graphName, targetEnv)` resolves two `AdminConnectInfo`s via the existing `adminInfoFor` callback (source Development-gated, target Runtime-gated), calls `proxy.ExportGraph(sourceInfo, { graphName })` then `proxy.LoadGraph(targetInfo, { graphName, packages })`, and returns a leak-free `PromotionResultDto`. New `IAdminProxy`/`IAdminConnection` methods `ExportGraph`/`LoadGraph`/`GetLoadedGraph`; error classification reuses `GraphService.Classify` + new host `ErrorStatuses` entries.

## Review focus (inputs the FRs imply but no single task's happy path exercises)

- **Promote with an empty graph** (admin created it, no solution contributed yet): export yields zero packages; the runtime load must succeed with an empty instance (or reject cleanly with a clear message) — not crash. Decide and pin one behavior.
- **Promote onto a runtime that already has a graph loaded** (replace): the old instance and its loaded-manifest record are fully replaced; a subsequent `graph/loaded` reflects the new graph only; no stale packages are served.
- **Wrong environment types**: Development target or Runtime source rejected before any transfer (FR2); the error names which side was wrong.
- **A package present in the dev graph whose `model.json` blob is missing on disk** (corrupt/partial contribution): export fails with a clear error naming the missing `{id,version}`, rather than silently exporting a short set.
- **Querying a runtime env graph before anything is promoted**: a read against the env-graph target with no loaded instance returns a clear "no graph loaded" error, not a null-deref.

## What the engineer inherits (do not rebuild)

- Control plane + Mural portal + operator auth; `EnvironmentService.AdminInfoFor` (per-env Owner credential) and the single-connection `AdminProxy.With` pattern; `GraphService` dev-gate + `Classify` + `GraphDto` projection.
- `DevGraphStore`/`DevGraphService` (slices + `EffectivePackages`) and `GraphPackageIngest` (immutable write, `<id>/<version>/model.json` layout) on the dev container.
- `RuntimeAppGraph.BuildDomain` + `StoragePackageSource` + `Domain`/`GraphQuery` (packages → queryable graph); `AppIngestService` immutable ingest; `PragmaticServer` per-tenant holders + `RuntimeAttachArgs`/`DevelopmentAttachArgs` threading; `PolicyGate` deny-by-default table; `EnsureRuntime`/`EnsureDevelopment`.
- `GraphProtocol` + DTOs (`GraphDetailDto`, `ContributedPackageDto{id,version,modelJson}`, `GraphRefParamsDto`); `PragmaticClient` wrappers; the portal view/navigator/api-client patterns (`GraphListView`, `CreateGraphView`, `MakerTokenView`, `environment-detail-view` type-branching).

## Cross-repo + conventions

- Repos: `pragmatic-protocol` (ops + DTOs + client, dist rebuilt), `pragmatic-server` (host + control-plane + portal). Build order protocol → server; rebuild protocol dist before server typechecks/tests see it. In-place feature branch `feat/sp-graph-4` in each repo (not worktrees).
- OOP, Allman braces, PascalCase interfaces/public methods, enums over string literals, no inline reused string literals (hoist to `private static readonly`), LF-only. Secrets never logged/echoed/returned/in DTOs. Nothing pushed without explicit instruction.
- Exit: a gated control-plane smoke promotes a contributed dev graph into a runtime environment and asserts (a) the runtime `graph/loaded` reflects it and (b) a cypher read against the runtime env-graph target returns the promoted content; portal shows the loaded graph on a runtime env's detail. Live container e2e is operator-run (mirrors the tenant-publish/portal e2e gating posture).
