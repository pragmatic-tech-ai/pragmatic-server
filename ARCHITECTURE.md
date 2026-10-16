# pragmatic-server — Architecture Index

> Navigational map for orientation. Read this before re-exploring. **Maintenance rule:** when a change moves or renames a seam below, update this file in the same commit. Line numbers drift — treat them as "near here", trust the symbol name.

**Package:** `@pragmatic-tech-ai/pragmatic-server` — Layer **L4** headless server. Exposes the TODL engine (+ connectors + identity) to remote clients over `pragmatic-protocol` (JSON-RPC 2.0 over WebSocket). Consumes TODL + todl-runtime + pragmatic-protocol + todl-identity + todl-platform-node as built `dist` via `file:` sibling deps.

**Vision context (read these memories):** the server is two **tenant types** — a *development* center (collaborative edit of ONE active solution; the surface SP3/Cypher shipped against) and a *runtime* graph provider (compiled application = package set + connectors). See memory `project_server_dual_purpose` and `project_server_architecture`. The dev-vs-runtime tenant **type** now exists in code as `TenantPurpose` (`src/tenancy/tenant-purpose.ts`: `Development` / `Runtime`; `PragmaticServer.Purpose()`); the runtime data-op surface is described under "Runtime data ops" below.

---

## Layering & composition

- Per-tenant **`PragmaticServer`** builds a `LazyCompositionRoot(HostKinds.Server)` — lazy domain modules (solution-services, language-service: Dormant→Active on first `Resolve`) + eager infra (storage, prompt, package source/store, connectors). `src/pragmatic-server.ts`.
- Engine-never-imports-server holds: the server composes down into TODL; TODL has no server symbol.

## Entry points

- **Programmatic:** `PragmaticServer` (`src/pragmatic-server.ts`) — `Start` / `OpenSolution(dir)` / `Manager()` / `LanguageService()` / `Graph(context)` / `Connectors()` / `Dispose`.
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
- **`Graph(context)`** (:248) — lazily builds `TenantGraphCache(() => this.CollectGraphSources())` (:250), returns `graphCache.GraphFor(context)`.
- **`CollectGraphSources()`** (:254) — reads `(await Manager()).ActiveSolution`; `[]` when none open; else iterates `solution.Members`, skips members without `.Storage`, `languageService.ModelView(member.Storage)` → `{ repo: view.model, model: solution.Name, version: '0.0.0' }` as `TenantRepository`, identity-deduped (:270). ⇐ this is the **dev-tenant composition root**; the runtime tenant needs to compose from an application's *package set* instead.

## Cypher query path (`src/host/cypher/`)

- **`TenantGraphComposition`** (`tenant-graph-source.ts:44`) — `Compose()` emits each member `Repository` via `PackageManifestBridge.toResolvedJsonDocument`, merges seeds (assert-no-conflict dedup); `BuildQuery(artifact)` (:64) loads into `Domain(new MemoryPackageSource(...))` + `FrozenGraph` wrapped as `GraphQuery`. `TenantRepository` type at :7.
- **`TenantGraphCache`** (`tenant-graph-cache.ts:15`) — caches one UNFILTERED artifact, invalidated on `repo.changed`; per request `AllowedIds(entries, context)` strips RBAC-hidden instances, **deny-wins across repos** (:85), keeps seedNodes in allowed + seedEdges both-endpoints allowed; then binds graph.
- **Handler:** `ServerConnectionHandler` registers `CypherProtocol.Query` under `guarded` (rate-limit→authorize→handler); `cypher-param-converter.ts` (wire params→engine, `Object.create(null)` anti-`__proto__`), `cypher-result-mapper.ts` (engine PascalCase→wire camelCase). Error map: syntax/semantic→InvalidParams, `CypherTimeout`→ -32030. Limits from `CypherLimits` config.

## Runtime data ops (`TenantPurpose.Runtime`; `src/host/sharing/`, `src/host/apps/`)

- **Applications:** `PragmaticAppsRegistry` (`src/host/apps/`) lists/opens an application (manifest = package set); a connection binds one app (`boundApp`) via `application/open`. Data ops require a bound app, else "no application selected".
- **Per-app `PragmaticServer` methods** (Runtime only): `GraphForPragmaticApp`, `WriteForPragmaticApp` (`data/write`), `ShareForPragmaticApp` / `UnshareForPragmaticApp` / `ListSharesForPragmaticApp` (`data/share`, `data/unshare`, `data/shares/list`; SP-5 record sharing), `AssignForPragmaticApp` (`data/assign`; SP-5b record assign). `AppShareStore(name)` is the per-app share persistence.
- **Services** (`src/host/sharing/`): `ShareService` (grant/revoke/list), `ShareStore` + `ShareGrantIndex` (per-principal grants keyed by concept/record; `AllowsRecord`), `AssignService` (changes owner / owning-BU columns under the **Assign** right via role OR record share, bypassing the Update gate; maps `AssignOutcome` from the identity engine to `AssignStatus`; empty mapped fields -> `Invalid`, adapter fault -> `Denied` "write failed", key conflict -> `Denied` "write conflict"), plus `ShareWidening*` filters/authorizers that widen read/write for shared records.
- **Provider threading:** `ServerConnectionHandler.RuntimeAttachArgs(server)` returns `{ applications, appGraphProvider, appWriteProvider, shareProvider, unshareProvider, listSharesProvider, assignProvider }` (all `undefined` for a Development server); both Attach sites (`PragmaticServerHost` and `WorkerHost`) spread it into `ServerConnectionHandler.Attach`, which stores each provider and forwards the call with the bound app name.
- **Policy:** `PolicyGate` maps `data/write`, `data/share`, `data/unshare`, `data/assign` to `writeTenant` (Write/Tenant); the finer Assign/Share rights are enforced inside the services, not the gate.

## Connectors (`src/host/` + phase-6 wiring)

- `PragmaticServer.Connectors()` (:226) — reaches the first member with `.Storage` (same solution-view seam). In-process `ConnectorRuntime` + `ConnectorsHost`; `ConnectorService` + handlers over `ConnectorProtocol`. Per-tenant `ConnectorsPolicy` (allowlist / catalog-only fail-closed / provider-override) via `PolicyConnectionResolver`. ⇐ runtime-tenant vision: connectors inject instances INTO Cypher queries — NOT wired into the graph scan path today.

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
| Graph for a request | `PragmaticServer.Graph` → `TenantGraphCache` — `src/host/cypher/` |
| Active-solution → repos | `CollectGraphSources` — `src/pragmatic-server.ts:254` |
| RBAC instance filter | `TenantGraphCache.AllowedIds` — `tenant-graph-cache.ts:85` |
| Method authorization | `PolicyGate` — `src/host/policy-gate.ts` |
| Request pipeline | `ServerConnectionHandler.guarded` — `src/host/server-connection-handler.ts` |
| HTTP/WS host | `PragmaticServerHost` — `src/host/pragmatic-server-host.ts` |
| Auth token issuance | `AuthHttpEndpoint` — `src/host/auth-http-endpoint.ts` |
| Package storage registration | `PragmaticServer.RegisterInfrastructure` — `src/pragmatic-server.ts:333` |
| Process entry / config | `ServerBootstrap` / `ServerConfigLoader` — `src/config/` |
