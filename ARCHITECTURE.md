# pragmatic-server — Architecture Index

> Navigational map for orientation. Read this before re-exploring. **Maintenance rule:** when a change moves or renames a seam below, update this file in the same commit. Line numbers drift — treat them as "near here", trust the symbol name.

**Package:** `@pragmatic-tech-ai/pragmatic-server` — Layer **L4** headless server. Exposes the TODL engine (+ connectors + identity) to remote clients over `pragmatic-protocol` (JSON-RPC 2.0 over WebSocket). Consumes TODL + todl-runtime + pragmatic-protocol + todl-identity + todl-platform-node as built `dist` via `file:` sibling deps.

**Vision context (read these memories):** the server is two **tenant types** — a *development* center (collaborative edit of ONE active solution; the surface SP3/Cypher shipped against) and a *runtime* graph provider (compiled application = package set + connectors). See memory `project_server_dual_purpose` and `project_server_architecture`. The dev-vs-runtime tenant **type** now exists in code as `TenantPurpose` (`src/tenancy/tenant-purpose.ts`: `Development` / `Runtime`; `PragmaticServer.Purpose()`); the runtime data-op surface is described under "Runtime data ops" below.

---

## Layering & composition

- Per-tenant **`PragmaticServer`** builds a `LazyCompositionRoot(HostKinds.Server)` — lazy domain modules (solution-services, language-service: Dormant→Active on first `Resolve`) + eager infra (storage, prompt, package source/store, connectors). `src/pragmatic-server.ts`.
- Engine-never-imports-server holds: the server composes down into TODL; TODL has no server symbol.

## Entry points

- **Programmatic:** `PragmaticServer` (`src/pragmatic-server.ts`) — `Start` / `OpenSolution(dir)` / `Manager()` / `LanguageService()` / `DevEngine()` / `DevScopes()` / `DevCypher()` / `Connectors()` / `Dispose`.
- **Process:** `bin` entry via `ServerBootstrap` + `ServerConfigLoader` (`src/config/`) — env+file config, fail-closed; SIGTERM graceful shutdown.
- **Host:** `PragmaticServerHost` (`src/host/pragmatic-server-host.ts`) — one server over a `ws` `WebSocketServer({ noServer: true })`; `StartAsync` / `DisposeAsync`. WorkerHost variant for multi-tenant workers.

## HTTP / transport surface (`src/host/pragmatic-server-host.ts`)

- `createServer()`/`httpsCreateServer` + `WebSocketServer` (~:213); upgrades via `wss.handleUpgrade` (~:430). **WebSocket is the primary surface.**
- HTTP router `Request(req,res)` (~:482):
  - `/healthz` + `/readyz` — `HealthEndpoint` (`src/host/health-endpoint.ts`), unauthenticated.
  - `/auth/login`, `/auth/oidc/begin`, `/auth/oidc/callback`, `/auth/machine` — `AuthHttpEndpoint` (`src/host/auth-http-endpoint.ts`), deny-by-default token issuance.
  - everything else → 404.
- **No static/SPA/asset serving today** (relevant: runtime-tenant same-origin frontend is a future cycle).

## Tenancy (`src/tenancy/`)

- **`TenantRegistry`** (`src/tenancy/tenant-registry.ts:31`) — owns one `PragmaticServer` per tenant, `servers: Map<string, PragmaticServer>` (:50), lazy-built on first use. Validates tenant id as a path segment (`SeparatorPattern`, `InvalidTenantError`, :38/:183).
- **`OptionsFor(tenantId)`** (:223) is the composition seam. **Per-tenant storage root = `packages/` + `identity/` ONLY** (`PackagesDir='packages'` :33, `IdentityDir='identity'` :34; roots at :226/:232). No application/manifest dir provisioned (reshape adds this).
- `Tenant` = `{ id, displayName }` (from `@pragmatic-tech-ai/todl-identity`); built at :234.
- **Provisioning:** `ITenantProvisioning.OptionsFor` → `TenantProvisioning` (`src/tenancy/tenant-provisioning.ts:6`: `{ displayName, bootstrap?, oidc?, connectorsPolicy?, connectors?, connectorSecretRefs?, identity?, machine? }`). Impls: `InMemoryTenantProvisioning` (tenant-registry.ts:14), `FileTenantProvisioning` (`src/config/file-tenant-provisioning.ts:57`, on-disk `{ tenants: Record<id, TenantShape> }`). **No `TenantKind`/type discriminator anywhere** — the only axis is `DeploymentMode` (Local/cloud, `src/platform/deployment-mode.ts`), applied uniformly. ⇐ reshape target: a per-tenant type belongs in `TenantProvisioning`/`TenantShape`.

## Domain binding: solution → graph (`src/pragmatic-server.ts`)

- `Manager()` (:202) → `root.Resolve(SolutionManagerService.Key)`. Holds **ONE active solution** (engine side; see TODL index). `OpenSolution` (:212) delegates to the manager.
- The dev tenant's graph is the embedded engine (`DevEngine()`, see "Dev graph engine"); the runtime tenant composes from an application's *package set* (`GraphForPragmaticApp`) or the loaded environment graph.

## Cypher query path (`src/host/cypher/`)

- **Dev `cypher/query` / `cypher/models`** run on the dev graph engine (`DevCypherQuery`, see "Dev graph engine"); the handler gets it as `IDevCypherQuery` (its 6th Attach parameter, `devCypher`, from `DevelopmentAttachArgs`). The legacy dev graph caches (`TenantGraphCache`, `ModelShardCache`, `ModelShardGraph`, `TenantGraphComposition`) are gone. The runtime branches (bound app, environment graph) still execute TODL `Cypher.CypherEngine.OverQuery` over an `IGraphQuery`.
- **Read endpoint guards:** `cypher/query` parses once and rejects a well-formed write (names `cypher/execute`) and, when paged, a tail SKIP/LIMIT. Runtime cursors also fingerprint the reachable data (`paging/graph-data-digest.ts`), since runtime graphs re-pull per request.
- **Cells:** `cypher-result-mapper.ts` decodes engine cells with `Cypher.CypherCellCodec` (node = `{ "$node": … }`, reserved-key maps escaped as `{ "$map": … }`) — never by shape.
- **Writes (`cypher/execute`, dev):** `DevCypherExecutor` = in-process mutex + tenant write lease (`write-lock.ts`; `RedisWriteLock` from `RedisTenantOwnership` in a cluster, via `PragmaticServerOptions.writeLock`) held across plan→authorize→commit→persist, fenced (`Held()`) + source-hash CAS before persist. Co-located schema members are writable (TODL splices model bodies). Secured graphs forward `Materialize` (read-your-writes).
- **Push-down (runtime):** a runtime read passes `{ text, parameters }` to `GraphForPragmaticApp`, which pushes `Cypher.CypherPushDown` ∧ the access-policy push-down (only with no record shares) into `ConnectorPrefetch` source queries.
- **Handler:** `ServerConnectionHandler` registers `CypherProtocol.Query` under `guarded` (rate-limit→authorize→handler); `cypher-param-converter.ts` (wire params→engine, `Object.create(null)` anti-`__proto__`), `cypher-result-mapper.ts` (engine PascalCase→wire camelCase). Error map: syntax/semantic→InvalidParams, `CypherTimeout`→ -32030 (`DevCypherQuery.TimeoutCode`, re-exported as `ServerConnectionHandler.CypherTimeoutCode`). Limits from `CypherLimits` config.

## Dev graph engine (`src/host/engine/`)

Plan M1.4 moves the dev-tenant graph onto an embedded pragmatic-graph engine (`@pragmatic-tech-ai/graph`, `file:../pragmatic-graph`). Inputs come from SAVED `.todl` files only, never the language service's unsaved buffers (`DidChange` text is a live buffer).

- **`SavedMemberReader`** (`saved-member-reader.ts`) - per member: `TodlSourceCollector.Collect(storage)` + `ResolveBasesFor(storage)` -> `SavedMember { Storage, Sources, Bases, OriginOf, Models }`; `Models` = the `model` containers the member's own sources declare (compile provenance). `NamespaceOf(modelId, solutionName)` = id prefix, else solution name. `DeclaredModelCache` keeps each storage's declared models for the source hash they were compiled from, so an unchanged member is not recompiled; the engine host shares ONE reader between the snapshot source and the workspace (both constructors take an optional reader).
- **`DevSnapshotSource.Current()`** (`dev-snapshot-source.ts`) - every member with a model compiled from its saved sources (absolute uris) by TODL `SavedModelCompiler` (one package per model id, so seed `Owner` = model id; instances outside every model -> the solution package), described by `SnapshotDescriber` with `DefaultConnector: TodlNames.FileConnector`. `Description.Version` is the content digest `GraphEngine.Upgrade` compares. Base nodes compiled from an in-solution member that is itself compiled here are stripped (`OriginOf` `OpenProject`), so nothing is declared twice. `CompileDiagnostics` carries the compile's diagnostics (an error = the saved sources do not compile).
- **`ServerModelWorkspace`** (`server-model-workspace.ts`) - TODL `ITodlModelWorkspace` for `TodlFileConnector`: `OpenDraft(modelId)` finds the member whose saved sources declare the model (`OwningMember`; the saved-file counterpart of `PragmaticServer.OwningMember`), drafts over its sources (storage-relative uris), `SourceHash` = `TodlSourceCollector.SourceHash`. Solution name / undeclared id -> undefined (not editable). Each `WriteFile`/`DeleteFile` is a per-file compare-and-swap (storage must hold the opening text or this session's own last write, else it refuses with `EngineBridgeError` `Stale` -> the connector fails the commit Stale, restores what it wrote and does not count the refused write as unrestored: two models sharing a file cannot lose an edit), then `DidChange(absoluteUri, text)` / `DidDelete(absoluteUri)` + `WhenIdle()`; a refresh failure is logged, never fails the write. Absolute uris: `TodlSourceCollector.AbsoluteUri`.
- `IDevSolution` (`dev-solution.ts`) is the solution slice it reads (`Name`, `Members.ToArray()`); TODL `Solution` satisfies it.
- **`DevGraphEngineHost`** (`dev-graph-engine-host.ts`) implements `IDevGraphEngine { Engine(); Repository(); Description(); Snapshot(); Changed: ISignal<void> }` + `IDisposable` (`Snapshot()` = the whole `DevSnapshot` the engine runs in one read, incl. its `CellMapper`: TODL `EngineCellMapper` over the same compiled metadata). `PragmaticServer.DevEngine()` memoizes one (`devEngine ??=`; throws once the server is disposing; `DoDispose` disposes the scope source and then it, after the connectors host and identity flow store, just before draining the language service); `ServerConnectionHandler.DevelopmentAttachArgs` hands it (with `devGraphService`) to every dev-tenant `Attach` in BOTH `PragmaticServerHost` and `WorkerHost` (the handler's last ctor/Attach parameter `devEngine`). Opens on first use: `GraphEngine.Open({ Description, Storage: Memory, Connectors: [TodlFileConnector(ServerModelWorkspace)] })`, no solution -> the empty description. Upgrade: `GraphChanged` only (re)arms a `UpgradeDebounceMs = 150` debounce (`IUpgradeTimer`; never works inside the language-service queue or a commit's refresh); one drain loop then recompiles (`DevSnapshotSource.Current()`) and calls `engine.Upgrade` only when `Version` differs, changes arriving meanwhile coalescing into one more pass. The connector is wrapped by `EngineWriteTracker`, which counts the engine's own connector transactions (Begin -> Commit/Revert, plus a post-commit compensating Revert): the drain waits until none is in flight and re-reads when one began while it read, so a multi-file commit half on disk is never applied (an upgrade mid-commit would also fail that commit, ruling R77); the one remaining window is a commit that begins while `Upgrade` runs, which fails with a retry-safe ConflictError. `DevSnapshotSource` returns its previous snapshot without recompiling when the solution, every member's source hash and its bases fingerprint (`SavedMember.BasesHash`: content of the resolved bases + origins, so freshly rebuilt sibling bases still match) are unchanged; `DeclaredModelCache` never caches a compile with errors. A throwing `Changed` subscriber is reported (`ChangedHandlerFailed`) and never stalls later upgrades. A throw or compile error (`DevSnapshotCompileError`) is reported to `IDevEngineDiagnostics` and not applied: the engine keeps its previous version, the next change retries. `Changed` is raised after each applied upgrade. `WhenUpgraded()` awaits the running drain (tests).
- **`DevAccessScopeSource`** (`dev-access-scope-source.ts`) - the ONE place dev graph access is decided: `ScopeFor(ctx): Promise<IDevScope { Scope: AccessScope; Placement(modelId); Digest }>`; endpoints pass `Scope` to the engine and never filter or mask themselves. Scope = TODL `PolicyScopeCompiler.FromRepository(host repo, description).Compile(PrincipalFacts, Allow)` AND (identity configured) `DepthScopeCompiler.Compile(TenantReadAuthorization.EvaluatorForContext(ctx), principal, description)`, combined deny-wins by `AccessScopeConjunction` (same-key Rows ANDed, Writes ANDed per op, Hidden / HiddenExact and ReadOnly / ReadOnlyExact (per op) unioned key by key, a Deny default the other scope's entries would override materialized as `Not(ConceptIs concept)` ANDed onto that concept, never a plain False that would reach its subconcepts). Policy entries (and policy Hidden) keep engine inheritance. No identity: policy Rows only, Default Allow, no write rules (today's open dev writes). Cached per `Digest` = JSON of (`ConnectorPrincipalDigest`, tenant, sha256 of the sorted claims, engine `SchemaVersion`, security generation); `TenantReadAuthorization.Invalidated` (`ISignal<string>`, raised by `Invalidate`) bumps the generation and drops the cache, host `Changed` drops it. Every compiled scope is opened once on the engine (`BeginRead`, its ScopeValidator) before it is handed out; compiler diagnostics go to `IDevScopeDiagnostics` (default `LoggerDevScopeDiagnostics` over `ILogger`; once per message until the cache drops). Digest coverage: the exact member sets are derived only from the evaluator (tenant + security generation), the principal (principal digest + claims hash) and the schema version, all already in the Digest. Failures are `DevAccessScopeError` (`DevAccessScopeErrorCode`). `Placement(modelId)` = `TodlNodePlacement(modelId, NamespaceOf(modelId, solution))` + the depth create defaults (`IPlacementDefaults`) as `INodePlace.Defaults`.
- **Production wiring:** `PragmaticServer.DevScopes()` memoizes one `DevAccessScopeSource(DevEngine(), identity ? ReadAuthorization() : undefined, identity configured, active solution name, LoggerDevScopeDiagnostics(options.logger ?? NullLogger))` (a failed build is evicted and retried); `PragmaticServerOptions.logger` is the host's logger, handed down by `TenantRegistry` (both hosts pass `options.logger`). Disposed with the server, before the engine.
- **`DevCypherQuery`** (`dev-cypher-query.ts`) - dev `cypher/query` + `cypher/models` on the engine (`PragmaticServer.DevCypher()`, memoized). `Run(ctx, { Source; Parameters; ModelId?; Page { Params, Limits, RowCap }; TimeoutMs; MaxVarLength })`: scope = the caller's `IDevScope.Scope`; a `ModelId` must be one of `Models()` (else InvalidParams "model not found", identical for every unknown id) and ANDs `OwnerIs(modelId)` into the `todl.Element` rows entry (`AccessScopeConjunction`, deny-wins; cached per scope object), so the model filter reaches every concept. Executes `Cypher.CypherEngine(engine, { MaxVarLength }).Execute(scope, source, { Parameters, Limits: { Skip, RowCap, Cancel: Deadline.After(TimeoutMs) } })` -> `DevSnapshot.CellMapper.MapResult` -> `CypherResultMapper.ToWire`. Cursor fingerprint = `cypher`, text, canonical params, engine `SchemaVersion`, latest commit (an `AccessScope.System` reader's `SnapshotCommit`; reads carry no `result.Commit`) and, model-scoped, `model`, the model id and the scope `Digest` (they replace `GraphRevision`). The state is read before and after the run; a run that saw an upgrade or commit is repeated (`MaxAttempts` 5), a continuation that never settles is CursorStale. Engine `CypherErrorCode.Syntax`/`Semantic` -> InvalidParams, `Timeout` -> -32030. `Models()` = the sorted distinct seed `Owner`s of the running description, without the solution package (it owns what lies outside every model, and the terms). The endpoint never filters or masks: hidden members come back as the engine and `EngineCellMapper` render them.
- **`DepthScopeCompiler`** (`depth-scope-compiler.ts`) - reproduces today's exact-concept `AccessDepthInstanceFilter` / write gate: every described concept K gets Rows and Create/Update/Delete entries guarded `Or(Not(ConceptIs K), rule)` (R93), so a rule never reaches K's subconcepts. Rule = K's own level: None False, Organization True, User `In(owner, [id, ...teams])`, BusinessUnit / BusinessUnitAndChildren `In(bu, evaluator.ReachOf(principal) [+descendants])` with OwnershipResolver's root fallback for an unset/empty/unknown unit VALUE; a missing or non-String owner / BU field compiles to False with a diagnostic. Ungoverned concepts are None (denied); a tenant with no security model (DenyAll) denies every instance, while `todl.Term` stays readable (today's schema-level terms) and is never writable. Field security is exact-concept like today's mask (R94): unreadable secured member -> `HiddenExact`; readable but not create-writable -> `ReadOnlyExact.Create`, not update-writable -> `ReadOnlyExact.Update`, so a member secured on a parent is never hidden / read-only on a subconcept that does not secure it. Declared behaviour change: write-only members (hidden but writable) are not supported, writing a hidden member is refused (`HiddenMember`). `EngineSchemaCatalog` (`engine-schema-catalog.ts`) reads concepts, ancestors, applicable keys and effective members (with property types) off the description so every emitted name is valid. `PrincipalFacts` (`principal-facts.ts`) adapts `Principal` to TODL `IPrincipalFacts` (`groups` -> Groups, else a claim).

## Runtime data ops (`TenantPurpose.Runtime`; `src/host/sharing/`, `src/host/apps/`)

- **Applications:** `PragmaticAppsRegistry` (`src/host/apps/`) lists/opens an application (manifest = package set); a connection binds one app (`boundApp`) via `application/open`. Data ops require a bound app, else "no application selected".
- **Per-app `PragmaticServer` methods** (Runtime only): `GraphForPragmaticApp`, `WriteForPragmaticApp` (`data/write`), `ShareForPragmaticApp` / `UnshareForPragmaticApp` / `ListSharesForPragmaticApp` (`data/share`, `data/unshare`, `data/shares/list`; SP-5 record sharing), `AssignForPragmaticApp` (`data/assign`; SP-5b record assign). `AppShareStore(name)` is the per-app share persistence.
- **Services** (`src/host/sharing/`): `ShareService` (grant/revoke/list), `ShareStore` + `ShareGrantIndex` (per-principal grants keyed by concept/record; `AllowsRecord`), `AssignService` (changes owner / owning-BU columns under the **Assign** right via role OR record share, bypassing the Update gate; maps `AssignOutcome` from the identity engine to `AssignStatus`; empty mapped fields -> `Invalid`, adapter fault -> `Denied` "write failed", key conflict -> `Denied` "write conflict"), plus `ShareWidening*` filters/authorizers that widen read/write for shared records.
- **Provider threading:** `ServerConnectionHandler.RuntimeAttachArgs(server)` returns `{ applications, appGraphProvider, appWriteProvider, shareProvider, unshareProvider, listSharesProvider, assignProvider }` (all `undefined` for a Development server); both Attach sites (`PragmaticServerHost` and `WorkerHost`) spread it into `ServerConnectionHandler.Attach`, which stores each provider and forwards the call with the bound app name.
- **Policy:** `PolicyGate` maps `data/write`, `data/share`, `data/unshare`, `data/assign` to `writeTenant` (Write/Tenant); the finer Assign/Share rights are enforced inside the services, not the gate.

## Connectors (`src/host/` + phase-6 wiring)

- `PragmaticServer.Connectors()` (:226) — reaches the first member with `.Storage` (same solution-view seam). In-process `ConnectorRuntime` + `ConnectorsHost`; `ConnectorService` + handlers over `ConnectorProtocol`. Per-tenant `ConnectorsPolicy` (allowlist / catalog-only fail-closed / provider-override) via `PolicyConnectionResolver`. Runtime app graphs prefetch connector rows per request (`ConnectorPrefetch`), with query/policy filters pushed down.

## Identity / RBAC / authorization

- **`PolicyGate`** — deny-by-default `BuildTable` mapping protocol method → required `{ Action, ResourceKind }` (e.g. `CypherProtocol.Query.method → Read/Tenant` from `Tenant.Id`). `src/host/policy-gate.ts`.
- RBAC instance filtering uses `AccessContext` (from todl-identity) per request, applied in the graph cache (deny-wins) — not inside the engine.
- `guarded(...)` pipeline in `ServerConnectionHandler` wraps every method: rate-limit → authorize (PolicyGate) → handler.

## Config / provisioning (`src/config/`)

- `ServerConfigLoader` (env+file, fail-closed), `FileTenantProvisioning`, `tenant-provisioning-factory.ts` (source selection), `CypherLimits` (`cypherRowCap`/`cypherTimeoutMs`/`cypherMaxVarLength`) → `ServerBootstrap.CypherLimitsOf` → `cypherLimits` option → both host variants → `Attach`.

## Package storage layout

- Registered in `PragmaticServer.RegisterInfrastructure` (:333) over `packagesRoot`: `SolutionManagerService.PackageSourceKey → new StoragePackageSource(packagesStorage)` (:339); `PackageStoreKey → new StoragePackageStore(packagesStorage)` (:340); then `NodeProjectSystemComposer.Compose(services)` (:341) + connectors host.
- Blob layout `<model>/<version>/model.json` (see TODL `StoragePackageSource`/`StoragePackageStore`).

## Tests

- `src/host/tests/` — e2e through real `PragmaticClient` → socket pair → server (e.g. `cypher-surface.test.ts`). Node test runner; `npm test`. Suite ~744 (15 pre-existing skips).

## Where does X live?

| Concern | Symbol / file |
| --- | --- |
| Per-tenant server | `PragmaticServer` — `src/pragmatic-server.ts` |
| Tenant → server routing | `TenantRegistry` — `src/tenancy/tenant-registry.ts` |
| Tenant provisioning shape | `TenantProvisioning` — `src/tenancy/tenant-provisioning.ts:6` |
| Dev graph for a request (cypher/query, cypher/models) | `DevCypherQuery` via `PragmaticServer.DevCypher()` — `src/host/engine/dev-cypher-query.ts` |
| Runtime graph for a request | `PragmaticServer.GraphForPragmaticApp` / `EnvironmentGraphQuery` — `src/pragmatic-server.ts` |
| Dev engine snapshot / model workspace | `DevSnapshotSource` / `ServerModelWorkspace` — `src/host/engine/` |
| Dev graph engine (open/upgrade/attach) | `DevGraphEngineHost` via `PragmaticServer.DevEngine()` — `src/host/engine/dev-graph-engine-host.ts` |
| Dev graph access scope (policy + depth + field security) | `DevAccessScopeSource` / `DepthScopeCompiler` — `src/host/engine/` |
| RBAC instance filter (dev) | the engine `AccessScope` from `DevAccessScopeSource` — `src/host/engine/` |
| Method authorization | `PolicyGate` — `src/host/policy-gate.ts` |
| Request pipeline | `ServerConnectionHandler.guarded` — `src/host/server-connection-handler.ts` |
| HTTP/WS host | `PragmaticServerHost` — `src/host/pragmatic-server-host.ts` |
| Auth token issuance | `AuthHttpEndpoint` — `src/host/auth-http-endpoint.ts` |
| Package storage registration | `PragmaticServer.RegisterInfrastructure` — `src/pragmatic-server.ts:333` |
| Process entry / config | `ServerBootstrap` / `ServerConfigLoader` — `src/config/` |
