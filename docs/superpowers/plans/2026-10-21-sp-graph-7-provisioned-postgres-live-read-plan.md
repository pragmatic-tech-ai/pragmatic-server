# SP-GRAPH-7 (slice 1) — Provisioned Postgres, live read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runtime environment provisioned with a Postgres sidecar serves a connector-backed concept live (read-through per request) through the existing connector stack, proven by extending the live-loop e2e.

**Architecture:** Mirror the already-working app-data connector overlay (`GraphForPragmaticApp`) onto the environment-graph read path, applied per request inside `EnvironmentGraphQuery()`. Provision a Postgres container + user-defined docker network via a new `RuntimePostgres` template; inject the connection through the existing `tenants.json`/`provisioned-secrets.json`/`ConnectorsPolicy` machinery. No TODL/engine change — the connector engine, SQL adapter, `PgSqlSession`, and `ConnectorsHost` already exist and are registered in the server.

**Tech Stack:** TypeScript (ESM, strict), pragmatic-server (node:test via `tsx --test`), Plexus (vitest + Playwright), Docker (`postgres:16`), `pg` (already a dep of `todl-connectors-host`).

**Spec:** `pragmatic-server/docs/superpowers/specs/2026-10-21-sp-graph-7-provisioned-postgres-live-read-design.md` — executors read both.

## Global Constraints

- OOP: every function is a class member (static if stateless); no module-level functions/vars. Allman braces. Reused string literals are `private static readonly` PascalCase constants. Enums over string-literal unions. PascalCase interfaces and public methods.
- Layering: `todl-runtime → todl → mural/plexus-core → apps`; lower never imports higher. Credentials server-side by name only — never in a model, log, DTO, or error.
- Tests live in a `tests/` subfolder next to the code. LF-only line endings.
- The live e2e runs the server from the `pragmatic-server:dev` Docker image (rebuild it to pick up server changes) plus, now, a `postgres:16` container; test windows open on the second monitor via `SP_E2E_WINDOW_ORIGIN`.
- Fixed convention constant this slice: the named connection is **`appdb`** (the fixture's authored `connection = "appdb"` must equal the template's connection-name constant).
- Specs/plans in-repo under `docs/superpowers/`; work tracked in GitHub Project #1.

## Review Focus

- **Env graph with no connector binding is unchanged** — the overlay must be a no-op (return the bare base query) when the promoted plan has zero bindings, so Stage-1's in-graph Contoso loop still passes. *(Task 2 test.)*
- **Read-through reflects a changed row without re-promote** — a second `EnvironmentGraphQuery()` after the source rows change must return the new rows (no caching at promote). *(Task 2 test with a mutable fake adapter; Task 6 proves it against real Postgres.)*
- **Empty source table** — a connector-backed concept whose table has no rows renders as an empty collection, not an error. *(Task 2 test.)*
- **Undeclared/mismatched connection name** — a model referencing a connection the tenant did not declare fails closed (`ConnectionNotDeclaredError`), not a silent empty read; the fixture and template therefore share the `appdb` constant. *(Covered by Task 5 compile + Task 6 wiring; the fail-closed path already has unit coverage in `file-connection-resolver`.)*
- **DB unreachable at read** — if the adapter opens but the query fails, the error propagates (loud), not a silent-empty read; the served request surfaces an error rather than pretending the table is empty. *(Task 2 test asserts a throwing adapter propagates.)*

---

### Task 1: `AppConnectorPlan.ForPackages` — reconstruct a plan from refs

**Files:**
- Modify: `pragmatic-server/src/host/cypher/app-connector-plan.ts`
- Test: `pragmatic-server/src/host/cypher/tests/app-connector-plan.test.ts` (extend; create if absent)

**Interfaces:**
- Consumes: `PragmaticAppPackageRef { id: string; version: string }` (from `../apps/pragmatic-app-manifest.js`), `IStorage`.
- Produces: `static ForPackages(storage: IStorage, packages: readonly PragmaticAppPackageRef[], model: string, version: string): Promise<ModelConnectorPlan>`. The existing `For(storage, manifest)` is refactored to delegate: `return AppConnectorPlan.ForPackages(storage, manifest.packages, manifest.name, manifest.version)`.

- [ ] **Step 1: Write the failing test** — `ForPackages reconstructs the merged plan from refs without a manifest`: given a storage with one package `model.json` that declares a `sql` connector + one binding, `ForPackages(storage, [{id,version}], 'g', '0')` returns a `ModelConnectorPlan` whose `Model === 'g'`, `Version === '0'`, `Connectors.length === 1`, `Bindings.length === 1`. And `For(storage, {name:'g',version:'0',packages:[...]})` returns an equal plan.
- [ ] **Step 2: Run to verify it fails** — `cd pragmatic-server && npx tsx --test "src/host/cypher/tests/app-connector-plan.test.ts"`; expect FAIL (`ForPackages` not a function).
- [ ] **Step 3: Implement** — extract the loop body of `For` into `ForPackages(storage, packages, model, version)`; it returns `{ Model: model, Version: version, Connectors, Bindings }`. `For` becomes a one-line delegate. No behavior change to the dedup/conflict logic.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `fix(server): AppConnectorPlan.ForPackages reconstructs a plan from refs`.

---

### Task 2: Per-request connector overlay on the environment-graph read path

**Files:**
- Modify: `pragmatic-server/src/host/graphs/environment-graph.ts` (`EnvironmentGraph`)
- Modify: `pragmatic-server/src/pragmatic-server.ts` (`LoadEnvironmentGraph`, `EnvironmentGraphQuery`)
- Test: `pragmatic-server/src/host/graphs/tests/environment-graph.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 `AppConnectorPlan.ForPackages`; `RuntimeAppGraph.BuildDomainFromPackages(source, refs): Promise<Domain>`; `ConnectorPrefetch.ForConcepts(concepts, plan, catalog, services, reflector): Promise<Map<string, InstanceMirror[]>>`; `ConnectorRuntimeGraphQuery(base, snapshot, defaultConcepts?)`; `DataSourceAdapterCatalog.ServiceKey`.
- Produces: `EnvironmentGraph.Build` signature changes to `Build(storage: IStorage, graphName: string, refs: readonly PackageRef[]): Promise<EnvironmentGraph>` (it constructs its own `StoragePackageSource(storage)` internally and keeps `storage` for `ForPackages`). `EnvironmentGraph` gains `Base(): IGraphQuery`, `Plan(): ModelConnectorPlan`, `Domain(): Domain`. `EnvironmentGraphQuery()` resolves the live, connector-overlaid query per call. The sole `Build` caller (`LoadEnvironmentGraph`) changes to `EnvironmentGraph.Build(this.PackagesStorage(), params.graphName, refs)`.

- [ ] **Step 1: Write the failing tests** in `environment-graph.test.ts`:
  - `a plain env graph (no connector bindings) returns the base query unchanged` — build from a package with no connectors; assert `AllInstances()` equals the base domain's instances.
  - `a connector-backed concept is served from the adapter snapshot` — build from a package declaring a `sql` binding for concept `C`; with a fake catalog whose adapter returns two rows, the overlaid query's `InstancesOf('C')` returns those two mirrors (not base rows).
  - `read-through: a second query reflects changed adapter rows` — mutate the fake adapter's rows between two overlay builds; the second result reflects the new rows (proves no promote-time caching).
  - `empty source yields an empty concept, not an error` — adapter returns `[]`; `InstancesOf('C')` is `[]`.
  - `a throwing adapter propagates` — adapter `Query` throws; the overlay build rejects (loud), not silent-empty.
  Use the existing fake-adapter/catalog pattern from `src/host/cypher/tests` / the connectors tests (register a fake `IDataSourceAdapterFactory` into a `DataSourceAdapterCatalog`).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
  - `EnvironmentGraph.Build`: in addition to the base `GraphQuery`, build `domain = await RuntimeAppGraph.BuildDomainFromPackages(source, refs)`, `base = new GraphQuery(domain.graph)`, and `plan = await AppConnectorPlan.ForPackages(storage, refs, graphName, EnvironmentGraph.PlanVersion)` (`PlanVersion = '0'`). Store `base`, `plan`, `domain`; keep the `GraphLoadedDto` record as today. (`Build` needs the packages `IStorage` for `ForPackages`; thread it from `LoadEnvironmentGraph`, which has `this.PackagesStorage()`.) Expose `Base()/Plan()/Domain()`.
  - `pragmatic-server.ts EnvironmentGraphQuery()`: if `graph.Plan().Bindings.length === 0`, return `graph.Base()`. Else `const services = this.root.Services(); const concepts = graph.Plan().Bindings.map(b => b.Concept); const snapshot = await ConnectorPrefetch.ForConcepts(concepts, graph.Plan(), services.getRequired(DataSourceAdapterCatalog.ServiceKey), services, graph.Domain()); return new ConnectorRuntimeGraphQuery(graph.Base(), snapshot)` (empty `defaultConcepts` — no builtin store on the env graph this slice). This runs per request (read-through).
  - `LoadEnvironmentGraph`: pass the packages storage into `EnvironmentGraph.Build`.
- [ ] **Step 4: Run to verify they pass**, plus the existing `environment-graph.test.ts` / `runtime-environment-graph.test.ts` still green.
- [ ] **Step 5: Commit** — `feat(server): per-request connector overlay on the environment-graph read path`.

---

### Task 3: Postgres sidecar + user-defined network in `DockerEnv`

**Files:**
- Modify: `pragmatic-server/environments/seed/docker.ts` (`DockerEnv`)
- Modify: `pragmatic-server/environments/seed/bundle.ts` (`EnvDefinition` gains an optional database descriptor)
- Test: `pragmatic-server/environments/seed/tests/docker-run-args.test.ts` (extend)

**Interfaces:**
- Consumes: `EnvDefinition` (`{ name, kind, tenantId, purpose, hostPort }`).
- Produces: `EnvDefinition` gains `database?: { connectionName: string; host: string; port: number; database: string; user: string; password: string; hostPort: number }` (host = the sidecar container name). `DockerEnv` gains `static NetworkName(def)`, `static DbContainerName(def)`, `static DbVolumeName(def)`, `static PostgresRunArgs(def): string[]`, and network create/remove in `Up`/`Down`. `RunArgs` adds `--network <NetworkName>` to the server container iff `def.database !== undefined`.

- [ ] **Step 1: Write the failing tests** in `docker-run-args.test.ts`:
  - `a database env adds --network to the server run args` — a `def` with `database` present → `RunArgs(def, dir)` contains `['--network', DockerEnv.NetworkName(def)]`; a `def` without → it does not.
  - `PostgresRunArgs builds a pinned postgres container on the network` — asserts image `postgres:16`, `--name DbContainerName`, `--network NetworkName`, `-v DbVolumeName:/var/lib/postgresql/data`, `-e POSTGRES_PASSWORD=`/`POSTGRES_USER=`/`POSTGRES_DB=` from `def.database`, and `-p <database.hostPort>:5432` (host-published so the e2e can seed/mutate).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** the statics + `PostgresRunArgs` (mirroring the existing constant-per-flag style), add `--network` to `RunArgs` when `def.database` is set, and in `Up`: create the network, `docker run` the Postgres container, **wait until ready** (poll `docker exec <db> pg_isready` or a TCP probe, bounded like `WaitHealthy`), then the server; in `Down`: remove the server, the DB container, the DB volume, and the network (each `-f`/absence-tolerant like the existing `rm -f`). Docker-touching methods stay exercised by the smoke run, not unit tests (only the pure arg builders are unit-tested) — matching the file's convention.
- [ ] **Step 4: Run to verify the arg tests pass** and the existing `docker-run-args.test.ts` cases are unchanged.
- [ ] **Step 5: Commit** — `feat(server): DockerEnv provisions a postgres sidecar on a per-env network`.

---

### Task 4: `RuntimePostgres` template + bundle connection wiring

**Files:**
- Modify: `pragmatic-server/admin/control-plane/environment-record.ts` (`Template` enum)
- Modify: `pragmatic-server/admin/control-plane/template-catalog.ts` (`All`, `Resolve`, `DefaultTypeFor`)
- Modify: `pragmatic-server/environments/seed/bundle.ts` (`WriteTenants`, `WriteSecrets`)
- Modify: `pragmatic-server/admin/control-plane/environment-service.ts` (`Create`: run the sidecar before the server when `def.database` is set)
- Test: `pragmatic-server/environments/seed/tests/bundle.test.ts` (extend) + `pragmatic-server/admin/control-plane/tests/template-catalog.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3 `EnvDefinition.database`, `DockerEnv.DbContainerName`.
- Produces: `Template.RuntimePostgres`; `TemplateCatalog.Resolve(Template.RuntimePostgres, name, hostPort, type)` returns a `def` with `purpose = Runtime` and `database` populated (`connectionName = 'appdb'`, `host = DockerEnv.DbContainerName(def)`, `port = 5432`, `database = 'appdb'`, `user = 'appuser'`, a generated `password`, and a `hostPort` allocated for the DB), and a seed dir (reuse the dev-blank seed). `BundleBuilder.WriteTenants` emits, when `def.database` is set, `connections: { [connectionName]: { settings: { host, port, database, user }, secretRef: '<tenantId>/appdb/password' } }` and `connectorsPolicy.adapterAllowlist: ['sql']` (keep `catalogOnly: true`). `WriteSecrets` writes the password value under that `secretRef`.

- [ ] **Step 1: Write the failing tests:**
  - (bundle) `a RuntimePostgres tenant bundle declares the sql connection and allows sql` — generate a bundle for a `def` with `database`; `tenants.json` for the tenant has `connections.appdb.settings` with the host/port/db/user, a `secretRef`, and `connectorsPolicy.adapterAllowlist` containing `'sql'` with `catalogOnly: true`; `provisioned-secrets.json` has the password under that ref.
  - (bundle) `a tenant without a database keeps deny-all and no connections` — DevBlank/DemoContoso bundle unchanged (`adapterAllowlist: []`, no `connections`).
  - (template) `RuntimePostgres resolves to a runtime def with an appdb database` — `Resolve(Template.RuntimePostgres, 'e', 8080, Runtime).def.purpose === Runtime` and `.database.connectionName === 'appdb'`, `.database.host === DockerEnv.DbContainerName(def)`; `All()` lists it; `DefaultTypeFor(RuntimePostgres) === Runtime`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** the enum member, the catalog branch (generate the password with the existing crypto helper used for master-key/secret generation; allocate the DB `hostPort` the same way env host ports are allocated), the two bundle writers (guarded on `def.database`), and the `EnvironmentService.Create` ordering (sidecar up before server when `def.database` set — delegating to the Task 3 `DockerEnv` methods via the `IDockerEnv` port).
- [ ] **Step 4: Run to verify they pass**, existing bundle/template tests green.
- [ ] **Step 5: Commit** — `feat(server): RuntimePostgres template provisions + declares the appdb sql connection`.

---

### Task 5: Connector-backed fixture (Plexus)

**Files:**
- Create: `Plexus/apps/plexus/e2e/fixtures/catalog/catalog.todl`
- Create: `Plexus/apps/plexus/e2e/fixtures/catalog/project.plexus`
- Modify: `Plexus/apps/plexus/e2e/fixtures/fixture-manifest.ts` (add a `CatalogFixture` descriptor)
- Test: `Plexus/apps/plexus/e2e/fixtures/tests/fixtures-compile.test.ts` (extend)

**Interfaces:**
- Consumes: the existing `IFixtureDescriptor` shape (`folder, appId, entrypointConcept, assertField, assertValue`).
- Produces: `CatalogFixture` with `entrypointConcept = 'catalog.Product'`, `assertField = 'name'`, `assertValue = 'Live Postgres Widget'` (the row the e2e seeds).

- [ ] **Step 1: Write the failing test** in `fixtures-compile.test.ts`: register `CatalogFixture` in the suite; assert it `compiles with zero errors`, the entrypoint concept node exists, and the compiled package contains a connector plan (one `sql` connector named `appdb` + one binding for `catalog.Product`). Reuse the existing `FixtureCase` machinery.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Author the fixture.** `catalog.todl`:
  ```
  namespace catalog
  {
      datasource appdb { kind = sql; connection = "appdb"; }
      concept Product { name : string; unitPrice : number; }
      model Catalog : catalog
      {
          annotate entrypoint { }
          connect appdb;
          populate Product from appdb.products key id { name = "name"; unitPrice = "unit_price"; }
      }
  }
  ```
  `project.plexus`: `{ "type": "architecture", "name": "Catalog", "version": 1, "id": "catalog", "packageVersion": "0.1.0" }`. Add the descriptor.
- [ ] **Step 4: Run to verify it passes** (`npx vitest run e2e/fixtures/tests/fixtures-compile.test.ts`).
- [ ] **Step 5: Commit** — `test(plexus): connector-backed catalog fixture (Product populated from appdb.products)`.

---

### Task 6: Extend the SP_RUNTIME_LOOP_E2E with the live-Postgres leg

**Files:**
- Modify: `pragmatic-server/admin/control-plane/loop-orchestrator.ts` (`CreateRuntime` uses `Template.RuntimePostgres`; new `db-exec` subcommand runs SQL against the env's provisioned Postgres via a `pg.Pool` built from the env's `database` coordinates)
- Modify: `Plexus/apps/plexus/e2e/support/orchestrator-client.ts` (add `DbExec(sql: string): Promise<void>`)
- Modify: `Plexus/apps/plexus/e2e/runtime-live-loop.spec.ts` (add the connector leg)
- Test: the gated e2e itself is the test.

**Interfaces:**
- Consumes: Task 4 `RuntimePostgres`; Task 5 `CatalogFixture`; existing `RendererOps.GenerateUi/Contribute`, `OrchestratorClient.Promote`, `BrowserReader`.
- Produces: `OrchestratorClient.DbExec(sql)`; a `db-exec` orchestrator subcommand.

- [ ] **Step 1: Switch `CreateRuntime` to provision `Template.RuntimePostgres`** so the runtime env has a Postgres sidecar. Add the `db-exec --sql <sql>` subcommand: resolve the env's `database` coordinates and run the SQL via `pg` (reuse `PgSqlSession`/`pg.Pool`; connect over the host-published DB port). Verify the existing in-graph Contoso legs of the loop still pass (the overlay no-ops without bindings) by running the gated e2e once.
- [ ] **Step 2: Add `OrchestratorClient.DbExec`** mirroring the existing subcommand-spawn plumbing.
- [ ] **Step 3: Add the connector leg** as new `test.step('live Postgres read, no re-promote', …)` after the existing steps:
  - `DbExec('CREATE TABLE products (id text primary key, name text, unit_price numeric); INSERT INTO products VALUES (\'p1\', \'Live Postgres Widget\', 249);')`.
  - Open the `CatalogFixture` project, Generate UI for `catalog.Product`, Contribute to the dev graph, `Promote`.
  - A signed-in reader's browser reads the served Catalog app; assert `getByText('Live Postgres Widget')` is visible.
  - `DbExec("UPDATE products SET name = 'Updated Postgres Widget' WHERE id = 'p1';")`; reload the page (NO re-promote); assert `getByText('Updated Postgres Widget')` visible and `getByText('Live Postgres Widget')` has count 0 — the read-through proof.
  - All windows on the second monitor (reuse the existing placement).
- [ ] **Step 4: Run the gated e2e** — rebuild the `pragmatic-server:dev` image (the orchestrator + Postgres provisioning are server-side) and the Plexus app, then from `apps/plexus`: `SP_RUNTIME_LOOP_E2E=1 SP_E2E_WINDOW_ORIGIN=-2560,0 SP_SERVER_REPO=<server> npx playwright test runtime-live-loop.spec.ts`. Expect `1 passed`.
- [ ] **Step 5: Commit** — `test: live-Postgres read-through leg in the runtime live-loop e2e`.

---

## Notes for the executor

- **Deferred (out of this slice, do not build):** write-back to Postgres; maker-authoring a connector in the Plexus UI; non-SQL adapters; caching / per-request label narrowing of the prefetch; DB-credential persistence across env restarts (the e2e tears the env down each run, so a per-provision credential is consistent within one run); per-instance RBAC on the env-graph path.
- **Rebuild discipline:** a pragmatic-server source change requires rebuilding the `pragmatic-server:dev` image before the e2e sees it (`DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=/c/tmp/sp-e2e-npmrc/.npmrc -t pragmatic-server:dev .` from the workspace root; refresh the npmrc token with `gh auth token`). TODL/Plexus changes reach the e2e via TODL `dist` + the Plexus app build (`out/`).
