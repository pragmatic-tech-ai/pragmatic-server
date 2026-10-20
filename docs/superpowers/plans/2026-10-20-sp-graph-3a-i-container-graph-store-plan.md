# SP-GRAPH-3a-i: Container-Owned Graph Store + Protocol CRUD + Control-Plane Proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a graph's ownership into the development-environment container — a graph protocol surface (create/list/get/delete) backed by a container-side store in the tenant data volume, with the SP-GRAPH-2 control-plane graph service reworked from a host-side file into a proxy of the running container.

**Architecture:** A new `GraphProtocol` (pragmatic-protocol) exposes graph CRUD over the existing JSON-RPC/WS transport; `PragmaticClient` gains wrapper methods. On the server, a `DevGraphStore` persists graph records through the platform `IStorage` under a new per-tenant `graphsRoot`; a `DevGraphService` (behind `IDevGraphService`) enforces development-purpose gating, unique names, and name sanitation; `ServerConnectionHandler` gains the four graph ops, each `EnsureDevelopment`-gated and policy-gated. The control plane's SP-GRAPH-2 `GraphService` is reworked to delegate to the container over the existing admin proxy (as the env Owner), retiring the host-side `GraphRegistry`/`graphs.json`. This is the operator-relayed CRUD half; SP-GRAPH-3a-ii adds the maker capability, `graph/contribute`, the additive per-solution merge, and the portal token mint.

**Tech Stack:** TypeScript; `vscode-jsonrpc` `RequestType`/`RequestType0`; `node:test` + `node:assert/strict`; the platform `IStorage` abstraction; Mural + Vite portal (unchanged in this slice beyond behavior).

**Spec:** `pragmatic-server/docs/superpowers/specs/2026-10-20-sp-graph-3a-maker-contribution-spec.md` (parent design: `2026-10-20-environments-graphs-admin-design.md`). This plan implements FR1 (create/list/get/delete ops, dev-only), FR2 (container-persisted, empty-manifest round-trip), and the CRUD-via-proxy portion of FR6. FR3–FR5 and the maker-token mint portion of FR6 are SP-GRAPH-3a-ii.

## Global Constraints

- OOP (methods on classes, no free functions or module-level state); Allman braces; real enums (never string-literal unions); no inline string literals (hoist to `private static readonly` PascalCase constants); PascalCase for interfaces and public methods.
- No seam bags: the handler receives a real `IDevGraphService` interface, not additional lambda-provider parameters.
- pragmatic-server lexical style: single quotes, no semicolons, `.js` import suffixes, Allman. pragmatic-protocol: match the surrounding files (single quotes, no semicolons, `.js` suffixes).
- LF-only line endings (zero carriage-return bytes) in every file touched.
- Engine-layering holds: lower layers never import upward; the protocol package carries no server/host types.
- Tests live under `tests/` folders beside the code (server: `src/host/graphs/tests/` etc.; protocol: `src/tests/`; control-plane: `admin/control-plane/tests/`). Fix all review findings including Minors.
- Secrets/tokens/credentials never logged, echoed, committed, or added to a DTO. Nothing pushed until the user asks; work on a branch.
- New protocol ops follow the five-step convention in `pragmatic-protocol/ARCHITECTURE.md` and keep `barrel-parity.test.ts` green; every op gets a deny-by-default `PolicyGate` table entry.
- **Cross-repo build:** `pragmatic-server` consumes `@pragmatic-tech-ai/pragmatic-protocol` as a symlinked sibling resolving `dist/`. After any protocol source change, run `npm --prefix ../pragmatic-protocol run build` before server typecheck/tests see it. The `typecheck:tools` gate (pragmatic-server) must stay green.

## Design rulings (resolved up front; a task reviewer must not re-litigate without a spec conflict)

- **Container owns the graph** (identity + manifest) in the tenant volume under `graphsRoot = <baseDir>/<tenant>/graphs`; the host-side `graphs.json` from SP-GRAPH-2 is retired. Managing graphs now requires the env container running — an accepted behavior change (spec Model).
- **CRUD authz reuses existing roles** (no new capability this slice): `graph/create` and `graph/delete` → `administer` (Tenant); `graph/list` and `graph/get` → `readTenant`. The maker capability + `graph/contribute` are SP-GRAPH-3a-ii.
- **Dev-gating mirrors deploy:** the four graph ops are always registered on the handler and each calls `EnsureDevelopment()` (throws `NotDevelopmentMessage` on a runtime tenant); the `IDevGraphService` provider is wired only for a Development server (undefined otherwise), exactly as `deployProvider` is wired only for Runtime.
- **Control-plane relays as the env Owner** using the existing `EnvironmentService.AdminInfo(name)` credentials over the `AdminProxy` connection pattern; the portal keeps its SP-GRAPH-2 routes/DTO (`GraphDto {name,description,packageCount,createdAt}`), now sourced from the container.
- **3a-i packages are always `[]`**: with no contribute op yet, a graph's effective package list is empty; `packageCount` is `0`. This is the defined starting point FR2/3a-ii build on.

## Review Focus

- **Dev-only gating end to end:** every graph op is rejected on a Runtime tenant (`EnsureDevelopment` throws) and the control-plane service rejects a non-Development environment before proxying. (Tasks 3, 4, 5.)
- **Empty-manifest round-trip:** a created graph's `packages` round-trips as an empty array (never null/undefined) through persist + a fresh store load / reconnect; `packageCount === 0`. (Tasks 2, 3.)
- **Duplicate-name rejection within a tenant** (create twice → Conflict-style error) and **not-found** for get/delete of an absent graph. (Tasks 3, 5.)
- **No host-side graph persistence remains:** the control-plane no longer writes `graphs.json`; `GraphRegistry` is removed and nothing references it. (Task 5.)
- **Env-not-running is a clean error**, not a crash: create/list against a stopped environment surfaces a clear failure through the proxy. (Task 5.)
- **No secret/internal-path leak** in any graph DTO (protocol or control-plane): no `bundleDir`, no tenant filesystem path, no credential. (Tasks 1, 5.)

---

### Task 1: Graph protocol ops + client wrappers (pragmatic-protocol)

**Files:**
- Create: `pragmatic-protocol/src/contracts/graph-protocol.ts`
- Modify: `pragmatic-protocol/src/dto/wire-dtos.ts` (add the graph DTOs near the app-deploy DTOs)
- Modify: `pragmatic-protocol/src/index.ts` (barrel-export `GraphProtocol` and the DTOs)
- Modify: `pragmatic-protocol/src/client/pragmatic-client.ts` (four wrapper methods)
- Test: `pragmatic-protocol/src/tests/graph-protocol-contract.test.ts`

**Interfaces:**
- Produces (DTOs, flat camelCase): `GraphCreateParamsDto { graphName: string; description: string }`; `GraphRefParamsDto { graphName: string }`; `GraphSummaryDto { name: string; description: string; packageCount: number; createdAt: string }`; `GraphDetailDto { name: string; description: string; packages: { id: string; version: string }[]; createdAt: string }`.
- Produces (contract): `class GraphProtocol` with `Create = RequestType<GraphCreateParamsDto, GraphSummaryDto, void>('graph/create')`, `List = RequestType0<GraphSummaryDto[], void>('graph/list')`, `Get = RequestType<GraphRefParamsDto, GraphDetailDto, void>('graph/get')`, `Delete = RequestType<GraphRefParamsDto, void, void>('graph/delete')` (method strings hoisted to `private static readonly`, mirroring `pragmatic-app-protocol.ts`).
- Produces (client): `PragmaticClient.CreateGraph(params: GraphCreateParamsDto): Promise<GraphSummaryDto>`, `ListGraphs(): Promise<GraphSummaryDto[]>`, `GetGraph(params: GraphRefParamsDto): Promise<GraphDetailDto>`, `DeleteGraph(params: GraphRefParamsDto): Promise<void>` — each delegating via `this.Request(GraphProtocol.X, ...)` (mirror `DeployApplication` for `RequestType` and the existing `RequestType0` list wrapper for `List`).
- Consumes: `RequestType`/`RequestType0` from `vscode-jsonrpc`.

- [ ] **Step 1: Write the failing contract test** — assert each `GraphProtocol.*.method` equals its wire string (`'graph/create'`, `'graph/list'`, `'graph/get'`, `'graph/delete'`), and (mirroring `barrel-parity.test.ts`) that `GraphProtocol` and the four DTO type names are exported from the barrel.
- [ ] **Step 2: Run the protocol tests, confirm failure** — `npm --prefix pragmatic-protocol test` (Expected: FAIL — `GraphProtocol` undefined / barrel parity).
- [ ] **Step 3: Implement** the DTOs, `graph-protocol.ts`, the barrel exports, and the four `PragmaticClient` wrappers.
- [ ] **Step 4: Build + test** — `npm --prefix pragmatic-protocol run build` then `npm --prefix pragmatic-protocol test` (barrel-parity + the new contract test pass).
- [ ] **Step 5: Commit** — `feat(protocol): graph CRUD operations and client wrappers`.

---

### Task 2: Container-side graph store (pragmatic-server)

**Files:**
- Create: `pragmatic-server/src/host/graphs/dev-graph-store.ts`
- Modify: `pragmatic-server/src/tenancy/tenant-registry.ts` (add `graphsRoot = join(baseDir, tenantId, 'graphs')` to `OptionsFor`, hoisting a `GraphsDir` constant beside `PackagesDir`/`ApplicationsDir`)
- Modify: `pragmatic-server/src/pragmatic-server.ts` (a `GraphsStorage(): IStorage` accessor reading `this.options.graphsRoot`; add `graphsRoot?` to the server options type where `packagesRoot`/`applicationsRoot` live)
- Test: `pragmatic-server/src/host/graphs/tests/dev-graph-store.test.ts`

**Interfaces:**
- Produces: `type DevGraphRecord = { name: string; description: string; packages: { id: string; version: string }[]; createdAt: string }`; `class DevGraphStore` constructed `(storage: IStorage)` with `Load(): Promise<void>`, `List(): readonly DevGraphRecord[]`, `Get(name: string): DevGraphRecord | undefined`, `Put(record: DevGraphRecord): Promise<void>` (keyed by `record.name`), `Remove(name: string): Promise<void>`. Persists atomically as a single JSON document (root key `'graphs'`) via `IStorage`, mirroring `admin/control-plane/graph-registry.ts` but over `IStorage` rather than `node:fs`.
- Consumes: `IStorage` (read the interface in `src/platform` / wherever `CreateStorage` returns it — use its read/write/exists/delete methods; do not touch `node:fs` directly).

- [ ] **Step 1: Write the failing tests** (use an in-memory or temp `IStorage` fixture; check the store's existing tests for the available fake):
```ts
test('a graph with an empty package list round-trips through Put/Load', async () => { /* Put {name:'g1',description:'first',packages:[],createdAt}; reload a new DevGraphStore on the same storage; Get('g1'); assert name/description AND Array.isArray(packages)&&length===0 */ })
test('Load on empty storage yields an empty list', async () => { /* new store, Load, List().length===0 */ })
test('Remove deletes a graph; it is gone after reload', async () => { /* Put two, Remove one, reload, only the other remains */ })
```
- [ ] **Step 2: Run the tests, confirm failure** — `npx tsx --test pragmatic-server/src/host/graphs/tests/dev-graph-store.test.ts` (from the pragmatic-server dir).
- [ ] **Step 3: Implement** `DevGraphStore` over `IStorage`, plus the `graphsRoot` option and `GraphsStorage()` accessor. Hoist every literal (`'graphs'`, file name, encoding) to `private static readonly` constants.
- [ ] **Step 4: Run the tests, confirm they pass**, and `npm run typecheck:tools` (pragmatic-server) stays green.
- [ ] **Step 5: Commit** — `feat(server): container-side DevGraphStore in the tenant graphs volume`.

---

### Task 3: Dev graph service + purpose gate (pragmatic-server)

**Files:**
- Create: `pragmatic-server/src/host/graphs/dev-graph-service.ts`
- Modify: `pragmatic-server/src/pragmatic-server.ts` (a `GraphService(): IDevGraphService` accessor that `AssertDevelopmentPurpose()` then lazily builds a `DevGraphService` over `GraphsStorage()`; add `AssertDevelopmentPurpose` mirroring `AssertRuntimePurpose`)
- Test: `pragmatic-server/src/host/graphs/tests/dev-graph-service.test.ts`

**Interfaces:**
- Produces: `interface IDevGraphService { CreateGraph(params: GraphCreateParamsDto): Promise<GraphSummaryDto>; ListGraphs(): Promise<GraphSummaryDto[]>; GetGraph(params: GraphRefParamsDto): Promise<GraphDetailDto>; DeleteGraph(params: GraphRefParamsDto): Promise<void> }` (DTOs from pragmatic-protocol); `class DevGraphService implements IDevGraphService` constructed `(store: DevGraphStore)`. Error classes `GraphExistsError`, `GraphNotFoundError`, `GraphNameInvalidError` (each `extends Error`, `this.name` set, mirroring `admin/control-plane/environment-service.ts`'s pattern). Name sanitation reuses the pattern `/^[a-z0-9][a-z0-9-]*$/` (hoisted).
- Consumes: `DevGraphStore` (Task 2); the Task 1 DTOs.

- [ ] **Step 1: Write the failing tests** (construct `DevGraphService` directly over a `DevGraphStore` on a temp/in-memory storage — no running server needed):
```ts
test('CreateGraph persists a graph with an empty package list', async () => { /* Create {graphName:'g1',description:'first'}; GetGraph -> packages deepEqual [] , packageCount 0 from ListGraphs */ })
test('a duplicate graph name is rejected', async () => { /* Create g1 twice -> GraphExistsError */ })
test('an invalid graph name is rejected', async () => { /* 'Bad Name' -> GraphNameInvalidError */ })
test('GetGraph/DeleteGraph on an absent graph -> GraphNotFoundError; after Delete it is gone', async () => {})
```
- [ ] **Step 2: Run the tests, confirm failure.**
- [ ] **Step 3: Implement** `DevGraphService` (Create: sanitize, Load, GraphExistsError if present, Put `{name,description,packages:[],createdAt:new Date().toISOString()}`, return summary; List/Get/Delete over the store, mapping to `GraphSummaryDto`/`GraphDetailDto`; `GraphNotFoundError` where absent). Add `PragmaticServer.GraphService()` with `AssertDevelopmentPurpose()`.
- [ ] **Step 4: Run the tests, confirm they pass; `typecheck:tools` green.**
- [ ] **Step 5: Commit** — `feat(server): DevGraphService with development-purpose gating and unique names`.

---

### Task 4: Handler wiring + policy gate (pragmatic-server)

**Files:**
- Modify: `pragmatic-server/src/host/server-connection-handler.ts` (thread one `devGraphService?: IDevGraphService` through `Attach` and the constructor as a trailing optional param; register the four graph ops; add a `DevelopmentAttachArgs(server)` static that returns `{ devGraphService }` — the service for a Development server, `undefined` otherwise, mirroring `RuntimeAttachArgs`)
- Modify: `pragmatic-server/src/host/policy-gate.ts` (four `BuildTable` entries)
- Modify: `pragmatic-server/src/host/pragmatic-server-host.ts` (pass `...ServerConnectionHandler.DevelopmentAttachArgs(server)` into `Attach`, alongside the existing runtime args)
- Test: `pragmatic-server/src/host/tests/server-connection-handler.graphs.test.ts` (new file beside the existing handler tests)

**Interfaces:**
- Consumes: `IDevGraphService` (Task 3); `GraphProtocol` (Task 1); the existing `guarded`/`guardedNoParams`/`EnsureDevelopment`/`PolicyGate` machinery.
- Produces: registered handlers for `GraphProtocol.Create/List/Get/Delete`; `ServerConnectionHandler.DevelopmentAttachArgs`.

- [ ] **Step 1: Write the failing tests** (mirror the existing handler tests' fake `AccessContext` + fake service style; find how deploy/app handlers are tested):
```ts
test('graph/create routes to the service and returns a GraphSummaryDto (Development)', async () => {})
test('graph/list and graph/get route to the service (Development)', async () => {})
test('every graph op is rejected on a Runtime tenant with NotDevelopment', async () => { /* purpose=Runtime -> each op throws ResponseError InvalidRequest NotDevelopmentMessage */ })
test('policy gate maps the graph ops: create/delete=administer, list/get=readTenant', async () => { /* assert PolicyGate table entries */ })
```
- [ ] **Step 2: Run the tests, confirm failure.**
- [ ] **Step 3: Implement** — add the four `PolicyGate.BuildTable` entries (`GraphProtocol.Create.method`→`administer`, `GraphProtocol.Delete.method`→`administer`, `GraphProtocol.List.method`→`readTenant`, `GraphProtocol.Get.method`→`readTenant`). Register the ops in the handler's registration block: each handler calls `this.EnsureDevelopment()` then delegates to `this.devGraphService!` (`guardedNoParams` for `List`, `guarded` for the others). Add `devGraphService` to ctor/`Attach` (trailing optional) and `DevelopmentAttachArgs`. Wire it in `pragmatic-server-host.ts`.
- [ ] **Step 4: Run the handler tests + the full `src/host` suite; build protocol first if not already (`npm --prefix ../pragmatic-protocol run build`); `npm run typecheck:tools` green.**
- [ ] **Step 5: Commit** — `feat(server): graph CRUD handlers, development-gated and policy-gated`.

---

### Task 5: Control-plane graph service reworked to proxy the container (pragmatic-server/admin)

**Files:**
- Modify: `pragmatic-server/admin/control-plane/admin-proxy.ts` (extend `IAdminProxy`, `AdminProxy`, `IAdminConnection`, `WsAdminConnection` with `CreateGraph`/`ListGraphs`/`GetGraph`/`DeleteGraph` delegating to the Task 1 `PragmaticClient` wrappers, following the existing `GrantRole`/`GetConfig` method shape and the `With(info, conn => ...)` pattern)
- Rewrite: `pragmatic-server/admin/control-plane/graph-service.ts` (`GraphService` now constructed `(environments: IEnvironmentLookup, proxy: IAdminProxy, adminInfo: (name: string) => AdminConnectInfo)`; Create/List/Get/Delete dev-gate the environment then delegate to the proxy using the env's `AdminConnectInfo`; map protocol `GraphSummaryDto`/`GraphDetailDto` → the portal `GraphDto`)
- Delete: `pragmatic-server/admin/control-plane/graph-registry.ts` and `pragmatic-server/admin/control-plane/tests/graph-registry.test.ts` and `pragmatic-server/admin/control-plane/graph-record.ts` (host-side store retired; its types are superseded by the protocol DTOs)
- Modify: `pragmatic-server/admin/control-plane/server.ts` (construct `GraphService` with the proxy + an `AdminInfo` accessor from `EnvironmentService`, not a `GraphRegistry`)
- Modify: `pragmatic-server/admin/control-plane/control-plane-host.ts` only if `ToGraphDto`'s input type changes (map from the reworked service's return); routes/DTO shape stay as SP-GRAPH-2
- Modify: `pragmatic-server/admin/control-plane/environment-service.ts` if `AdminInfo(name)` is not already public (it exists at ~:300 — expose it if private)
- Test: rewrite `pragmatic-server/admin/control-plane/tests/graph-service.test.ts` (fake `IAdminProxy`); adjust `tests/control-plane-host.test.ts` (its `FakeGraphService` already implements the host `IGraphService` — keep it; only ctor wiring shifts)

**Interfaces:**
- Consumes: `IAdminProxy` + `AdminConnectInfo` (admin-proxy.ts); the Task 1 client wrappers (via the proxy connection); `EnvironmentService.AdminInfo`; `EnvType` (dev-gate).
- Produces: a proxy-backed control-plane `GraphService` keeping the host `IGraphService` contract `ControlPlaneHost` already depends on (`Create(envName,name,description)`, `List(envName)`, `Get(envName,graphName)`, `Delete(envName,graphName)` returning the portal `GraphDto` shape).

- [ ] **Step 1: Write the failing tests** — a `FakeAdminProxy` implementing the new graph methods; assert `GraphService.Create` dev-gates (rejects a Runtime/unknown env before proxying) and otherwise calls `proxy.CreateGraph(adminInfo, ...)`; `List/Get/Delete` delegate; a stopped/unreachable env surfaces a clear error (fake proxy throws → service surfaces it). Keep the existing control-plane-host graph route tests passing against the host `IGraphService` (via its `FakeGraphService`).
- [ ] **Step 2: Run the tests, confirm failure.**
- [ ] **Step 3: Implement** — extend the proxy; rewrite `GraphService` to delegate; delete `graph-registry.ts` + `graph-record.ts` + the registry test; update `server.ts` wiring; adjust `control-plane-host.ts` mapping only as needed. Confirm nothing still imports `GraphRegistry`/`graph-record`.
- [ ] **Step 4: Run the full control-plane suite (`npx tsx --test admin/control-plane/tests/*.test.ts`) + `npm run typecheck:tools`; both green. (Protocol dist already built in Task 1/4.)**
- [ ] **Step 5: Commit** — `refactor(admin): proxy graph CRUD to the dev-env container, retire host-side graph store`.

---

## Closing

SP-GRAPH-3a-i makes the container the graph's system of record and keeps the SP-GRAPH-2 portal working through a proxy. SP-GRAPH-3a-ii adds the least-privilege **maker capability** (new `Action`/`Role` in `todl-identity`), the `graph/contribute` op with the **additive per-solution merge** and **package immutability**, and the portal **maker-token mint**. SP-GRAPH-3b is the Plexus Build→contribute client. Promotion to a runtime is SP-GRAPH-4.
