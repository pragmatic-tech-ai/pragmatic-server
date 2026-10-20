# SP-GRAPH-2: Graph as an Admin-Created Additive Container — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin create a named graph (name + description, empty additive manifest) inside a Development environment, persisted as that environment's artifact, and surfaced in the portal — establishing the manifest format and the dev-environment graph store that contribution (SP-GRAPH-3) and promotion (SP-GRAPH-4) build on.

**Architecture:** Mirror the existing environment control-plane chain for a new, dev-environment-scoped `graph` entity. A `GraphManifest` (`name`, `description`, `packages: GraphPackageRef[]`) is the promotable artifact; a `GraphRecord` wraps it with `createdAt`. A `GraphRegistry` mirrors `EnvironmentRegistry`'s atomic JSON store but is rooted at the owning environment's bundle dir (`<bundleDir>/graphs.json`) — one store per dev environment, so no running container is needed to create or list graphs. A separate `GraphService` (behind a new `IGraphService`) validates the target environment (must exist and be `EnvType.Development`), enforces unique graph names within an environment, and drives the registry. `ControlPlaneHost` gains a second injected service and nested routes `/api/environments/:env/graphs(/:graph)`. The Mural portal gains a graphs list + create view reached from a Development environment's detail view.

**Tech Stack:** TypeScript run via `tsx`; `node:test` + `node:assert/strict` for control-plane unit tests; Mural + Vite for the portal; Playwright for the portal e2e.

**Spec:** `pragmatic-server/docs/superpowers/specs/2026-10-20-sp-graph-2-admin-graph-container-spec.md` (parent design: `2026-10-20-environments-graphs-admin-design.md`).

## Global Constraints

- OOP (methods on classes, no free functions or module-level state); Allman braces; real enums (never string-literal unions); no inline string literals (hoist to `private static readonly` PascalCase constants); PascalCase for interfaces and public methods.
- pragmatic-server lexical style: single quotes, no semicolons, `.js` import suffixes, Allman.
- LF-only line endings (zero carriage-return bytes) in every file touched.
- Control-plane tests live beside the code under `admin/control-plane/tests/`; portal tests under `admin/portal/tests/`. Fix all review findings including Minors.
- Secrets, tokens, and credentials are never added to any DTO, logged, or echoed.
- Nothing is pushed until the user asks. Work on a branch.
- Mural ComboBox / collapsed-selection text reads only `Label`/`Name`/`Text`: any ComboBox item class exposes a `Label`.
- The `typecheck:tools` gate (`npm run typecheck:tools`) must stay green; new `admin/control-plane/**` files are covered by it.

## Design rulings (resolved up front; a task reviewer must not re-litigate these without a spec conflict)

- **Nested routes** `/api/environments/:env/graphs` (GET list, POST create) and `/api/environments/:env/graphs/:graph` (GET, DELETE). Ownership by the dev environment is explicit and mirrors the existing `AdminPathPattern`. (The generic `EnvPathPattern` only matches `.../(start|stop|logs)?`, so `/graphs` falls through to the new pattern — no collision.)
- **Store location:** `<bundleDir>/graphs.json`, one `GraphRegistry` per environment. The control plane already owns each environment's bundle dir on disk and writes `tenants.json` etc. there, so graph metadata is managed without the container running.
- **Separate `IGraphService`** injected as a second `ControlPlaneHost` constructor parameter (not added to `IEnvironmentService`) — graph methods don't belong on the environment interface. This changes the `ControlPlaneHost` constructor and its two call sites (`server.ts`, the test `beforeEach`).
- **Manifest type** carries `name`, `description`, `packages: GraphPackageRef[]` with a local `GraphPackageRef { id; version }` (structurally identical to `src/host/apps` `PragmaticAppPackageRef`) — no coupling of `admin/` to `src/host` internals this slice.
- **No ws broadcast for graphs** this slice — the portal refreshes graph lists on navigation. (The existing `environments-changed` broadcast is untouched.)
- **No folded backlog items** in this slice: the design doc's SP-GRAPH-2/3 folded items (service-token UI, close `/api/events` on logout, masked token fields) are maker-auth/token plumbing that lands with SP-GRAPH-3's maker-authenticated upload, not on this operator-authed graph-CRUD path.

## Review Focus

- Creating a graph against a **Runtime** environment is rejected (`EnvironmentNotDevelopmentError` → 400), not created. (Task 2 at the service; Task 3 at the API.)
- Creating a graph against an **unknown/deleted** environment is rejected (`EnvironmentNotFoundError` → 404), not persisted orphaned. (Task 2; Task 3.)
- A **duplicate graph name within the same environment** is rejected (`GraphExistsError` → 409); the **same name in a different environment** is allowed (graphs are keyed within their owning environment's store). (Task 1 store keying; Task 2 service.)
- A new graph's manifest `packages` **round-trips as an empty array**, never `undefined`/`null`, so SP-GRAPH-3 has a defined starting point. (Task 1.)
- The graph **DTO leaks no secret or internal path** (no `bundleDir`) and rides the existing auth gate (unauthenticated graph request stays 401). (Task 3.)

---

### Task 1: Graph manifest + record types + GraphRegistry store

**Files:**
- Create: `admin/control-plane/graph-record.ts`
- Create: `admin/control-plane/graph-registry.ts`
- Test: `admin/control-plane/tests/graph-registry.test.ts`

**Interfaces:**
- Produces: `interface GraphPackageRef { id: string; version: string }`; `interface GraphManifest { name: string; description: string; packages: GraphPackageRef[] }`; `type GraphRecord = { manifest: GraphManifest; createdAt: string }`. `class GraphRegistry` constructed `new GraphRegistry(filePath: string)` with `Load(): Promise<void>`, `List(): readonly GraphRecord[]`, `Get(name: string): GraphRecord | undefined`, `Put(record: GraphRecord): Promise<void>`, `Remove(name: string): Promise<void>` (keyed by `record.manifest.name`).
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests** (mirror `environment-registry.test.ts`'s temp-file + fixture style)

```ts
// in graph-registry.test.ts
test('a graph with an empty manifest round-trips through Put/Load', async () =>
{
    // Put { manifest: { name: 'g1', description: 'first', packages: [] }, createdAt }
    // reload a new GraphRegistry on the same file; Get('g1')
    // assert manifest.name/description match AND Array.isArray(packages) && packages.length === 0
})
test('Load on a missing file yields an empty list (no throw)', async () =>
{
    // new registry on a non-existent path; Load; assert List().length === 0
})
test('Remove deletes a graph; it is gone after reload', async () =>
{
    // Put two, Remove one, reload, assert only the other remains
})
test('persist creates nested directories', async () =>
{
    // filePath under join(dir,'sub','graphs.json'); Put; assert the file exists and reloads
})
```

- [ ] **Step 2: Run the tests, confirm they fail** — `npx tsx --test admin/control-plane/tests/graph-registry.test.ts` (Expected: FAIL — modules/classes undefined).
- [ ] **Step 3: Implement** — `graph-record.ts` with the three types above (real types; `packages` required). `graph-registry.ts` mirroring `EnvironmentRegistry` MINUS the `IContainerProbe`/`Reconcile` parts: a `private readonly records = new Map<string, GraphRecord>()`, constructor `(private readonly filePath: string)`, `Load` parsing `{ graphs: { [name]: record } }` (root key constant `'graphs'`; silent return on `ENOENT`; rethrow else), `List`/`Get`/`Put`(key = `record.manifest.name`, store a copy)/`Remove`, and the same atomic `persist` (`mkdir` recursive, write to `${filePath}.${randomUUID()}.tmp`, `rename`). Hoist every literal (`'graphs'`, `'utf8'`, `'ENOENT'`, `'.tmp'`, indent `2`) to `private static readonly` constants, matching `EnvironmentRegistry`.
- [ ] **Step 4: Run the tests, confirm they pass.**
- [ ] **Step 5: Commit** — `feat(admin): graph manifest/record types and the GraphRegistry store`.

---

### Task 2: GraphService — dev-env gating, unique-name, CRUD

**Files:**
- Create: `admin/control-plane/graph-service.ts`
- Test: `admin/control-plane/tests/graph-service.test.ts`

**Interfaces:**
- Consumes: `GraphRecord`/`GraphManifest`/`GraphRegistry` (Task 1); `EnvironmentRecord`/`EnvType` (`environment-record.ts`).
- Produces: `interface IEnvironmentLookup { Get(name: string): EnvironmentRecord | undefined }` (structurally satisfied by `EnvironmentRegistry`); `class GraphService` with `Create(envName: string, name: string, description: string): Promise<GraphRecord>`, `List(envName: string): Promise<readonly GraphRecord[]>`, `Get(envName: string, graphName: string): Promise<GraphRecord>`, `Delete(envName: string, graphName: string): Promise<void>`. Error classes `GraphExistsError`, `GraphNotFoundError`, `GraphNameInvalidError`, `EnvironmentNotDevelopmentError` (each an `Error` subclass with a `private static readonly ErrorName`/`MessagePrefix` and `this.name`, mirroring `environment-service.ts`), plus reuse of `EnvironmentNotFoundError` from `environment-service.ts`.

- [ ] **Step 1: Write the failing tests** (a fake `IEnvironmentLookup` returning a record with a temp `bundleDir` and a chosen `type`, so no Docker/probe is needed)

```ts
test('Create persists a graph with an empty manifest in a Development environment', async () =>
{
    // lookup returns { ...devRecord, type: EnvType.Development, bundleDir: tmp }
    // svc.Create('dev1', 'g1', 'first'); reload graphs.json under tmp; assert manifest.name==='g1', description==='first', packages===[]
})
test('Create against a Runtime environment is rejected', async () =>
{
    // lookup returns type: EnvType.Runtime -> assert.rejects(EnvironmentNotDevelopmentError)
})
test('Create against an unknown environment is rejected', async () =>
{
    // lookup returns undefined -> assert.rejects(EnvironmentNotFoundError)
})
test('a duplicate graph name in the same environment is rejected', async () =>
{
    // Create('dev1','g1',..) twice -> second rejects GraphExistsError
})
test('the same graph name in a different environment is allowed', async () =>
{
    // two dev envs with distinct bundleDirs; Create('a','g1') and Create('b','g1') both succeed
})
test('an invalid graph name is rejected', async () =>
{
    // Create('dev1','Bad Name','') -> GraphNameInvalidError
})
test('List is scoped to the environment; Delete removes', async () =>
{
    // Create two in dev1; List('dev1') has 2; Delete('dev1','g1'); List has 1; Get deleted -> GraphNotFoundError
})
```

- [ ] **Step 2: Run the tests, confirm they fail.**
- [ ] **Step 3: Implement** — `GraphService(private readonly environments: IEnvironmentLookup)`. A private `Require(envName)` that `environments.Get(envName)` → `EnvironmentNotFoundError` if undefined, then throws `EnvironmentNotDevelopmentError` if `record.type !== EnvType.Development`, returning the record. A private `StoreFor(record)` returning `new GraphRegistry(join(record.bundleDir, GraphService.GraphsFile))` (`GraphsFile = 'graphs.json'`). A private static `SanitizeGraphName(name)` validating against `/^[a-z0-9][a-z0-9-]*$/` (hoist the pattern) → `GraphNameInvalidError`. `Create`: require dev env, sanitize name, `Load` the store, throw `GraphExistsError` if `Get(name)` present, build `{ manifest: { name, description, packages: [] }, createdAt: new Date().toISOString() }`, `Put`, return it. `List`: require dev env, `Load`, return `List()`. `Get`: require, `Load`, `Get(graphName)` or `GraphNotFoundError`. `Delete`: require, `Load`, `GraphNotFoundError` if absent, `Remove`. Register nothing with the host here. No inline literals.
- [ ] **Step 4: Run the tests, confirm they pass** (run the whole `graph-service.test.ts`).
- [ ] **Step 5: Commit** — `feat(admin): GraphService with dev-env gating and unique graph names`.

---

### Task 3: Control-plane host — IGraphService, nested routes, DTO, validation

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (add `IGraphService` ~after line 39; `GraphDto` ~after `EnvironmentDto`; a `GraphCreateBody` type; `GraphPathPattern`; register graph errors in `ErrorStatuses` ~line 168; a `RouteGraphs` block in `RouteApi`; `HandleCreateGraph`; `ToGraphDto`; add `graphService` as the 2nd constructor parameter)
- Modify: `admin/control-plane/server.ts` (~lines 47-55: construct `GraphService` over the `EnvironmentRegistry` and pass it to `ControlPlaneHost`)
- Test: `admin/control-plane/tests/control-plane-host.test.ts`

**Interfaces:**
- Consumes: `GraphService` + its error classes (Task 2); `GraphRecord`/`GraphManifest` (Task 1).
- Produces: `interface IGraphService` (the four `GraphService` methods, typed in control-plane terms); `type GraphDto = { name: string; description: string; packageCount: number; createdAt: string }`; `ControlPlaneHost` constructor `(service: IEnvironmentService, graphService: IGraphService, staticRoot: string, operator: IOperatorIdentity, secureCookie: boolean)`.

- [ ] **Step 1: Write the failing tests** (add a `FakeGraphService implements IGraphService` next to `FakeService`; update the `beforeEach` `new ControlPlaneHost(...)` to pass it; extend `Harness.DtoKeys`/the no-leak list for graphs)

```ts
test('POST .../graphs with name+description returns 201 and a leak-free GraphDto', async () =>
{
    // POST /api/environments/dev1/graphs { name:'g1', description:'first' }
    // assert 201; body keys === {name,description,packageCount,createdAt}; packageCount === 0; no bundleDir/secret
})
test('GET .../graphs lists the environment graphs', async () =>
{
    // seed FakeGraphService; GET -> 200, array of GraphDto
})
test('POST .../graphs against a runtime env maps to 400', async () =>
{
    // FakeGraphService.Throw = new EnvironmentNotDevelopmentError('dev1') -> 400
})
test('POST .../graphs against an unknown env maps to 404', async () =>
{
    // EnvironmentNotFoundError -> 404
})
test('POST a duplicate graph maps to 409', async () =>
{
    // GraphExistsError -> 409
})
test('a missing name/description is 400; an unauthenticated graphs request is 401', async () =>
{
    // no name -> 400 NameRequired-style; Anon GET/POST -> 401 (gate runs before routing)
})
```

- [ ] **Step 2: Run the tests, confirm they fail.**
- [ ] **Step 3: Implement** — add `IGraphService`; add `graphService` as the 2nd ctor param and store it. Add `GraphPathPattern = /^\/api\/environments\/([^/]+)\/graphs(?:\/([^/]+))?$/` and a `RouteGraphs` block in `RouteApi` placed with the other `/api/environments/...` patterns (its first group is the env name, the optional second is the graph name): GET with no graph name → `WriteJson(200, (await graphService.List(env)).map(ToGraphDto))`; POST with no graph name → `HandleCreateGraph(env, req, res)`; GET with a graph name → `ToGraphDto(await graphService.Get(env, graph))`; DELETE with a graph name → `await graphService.Delete(env, graph)` then 200. Decode the env/graph path segments with the existing `Decode` and 400 on a bad segment, mirroring the env routes. `HandleCreateGraph` mirrors `HandleCreate`: read+parse body (reuse `ReadJsonObject`), require `name` and `description` are non-empty strings (reuse `NonEmpty`; hoist a `DescriptionRequiredMessage`), call `graphService.Create(env, name, description)`, `WriteJson(201, ToGraphDto(rec))`. `ToGraphDto(r: GraphRecord)` returns `{ name: r.manifest.name, description: r.manifest.description, packageCount: r.manifest.packages.length, createdAt: r.createdAt }` — no `bundleDir`/secret. Register in `ErrorStatuses`: `GraphExistsError`→409, `GraphNotFoundError`→404, `GraphNameInvalidError`→400, `EnvironmentNotDevelopmentError`→400 (reuse the existing `EnvironmentNotFoundError`→404 entry). Update `server.ts` to build `new GraphService(registry)` and pass it as the 2nd `ControlPlaneHost` arg.
- [ ] **Step 4: Run the tests, confirm they pass** (run the whole `control-plane-host.test.ts`; then `npm run typecheck:tools` to catch the constructor-signature change across `server.ts`).
- [ ] **Step 5: Commit** — `feat(admin): control-plane graph routes (nested, dev-env scoped, fail-closed)`.

---

### Task 4: Portal — graphs list + create, reached from a Development environment

**Files:**
- Modify: `admin/portal/src/portal-types.ts` (`GraphDto`; `IPortalNavigator` += `ShowGraphs(envName: string)`, `ShowCreateGraph(envName: string)`)
- Modify: `admin/portal/src/api-client.ts` (`ListGraphs`, `CreateGraph`, `DeleteGraph` + the nested route helper)
- Modify: `admin/portal/src/environment-detail-view.ts` (a "Graphs" button shown only for a Development-type environment → `nav.ShowGraphs(name)`)
- Modify: `admin/portal/src/app.ts` (import the two graph views; add `ShowGraphs`/`ShowCreateGraph`)
- Create: `admin/portal/src/graph-list-view.ts`, `admin/portal/src/create-graph-view.ts`
- Test: `admin/portal/tests/api-client.test.ts`, `admin/portal/tests/portal.spec.ts`

**Interfaces:**
- Consumes: the host `GraphDto`, the nested `/api/environments/:env/graphs` routes (Task 3).
- Produces: portal `GraphDto { name: string; description: string; packageCount: number; createdAt: string }`; `CreateGraph(envName, name, description)` / `ListGraphs(envName)` / `DeleteGraph(envName, graphName)` client methods; `GraphListView`/`CreateGraphView` (extending `PortalViewBase`).

- [ ] **Step 1: Write the failing tests**

```ts
// api-client.test.ts (FetchStub pattern)
test('CreateGraph posts name+description to the nested env graphs route', async () =>
{
    // client.CreateGraph('dev1','g1','first')
    // assert captured route === '/api/environments/dev1/graphs' (env encoded) and body === { name:'g1', description:'first' }
})
test('ListGraphs GETs the nested env graphs route', async () =>
{
    // client.ListGraphs('dev1') -> route '/api/environments/dev1/graphs', no body
})
```
For `portal.spec.ts` (gated Playwright): extend `FakeControlPlane` with the nested graphs routes (list + create); assert that a Development environment's detail view shows a "Graphs" entry, that opening it lists graphs, and that submitting the create form posts the name + description and returns to the list showing the new graph with a 0 package count.

- [ ] **Step 2: Run the tests, confirm they fail.**
- [ ] **Step 3: Implement** — portal `GraphDto`; `IPortalNavigator` gains `ShowGraphs`/`ShowCreateGraph`. `api-client.ts`: a `GraphsRoute(envName)` helper (`EnvironmentsRoute + '/' + encodeURIComponent(envName) + '/graphs'`), `ListGraphs(envName)` = `Send(GraphsRoute(env), undefined)`, `CreateGraph(envName, name, description)` = `Send(GraphsRoute(env), { method: POST, body: JSON.stringify({ name, description }) })`, `DeleteGraph(envName, graphName)` = `Send(GraphsRoute(env)+'/'+encodeURIComponent(graphName), { method: DELETE })`. `GraphListView` mirrors `EnvironmentListView`: constructor `(client, nav, envName)`; heading, a `NewLabel`-style button → `nav.ShowCreateGraph(envName)`, a Back button → `nav.ShowDetail(envName)`, and rows (name | description | package-count) with a Delete+confirm (via `this.Run(() => client.DeleteGraph(envName, graphName))`); `Refresh` calls `client.ListGraphs(envName)`. `CreateGraphView` mirrors `CreateEnvironmentView`: `nameBox` + a `descriptionBox` (`TextBox`), a Create button that validates non-empty name+description client-side then calls `client.CreateGraph(envName, name, description)` and on success `nav.ShowGraphs(envName)`, and a Back button. `environment-detail-view.ts`: add a `Graphs` button (hoist the label) shown only when the environment DTO's `type` is Development → `nav.ShowGraphs(name)`. `app.ts`: import the two views; `ShowGraphs(envName)` → `Show(new GraphListView(client, this, envName))`; `ShowCreateGraph(envName)` → `Show(new CreateGraphView(client, this, envName))`. Hoist all new labels/placeholders to constants; any ComboBox-free here, but keep the `Label` rule in mind if a dropdown is added.
- [ ] **Step 4: Run the tests, confirm they pass** — `npm --prefix admin/portal test` and (gated) `npm --prefix admin/portal run test:e2e`.
- [ ] **Step 5: Commit** — `feat(admin-portal): create and list graphs within a development environment`.

---

## Closing

SP-GRAPH-2 defines the graph container and its store but leaves the manifest empty. SP-GRAPH-3 (solutions contribute compiled packages, maker-authenticated) grows `manifest.packages` additively; SP-GRAPH-4 promotes a graph's manifest into a runtime. The design doc's SP-GRAPH-2/3 folded backlog items (service-token UI, close `/api/events` on logout, masked token fields) are deferred to SP-GRAPH-3, where maker/token authentication is introduced.
