# Dev tenants on the graph engine (milestone 1, plan 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every dev-tenant graph read and write in pragmatic-server (`cypher/query` with and without `modelId`, `cypher/execute`, `model/view`, `model/resources`) runs on one embedded pragmatic-graph engine per dev tenant, under an `AccessScope` built from the caller's principal. Wire shapes stay the same, and the dev-only legacy graph paths are retired.

**Architecture:**
- **Host:** a lazy per-tenant `DevGraphEngineHost` owns a memory `GraphEngine`, opened from a snapshot compiled from the solution's *saved* `.todl` files. One package per model id, so engine `Owner` = model id. `TodlFileConnector` is the default connector, over a server `ITodlModelWorkspace`. Every language-service graph change recompiles and runs `engine.Upgrade`, serialized.
- **Endpoints:** they stop building graphs, filters or masks. They ask the host for the engine and a principal's scope (`DevAccessScopeSource`: TODL policies via `PolicyScopeCompiler`, access-depth roles, field security and create defaults compiled to engine predicates), then call `Cypher.CypherEngine` and map cells with `EngineCellMapper` into today's DTOs.
- **Engine extension:** a small pragmatic-graph change adds write-only field rules and create defaults to the engine contracts.

**Tech Stack:** TypeScript (ESM, NodeNext), `tsx --test`, pragmatic-server; TODL `@pragmatic-tech-ai/todl` (+ `/engine` subpath); `@pragmatic-tech-ai/graph` ≥ 0.1.2; todl-identity / todl-identity-engine.

**Spec:** `D:/architecture-agent/pragmatic-graph/docs/superpowers/specs/2026-11-06-graph-consolidation-design.md` — §6, §7, §8, §9 (dev), §10, §11 milestone 1, §12. Audit: `pragmatic-graph/docs/integration/query-surfaces-audit.md`. Builds on M1.1–M1.3 (engine core, Cypher on engine, TODL engine bridge: `SnapshotDescriber`, `PolicyScopeCompiler`, `TodlFileConnector`, `TodlNodePlacement`, `EngineCellMapper`, `IPrincipalFacts`, `ITodlModelWorkspace`; their rulings R80–R90, P3-a…PF-f).

**Out of scope (milestone 2, runtime):**
- the runtime `cypher/query` branches A3 (app graph + `ConnectorPrefetch` + `CypherPushDown`) and A4 (environment graph);
- `data/write`, `connector/*`;
- `GraphDataDigest`;
- keyset cursors;
- runtime change push;
- deleting TODL's `src/cypher` (the runtime branches still call `Cypher.CypherEngine.OverQuery` and `GraphQueryAdapter`);
- `FilteredGraphQuery` / `FieldMaskedGraphQuery` / `ModelReadFilter` where runtime still uses them;
- `EngineStorageConnector`.

The plan states which retirements are dev-only.

Carry-ins resolved here: Domain evict of a dependent (Task 2). The engine change feed's `SetOwner` op (kind 7, R90) has no consumer in this plan: dev clients keep `solution/graphChanged`, and the milestone-2 runtime change push must handle it. For milestone 2: `EngineCellMapper` type-imports TODL's `src/cypher` DTOs, which must move when `src/cypher` is deleted.

## Global Constraints

- Layering: the engine never imports TODL, the server or identity; TODL imports the engine only under `src/engine-bridge/`; the server may import both.
- Anti-goals (spec §2): no endpoint filters or masks data itself or bypasses the engine scope; no second dev code path; no stale external data.
- Snapshot from **saved** `.todl` files only, never unsaved editor buffers (spec §9 dev).
- Dev and runtime share mechanism; dev policies may be lenient but identity-backed dev tenants stay fail-closed exactly as today (no security model → deny all; `graph-scope-unchanged.test.ts`).
- Wire shapes of `cypher/query`, `cypher/execute`, `cypher/models`, `model/view`, `model/resources` are unchanged (pragmatic-protocol DTOs untouched).
- Code style (global CLAUDE.md): OOP, no module-level functions or mutable state, Allman braces, PascalCase interfaces/public methods, `private static readonly` constants for reused literals, enums, `dispose()`; tests in `tests/` subfolders; LF.
- Server: `npm test`, `npm run build`, `npx tsc -p tsconfig.json --noEmit` green after each task; update `ARCHITECTURE.md` in the commit that moves a seam. TODL consumed via `file:../TODL` (rebuild TODL `dist` before server sees TODL changes); the engine via npm/link at ≥ 0.1.2.
- Fix every review finding, including minors.

## Review Focus

1. A developer types in the editor without saving: the engine (cypher/query results) must not change; saving changes it. → Task 3 test `unsaved buffer does not reach the snapshot`.
2. A save (upgrade) lands while a long cypher/query is paging: each page reads one consistent engine snapshot, and the next page's cursor is stale rather than mixing versions. → Task 6 test `upgrade between pages stales the cursor`.
3. An identity-backed dev tenant with no security model: every endpoint returns nothing and every write is Denied, as today. → Task 5 test `no security model is deny all`.
4. A dev tenant served by a cluster `WorkerHost` (not the single-process host): `cypher/query`, `cypher/execute` and `model/view` work there too (audit defect 4). → Task 4 test `worker host serves dev graph endpoints`.
5. A Cypher `CREATE` by a principal whose depth role is User level: the created node is stamped with the principal as owner (today's `CreateDefaults`) and is visible to them afterwards. → Task 7 test `create stamps owner defaults`.

---

### Task 1: Engine — create defaults and read-only write members

**Repo:** `D:/architecture-agent/pragmatic-graph` (branch `feat/write-defaults`; version → 0.1.2; rulings R91+ in `docs/decisions.md`).

**Files:**
- Modify: `src/cypher/write/NodePlacement.ts` (`INodePlace`), the Cypher create path that consumes it (`src/cypher/write/*`), `src/access/AccessScope.ts` (`IWriteRules`), `src/access/WriteGate.ts` (enforcement), `src/access/ScopeValidator.ts` (names known), `README.md`, `docs/decisions.md`, `package.json`.
- Test: `src/cypher/tests/PlacementDefaults.test.ts`, `src/access/tests/ReadOnlyMembers.test.ts`.

**Interfaces:**
- Produces:
  - `INodePlace { PublicId; Owner; Defaults?: ReadonlyMap<string, CellValue> }`: properties a Cypher CREATE sets when the query did not set them. They are applied before the create predicate is checked.
  - `IWriteRules { Create?; Update?; Delete?; ReadOnly?: ReadonlySet<string> }`: members the writer may not set, link or unlink on that concept's nodes, for create and update alike. A violation is `AccessError` with a new appended code `MemberReadOnly`. Defaults coming from placement are exempt.

- [ ] **Step 1: Failing tests.**
  - `defaults fill unset properties` (CREATE without `owner` → stored owner = default).
  - `query value wins over default`.
  - `defaults count for the create predicate` (create predicate `owner = 'u1'` passes with default u1).
  - `read-only member set is denied` (SET and CREATE with that property → MemberReadOnly, nothing committed).
  - `read-only relationship link denied`.
  - `read-only member still readable`.
  - `default on a read-only member is allowed`.
- [ ] **Step 2: Run** `npx tsx --test src/cypher/tests/PlacementDefaults.test.ts src/access/tests/ReadOnlyMembers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Bump the version to 0.1.2 and add rulings R91 (defaults) and R92 (read-only members).
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(access): placement defaults and read-only write members`.

---

### Task 2: TODL — `Domain.Snapshot`, evict fix, saved-sources compile helper

**Repo:** `D:/architecture-agent/TODL` (branch `feat/dev-engine-host`).

**Files:**
- Modify:
  - `src/domain/domain.ts`: `graph` → `Snapshot`, the same `MetadataSnapshot` instance.
  - Every TODL use listed by `grep -rn "\.graph\b"` on Domain instances: `domain-host.ts`, the domain tests, the engine-bridge tests, the package-manager tests.
  - `src/domain/metadata-snapshot.ts`: the evict path.
- Create: `src/engine-bridge/SavedModelCompiler.ts`.
- Test: `src/domain/tests/domain-evict-rebound.test.ts`, `src/engine-bridge/tests/SavedModelCompiler.test.ts`.

**Interfaces:**
- Produces:
  - `Domain.Snapshot: MetadataSnapshot`. `graph` is removed, with no alias.
  - **Evict rule:** evicting a dependent package no longer removes nodes whose home package (`HomeModelOf`) is still loaded. Such a node is re-bound to its home package's own seed values.
  - **`SavedModelCompiler`:**
    - `static Compile(models: readonly ISavedModel[], bases: Repository): ISavedSnapshot`;
    - `ISavedModel { ModelId: string; Namespace: string; Sources: readonly SourceFile[] }`;
    - `ISavedSnapshot { Snapshot: MetadataSnapshot; Repository: Repository; Diagnostics: readonly Diagnostic[] }`.
    - It compiles the given saved sources (`checkAgainst(bases, sources)`). It emits one package per model id with `ModelShardExtractor`, deps-ordered, and binds a fresh `Domain`, so `HomeModelOf(node)` is the model id that declares the node.
    - Instances outside every model go to a package named by the solution, owner = that name; they are read-only in Task 4.
- [ ] **Step 1: Failing tests.**
  - `evicting a dependent keeps the dependency's re-bound instances` (pkg.b re-binds a.a1; unload pkg.b → a.a1 present with pkg.a values).
  - `each instance's home is its model id`.
  - `compile uses only the sources given` (a stale buffer elsewhere has no effect).
  - `two models of one member are two packages`.
  - `instance outside any model gets the solution owner`.
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/domain/tests/domain-evict-rebound.test.ts src/engine-bridge/tests/SavedModelCompiler.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Do the rename across TODL and update the pragmatic-server uses (`pragmatic-server.ts:780`, `host/cypher/runtime-app-graph.ts`, `host/cypher/tenant-graph-source.ts`, `host/graphs/environment-graph.ts`, `environments/seed/compile.ts`) in a server commit on branch `feat/dev-graph-on-engine`.
- [ ] **Step 4: Run** TODL `npm test`, `npm run typecheck`, `npm run build`; then server `npm test`, `npx tsc -p tsconfig.json --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** TODL `feat(domain): Snapshot, evict keeps re-bound home instances, saved-model compiler`; server `refactor: Domain.Snapshot`.

---

### Task 3: Server — dev model workspace and saved snapshot source

**Files:**
- Create:
  - `src/host/engine/server-model-workspace.ts`: `ServerModelWorkspace implements ITodlModelWorkspace`.
  - `src/host/engine/dev-snapshot-source.ts`: `DevSnapshotSource`.
- Test: `src/host/engine/tests/server-model-workspace.test.ts`, `src/host/engine/tests/dev-snapshot-source.test.ts`.

**Interfaces:**
- Consumes:
  - TODL `ITodlModelWorkspace` / `ITodlDraftSession`, `SavedModelCompiler` (Task 2), `SnapshotDescriber`, `TodlNames.FileConnector`.
  - Server `TodlSourceCollector` (`host/model/todl-source-collector.ts`), `IDevLanguageService` (`ResolveBasesFor`, `DidChange`, `WhenIdle`, `GraphRevision`), `IStorage`.
  - Solution members, and `OwningMember` logic (`pragmatic-server.ts:979`), moved here.
- Produces:
  - `ServerModelWorkspace(solution: () => Promise<ISolution | undefined>, languageService: IDevLanguageService)`.
    - `OpenDraft(modelId)` resolves the owning member and the namespace (the `modelId` prefix, else the solution name). It returns undefined for a non-member or solution-owned id.
    - The session's `WriteFile` / `DeleteFile` write member storage. After the commit the session calls `languageService.DidChange(absoluteUri, text)` for every file, then `WhenIdle()`.
    - `SourceHash` = `TodlSourceCollector.SourceHash`.
  - `DevSnapshotSource(solution, languageService)`, method `Current(): Promise<ISnapshotDescription & { Repository: Repository }>`.
    - It collects every member's **saved** sources via `TodlSourceCollector.Collect(storage)`, and the bases via `ResolveBasesFor`.
    - It compiles with `SavedModelCompiler`, then describes with `{ DefaultConnector: TodlNames.FileConnector }`.
- [ ] **Step 1: Failing tests.**
  - `unsaved buffer does not reach the snapshot` (`DidChange` with unsaved text → `Current()` equals the version before; write the file → a different version).
  - `owner of every seed node is its model id`.
  - `open draft for a member model edits that member's file`.
  - `non-member model is not editable`.
  - `commit notifies the language service once per written file`.
  - `source hash changes when a file changes on disk`.
- [ ] **Step 2: Run** `npx tsx --test src/host/engine/tests/*.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): server model workspace and saved snapshot source`.

---

### Task 4: Server — `DevGraphEngineHost` and attach in both hosts

**Files:**
- Create: `src/host/engine/dev-graph-engine-host.ts`.
- Modify:
  - `src/pragmatic-server.ts`: a lazy `devEngine ??=` field and `DevEngine()`, and `DoDispose` disposing it.
  - `src/host/server-connection-handler.ts`: Attach / constructor take an `IDevGraphEngine` provider.
  - `src/host/pragmatic-server-host.ts` and `src/cluster/worker-host.ts`: both Attach sites pass the dev providers. This also fixes the missing `devGraphService` / `environmentGraphHost` in WorkerHost.
  - `ARCHITECTURE.md`.
- Test: `src/host/engine/tests/dev-graph-engine-host.test.ts`, `src/cluster/tests/worker-host-dev-graph.test.ts`.

**Interfaces:**
- Consumes: Task 3. `GraphEngine.Open({ Description, Storage: memory, Connectors: [new TodlFileConnector(workspace)] })` and `GraphEngine.Upgrade`, `SchemaVersion`, `CommitApplied` (check the exact option names in pragmatic-graph `GraphEngine.ts`).
- Produces: `interface IDevGraphEngine { Engine(): Promise<GraphEngine>; Repository(): Promise<Repository>; Description(): Promise<ISchemaDescription>; readonly Changed: ISignal<void> }`. Backed by `DevGraphEngineHost implements IDevGraphEngine, IDisposable`:
  - **Open:** opens on first use.
  - **Upgrade:** subscribes to `languageService.GraphChanged`, debounced by `DevGraphEngineHost.UpgradeDebounceMs = 150`. It calls `DevSnapshotSource.Current()`, then `engine.Upgrade` if the version differs. Upgrades are serialized; readers already open keep their snapshot.
  - **No solution open:** an empty description.
  - **Failure:** an upgrade failure is logged and the engine keeps the previous version.
  - **`Changed`:** raised after each applied upgrade.
- [ ] **Step 1: Failing tests.**
  - `opens once and reuses`.
  - `saved edit upgrades the engine`.
  - `unchanged recompile does not upgrade`.
  - `two rapid saves upgrade once to the latest`.
  - `dispose disposes the engine`.
  - `upgrade failure keeps the previous engine data`.
  - `worker host serves dev graph endpoints` (a WorkerHost-attached connection runs `cypher/query` on a dev tenant).
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): dev graph engine host, attached in both hosts`.

---

### Task 5: Server — `DevAccessScopeSource`

**Files:**
- Create:
  - `src/host/engine/dev-access-scope-source.ts`;
  - `src/host/engine/principal-facts.ts`: `PrincipalFacts implements IPrincipalFacts`;
  - `src/host/engine/depth-scope-compiler.ts`.
- Test: `src/host/engine/tests/dev-access-scope-source.test.ts`, `src/host/engine/tests/depth-scope-compiler.test.ts`.

**Interfaces:**
- Consumes:
  - TODL `PolicyScopeCompiler.FromRepository(repo, description)` and `Compile(facts, default)`.
  - todl-identity `Principal` (`Id`, `Claims`, `Groups`).
  - todl-identity-engine `AccessDepthEvaluator` (`EffectiveLevel`, `MembershipOf`, `GovernedConcepts`, `CreateDefaults`, `FieldSecurity()` with `IsSecured` / `CanReadField` / `CanWriteField`), the ownership rules (owner field, business-unit field, via `OwnershipResolver.OwnerField` / `BusinessUnitField`), and the hierarchy.
  - Server `TenantReadAuthorization` (the per-tenant evaluator cache and `Invalidate`).
  - Task 1 `ReadOnly` and `Defaults`.
- Produces:
  - `PrincipalFacts(principal)`: `Get(name)` = `name === 'groups' ? Groups : Claims.get(name)`; `Id` = `Principal.Id`.
  - `DepthScopeCompiler.Compile(evaluator, principal, description): { Rows; Writes; Hidden; ReadOnly; Defaults(concept) }`.
    - Per governed concept and action (Read → Rows; Create/Update/Delete → Writes):
      - `None` → `FalsePredicate`;
      - `Organization` → `TruePredicate`;
      - `User` → `In(ownerField, [principal.Id, ...teams])`;
      - `BusinessUnit` → `In(buField, reach)`;
      - `ParentChild` → `In(buField, every BU the hierarchy contains under reach)`.
    - A missing ownership field → `False`, with a diagnostic.
    - Ungoverned concepts follow today's `AccessDepthInstanceFilter` semantics (read them; pin them in a test).
    - Field security: a member that is not readable goes to `Hidden`. A member that is readable but not writable for create/update goes to `ReadOnly`.
    - Create defaults come from `CreateDefaults`.
  - `DevAccessScopeSource(host, readAuthorization, identityConfigured: boolean)`, method `ScopeFor(ctx: AccessContext): Promise<IDevScope>`, where `IDevScope { Scope: AccessScope; Placement(modelId: string): Cypher.INodePlacement; Digest: string }`.
    - The scope is the AND of the policy scope and the depth scope. Rows entries on the same key are ANDed; Writes are ANDed per operation; Hidden and ReadOnly are unioned. Validate against the description (as P4-l).
    - No identity → Default Allow with no Rows. Identity with no security model → Default Deny (today's DenyAll).
    - Cached per (`ConnectorPrincipalDigest.Of(ctx)`, schema version), and invalidated on `TenantReadAuthorization.Invalidate` and on `host.Changed`.
    - `Placement(modelId)` = `TodlNodePlacement(modelId, namespace)` plus `Defaults` from depth create defaults.
- [ ] **Step 1: Failing tests.**
  - One per depth level × Read/Create/Update/Delete.
  - `teams count for user level`.
  - `parent-child reach includes descendants`.
  - `secured readable field hidden without profile`.
  - `readable but not writable field is read-only`.
  - `policy and depth combine (deny wins)`.
  - `no identity allows all`.
  - `no security model is deny all` (identity configured; scan returns nothing; create Denied).
  - `scope cached per principal and dropped on security model reload`.
  - `scope validates against the engine schema`.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): dev access scope from policies, depth and field security`.

---

### Task 6: Server — dev `cypher/query` and `cypher/models` on the engine

**Files:**
- Create: `src/host/engine/dev-cypher-query.ts`: `DevCypherQuery`.
- Modify: `src/host/server-connection-handler.ts` (`RunCypherQuery` Development branches, `RunCypherModels`), `src/pragmatic-server.ts` (`Graph`, `ModelGraph`, `ModelIds`, `Shards`, `CollectGraphSources` removed or narrowed to their runtime callers), `ARCHITECTURE.md`.
- Delete (dev-only): `host/cypher/tenant-graph-cache.ts`, `host/cypher/model-shard-cache.ts`, `host/cypher/model-shard-graph.ts`, and their tests. Keep `tenant-graph-source.ts` only if a runtime caller remains; otherwise delete it.
- Test: `src/host/engine/tests/dev-cypher-query.test.ts`. Port the dev cases of `host/tests/cypher-surface.test.ts`, `cypher-model-scoped.test.ts`, `cypher-paging.test.ts`, `cypher-paging-guard.test.ts`, `graph-scope-unchanged.test.ts`, `server-graph*.test.ts` and `server-field-security.test.ts` to the engine path. Every assertion stays; only the setup changes.

**Interfaces:**
- Consumes: Tasks 4–5; TODL `EngineCellMapper`; server `CypherResultMapper.ToWire`, `PageRequest`, `PageFingerprint`, `CypherParamConverter`.
- Produces: `DevCypherQuery.Run(ctx, request: { Source; Parameters; ModelId?; Page; TimeoutMs; MaxVarLength }): Promise<CypherQueryPageDto>`.
  - **Scope:** the caller's `IDevScope`.
  - **`modelId`:** an unknown or non-member id is InvalidParams "model not found", as today. A known id ANDs `OwnerIs(modelId)` into the `todl.Element` Rows entry, so the filter applies to every concept.
  - **Execution:** `Cypher.CypherEngine.Execute(scope, source, { Parameters, Limits: { Skip, RowCap, Cancel: Deadline.After(TimeoutMs) } })`, then `EngineCellMapper.MapResult`, then `CypherResultMapper.ToWire`.
  - **Cursor fingerprint:** `PageFingerprint.Of('cypher', source, canonical params, engine.SchemaVersion, String(result.Commit ?? reader commit), modelId?, principal digest?)`. Commit and schema version replace `GraphRevision`.
  - **Errors:** engine `CypherErrorCode.Syntax` / `Semantic` → InvalidParams; `Timeout` → -32030.
  - **`cypher/models`:** the sorted distinct model ids of the description's seed Owners, excluding the solution package.
- [ ] **Step 1: Write and port tests.**
  - All ported assertions.
  - `modelId scopes to that model's instances`.
  - `upgrade between pages stales the cursor`.
  - `a policy-hidden instance is absent from count, return and traversal`.
  - `depth applies with and without modelId` (A1/A2 semantics unified).
  - `field-secured member absent from node cells`.
  - `no solution open returns no rows`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Route the Development branches to `DevCypherQuery`. The runtime branches (A3/A4) stay untouched.
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): dev cypher/query and cypher/models on the engine`.

---

### Task 7: Server — dev `cypher/execute` on the engine

**Files:**
- Create: `src/host/engine/dev-cypher-execute.ts`: `DevCypherExecute`.
- Modify: `src/pragmatic-server.ts` (`ExecuteCypher`), `src/host/server-connection-handler.ts` (`RunCypherExecute`), `ARCHITECTURE.md`.
- Delete (dev-only):
  - `host/cypher/dev-cypher-executor.ts`
  - `host/model/dev-model-writer.ts`
  - `host/cypher/authorizing-cypher-writer.ts`
  - `host/cypher/dev-write-security.ts`
  - `host/cypher/dev-write-target-source.ts`
  - `host/cypher/reflected-view.ts`, unless a runtime caller remains
  - `host/cypher/cypher-execute-result-mapper.ts`'s TODL-DTO dependency (rewritten over the engine stats)
  - their tests, ported where the behaviour survives
- Test: `src/host/engine/tests/dev-cypher-execute.test.ts`. Port every case of `host/tests/cypher-execute.test.ts`, `host/cypher/tests/dev-cypher-executor.test.ts` (lease cases), `authorizing-cypher-writer.test.ts` (as scope cases) and `host/model/tests/dev-model-writer.test.ts` (persist / restore cases now owned by `TodlFileConnector`; keep the server-observable ones).

**Interfaces:**
- Consumes: Tasks 4–5; `IWriteLock` / `WriteLockBusyError` (`host/cypher/write-lock.ts`); `Cypher.CypherEngine.Execute` with `Placement: scope.Placement(modelId)`; `CypherResult.Stats` / `Commit`.
- Produces: `DevCypherExecute.Run(ctx, modelId, request: DevCypherRequest): Promise<CypherExecuteResultDto>`.
  - **Model id:** required; unknown → InvalidParams (as today).
  - **Expected revision:** an `expectedRevision` mismatch with `languageService.GraphRevision` → Conflict "graph revision has advanced".
  - **Lease:** acquired around the engine execution, with the fence check before return as today.
  - **Status mapping:**

    | Engine outcome | Status |
    |---|---|
    | `CypherWriteErrorCode.Conflict`, or `ConnectorError` with an `EngineBridgeError Stale` cause | Conflict "model sources changed during the write" |
    | `Denied`, or `AccessError` (including `MemberReadOnly`) | Denied |
    | `Invalid`, or `EngineBridgeError` `NotEditable` / `ForeignId` / `UnsupportedValue` | Invalid |
    | `ConnectorFailed` otherwise, or `PersistFailed` | Failed |
    | No writes | Applied with zero counts and an unchanged revision |

  - **Revision:** after a successful commit, await the host's next applied upgrade (or `WhenIdle`), then return `languageService.GraphRevision` as `revision`.
  - **RETURN rows:** go through `EngineCellMapper` and the existing wire mapper.
- [ ] **Step 1: Write and port tests.**
  - All ported assertions.
  - `create stamps owner defaults`.
  - `read-only field write is Denied, source unchanged`.
  - `write to an instance outside the scope is Denied`.
  - `create is visible to a follow-up query`.
  - `concurrent executes serialize`.
  - `stale sources give Conflict`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): dev cypher/execute on the engine`.

---

### Task 8: Server — `model/view` and `model/resources` visibility from the engine scope

**Files:**
- Create: `src/host/engine/dev-model-view.ts`: `DevModelView`.
- Modify: `src/host/server-connection-handler.ts` (`ProjectModelView`, `ResourceHidden` for Development tenants), `src/host/model-member-builder.ts` (masking from a hidden-member set instead of `IFieldReadMask` when given), `ARCHITECTURE.md`.
- Test: `src/host/engine/tests/dev-model-view.test.ts`. Port the dev cases of `model-view-paging.test.ts`, `model-read-filter.test.ts`, `model-surface.test.ts`.

**Interfaces:**
- Consumes: Tasks 4–5; `ModelMemberBuilder`; `languageService.ModelView`, `Resources`.
- Produces: `DevModelView.Page(ctx, memberId, page): Promise<ModelViewPageDto>` and `DevModelView.Hidden(ctx, nodeId): Promise<boolean>`.
  - **Structure:** comes from the language-service Repository, as today.
  - **Instance visibility:** the set of public ids the engine returns for the caller's scope (`GraphReader.ScanNodes('todl.Element')`). Non-instance nodes (schema, classes, `type === null`) are kept, as today.
  - **Attribute masking:** uses the scope's `Hidden` set for the node's concept.
  - **Edges:** to invisible targets or hidden members are dropped.
  - **Fingerprint:** `memberId`, `GraphRevision`, engine schema version, principal digest.
  - **Depth:** the access-depth filter now applies here, fixing audit defect 3.
- [ ] **Step 1: Write and port tests.**
  - All ported assertions.
  - `depth hides an instance from model/view` (new).
  - `resources of a hidden instance are empty`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): dev model/view and resources visibility from the engine scope`.

---

### Task 9: Retirements, scope invariant suite, docs

**Files:**
- **TODL:** delete `src/authoring/model-draft-writer.ts`, `src/authoring/model-draft-baker.ts`, their exports (`src/index.ts`: `ModelDraftWriter`, `ModelDraftBaker`, `ModelDraftBakeOptions`) and their tests. The six `src/authoring/tests/*` files listed by grep are deleted, or their ModelDraft-only cases are ported to `model-draft*.test.ts`. Also update `ARCHITECTURE.md`. Regenerate Plexus `apps/plexus/src/renderer/src/modules/typescript/framework-typings.generated.ts` with its generator, if it embeds the removed names.
- **Server:**
  - Delete every dev-only class left without callers: `PrincipalDraftGraphMask`, `AllowedIds` in `TenantGraphCache`, and any `FieldMaskedGraphQuery` / `FilteredGraphQuery` / `ModelReadFilter` use that is Development-only. Keep the classes while runtime callers remain.
  - Create `src/host/engine/tests/scope-invariant.test.ts`.
  - Update `ARCHITECTURE.md` and pragmatic-protocol `ARCHITECTURE.md` (the stale sections audit defect 7 names).
- **pragmatic-graph:** publish 0.1.2 (needs user approval at the finish step). Bump the TODL peer/dev range and the server dependency to ^0.1.2.

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces: `scope-invariant.test.ts`, spec §12 "No endpoint returns a row or member outside its AccessScope".
  - **Fixture:** one dev tenant, three principals (no profile, BU-level, org-level).
  - **Per endpoint** (`cypher/query` with and without `modelId`, `cypher/execute` RETURN, `model/view`, `model/resources`), the test asserts:
    - every instance id returned is in the principal's engine-visible set;
    - every returned attribute is readable under the principal's field security.
- [ ] **Step 1: Write** `scope-invariant.test.ts`. Expected: PASS once Tasks 6–8 are in. A failure is fixed in the owning task's code.
- [ ] **Step 2: Delete** the retired code. Then run `grep -rn "ModelDraftWriter\|ModelDraftBaker\|TenantGraphCache\|ModelShardCache\|DevModelWriter\|AuthorizingCypherWriter\|PrincipalDraftGraphMask"` across TODL, the server and Plexus source. Expected: no hits outside docs history.
- [ ] **Step 3: Run** TODL `npm test`, `npm run typecheck`, `npm run build`; server `npm test`, `npm run build`, `npx tsc -p tsconfig.json --noEmit`; Plexus typecheck if its typings changed. Expected: PASS.
- [ ] **Step 4: Commit** TODL `refactor: retire ModelDraftWriter and ModelDraftBaker`; server `refactor: retire dev legacy graph paths; scope invariant suite; docs`.
