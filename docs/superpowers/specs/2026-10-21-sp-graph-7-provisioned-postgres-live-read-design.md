# SP-GRAPH-7 (slice 1) — Provisioned Postgres, live read into a runtime environment

**Status:** Design, awaiting approval. Part of the Env/Admin/Plexus program (Milestone-2, Stage 2). Follows Milestone-2 Stage-1 (runtime-publishing live-loop, green + pushed 2026-10-21).

## Intent (the why)

Everything the platform serves today is **in-graph** data: a maker authors a TODL model, its instances compile into packages, the admin promotes them, and the runtime serves that frozen snapshot. A re-promote is the only way data changes. The dual-purpose-server / Power-Platform-analog promise is that an environment's data can be a **real, live external datasource** — the runtime reflects the current rows of an external database, not a baked copy.

This slice makes that real in the smallest way that closes a visible loop: a **runtime environment is backed by a provisioned Postgres**, and the **served app reads live from it** through a connector binding. Change a row in Postgres, reload the served app, see the new value — with no re-promote.

The reason this is a small slice and not a subsystem: the connector stack **already exists and is pushed** (TODL `FederatedModelDataConnector` + `datasource`/`connect`/`populate` syntax + `SqlAdapter`; `todl-connectors-host` `PgSqlSession`/`SqlAdapterFactory`/`ConnectorsHost`; and the server already registers the SQL adapter and already overlays connectors onto the **app-data** read path). This slice is integration: provision the DB, inject the connection, and extend the existing connector overlay to the **environment-graph** read path.

## Decisions already made (settled with the user)

1. **First outcome = live read from a provisioned Postgres** (not write-back, not provisioning-only, not maker-authoring-first).
2. **Read-only** this slice. Write-back (CRUD to Postgres) is a later slice.
3. **"Live" = read-through per request.** Every served read reflects the current Postgres rows; a changed row appears on reload with no re-promote. Caching is a deliberate later optimization.
4. (Inherited, locked by the connectors design that already shipped) **Credentials are always server-side, by name** — never in the authored model, never logged. Connections are named server-catalog refs.

## Goals

- A runtime environment can be provisioned **with a Postgres sidecar** (opt-in), reachable by the server container over a private docker network.
- A promoted, connector-backed model's concept serves its instances **live from Postgres** through the existing connector overlay, resolved **per served request**.
- The connection (host/port/db/user + secret) is injected through the **existing** `tenants.json` / `provisioned-secrets.json` / `ConnectorsPolicy` machinery — no new secret path.
- An operator-gated e2e proves the loop: provision env+DB → seed a Postgres table → author/contribute/promote a connector-backed model → served app shows the Postgres row → **UPDATE the row directly in Postgres → reload → new value, no re-promote**.

## Non-goals / anti-goals (this slice)

- **Write-back** (served-app edits flowing to Postgres). The `ConnectorWorkingCopy`/`Apply` path exists but is out of scope here.
- **Maker authoring a connector in the Plexus UI.** The connector-backed model is authored as `.todl` and contributed through the existing SP-GRAPH-3 path; no new Plexus authoring surface.
- **Non-SQL adapters** (REST / GraphQL / Cypher / Mongo). They exist in `todl-connectors-host` but are not exercised here.
- **Caching, connection pooling tuning, read performance.** Read-through per request is correct-first; a full re-query per request is acceptable for the proof.
- **Multi-tenant adapter isolation / out-of-process adapters** (a v2 security concern already noted in the connectors spec).
- **Owning the external schema.** The connector reads an **existing** external database; this slice does not define migrations or schema ownership. (The e2e seeds a table only to have something to read.)
- **Rewriting the Stage-1 Contoso fixture.** Its re-promote leg asserts *in-graph* data; a separate connector-backed fixture is added instead (see Design call B).

## What already exists — reuse, do not rebuild (seam map, with anchors)

Connector engine & syntax (`@pragmatic-tech-ai/todl`):
- `datasource`/`connect`/`populate` parsing — `TODL/src/compiler-services/parse/parser.ts:866,890,902`.
- `ModelConnectorPlan` emitted into `model.json` — `TODL/src/codegen/connector-plan-emitter.ts`.
- `DataSourceKind.Sql`, `ConnectorSpec`, `ConnectorBinding`, `ModelConnectorPlan` — `TODL/src/model-data/connector-plan.ts:4,14,35,66`.
- `DataSourceAdapterCatalog` (ServiceKey, memoized `Open`) — `TODL/src/model-data/data-source-adapter-catalog.ts:27,51`.
- `ConnectorPrefetch.ForConcepts(concepts, plan, catalog, services, reflector)` → snapshot — `TODL/src/model-data/connector-prefetch.ts:17`.
- `ConnectorRuntimeGraphQuery` (graph-level overlay: connector concepts from snapshot, rest from base) — `TODL/src/graph-api/connector-runtime-graph-query.ts:5`.
- SQL adapter body + session contract — `TODL/src/model-data/sql-adapter.ts:135`, `sql-session.ts:13`.

Host (`@pragmatic-tech-ai/todl-connectors-host`):
- `PgSqlSession` over `pg.Pool` — `todl-connectors-host/src/sql/pg-sql-session.ts:108`.
- `SqlAdapterFactory` (`Kind = Sql`) — `todl-connectors-host/src/sql/sql-adapter-factory.ts:12`.
- `SqlConnectionConfig.From(config, secret)` → pg.Pool opts (host/port/db/user/ssl, secret→password) — `todl-connectors-host/src/sql/sql-connection-config.ts:14,28`.
- `ConnectorsHost` composition root (registers Sql/Rest/Cypher/Document) — `todl-connectors-host/src/connectors-host.ts:40-44`.

Server — connector already live, and the app-path overlay that is the template to copy:
- `ConnectorsHost` constructed and `SqlAdapterFactory` already registered — `pragmatic-server/src/pragmatic-server.ts:204-205`.
- App-data read path overlay (the exact pattern to mirror for env-graph) — `pragmatic-server/src/pragmatic-server.ts:520,526-529` (`GraphForPragmaticApp` → `ConnectorPrefetch.ForConcepts` → `new ConnectorRuntimeGraphQuery(base, snapshot, defaultConcepts)`, then `FilteredGraphQuery` for RBAC at `:538`).
- Reconstruct a `ModelConnectorPlan` from promoted package bytes — `pragmatic-server/src/host/cypher/app-connector-plan.ts:15` (`AppConnectorPlan.For`).
- The env-graph path that is missing the overlay — `pragmatic-server/src/host/graphs/environment-graph.ts:42,49` (`EnvironmentGraph.Build` → `RuntimeAppGraph.BuildQueryFromPackages`, `Query()` returns the bare `GraphQuery`); `pragmatic-server/src/pragmatic-server.ts:451,465` (`LoadEnvironmentGraph`, `EnvironmentGraphQuery()`).

Provisioning / lifecycle:
- `DockerEnv` single-container run args (no network, host-port only) — `pragmatic-server/environments/seed/docker.ts:13,102,189,196,223,248`.
- `EnvironmentService.Create/Start/Stop/Delete` — `pragmatic-server/admin/control-plane/environment-service.ts:133,225,234,241`.
- `TemplateCatalog.Resolve` (`DevBlank`/`DemoContoso` → `EnvDefinition` + seed dir) — `pragmatic-server/admin/control-plane/template-catalog.ts:19,71`.
- Provisioning bundle writer (`tenants.json` / `provisioned-secrets.json`) — `pragmatic-server/environments/seed/bundle.ts` (`BundleBuilder`).
- Loop orchestrator (e2e driver) — `pragmatic-server/admin/control-plane/loop-orchestrator.ts:230,261,288`.

Secrets / connection config (reuse verbatim):
- `FileConnectionResolver` (named connection `Settings` + inline + secret; fail-closed on undeclared) — `pragmatic-server/src/host/file-connection-resolver.ts:7,37,68`.
- `PolicyConnectionResolver` (rejects a `DataSourceKind` not in the tenant `ConnectorsPolicy.AdapterAllowlist`) — `pragmatic-server/src/host/policy-connection-resolver.ts:15,39`, wired at `pragmatic-server.ts:221`.
- `ProvisionedSecretSource` (`/cfg/provisioned-secrets.json`) — `pragmatic-server/src/config/provisioned-secret-source.ts:8,47`.
- Tenant provisioning `connections` → resolver + secret refs — `pragmatic-server/src/config/file-tenant-provisioning.ts:153,154,319`; `TenantRegistry.OptionsFor` threads secret refs — `pragmatic-server/src/tenancy/tenant-registry.ts:228,246,247`.

Closest existing tests (templates):
- Full tenant→policy→resolver→SQL path over pg-mem — `pragmatic-server/src/tenancy/tests/tenant-file-connection-e2e.test.ts`.
- Live-Postgres gated conformance + reusable harness — `todl-connectors-host/src/sql/tests/pg-sql-conformance.test.ts`, `todl-connectors-host/src/testing/pg-mem-adapter.ts:8,69` (`PgMemAdapterHarness`, `PgLiveHarness.Make(connectionString)`).
- Env-graph tests to extend — `pragmatic-server/src/host/graphs/tests/environment-graph.test.ts`, `runtime-environment-graph.test.ts`.
- Container run-args tests to extend for the sidecar/network — `pragmatic-server/environments/seed/tests/docker-run-args.test.ts`, `docker.test.ts`.

## The approach (the how I'm choosing)

Four work areas, smallest-coherent-first:

**A. Env-graph connector overlay (per-request).** Give the environment-graph read path the same connector composition the app path already uses. The base domain + reconstructed `ModelConnectorPlan` (via `AppConnectorPlan.For` over the promoted packages) are built once at promote (in or beside `EnvironmentGraph.Build`). The **connector prefetch + `ConnectorRuntimeGraphQuery` overlay is applied per request**, inside `EnvironmentGraphQuery()` (`pragmatic-server.ts:465`), so each served read re-queries Postgres and reflects current rows (Decision 3). When a model has no connector binding, the path is unchanged (bare `GraphQuery`) — this is purely additive.

**B. Postgres sidecar provisioning (opt-in).** Extend `DockerEnv` from single-container to a small composition: create a per-environment docker network, run a `postgres:<pinned>` container with its own named volume on that network, start it before the server, add `--network` to the server run so the server reaches the DB by container name, and tear both down (plus network + volume) on `Down`/`Delete`. The server reads the DB over the private network (not host-published). Opt-in via a template/flag (Design call A) so environments that don't need a DB don't pay for one.

**C. Connection injection (existing machinery).** The provisioning bundle (`BundleBuilder`) writes a named `connections` entry into the env's `tenants.json` (`host` = the DB container name on the shared network, `port`, `database`, `user`), puts the password under a ref in `provisioned-secrets.json`, and adds `DataSourceKind.Sql` to the tenant's `ConnectorsPolicy` allowlist. `FileConnectionResolver` + `PolicyConnectionResolver` + `SqlConnectionConfig.From` already turn that into a `pg.Pool`. No new secret path.

**D. Connector-backed fixture + gated e2e.** A new fixture model declares `datasource pg { kind = sql; connection = "<named>"; }`, `connect pg;`, and `populate <Concept> from pg.<table> key <id> { <member> = "<column>"; … }`. The e2e: provision a runtime env **with** Postgres (via the opt-in), seed a table+row directly (test setup, mirroring `PgLiveHarness`), author→contribute→promote the connector-backed model, assert the served app renders the Postgres value, then `UPDATE` the row directly in Postgres, reload, and assert the **new** value renders with **no re-promote** (the read-through proof). Operator-gated; windows on the second monitor.

## Design calls I made (builder may rely on these; user may override)

- **A. Provisioning is opt-in via a template/flag**, not automatic for every runtime env (a DB per env is wasteful) and not auto-detected at promote (the env is created before the graph is known). A new template (e.g. `RuntimePostgres`) or a `withDatabase` flag on `EnvironmentService.Create` carries it. *(Flagged to the user — see Open decisions.)*
- **B. A new connector-backed fixture** is added; the Stage-1 Contoso fixture is left intact (rewriting it would break Stage-1's in-graph re-promote assertions). *(Flagged to the user.)*
- **C. Postgres image is version-pinned** (e.g. `postgres:16`), pulled by `DockerEnv.EnsureImage`-style logic; credentials for the sidecar are generated at provision time and written only to the mounted secret file.
- **D. The e2e seeds the Postgres table itself** (the connector reads a pre-existing external DB; owning schema is out of scope). The proof asserts both initial-read and change-visible-on-reload.
- **E. Read-through is implemented by running the prefetch+overlay per `EnvironmentGraphQuery()` call**, not by caching at promote. Correctness over performance this slice.
- **F. Primary repo is `pragmatic-server`** (master); the fixture + e2e-harness extensions live in `Plexus` (main). No TODL change is anticipated (the engine is complete); if the env-graph overlay needs a tiny engine seam, that is called out in the plan.

## Builder-check resolutions (verified in code; my calls, folded in)

A fresh-builder review raised eight buildability questions; all resolved by reading the code — several simplify the plan, none expand its scope:

- **Read path is the env-graph path.** An Environment-bound served app reads via `CypherProtocol.Query → RunCypherQuery → RequireEnvironmentGraph → EnvironmentGraphQuery()` (`server-connection-handler.ts:483,509,736`; `pragmatic-server.ts:465,471`). So the overlay belongs on the env-graph path, as designed.
- **RBAC.** `EnvironmentGraphQuery()` returns the graph **unwrapped** — no `FilteredGraphQuery` (that wrapper is only on the app path `:538` and model path `:834`). The env path does **no per-instance filtering for any node** today; connector-minted instances inherit the same coarse, tenant-level `readTenant` gating as promoted in-graph data — they bypass nothing connector-specific. Per-instance filtering on the env path is a separate cross-cutting concern, out of scope.
- **Read-through holds.** `SqlAdapter` caches no rows (`sql-adapter.ts` Query → session each call); `DataSourceAdapterCatalog.Open` memoizes the pool/adapter, not rows. So running the prefetch **per request** re-queries Postgres each time. The overlay must therefore run inside `EnvironmentGraphQuery()` (per call), not be cached at promote.
- **Prefetch inputs.** The env-graph seam has no query label set (unlike the app path's `ReferencedLabelSet`). Call: **prefetch every connector-backed concept in the plan on each request** — no signature change to `IEnvironmentGraphHost`; per-request-label narrowing is a later perf optimization.
- **Plan reconstruction.** `AppConnectorPlan.For` takes a `PragmaticAppManifest`; the env path has only `PackageRef`s. Call: adapt the reconstruction to work from refs (small refactor or a refs-taking sibling). Connector-declaration conflicts across promoted packages **fail at promote** (build time), not at first request — fail-fast.
- **SSL.** `SqlConnectionConfig.From` sets `ssl` only when config says `ssl="true"`; a plain no-TLS sidecar connects by default. No engine/host change.
- **Policy.** `ConnectorsPolicy.Default()` allows all kinds, but the provisioning bundle writes an **explicit deny-all** policy per tenant (`bundle.ts` `WriteTenants`: `connectorsPolicy: { adapterAllowlist: [], catalogOnly: true, … }`). So the `RuntimePostgres` template's bundle **must** set `adapterAllowlist: ['sql']` (and keep `catalogOnly: true`, which matches the named-connection design). This is a required, template-scoped bundle change — not optional.
- **Connection name.** The `connection = "<named>"` baked into the fixture model must match the key the provisioner writes into `tenants.json`. Call: fixture and provisioner **share one fixed connection-name constant** for this slice.
- **Sidecar lifecycle.** Call: start Postgres and **wait until ready** (healthcheck / `pg_isready`) before the server starts; a user-defined docker network is mandatory (name resolution). Env `Stop`/`Start` **keeps** the DB volume; `Delete` removes the DB container, its volume, and the network. DB credentials are generated **once at provision and persisted with the env** (reused on restart) so they always match the persistent volume.

## Decisions resolved with the user

1. **Provisioning = a dedicated env template** (`RuntimePostgres` in `TemplateCatalog`) that bundles the Postgres sidecar — not a `withDatabase` flag, not always-on. The sidecar + network provisioning attaches when this template is resolved.
2. **A new connector-backed fixture** carries the proof; the Stage-1 Contoso fixture stays intact.
3. **The existing `SP_RUNTIME_LOOP_E2E` spec is extended** with the connector leg (not a separate gated spec). Consequence (accepted): that spec now also requires Docker + a Postgres image, and the live-loop test runs longer; the connector leg provisions the `RuntimePostgres` template, seeds a table, and asserts the live-read + change-on-reload proof as additional steps.

## Constraints (program-wide)

- OOP (methods on classes, no module-level functions/vars); Allman braces; no inline string literals (hoist to `private static readonly`); PascalCase interfaces/public methods; enums over string-literal unions.
- Layering: `todl-runtime → todl → mural/plexus-core → apps`; lower never imports higher. Credentials server-side by name only; never in the model, logs, DTOs, or errors.
- Tests live in `tests/` subfolders. LF-only line endings.
- The live e2e runs the server in the `pragmatic-server:dev` **Docker image** (rebuild it to pick up server changes) and now additionally a **Postgres** container; test windows open on the operator's second monitor (`SP_E2E_WINDOW_ORIGIN`).
- Specs/plans live in-repo under `docs/superpowers/` (not `C:\tmp`); work tracked in GitHub Project #1.
- Nothing is built until this design is approved; the implementation plan (writing-plans) follows approval.

## What's left to the builder

The plan (writing-plans) will decompose: the `DockerEnv` sidecar+network changes and their run-args tests; the `EnvironmentService`/bundle/template wiring for the opt-in and the connection entry; the per-request env-graph overlay in `pragmatic-server.ts`/`environment-graph.ts` and its unit tests (connector-backed vs plain env graph); the connector-backed fixture; and the gated live-Postgres e2e. Exact signatures, file paths, and the pinned Postgres version are the plan's to fix.
