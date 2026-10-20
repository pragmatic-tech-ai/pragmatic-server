# SP-GRAPH-3a-ii: Maker-Authenticated Graph Contribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a maker a least-privilege, token-authenticated way to contribute a solution's compiled packages into a named dev-environment graph, with additive per-solution merge and package immutability, plus a portal path to mint and reveal the maker token once.

**Architecture:** A new least-privilege `Action.Contribute` + `Role.Maker` in `todl-identity`; a `graph/contribute` protocol op; a container-side additive per-solution merge in the dev graph store with package ingest mirroring the existing immutable deploy discipline; and a control-plane mint path that (as the env Owner, over the existing admin proxy) idempotently grants `Role.Maker` to a well-known maker principal and issues a standard service token for it, surfaced once by a new portal view. The maker token itself needs no change to the token-issuance contract.

**Tech Stack:** TypeScript across three symlinked sibling repos — `todl-identity` (authz model), `pragmatic-protocol` (JSON-RPC/WS wire), `pragmatic-server` (container graph store/handlers, control-plane, Mural browser portal). Build order is identity dist, then protocol dist, then server.

**Spec:** `docs/superpowers/specs/2026-10-20-sp-graph-3a-maker-contribution-spec.md` (3a-ii implements FR3 additive merge, FR4 package immutability, FR5 maker auth, FR6 token mint; FR1/FR2/FR6-CRUD shipped in 3a-i).

## Global Constraints

- OOP: behavior on classes/methods; no module-level free functions or mutable module state. Allman braces (opening brace on its own line) for every block.
- Real `enum`s over string-literal unions. No inline string literals — hoist reused/user-facing strings to `private static readonly` PascalCase constants (one home per literal).
- PascalCase for all interfaces and public methods. Private members and serialized data-shape fields keep their existing casing.
- Engine-layering holds: lower layers never import upward. New protocol ops follow the five-step "add a protocol method" convention; `PolicyGate` stays deny-by-default.
- The maker capability is least-privilege: `Role.Maker` covers ONLY `Action.Contribute` — not Read/Write/Delete/Administer/Connect — so a maker token cannot list/get/create/delete graphs nor perform any admin op.
- Secrets/tokens are never logged, echoed, committed, persisted in any stored record, or returned by any list/snapshot DTO. The minted token appears once, only in the mint response and the portal reveal.
- LF-only line endings. Every test file under a `tests/` folder. Fix ALL review findings including Minors. Nothing is pushed until the user asks.
- `pragmatic-server` lexical style: single quotes, no semicolons, `.js` import suffixes. `pragmatic-protocol` and `todl-identity` follow their own repo style (semicolons + double-quote imports in todl-identity; protocol per its existing files). `todl-identity/src/core/identity-enums.ts` is bare, semicolon-free enum bodies — match it.
- Cross-repo build ordering: after editing `todl-identity`, run `npm --prefix ../todl-identity run build`; after editing `pragmatic-protocol`, run `npm --prefix ../pragmatic-protocol run build`; only then does the server typecheck/test see the change. The `typecheck:tools` gate must stay green.

## Review Focus

- **Maker token not over-privileged:** a token minted for the maker principal authorizes `graph/contribute` only — rejected for `graph/create`/`graph/delete`, for `graph/list`/`graph/get`, and for every admin op (accounts/grants/config/security-model/deploy). Pin with authz tests at the capability table (Task 1) and the policy-gate/handler (Task 5).
- **Package immutability across solutions:** two solutions contributing the same `id@version` with identical bytes is an idempotent union; with differing bytes is a Conflict that writes no package file and mutates no manifest slice. Pin in Task 4.
- **Per-solution slice replacement, not append:** re-contributing a solution's slice replaces it; a package the solution dropped leaves the effective union unless another slice still holds it. Pin in Task 3 (store) and Task 4 (service).
- **Dev-only gating:** `graph/contribute` and the control-plane mint path are both rejected on a non-Development environment before any store write or token issuance. Pin in Task 4/5 (contribute) and Task 6 (mint).
- **No ordinal role comparison:** appending `Role.Maker` and `Action.Contribute` to the numeric enums must not change any decision — authorization is set-membership via `RoleCapabilities.Covers`, never `role >= X`. Task 1 verifies no ordinal comparison exists and that persisted grants still round-trip.
- **Empty-slice round-trip:** a graph with a solution slice set to `[]` (all packages dropped) and a brand-new graph both round-trip an empty effective package array (never null) through persist/reconnect. Pin in Task 3.
- **Secret hygiene:** the minted token is returned once by the mint route and shown once by the portal; it is never logged by the control-plane host, never placed in `AdminSnapshot`/token-list/stored env records. Pin in Task 6/7/8.

## Design rulings (decided for this plan; executors follow verbatim)

- **R1 — Capability shape.** Append `Action.Contribute` and `Role.Maker` to the numeric enums (last, no renumbering). `RoleCapabilities`: `Role.Maker -> { Action.Contribute }`; ALSO add `Action.Contribute` to `Role.Admin` and `Role.Owner` sets (role hierarchy: higher roles remain supersets). Viewer/Editor do NOT gain Contribute.
- **R2 — Contribute resource scope.** Tenant-scoped: policy `{ action: Action.Contribute, resourceKind: ResourceKind.Tenant }`. A Tenant-scoped `Role.Maker` grant covers the op's `ResourceRef(Tenant, tenantId, [])`. Per-graph scoping is out of scope.
- **R3 — Maker token binding, no contract change.** The control plane, as env Owner via the proxy: (1) idempotently `GrantRole({ subject: 'maker', role: 'Maker', resourceKind: 'Tenant', resourcePath: [] })`; (2) `IssueToken({ principalId: 'maker', scopes: ['graph-contribute'], expiresInSeconds: <ttl> })`. No account/password is created — a service principal authenticates by token and authority derives from the grant on its principal id. `AdminEnums.Roles` gains `['Maker', Role.Maker]` so the mutation parses. `IssueToken`/`ServiceTokenGrant`/`ServiceTokenAuthenticator` are unchanged.
- **R4 — Per-solution additive merge.** `DevGraphRecord.packages` (3a-i) becomes `DevGraphRecord.slices: Record<string, PackageRef[]>` keyed by stable solution id. The effective package list = union of all slices deduped by `id@version` (stable order), derived by the service for every `GraphSummaryDto`/`GraphDetailDto`. Re-contributing a solution id replaces its slice. 3a-i graphs persisted only empty package lists, so `Load` reads `slices ?? {}` and ignores any legacy `packages` field (no migration needed).
- **R5 — Package ingest + immutability.** Contribute ingests each package to `PackagesStorage()` at `<id>/<version>/model.json`, via a focused new `GraphPackageIngest` class mirroring `AppIngestService`'s discipline (byte-identical ⇒ skip; differing bytes ⇒ `GraphPackageConflictError`; crash-safe temp-then-rename; cleanup on failure). Do NOT refactor the shipped Runtime `AppIngestService`. The service ingests FIRST (enforcing immutability, no partial write), then updates the slice and persists the manifest — a rejected contribution mutates nothing. `DevGraphService` gains a `GraphPackageIngest` constructor arg.
- **R6 — Contribute is maker-direct, not proxied.** `graph/contribute` is called maker → container directly (the Plexus client is SP-GRAPH-3b). The control plane only mints the token; it does NOT relay contribute, so `admin/control-plane/graph-service.ts` `Classify` is unchanged (no Conflict mapping added there).
- **R7 — Portal reveal.** No existing "show secret once" surface; build `MakerTokenView extends PortalViewBase` (like `CreateGraphView`), shown Development-only from `environment-detail-view.ts`. Mural has no masked box, so render the token as selectable text with a "copy now — not shown again" warning; the view holds it in memory only.

---

### Task 1: Maker capability in `todl-identity`

**Files:**
- Modify: `../todl-identity/src/core/identity-enums.ts` (append enum members)
- Modify: `../todl-identity/src/authz/role-capabilities.ts` (capability table)
- Test: `../todl-identity/src/authz/tests/role-capabilities.test.ts`

**Interfaces:**
- Produces: `Action.Contribute`, `Role.Maker`; `RoleCapabilities.Covers(Role.Maker, Action.Contribute) === true`. Consumed by the server's `AdminEnums`, `PolicyGate`, and `graph/contribute` authorization.

- [ ] **Step 1: Add failing capability tests.** In `role-capabilities.test.ts` assert: `Covers(Role.Maker, Action.Contribute)` is `true`; `Covers(Role.Maker, Action.Read/Write/Delete/Administer/Connect)` are all `false`; `Covers(Role.Owner, Action.Contribute)` and `Covers(Role.Admin, Action.Contribute)` are `true`; `Covers(Role.Viewer, Action.Contribute)` and `Covers(Role.Editor, Action.Contribute)` are `false`.
- [ ] **Step 2: Run the suite; confirm the new assertions fail** (`Role.Maker`/`Action.Contribute` undefined).
- [ ] **Step 3: Append `Contribute` to `enum Action` and `Maker` to `enum Role`** in `identity-enums.ts` (last members, bare semicolon-free Allman style matching the file). In `role-capabilities.ts` add `[Role.Maker, new Set([Action.Contribute])]` and add `Action.Contribute` to the `Role.Admin` and `Role.Owner` sets.
- [ ] **Step 4: Verify no ordinal role comparison exists.** Grep `todl-identity/src`, `todl-identity-node/src`, `todl-identity-local/src` and `pragmatic-server/src` for role/action relational comparisons (`>= Role.`, `> Role.`, `< Action.`, etc.); confirm none. Record the grep result in the task report. If any exists, STOP and surface it.
- [ ] **Step 5: Run `npm --prefix ../todl-identity test`; confirm green.**
- [ ] **Step 6: Rebuild dist and commit.** `npm --prefix ../todl-identity run build`; commit the src + rebuilt dist with a conventional message.

---

### Task 2: `graph/contribute` protocol op in `pragmatic-protocol`

**Files:**
- Modify: `../pragmatic-protocol/src/dto/wire-dtos.ts` (new DTOs)
- Modify: `../pragmatic-protocol/src/contracts/graph-protocol.ts` (new op)
- Modify: `../pragmatic-protocol/src/client/pragmatic-client.ts` (wrapper)
- Test: `../pragmatic-protocol/src/tests/graph-protocol-contract.test.ts` (extend)

**Interfaces:**
- Produces:
  - `interface ContributedPackageDto { id: string; version: string; modelJson: string }`
  - `interface GraphContributeParamsDto { graphName: string; solutionId: string; packages: ContributedPackageDto[] }`
  - `GraphProtocol.Contribute = new RequestType<GraphContributeParamsDto, GraphDetailDto, void>('graph/contribute')` (method string hoisted to `private static readonly ContributeMethod`)
  - `PragmaticClient.ContributeGraph(params: GraphContributeParamsDto): Promise<GraphDetailDto>` via `this.Request(GraphProtocol.Contribute, params)`
- Consumes: existing `GraphDetailDto` (unchanged — contribute returns the updated detail).

- [ ] **Step 1: Extend the contract test** to assert `GraphProtocol.Contribute.method === 'graph/contribute'` and that `ContributeGraph` on `PragmaticClient` forwards to `GraphProtocol.Contribute` (mirror the existing Create/Get wrapper assertions and the barrel-parity expectations).
- [ ] **Step 2: Run the protocol suite; confirm the new assertions fail.**
- [ ] **Step 3: Add the DTOs** to `wire-dtos.ts` (flat camelCase, mirroring `CypherAppDeployParamsDto.packages[]` for the package element), the `Contribute` `RequestType` to `graph-protocol.ts` (import `GraphContributeParamsDto`), and the `ContributeGraph` wrapper to `pragmatic-client.ts` (import the new params type). DTOs are already surfaced by both barrels via `export *`; `GraphProtocol` is already exported.
- [ ] **Step 4: Run the protocol suite + barrel-parity test; confirm green.**
- [ ] **Step 5: Rebuild dist and commit.** `npm --prefix ../pragmatic-protocol run build`; commit src + dist.

---

### Task 3: Per-solution slice store in `src/host/graphs/dev-graph-store.ts`

**Files:**
- Modify: `src/host/graphs/dev-graph-store.ts`
- Test: `src/host/graphs/tests/dev-graph-store.test.ts` (extend)

**Interfaces:**
- Produces: `type PackageRef = { id: string; version: string }`; `type DevGraphRecord = { name: string; description: string; slices: Record<string, PackageRef[]>; createdAt: string }`. Store methods `Load/List/Get/Put/Remove` keep their signatures but persist `slices`. Deep `Copy` copies every slice array element-by-element.
- Consumes: `IStorage` (unchanged).

- [ ] **Step 1: Write failing store tests** over `MemoryStorage`: a record with two slices persists and reloads with both slices intact; `Copy` isolation holds (mutating a returned record's slice does not change stored state); a record with one slice set to `[]` round-trips as an empty slice (not dropped, not null); `Load` on a document whose graph entry has no `slices` key yields `slices === {}`.
- [ ] **Step 2: Run the store tests; confirm they fail** (records still carry `packages`).
- [ ] **Step 3: Change `DevGraphRecord` to the slices shape**, update `Load` to read `record.slices ?? {}` (ignore any legacy `packages` field), update `Copy` to deep-copy `slices` (each array and its `{id,version}` elements), and keep `Put`/`Remove`/`Persist` writing the whole document. Hoist any new JSON keys to `private static readonly` constants.
- [ ] **Step 4: Run the store tests; confirm green.**
- [ ] **Step 5: Commit.**

---

### Task 4: Contribute + ingest in `src/host/graphs/`

**Files:**
- Create: `src/host/graphs/graph-package-ingest.ts`
- Modify: `src/host/graphs/dev-graph-service.ts`
- Modify: `src/pragmatic-server.ts` (`GraphService()` construction)
- Test: `src/host/graphs/tests/graph-package-ingest.test.ts` (create)
- Test: `src/host/graphs/tests/dev-graph-service.test.ts` (extend)

**Interfaces:**
- Consumes: `ContributedPackageDto`, `GraphContributeParamsDto`, `GraphDetailDto` (Task 2); `DevGraphRecord`/`PackageRef` (Task 3); `IStorage`; `PragmaticServer.PackagesStorage()`.
- Produces:
  - `class GraphPackageIngest { constructor(packages: IStorage); Store(packages: readonly ContributedPackageDto[]): Promise<void> }`
  - `class GraphPackageConflictError extends Error` (secret-free message, `.name`)
  - `IDevGraphService.ContributeGraph(params: GraphContributeParamsDto): Promise<GraphDetailDto>`
  - `DevGraphService` constructor gains a second arg `ingest: GraphPackageIngest`; a `private static EffectivePackages(record: DevGraphRecord): PackageRef[]` deduping slices by the `id@version` key.

- [ ] **Step 1: Write failing `GraphPackageIngest` tests** over `MemoryStorage`: storing a new `id@version` writes `<id>/<version>/model.json`; storing the same `id@version` with identical bytes is a no-op success (file unchanged, no throw); storing the same `id@version` with different bytes throws `GraphPackageConflictError` AND leaves the existing file's bytes unchanged AND writes no other file from the batch (no partial write); a mid-batch conflict removes any temp/newly-created files.
- [ ] **Step 2: Write failing `DevGraphService.ContributeGraph` tests** over a `MemoryStorage`-backed store + a real `GraphPackageIngest`: contributing to a missing graph throws `GraphNotFoundError`; a first contribution puts the solution's packages in the effective union and returns them in the `GraphDetailDto`; a second contribution from a different solution unions (dedup by `id@version`); re-contributing the first solution with a dropped package shrinks the union; two solutions contributing the same `id@version` with identical bytes yields one union entry; the same `id@version` with differing bytes throws and leaves the manifest slice unchanged (no partial); a contribution with an empty `packages` array sets that slice to `[]` and the union reflects it.
- [ ] **Step 3: Run both test files; confirm failures** (`ContributeGraph`/`GraphPackageIngest` absent).
- [ ] **Step 4: Implement `GraphPackageIngest`** mirroring `AppIngestService.AssertImmutable` (bytes compare, skip-identical, Conflict-on-differ) and `Commit` (temp suffix + `Rename`, cleanup temps and newly-created files on failure, never delete a pre-existing file). Add a class comment noting it mirrors `AppIngestService`'s immutability discipline and the two must stay consistent. Implement `DevGraphService.ContributeGraph`: `Load`; `Get` or throw `GraphNotFoundError`; `await this.ingest.Store(params.packages)` FIRST; then set `record.slices[params.solutionId]` to the packages' `{id,version}` refs; `Put`; return `ToDetail`. Rewire `ToSummary`/`ToDetail`/`packageCount` to use `EffectivePackages`.
- [ ] **Step 5: Wire construction** in `pragmatic-server.ts` `GraphService()`: `new DevGraphService(new DevGraphStore(this.GraphsStorage()), new GraphPackageIngest(this.PackagesStorage()))`.
- [ ] **Step 6: Run the graphs tests + `npm run typecheck:tools`; confirm green. Commit.**

---

### Task 5: Register + authorize `graph/contribute` in `src/host/`

**Files:**
- Modify: `src/host/server-connection-handler.ts` (register the op)
- Modify: `src/host/policy-gate.ts` (contribute policy entry)
- Modify: `src/host/admin-enums.ts` (`Maker` name mapping)
- Test: `src/host/tests/server-connection-handler.graphs.test.ts` (extend)
- Test: `src/host/tests/policy-gate.test.ts` (extend, if present; else add graph-contribute coverage to the nearest policy-gate test)

**Interfaces:**
- Consumes: `GraphProtocol.Contribute` (Task 2); `IDevGraphService.ContributeGraph` (Task 4); `Action.Contribute` (Task 1); `Role.Maker`.
- Produces: `graph/contribute` handler guarded + `EnsureDevelopment()` + `RequireGraphService().ContributeGraph(p)`; `PolicyGate` entry `[GraphProtocol.Contribute.method, contribute]` with `const contribute: MethodPolicy = { action: Action.Contribute, resourceKind: ResourceKind.Tenant }`; `AdminEnums.Roles` entry `['Maker', Role.Maker]`.

- [ ] **Step 1: Write failing handler tests:** `graph/contribute` is rejected on a non-Development tenant (before any store call); on a Development tenant it delegates to `IDevGraphService.ContributeGraph` and returns the detail; when the service is absent `RequireGraphService` throws the unavailable `ResponseError`.
- [ ] **Step 2: Write failing policy tests:** `GraphProtocol.Contribute.method` resolves to `{ action: Action.Contribute, resourceKind: Tenant }`; a principal whose only grant is `Role.Maker` on the tenant is Allowed for `graph/contribute` and Denied for `graph/create`, `graph/delete`, `graph/list`, `graph/get`, and a representative admin method (e.g. `AdminProtocol.IssueToken`); a `Role.Owner` principal is Allowed for `graph/contribute`.
- [ ] **Step 3: Run; confirm failures.**
- [ ] **Step 4: Implement.** Register `GraphProtocol.Contribute` in `RegisterGraphHandlers` via `guarded` (it takes params), gated by `EnsureDevelopment()` then `RequireGraphService().ContributeGraph(p)`. Add the `contribute` policy constant + table entry in `PolicyGate.BuildTable`. Add `['Maker', Role.Maker]` to `AdminEnums.Roles`.
- [ ] **Step 5: Run the host suite + `npm run typecheck:tools`; confirm green. Commit.**

---

### Task 6: Maker-token mint in the control plane (proxy + env service)

**Files:**
- Modify: `admin/control-plane/admin-proxy.ts` (`IssueToken` on connection + proxy)
- Modify: `admin/control-plane/environment-service.ts` (`AdminIssueMakerToken`)
- Modify: `admin/control-plane/control-plane-host.ts` (only the `IEnvironmentService` interface entry, if the interface lives here; else env-service)
- Test: `admin/control-plane/tests/environment-service.test.ts` (extend, `FakeAdminProxy`)
- Test: `admin/control-plane/tests/admin-proxy.test.ts` (extend)

**Interfaces:**
- Consumes: `AdminProtocol.IssueToken`, `IssueTokenParams`, `TokenIssuedDto`, `GrantMutationDto` (protocol); existing `IAdminProxy.GrantRole`, `AdminConnectInfo`, `EnvironmentService.AdminInfoFor`, `EnvType.Development`.
- Produces:
  - `IAdminConnection.IssueToken(params: IssueTokenParams): Promise<TokenIssuedDto>`; `WsAdminConnection` implements via `this.conn.sendRequest(AdminProtocol.IssueToken, params)`.
  - `IAdminProxy.IssueToken(info, params)`; `AdminProxy.IssueToken` via `this.With(info, c => c.IssueToken(params))`.
  - `IEnvironmentService.AdminIssueMakerToken(name: string): Promise<TokenIssuedDto>`; `EnvironmentService.AdminIssueMakerToken` dev-gates (throw `EnvironmentNotDevelopmentError` if the registry record is not `EnvType.Development`), then `GrantRole(info, { subject: MakerPrincipalId, role: MakerRoleName, resourceKind: TenantKindName, resourcePath: [] })`, then `IssueToken(info, { principalId: MakerPrincipalId, scopes: [MakerScope], expiresInSeconds: MakerTokenTtlSeconds })`.
  - Hoisted constants on `EnvironmentService`: `MakerPrincipalId = 'maker'`, `MakerRoleName = 'Maker'`, `TenantKindName = 'Tenant'`, `MakerScope = 'graph-contribute'`, `MakerTokenTtlSeconds` (choose a bounded value, e.g. one hour; document it).

- [ ] **Step 1: Write failing `admin-proxy` test:** `AdminProxy.IssueToken(info, params)` opens one connection, calls the connection's `IssueToken`, disposes, and returns the `TokenIssuedDto`; a thrown error routes through `Classify` like the graph methods.
- [ ] **Step 2: Write failing `environment-service` tests** with a `FakeAdminProxy`: `AdminIssueMakerToken` on a Development env calls `GrantRole` once with the maker subject + `'Maker'` role + Tenant kind, THEN `IssueToken` for principal `'maker'`, and returns the token; calling it twice still succeeds (idempotent grant); on a non-Development env it throws `EnvironmentNotDevelopmentError` and calls neither `GrantRole` nor `IssueToken`; the returned `TokenIssuedDto` is passed through unchanged (token present).
- [ ] **Step 3: Run; confirm failures.**
- [ ] **Step 4: Implement** the `IssueToken` methods on `IAdminConnection`/`WsAdminConnection`/`IAdminProxy`/`AdminProxy` (mirror the graph methods), and `AdminIssueMakerToken` on `IEnvironmentService`/`EnvironmentService` with the hoisted constants and the dev-gate.
- [ ] **Step 5: Run the control-plane suite + `npm run typecheck:tools`; confirm green. Commit.**

---

### Task 7: Mint-token route in `admin/control-plane/control-plane-host.ts`

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts`
- Test: `admin/control-plane/tests/control-plane-host.test.ts` (extend)

**Interfaces:**
- Consumes: `IEnvironmentService.AdminIssueMakerToken` (Task 6); existing operator-auth gate (`Authenticated`/`OriginAllowed`), `ErrorStatuses`, `AdminStatus`, `WriteJson`.
- Produces: a `MakerTokenDto { token: string; principalId: string; expiresAt: string | null }` (host-local type, mirror of the token subset actually revealed); path constant + `MakerTokenPathPattern` for `POST /api/environments/:name/maker-token`; `RouteMakerToken` dispatcher wired into `RouteApi`; `HandleIssueMakerToken` calling `this.service.AdminIssueMakerToken(name)` and writing the DTO with `StatusCreated` (or `StatusOk`).

- [ ] **Step 1: Write failing host tests** (mirror the graph-route tests): an authenticated operator `POST`ing the maker-token path for a Development env gets 2xx and a body carrying a non-empty `token`; an unauthenticated request gets 401; a cross-origin mutating request gets 403; a non-Development env surfaces `EnvironmentNotDevelopmentError` as 400; an unknown env surfaces 404; an `AdminProxyError` maps via `AdminStatus`. Add an assertion that the handler does NOT pass the token to the host logger (spy/fake logger sees no call containing the token value).
- [ ] **Step 2: Run; confirm failures.**
- [ ] **Step 3: Implement** the path constant(s), `MakerTokenPathPattern`, `RouteMakerToken` (POST-only; 405 otherwise, matching the graph routes), and `HandleIssueMakerToken`. Return only `{ token, principalId, expiresAt }`. Ensure no log statement includes the token.
- [ ] **Step 4: Run the control-plane suite + `npm run typecheck:tools`; confirm green. Commit.**

---

### Task 8: Portal maker-token reveal

**Files:**
- Modify: `admin/portal/src/portal-types.ts` (`MakerTokenDto` mirror + `IPortalNavigator.ShowMakerToken`)
- Modify: `admin/portal/src/api-client.ts` (`IssueMakerToken`)
- Create: `admin/portal/src/maker-token-view.ts`
- Modify: `admin/portal/src/app.ts` (`ShowMakerToken` navigation)
- Modify: `admin/portal/src/environment-detail-view.ts` (Development-only button)
- Test: `admin/portal/tests/portal.spec.ts` (extend)

**Interfaces:**
- Consumes: `ControlPlaneClient.Send`, `PortalViewBase`, `IPortalNavigator` (existing); the maker-token route (Task 7).
- Produces: `interface MakerTokenDto { token: string; principalId: string; expiresAt: string | null }` (portal-local structural mirror, like `SecurityModelDto`); `ControlPlaneClient.IssueMakerToken(envName: string): Promise<MakerTokenDto>` (POST via a `MakerTokenRoute`); `class MakerTokenView extends PortalViewBase`; `IPortalNavigator.ShowMakerToken(envName: string)` + `App.ShowMakerToken`; a Development-only "Mint maker token" button on the environment detail view.

- [ ] **Step 1: Write a failing portal test** (mirror the create-graph flow): from a Development environment detail, the "Mint maker token" control navigates to `MakerTokenView`; minting calls `IssueMakerToken` and the returned token renders once as selectable text with the "not shown again" warning; the token string is not written to any persisted client state and the view does not appear for a Runtime environment.
- [ ] **Step 2: Run the portal spec; confirm failure.**
- [ ] **Step 3: Implement** the DTO mirror + navigator member in `portal-types.ts`, `IssueMakerToken` in `api-client.ts` (mirror `CreateGraph`'s `Send` + `MethodPost` style with a `MakerTokenRoute` helper), `MakerTokenView` (ctor `(client, nav, envName)`, a mint button via `MakeButton`, `Run(...)` the mint then render the token + warning; hold the token in a field only), `App.ShowMakerToken`, and the Development-only button in `environment-detail-view.ts` next to the Graphs button.
- [ ] **Step 4: Run the portal spec + `npm run typecheck:tools`; confirm green. Commit.**

---

## Build & verification notes

- Execute tasks in order: Task 1 (identity, rebuild dist) → Task 2 (protocol, rebuild dist) → Tasks 3-8 (server). The server will not typecheck Task 5+ until the identity and protocol dists are rebuilt.
- Final whole-branch verification (most-capable model): control-plane suite, full `src/host` suite, the graphs store/service/ingest tests, the portal spec, and `npm run typecheck:tools` — all green — plus a grep of server + control-plane source/logs confirming the token value is never logged.
