# SP-GRAPH-4 — Runtime graph promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote a development-environment graph's current manifest into a runtime environment: the control plane reads the graph's compiled packages out of the dev container and loads them into the runtime container, which builds one live environment-graph instance, exposes it for reads, and reports it to the admin panel.

**Architecture:** New dedicated protocol ops carry packages dev→control-plane→runtime (no app-deploy reuse, no container-to-container contact). The dev container gains a read/export path over its existing immutable package store; the runtime container gains a per-tenant env-graph holder built via the same `RuntimeAppGraph.BuildDomain` path apps use (replace-on-promote), a loaded-manifest record, and an env-graph read target selected without a bound app. The control plane's `GraphService` orchestrates the two-Owner relay; the portal adds a promote flow and a runtime loaded-graph display.

**Tech Stack:** TypeScript (strict, ESM); `vscode-jsonrpc` over WS; `@pragmatic-tech-ai/todl` (`Domain`/`StoragePackageSource`/`GraphQuery`); Mural web portal; `node:test`; cross-repo `file:` dist siblings.

**Spec:** `docs/superpowers/specs/2026-10-20-sp-graph-4-runtime-graph-promotion-spec.md`

## Global Constraints

- **Repos + build order:** `pragmatic-protocol` then `pragmatic-server`. After editing protocol, run `npm --prefix ../pragmatic-protocol run build` before server typecheck/tests resolve it. In-place branch `feat/sp-graph-4` in each repo (NOT worktrees — npm install over a worktree detaches the sibling symlink graph).
- **Style:** OOP (methods on classes; no module-level free functions or mutable state; module-level `const`/type/enum OK), Allman braces, PascalCase interfaces + public methods, enums over string-literal unions, no inline reused/user-facing string literals (hoist to `private static readonly` PascalCase constants), LF-only (verify `tr -cd '\r' < file | wc -c` == 0).
- **Security:** Owner credentials and issued tokens are never logged, echoed, returned in a DTO, or placed in an error message. Promotion result/loaded DTOs carry only non-secret fields.
- **Immutability:** package ingest on the runtime is byte-identical-skip / differing-conflict, crash-safe temp+rename, exactly like the existing `GraphPackageIngest`/`AppIngestService`.
- **Policy-gate is deny-by-default:** every new protocol method MUST get a `BuildTable` entry or it is rejected.
- **No push** without explicit user instruction.

## Review Focus

- **Empty graph promotion:** export of a graph with no contributed packages yields `[]`; runtime load succeeds and builds an empty instance (RULING: empty is valid, not an error) — Task 3 test `load_empty_package_set_builds_empty_instance`.
- **Replace-on-promote:** promoting onto a runtime that already has a loaded graph fully replaces the instance and the loaded-manifest record; no stale packages served — Task 3 test `second_load_replaces_instance_and_record`.
- **Wrong env types:** Development target or Runtime source rejected before any transfer, error names the wrong side — Task 5 test `promote_rejects_runtime_source_and_development_target`.
- **Missing package blob:** a graph ref whose `model.json` is absent on the dev packages volume → export throws naming the `{id,version}`, never a short silent set — Task 2 test `export_missing_blob_throws_named`.
- **Query before promote:** a read against the runtime env-graph target with no loaded instance → clear "no graph loaded" error, no null-deref — Task 4 test `env_graph_query_without_load_errors_clearly`.

---

## Task 1: Protocol ops + DTOs + client wrappers (pragmatic-protocol)

**Files:**
- Modify: `pragmatic-protocol/src/dto/wire-dtos.ts`
- Modify: `pragmatic-protocol/src/contracts/graph-protocol.ts`
- Modify: `pragmatic-protocol/src/client/pragmatic-client.ts`
- Test: `pragmatic-protocol/src/**/tests/*` (mirror existing graph-protocol/client tests)

**Interfaces:**
- Produces (consumed by server Tasks 2–5 and the control-plane proxy):
  - `GraphExportDto { name: string; packages: ContributedPackageDto[] }` — the effective package set WITH `modelJson` content (reuses the existing `ContributedPackageDto{id,version,modelJson}`).
  - `GraphLoadParamsDto { graphName: string; packages: ContributedPackageDto[] }`.
  - `GraphLoadedDto { name: string; packages: { id: string; version: string }[]; promotedAt: string }` — the runtime's recorded loaded manifest (refs only, no content).
  - `GraphProtocol.Export = new RequestType<GraphRefParamsDto, GraphExportDto, void>('graph/export')`
  - `GraphProtocol.Load = new RequestType<GraphLoadParamsDto, GraphLoadedDto, void>('graph/load')`
  - `GraphProtocol.Loaded = new RequestType0<GraphLoadedDto | null, void>('graph/loaded')` (per-tenant, no params; `null` = nothing loaded).
  - `PragmaticClient.ExportGraph(params: GraphRefParamsDto): Promise<GraphExportDto>`, `LoadGraph(params: GraphLoadParamsDto): Promise<GraphLoadedDto>`, `GetLoadedGraph(): Promise<GraphLoadedDto | null>`.

- [ ] **Step 1: Write failing tests** mirroring the existing graph-protocol/pragmatic-client tests: assert the three new `RequestType` method strings (`'graph/export'`, `'graph/load'`, `'graph/loaded'`) and that the client wrappers forward to `sendRequest(GraphProtocol.X, params)` and return the typed result (fake connection recording method + params), including `GetLoadedGraph` returning `null` passthrough.
- [ ] **Step 2: Run; confirm fail** (`npm --prefix ../pragmatic-protocol test` or the repo's test script).
- [ ] **Step 3: Implement** the DTOs (after the existing graph DTOs ~line 775–814 of wire-dtos.ts, placed with the other graph DTOs), the three ops on `GraphProtocol`, and the three client wrappers (beside `ContributeGraph` ~line 408 of pragmatic-client.ts). Ensure BOTH package barrels export any new DTO (follow how `GraphContributeParamsDto` is exported).
- [ ] **Step 4: Run; green. Build dist:** `npm --prefix ../pragmatic-protocol run build`. Commit.

---

## Task 2: Dev-side graph export (pragmatic-server)

**Files:**
- Create: `src/host/graphs/graph-package-reader.ts`
- Modify: `src/host/graphs/dev-graph-service.ts`
- Modify: `src/host/server-connection-handler.ts` (register `graph/export`, `EnsureDevelopment`)
- Modify: `src/host/policy-gate.ts` (`graph/export` → `readTenant`)
- Test: `src/host/graphs/tests/graph-package-reader.test.ts`, extend `dev-graph-service.test.ts`

**Interfaces:**
- Consumes: `DevGraphStore`/`DevGraphRecord.slices`, `DevGraphService.EffectivePackages` (promote from `private static` to usable), `GraphPackageIngest`'s packages `IStorage` + `<id>/<version>/model.json` layout, `GraphExportDto`/`ContributedPackageDto` (Task 1).
- Produces:
  - `class GraphPackageReader { constructor(packages: IStorage); ReadAll(refs: readonly PackageRef[]): Promise<ContributedPackageDto[]> }` — reads each `<id>/<version>/model.json` via `packages.ReadText`; a missing blob throws a hoisted `GraphPackageMissingError` naming the `{id,version}`. One home for the `'model.json'` constant and the path join (reuse the same segment join as `GraphPackageIngest`).
  - `DevGraphService.ExportGraph(params: GraphRefParamsDto): Promise<GraphExportDto>` — `Get`s the record (throws the existing not-found error if absent), computes effective refs, `ReadAll`s their content, returns `{ name, packages }`.

- [ ] **Step 1: Write failing tests.** `graph-package-reader.test.ts`: `ReadAll` returns `{id,version,modelJson}` for present blobs; **`export_missing_blob_throws_named`** — a ref with no blob throws `GraphPackageMissingError` whose message contains the id and version. `dev-graph-service.test.ts`: `ExportGraph` on a two-solution graph returns the deduped union with content; **empty graph → `{ name, packages: [] }`**; unknown graph → the existing not-found error.
- [ ] **Step 2: Run; confirm fail.**
- [ ] **Step 3: Implement** `GraphPackageReader`, `ExportGraph`, the handler registration in `RegisterGraphHandlers` (guarded + `EnsureDevelopment` + `RequireGraphService().ExportGraph`), and the policy-gate entry `GraphProtocol.Export → { action: Action.Read, resourceKind: ResourceKind.Tenant }`.
- [ ] **Step 4: Run; green** (server graph tests + `src/host` suite). Commit.

---

## Task 3: Runtime env-graph load + instance holder (pragmatic-server)

**Files:**
- Create: `src/host/graphs/environment-graph.ts` (the per-tenant env-graph holder + loaded-manifest record store)
- Modify: `src/pragmatic-server.ts` (holder field + `LoadEnvironmentGraph`, `EnvironmentGraph()`, `LoadedGraph()` accessors; runtime package ingest)
- Modify: `src/host/server-connection-handler.ts` (register `graph/load` `EnsureRuntime`, `graph/loaded`)
- Modify: `src/host/policy-gate.ts` (`graph/load` → `administer`, `graph/loaded` → `readTenant`)
- Test: `src/host/graphs/tests/environment-graph.test.ts`, extend server/host tests

**Interfaces:**
- Consumes: `RuntimeAppGraph.BuildDomain(new StoragePackageSource(PackagesStorage()), { packages })` (the packages→`Domain`→`GraphQuery` path, `src/host/cypher/runtime-app-graph.ts:11`), `GraphPackageIngest` (reused pointed at the runtime `PackagesStorage()` for immutable write), `PragmaticServer` per-tenant holders (`appGraphs`, `PackagesStorage`, `Purpose`), `GraphLoadParamsDto`/`GraphLoadedDto`.
- Produces (consumed by Task 4 reads + Task 5 proxy):
  - `class EnvironmentGraph` — holds the built `IGraphQuery` instance + the loaded-manifest record; `static async Build(packages: IStorage, graphName: string, refs: readonly PackageRef[]): Promise<EnvironmentGraph>`; `Query(): IGraphQuery`; `Record(): GraphLoadedDto`. Hoist `'model.json'` and the record filename to constants.
  - A loaded-manifest record persisted in the tenant volume (small JSON: `{ name, packages: PackageRef[], promotedAt }`), so `graph/loaded` survives a restart; replace-on-promote overwrites it.
  - `PragmaticServer.LoadEnvironmentGraph(params: GraphLoadParamsDto): Promise<GraphLoadedDto>` — `AssertRuntimePurpose`; immutable-ingest the packages into `PackagesStorage()`; build the instance; store it in the holder (replace any prior); persist + return the loaded record.
  - `PragmaticServer.EnvironmentGraphQuery(context): Promise<IGraphQuery>` — returns the loaded instance's query (RBAC applied by the caller/gate); throws a hoisted `NoEnvironmentGraphError` if nothing is loaded.
  - `PragmaticServer.LoadedGraph(): Promise<GraphLoadedDto | null>` — reads the record (or `null`).

- [ ] **Step 1: Write failing tests.** `environment-graph.test.ts` (+ a fake packages `IStorage` pre-seeded with `model.json`): `Build` yields a queryable instance over the packages; `Record` returns `{name, packages, promotedAt}`. Server-level: `LoadEnvironmentGraph` on a Runtime server builds + persists the record and `LoadedGraph()` reads it back; **`second_load_replaces_instance_and_record`** (two loads, the second graph name/packages are what `LoadedGraph` returns, first instance discarded); **`load_empty_package_set_builds_empty_instance`** (packages `[]` → success, `LoadedGraph` shows zero packages); `LoadEnvironmentGraph` on a Development server throws (purpose assert).
- [ ] **Step 2: Run; confirm fail.**
- [ ] **Step 3: Implement** `EnvironmentGraph`, the `PragmaticServer` holder + methods, the handlers (`graph/load` guarded + `EnsureRuntime` + `administer`; `graph/loaded` guarded + `RequireServer().LoadedGraph()`), and the policy-gate entries.
- [ ] **Step 4: Run; green. Commit.**

---

## Task 4: Runtime env-graph read target (pragmatic-server)

**Files:**
- Modify: `src/host/server-connection-handler.ts` (`envGraphProvider` in `RuntimeAttachArgs` + `Attach` threading + `RunCypherQuery` env-graph branch)
- Modify: `src/host/pragmatic-server-host.ts` (thread `envGraphProvider` into `Attach`)
- Test: extend `src/host/tests/*` connection-handler tests

**Interfaces:**
- Consumes: `PragmaticServer.EnvironmentGraphQuery(context)` + `NoEnvironmentGraphError` (Task 3), the existing `RunCypherQuery` selection logic (`src/host/server-connection-handler.ts:478`, Runtime branch ~501), `RuntimeAttachArgs` (~206), the RBAC gate (`CypherProtocol.Query → readTenant`).
- Produces: `envGraphProvider?: (context) => Promise<IGraphQuery>` added to `RuntimeAttachArgs`'s returned object and to `Attach`'s parameters; `RunCypherQuery` on Runtime with no bound app and no model id resolves to `envGraphProvider` (instead of the today-only `RequireBoundAppGraph`), throwing a clear "no graph loaded" error when none. The bound-app path and all `EnsureDevelopment` authoring gates stay unchanged.

- [ ] **Step 1: Write failing tests.** With a Runtime-purpose handler + a fake `envGraphProvider`: a non-model, non-bound-app `CypherProtocol.Query` resolves to the env graph and returns its nodes; **`env_graph_query_without_load_errors_clearly`** — provider throws `NoEnvironmentGraphError` → the query rejects with that clear message (no null-deref); a bound-app query STILL uses the app graph (unchanged); `CypherProtocol.Execute` and `GraphProtocol.Create/Contribute` STILL reject on Runtime (`EnsureDevelopment` unchanged); model-scoped query on Runtime still rejected.
- [ ] **Step 2: Run; confirm fail.**
- [ ] **Step 3: Implement** the `RuntimeAttachArgs` addition (bind `server.EnvironmentGraphQuery` when `Purpose()===Runtime`), the `Attach` parameter threading, the host wiring, and the `RunCypherQuery` branch.
- [ ] **Step 4: Run; green** (full `src/host`). Commit.

---

## Task 5: Control-plane proxy + promotion orchestration (pragmatic-server admin)

**Files:**
- Modify: `admin/control-plane/admin-proxy.ts` (`ExportGraph`/`LoadGraph`/`GetLoadedGraph` on `IAdminProxy`/`AdminProxy`/`IAdminConnection`/`WsAdminConnection`)
- Modify: `admin/control-plane/environment-service.ts` (`EnvironmentNotRuntimeError`; promotion type gates)
- Modify: `admin/control-plane/graph-service.ts` (`Promote`, `GetLoaded`)
- Modify: `admin/control-plane/control-plane-host.ts` (`IGraphService.Promote`/`GetLoaded`, `PromotionResultDto`, `PromotePathPattern` + `RoutePromote`, `ErrorStatuses` entry)
- Modify: `admin/control-plane/server.ts` (no new ctor arg — confirm `GraphService` already has `proxy` + `adminInfoFor`)
- Test: extend `admin/control-plane/tests/control-plane-host.test.ts` (`FakeGraphService.Promote/GetLoaded` + route tests) and `graph-service.test.ts`

**Interfaces:**
- Consumes: `AdminConnectInfo`, `AdminProxy.With`, `WsAdminConnection.sendRequest(GraphProtocol.Export/Load/Loaded)` (Task 1), `EnvironmentService.AdminInfoFor` (called twice), `GraphService.Require`/`Classify`/`GraphDto`, `EnvType.Development`/`Runtime`.
- Produces:
  - `IAdminProxy`/`AdminProxy`: `ExportGraph(info, params: GraphRefParamsDto): Promise<GraphExportDto>`, `LoadGraph(info, params: GraphLoadParamsDto): Promise<GraphLoadedDto>`, `GetLoadedGraph(info): Promise<GraphLoadedDto | null>` (each via `With`). Matching `IAdminConnection`/`WsAdminConnection` RPCs.
  - `EnvironmentNotRuntimeError` (beside `EnvironmentNotDevelopmentError` in environment-service.ts).
  - `GraphService.Promote(sourceEnv: string, graphName: string, targetEnv: string): Promise<PromotionResultDto>` — Require source is Development (reuse dev gate) and target is Runtime (new gate → `EnvironmentNotRuntimeError`); `info` for each via `adminInfoFor`; `Classify(graphName, () => proxy.ExportGraph(sourceInfo, {graphName}))` then `proxy.LoadGraph(targetInfo, { graphName, packages })`; return `{ graphName, packageCount, targetEnv }`.
  - `GraphService.GetLoaded(runtimeEnv: string): Promise<GraphDto | null>` — Require target is Runtime; `proxy.GetLoadedGraph(info)` → `GraphDto | null`.
  - `PromotionResultDto { graphName: string; packageCount: number; targetEnv: string }` (no secrets).
  - Host: `PromotePathPattern` = `^/api/environments/([^/]+)/graphs/([^/]+)/promote$`, `.exec`'d in `RouteApi` BEFORE `EnvPathPattern`; `RoutePromote` (POST-only, `Decode` source env + graph, `ReadJsonObject` → `NonEmpty(targetEnv)`, `graphService.Promote`, `WriteJson(StatusOk, dto)`); `IGraphService.Promote`/`GetLoaded`; `ErrorStatuses` gains `EnvironmentNotRuntimeError → 400`. The loaded read is surfaced either on the existing graphs routing for a runtime env or a dedicated `GET .../graph` — reuse `RouteGraphs` style; keep one clear route.

- [ ] **Step 1: Write failing tests.** `control-plane-host.test.ts`: `POST /api/environments/dev1/graphs/g1/promote` with `{targetEnv:'rt1'}` calls `FakeGraphService.Promote('dev1','g1','rt1')` and returns the DTO; non-POST → false/405; malformed body → 400; the loaded-read route returns the `GraphDto`/empty. `graph-service.test.ts`: **`promote_rejects_runtime_source_and_development_target`** (source Runtime → `EnvironmentNotRuntimeError` is NOT it — source must be Development so a Runtime source → `EnvironmentNotDevelopmentError`; target Development → `EnvironmentNotRuntimeError`), both before any proxy call (assert the fake proxy saw zero calls); happy path calls `ExportGraph` then `LoadGraph` with the exported packages; a container `Protocol` error maps via `Classify`.
- [ ] **Step 2: Run; confirm fail.**
- [ ] **Step 3: Implement** the proxy methods, the error class, `Promote`/`GetLoaded`, the host route + DTO + `ErrorStatuses`, and confirm `server.ts`/`control-plane-smoke.ts` need no new ctor arg.
- [ ] **Step 4: Run; green** (control-plane suite + `typecheck:tools`). Commit.

---

## Task 6: Portal promote flow + runtime loaded-graph display (pragmatic-server portal)

**Files:**
- Create: `admin/portal/src/promote-graph-view.ts`
- Modify: `admin/portal/src/portal-types.ts` (`IPortalNavigator.ShowPromoteGraph`; a `PromotionResultDto`/loaded shape if needed)
- Modify: `admin/portal/src/api-client.ts` (`PromoteGraph`, `GetLoadedGraph` + route helpers)
- Modify: `admin/portal/src/app.ts` (`ShowPromoteGraph` wiring)
- Modify: `admin/portal/src/environment-detail-view.ts` (Promote button in the Development block; Runtime-type branch showing the loaded graph)
- Test: extend portal unit tests; extend `admin/portal/tests/portal.spec.ts` (gated e2e)

**Interfaces:**
- Consumes: `PortalViewBase`, `IPortalNavigator`, `ControlPlaneClient` (`ListGraphs`, `ListEnvironments`), `environment-detail-view` type-branch (`DevelopmentType`; add `RuntimeType`), `GraphListView`/`CreateGraphView` patterns.
- Produces:
  - `ControlPlaneClient.PromoteGraph(sourceEnv, graphName, targetEnv): Promise<PromotionResultDto>` (POST the promote route) and `GetLoadedGraph(runtimeEnv): Promise<GraphDto | null>`, with route helpers mirroring `GraphsRoute`.
  - `PromoteGraphView extends PortalViewBase` — ctor `(client, nav, devEnvName, graphName?)`; lists the dev env's graphs (or takes a chosen graph), a runtime-env picker populated from `ListEnvironments()` filtered to `type==='runtime'`, a Promote action → `client.PromoteGraph` → `Run` → back to the dev detail; all labels hoisted.
  - `IPortalNavigator.ShowPromoteGraph(devEnvName: string)` + `App.ShowPromoteGraph`.
  - `environment-detail-view`: a `Promote graph…` button inside the existing Development-only block; a new `RuntimeType = 'runtime'` branch rendering the loaded graph (name + package count + promoted-at via `GetLoadedGraph`, or "No graph loaded").

- [ ] **Step 1: Write failing tests.** Portal unit: `PromoteGraphView.Refresh` lists dev graphs + runtime envs and a promote submit calls `client.PromoteGraph(dev, graph, runtime)`; `environment-detail-view` shows the Promote button only for a Development env and the loaded-graph display only for a Runtime env (fake client). (Gated e2e: a promote happy-path step added to `portal.spec.ts`, operator-run.)
- [ ] **Step 2: Run; confirm fail** (`npm run <portal unit test>` per the portal's test script).
- [ ] **Step 3: Implement** the api-client methods + routes, the view, the navigator + app wiring, and the detail-view branches.
- [ ] **Step 4: Run; green** (portal unit; typecheck the portal tsconfig). Commit.

---

## Task 7: Gated end-to-end promotion smoke (pragmatic-server control-plane)

**Files:**
- Modify: `admin/control-plane/control-plane-smoke.ts` (new promotion step + `Labels`)

**Interfaces:**
- Consumes: the smoke's existing `Api(method, path, body)` HTTP driver + `Expect`, the already-wired `GraphService`, the maker-token mint + `graph/contribute` (3a-ii), the new promote route (Task 5), and a cypher read against the runtime env-graph target (Task 4).

- [ ] **Step 1:** Add a `PromotionRoundTrip` step to `Run()` mirroring `DevLifecycle`/`ManageRoundTrip`: create a Development env; create a graph; mint a maker token and `graph/contribute` a small package (or reuse an existing contribute helper); create a Runtime env; `POST .../graphs/:g/promote {targetEnv}`; assert the promote result DTO; assert `GetLoadedGraph(runtimeEnv)` reflects the graph; open a WS to the runtime tenant and run a `CypherProtocol.Query` against the env-graph target asserting the promoted content is returned. New `Labels` entries for each assertion.
- [ ] **Step 2:** Run the gated smoke per the repo's operator-run harness; confirm green. (This smoke is operator-gated like the portal/tenant-publish e2e — it needs the container/compose; do not wire it into the default unit run.)
- [ ] **Step 3: Commit.**

---

## Self-review notes

- **Spec coverage:** FR1/FR2/FR7 → Task 5 (route + two-env type gate + leak-free DTO); FR3 → Task 2; FR4 → Task 3; FR5 → Task 4; FR6 → Tasks 3 (record) + 5 (GetLoaded) + 6 (display); the five Review-Focus inputs → the named tests in Tasks 2/3/4/5.
- **Type consistency:** `GraphExportDto`/`GraphLoadParamsDto`/`GraphLoadedDto` defined once in Task 1 and consumed unchanged by Tasks 2–6; `ContributedPackageDto`/`PackageRef` reused; `PromotionResultDto` defined in Task 5 and consumed by Task 6.
- **Cross-task interfaces:** Task 2 produces `ExportGraph`/`GraphPackageReader`; Task 3 produces `LoadEnvironmentGraph`/`EnvironmentGraphQuery`/`LoadedGraph` + `NoEnvironmentGraphError`; Task 4 consumes `EnvironmentGraphQuery`; Task 5 consumes the protocol ops via the proxy; Task 6 consumes Task 5's route; Task 7 exercises all of them end-to-end.
- **Proportion:** signatures + test names only; no full bodies — the engineer writes idiomatic code against the named seams and the inherited siblings (`GraphPackageIngest`, `RuntimeAppGraph`, `AppIngestService`, `GraphService`, the portal view patterns).
