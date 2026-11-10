# Runtime environments on the graph engine (milestone 2, plan 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every runtime-tenant graph read and write in pragmatic-server (`cypher/query`, `cypher/models`, `cypher/execute`, `data/write`, `data/share|unshare|shares/list`, `data/assign`, `connector/*`, `model/view`, `model/resources`, `graph/load|loaded`, `application/*`) runs on ONE embedded pragmatic-graph engine per runtime environment, fed by every delivered package set, under one `AccessScope` per principal; runtime data changes are pushed; and every runtime path the switch makes dead (server and TODL) is deleted.

**Architecture:**
- **One engine-side seam for both purposes.** M1's dev classes are generalised, not copied: `IGraphEngineHost` / `IEngineSnapshot` (implemented by `DevGraphEngineHost` and the new `EnvironmentEngineHost`), `AccessScopeSource` with an `IScopeRules` strategy (dev: `DevScopeRules`, runtime: `EnvironmentScopeRules`), `EngineCypherQuery`, `EngineConnectorService`. The handler gets the same interfaces from either attach-args factory and stops branching on purpose for those endpoints.
- **Environment host.** `EnvironmentEngineHost` (inside the runtime `PragmaticServer`, which `TenantRegistry` only builds while it holds the tenant-ownership lease) composes the catalog with TODL `EnvironmentCatalogComposer` over `EnvironmentDeliveries` (every live app + the promote record), opens the engine on LMDB under the tenant's graphs root with one TODL `DataSourceConnector` per external connector plan, upgrades it in place on deploy/promote, and is disposed with the server.
- **Runtime-only services** (`src/host/environment/`): scope rules (policy files AND depth with the app-private bypass, share widening, read-only bindings, seeded nodes read-only), `EnvironmentDataWriter` (`data/write`), `EnvironmentShareService` / `EnvironmentAssignService` (grants as `todl.system.ShareGrant` nodes), `EnvironmentCypherExecute`, `EnvironmentModelView`, `DataChangedPush`.

**Tech Stack:** TypeScript (ESM, NodeNext), `tsx --test`; `@pragmatic-tech-ai/graph` 0.2.0 (M2.1), `@pragmatic-tech-ai/todl` 0.54.0 `/engine` (M2.2) → 0.55.0 (this plan), todl-identity / todl-identity-engine, pragmatic-protocol; LMDB via the engine.

**Spec:** `D:/architecture-agent/pragmatic-graph/docs/superpowers/specs/2026-11-06-graph-consolidation-design.md` — §6, §7, §8, §9, §10, §11.1, §12 (binding). Builds on: M2.1 `pragmatic-graph/docs/superpowers/plans/2026-11-10-external-bindings-on-engine.md` (D1–D9, fixed), M2.2 `pragmatic-graph/docs/superpowers/plans/2026-11-10-todl-runtime-on-engine.md` (T1–T14 and its "Retirement handoff to M2.3"), M1.4 `docs/superpowers/plans/2026-11-09-dev-graph-on-engine.md` (+ Execution rulings). Facts: `pragmatic-graph/docs/integration/m2-runtime-inventory.md`, `ARCHITECTURE.md`.

## Open questions for the owner (defaults are used; nothing blocks)

- **Q1 What `application/open` binds.** **Default (S7):** the consumer app only — it must be live, it stays required for `data/*` (wire compatibility), and it changes neither the scope nor the visible catalog (spec §9: the AccessScope is the only isolation; a client-chosen binding must never relax or decide security). Should a binding instead narrow `cypher/query` to the app's package closure?
- **Q2 Two apps' policy files rule the same concept.** **Default (S5):** both apply, deny wins (AND). App B's stricter rule therefore also restricts app A's users of that shared concept (Dataverse table-level semantics). Alternative: the home app's policy only.
- **Q3 `data/write` atomicity.** **Default (S10):** the whole batch is one engine transaction (spec §6); one failing op rolls back the others (`atomic batch rolled back`). Today non-atomic bindings applied op by op.
- **Q4 `connector/decisions` (entity-identity merge audit).** The engine federates per binding and merges nothing, so there are no merge decisions. **Default (S14):** it answers `[]` and this is listed as a declared behaviour change. Should identity resolution become an engine/TODL feature (a later plan)?
- **Q5 Data-changed granularity.** **Default (S16):** concept-level (`{ commit, concepts }`), filtered to concepts the connection may read; no ids (a deleted node's visibility cannot be judged after the fact). Id-level push is a later extension.
- **Q6 `connector/writePaged` `expectedVersion`.** The engine has no read-time OCC for external rows (M2.1 D7, M2.2 Q1). **Default (S14):** an op with a non-null `expectedVersion` is `invalid` with a fixed reason; results carry no `version`.
- **Q7 Where the environment LMDB lives in a cluster.** **Default (S2):** `<graphsRoot>/environment-engine` (a local path); a deployment must put the tenant base dir on storage the next lease holder can reach. The helm chart is not changed here; ARCHITECTURE.md states the requirement.
- **Q8 Blast radius of a malformed `access-policy.json`.** **Default (S5):** every concept whose home package is one of that app's own packages fails closed (Rows and Writes False); other concepts are unaffected (today the whole bound app failed every request).
- **Q9 `cypher/execute` on runtime tenants.** **Default (S13):** enabled (spec §8 lists it), gated by the existing `writeTenant` policy and the engine scope.

## Design rulings (record each in the implementing task's commit message and in ARCHITECTURE.md; the plan's id is the reference, e.g. "ruling S5")

- **S1 One code path.** Endpoint logic that only needs "an engine, its snapshot, a caller scope" is one class for both purposes: `EngineCypherQuery`, `EngineConnectorService`, `AccessScopeSource`, `EngineWriteFailure`, `CypherKeysetPage`, `ScopeReach`. What legitimately differs is host-shaped and stays per host: the dev `cypher/execute` (write lease, write fence, settle waits for `.todl` file writes) versus `EnvironmentCypherExecute` (no lease: the tenant-ownership lease already makes the engine single-owner, and the engine's OCC serializes); `model/view` structure (dev: the language service incl. unsaved buffers; runtime: the engine catalog). Both execute paths share placement, scope confinement and failure mapping.
- **S2 Environment host.** `EnvironmentEngineHost` opens lazily on first use: `GraphEngine.Open({ Description: catalog.Description, Storage: { Kind: options.environmentEngineStorage ?? StorageKind.Lmdb, Path: join(graphsRoot, EnvironmentEngineHost.StoreDir /* 'environment-engine' */) }, Connectors: one DataSourceConnector per catalog.Connectors entry, PrepareTimeoutMs: EnvironmentEngineHost.PrepareTimeoutMs /* 30000 */ })`. With no deliveries it still opens (the composer always adds `todl.system`). An LMDB `Locked` at Open is retried `OpenAttempts = 3` times with `OpenBackoffMs = 500` (×2) — the previous lease holder may still be closing — then fails the request. `Redeliver()` recomposes; when `ConnectorSetKey.Of(catalog.Connectors)` (sorted JSON of each plan's `Name` and `Spec`) is unchanged it calls `engine.Upgrade(description)`, else it **reopens** (the engine's connectors are fixed at Open): new callers wait on the host gate, readers already handed out finish, the engine is disposed and re-opened on the same path (Open upgrades it). Opens, upgrades and reopens are serialized. `dispose()` (server dispose = lease lost or idle eviction) disposes the engine (which closes the store); a restart opens from storage plus the composed description (R74: no commit when unchanged). `Changed` is raised after every applied upgrade or reopen.
- **S3 Deliveries.** `EnvironmentDeliveries.Current()` = one `DeliveryChannel.Deploy` delivery per app that has a `live` pointer (name = app name, packages = that version's `application.json` packages) plus, when `graphs/loaded-graph.json` exists, one `DeliveryChannel.Promote` delivery (name = record `name`, packages = record `packages`); sorted Deploy-before-Promote, then by name. `loaded-graph.json` stays as the promote record (it is the input of `graph/loaded`); only the instance built from it is retired.
- **S4 Delivery order.** All deploys and promotes of one environment run one at a time under the host's delivery mutex: (1) packages stored immutably (as today), (2) `EnvironmentCatalogComposer.Compose` over the prospective deliveries — pure; an `EnvironmentCatalogError` rejects (deploy: `AppDeployResultDto` `invalid` with the error's message; `graph/load`: InvalidParams with it), nothing persisted beyond the immutable packages; (3) the app `live` pointer / promote record is persisted; (4) `Redeliver()`. A failure in (4) is reported to `IEnvironmentDiagnostics.UpgradeFailed`, marks the host stale (the next request re-runs `Redeliver` before serving) and answers deploy with `failed`, reason `EnvironmentUpgradeFailedReason = 'deployed, but the environment graph could not be upgraded; it is retried on next use'` (graph/load: InternalError). Validating before persisting matters because §4.3 upgrades discard data irreversibly.
- **S5 Runtime scope.** `Final = Finish(And(PolicyEnv, Depth(bypass)))`, combined with `AccessScopeConjunction.And` (deny-wins, M1).
  - `PolicyEnv` = the AND over every live app X of `PolicyScopeCompiler.FromRules(AccessPolicySetting.Load(apps, X), description).Compile(PrincipalFacts, AccessDefault.Allow)`. No file: X contributes nothing. `MalformedPolicyError` from `Load`, or any `MalformedPolicy` diagnostic from `FromRules` (M2.2 T13 says fatal): every concept whose home model (`catalog.HomeModels`) is one of X's own package ids gets Rows `False` and Create/Update/Delete `False`, reported once per policy digest (Q8).
  - `bypass` (spec §11.1) = concepts K whose home package is one of exactly one live app X's own packages, delivered by no other delivery (another app's closure or the promote set), and not in `GovernedConceptsFor(ctx)`; empty when the tenant has no security model (DenyAll stays total, as today). `DepthScopeCompiler.Compile(…, { Bypass })` emits no Rows/Writes/field entries for K.
  - System concepts (`todl.system.*`) get no policy and no depth entries; `Finish` writes theirs.
  - `Finish` (runtime only): (a) **share widening** — subjects `{ PrincipalId, Teams: MembershipFor(ctx).teams }`; every non-system Rows entry `E` becomes `Or(E, ShareGrantScope.Widening(s, Read))`, every Update entry `Or(U, Widening(s, Update))`, every Delete entry `Or(D, Widening(s, Delete))`; under `Default: Deny` the default is first materialized per described non-system concept with the M1 `Not(ConceptIs K)` rule so the widening reaches entry-less concepts too (parity: today `ShareWideningInstanceFilter` wraps even DenyAll); (b) `Rows[ShareGrant] = ShareGrantScope.GrantRows(s)`, `Writes[ShareGrant]` Create/Update/Delete `False` (only S8/S9/S10 service scopes write grants); (c) for each read-only external binding (`catalog.Identity.ReadOnly()`), AND `Not(OwnerIs({binding.Model}))` into the Create/Update/Delete of its concept; (d) AND `Not(Seeded)` into the root `todl.Element` Update and Delete (spec §6: seeded nodes are read-only at runtime).
  - No identity configured: `PolicyEnv` rows, `Default: Allow`, no depth, no widening; (c) and (d) still apply.
  - Cache key (`IGraphScope.Digest`) = JSON of `[ConnectorPrincipalDigest, tenant, claims hash, SchemaVersion, security generation, PolicyDigest]`, where `PolicyDigest` = sha256 over each live app's name and policy text (absent = empty). The policy files are re-read per `ScopeFor` (today they were read per request), so a policy edit applies on the next request. Grants are graph data evaluated by predicate: a share never invalidates the cache.
- **S6 Runtime placement.** `IGraphScope.Placement(modelId?)` at runtime = TODL `EnvironmentNodePlacement(catalog.Identity, catalog.HomeModels)` plus the depth create defaults as `INodePlace.Defaults`; `modelId` does not affect placement.
- **S7 `application/open`.** Validates the app is live and binds its name to the connection; required by `data/write`, `data/share|unshare|shares/list`, `data/assign` (error unchanged: "no application selected"); not required by `cypher/*`, `connector/*`, `model/*`; no effect on scope or catalog (Q1).
- **S8 Shares as graph data.** The wire `id` of a record is its engine public id (`RecordKey`, `ConceptIdFields` retire). `Share`/`Unshare`/`List` first read the record under the caller's scope (`reader.ConceptOf(id)` must be `params.concept` or a subtype, else `not-found`). `CanShare` = `evaluator.Allows(principal, Share, EngineInstanceView)` OR a visible grant on the record for the caller's subjects with `share = true` (grant ids from `ShareGrants.PublicId(record, kind, id)` for the principal and each team). Writes run under `ShareServiceScope.For(callerScope, grantIds)` = the caller scope with `Rows[ShareGrant] = Or(GrantRows(s), IdIn(grantIds))` and `Writes[ShareGrant]` Create/Update/Delete = `IdIn(grantIds)`, so the engine confines the transaction to exactly those grants. Share = create-or-update grant `ShareGrants.PublicId(record, subject.kind, subject.id)` with Owner `SystemPackage.Ref.model`, `ShareGrants.Properties(kind, id, rights)`, and a `record` link (an external record: `LinkOptions.ExternalTarget` from `Identity.Parse`); unknown team → `invalid` (`IsKnownTeam`, as today). Unshare = delete that grant; absent → `not-found`. List = grants whose `record` links to the record (scope Rows `Or(GrantRows(s), Related('record', Out, IdIn{record}))`), mapped to `ShareGrantDto { concept: record concept, recordId, subject, rights: true rights in ShareRight order }`. Identity required (error unchanged).
- **S9 Assign.** Same record read and `Allows(Assign)` OR grant `assign = true`; `evaluator.AssignWrites(...)` and its status mapping unchanged; written under `AssignScope.For(callerScope, concept, recordId, ownershipMembers)`: `Writes[concept].Update = IdIn({recordId})` (replacing the caller's Update rule: assign bypasses the Update gate, as today) and `ReadOnlyExact.Update[concept]` = every member of the concept except the ownership members. A `ConflictError` or `ExternalWriteError` of kind `conflict` → `denied` "write conflict"; any other failure → `denied` "write failed" (today's reasons).
- **S10 `data/write`.** One engine transaction per batch (Q3). Pre-checks per op, before anything begins: unknown op kind, unknown concept, id required for update/delete, and the existing `RuntimeWritePayloadValidator` reasons (re-based on the engine description; relationship members stay unwritable, as today). A pre-check failure gives that op its status and every other op `failed` + `atomic batch rolled back`. Creates: `Placement.Place` → `CreateNode(PublicId, concept, { Owner })`, `SetProperty` per field, `SetDefault` per placement default. Updates: `SetProperty`. Deletes: first the grants linked to the record (`Links(record, In, 'record')`), with the batch scope widened by `Writes[ShareGrant].Delete = IdIn(those grant ids)`, then `DeleteNode`. Commit failure → `EngineWriteFailure.Map` (below); the op it attributes (error's public id equals the op's id or placed id) gets the mapped status, the others `failed` + rolled back; unattributed → every op the mapped status. Success → every op `applied`, creates with `id`.
  - **`EngineWriteFailure.Map(error): { Status: AppWriteStatus; Reason: string }`**: `ConflictError` / `CypherWriteErrorCode.Conflict` → `conflict` "write conflict"; `AccessError` `MemberReadOnly` / `HiddenMember` → `denied` "not authorized for a field", other `AccessError` → `denied` "not authorized for this record"; `CommitError` → `invalid` with the `CommitErrorCode` name; `EngineBridgeError` `NotWritable` → `invalid` "binding is read-only", `ForeignId` / `UnsupportedExternalChange` / `AmbiguousExternalBinding` → `invalid` with the code name; `ConnectorError` whose cause is `ExternalWriteError` `ExternalWriteFailed` → by its first failure kind `conflict`→`conflict`, `unsupported`→`invalid`, `error`→`failed` (M2.2 T9); any other `ConnectorError` → `failed` "write failed". Unknown errors propagate (InternalError).
- **S11 Keyset cursors.** `CypherKeysetPage` replaces offset paging for every engine Cypher page (dev and runtime `cypher/query`, runtime `connector/read*`, runtime `model/view`). Wire cursor = `PageCursorCodec.Encode({ offset: 0, fingerprint: fp + '\u0000' + CypherCursor.Encode() })`, `fp` = `PageFingerprint.Of('cypher', source, canonical params, SchemaVersion, scope Digest[, 'model', modelId])` — the commit is no longer in it, so commits between pages neither repeat nor skip rows (M2.1 D8); a schema upgrade or another principal stales the cursor. Engine `Limits.After` comes from the decoded cursor, the next cursor from `result.NextCursor`. The upgrade-retry loop of `DevCypherQuery` stays but compares `SchemaVersion` only. `GraphDataDigest` and `GraphRevision` fingerprints retire.
- **S12 Runtime `modelId`.** `cypher/query` and `cypher/execute` accept a runtime `modelId` that is one of `catalog.Packages` model ids other than `todl.system`; `cypher/models` lists exactly those (sorted). The scoping is M1's (`Or(ConceptIs todl.Term, OwnerIs({modelId}))` on `todl.Element`, T6-b/T7-b); runtime owners are home packages (engine nodes) and binding models (external nodes), so the filter means "this package's data". `RuntimeModelScopeMessage` retires.
- **S13 Runtime `cypher/execute`.** `EnvironmentCypherExecute.Run(ctx, modelId | undefined, DevCypherRequest)`: placement S6; `modelId` optional and, when given, confines writes as dev T7-b; `revision` = `Number(latest commit)` after the write (unchanged when nothing commits); an `expectedRevision` that differs → Conflict "graph revision has advanced"; one retry on `ConflictError`; statuses via `EngineWriteFailure` (the dev `DevWriteFailure` keeps only its file-specific `Stale` / `NotEditable` cases on top of it). RETURN rows as dev.
- **S14 Connectors on the engine (dev and runtime).** `modelId` = dev model id / runtime package id.
  - `connector/read`, `connector/readPage`: `MATCH (n:\`<concept>\`) RETURN n` under the caller scope AND the S12 model filter, keyset-paged (S11). `readPage` `where` terms become a parameterised `WHERE` over `n.<field>` (field must be a property member of the concept, else InvalidParams "unknown filter field"; ops map 1:1, `isNull`/`isNotNull` to `IS NULL`/`IS NOT NULL`); `read` still refuses `where`. `EntityDto` = `{ id: public id, concept, fields: visible scalar properties }` (bigint → number when safe, else decimal text; temporal → its ISO text).
  - `connector/writePaged`: each op's binding is found by `(concept, connector, source)` among the model's external bindings (none → `invalid` "no binding for this connector and source"); key → `Identity.Mint(binding, String(key))`; source fields → members by the inverse `FieldMap` (unknown field → `invalid`); upsert = update when the node is visible, else create with that public id and Owner = binding model; a non-null `expectedVersion` → `invalid` `ExpectedVersionUnsupported = 'expectedVersion is not supported; the connector guards concurrency at commit'` (Q6). All ops one transaction with S10's failure mapping; results carry no `version`.
  - `connector/writeBack`: there is no working copy any more (writes commit synchronously, §6), so `dirty` ids flush nothing; `deleted` ids are deleted in one transaction under the caller scope (closes audit defect 2). Result: `{ results: [{ applied, failures }], diagnostics: dirty.length > 0 ? [{ code: 'NothingToFlush', message: 'writes are committed when made; nothing is pending' }] : [] }`.
  - `connector/list` from the snapshot's external plans grouped by binding model; `connector/prepare`, `connector/refreshModel`: no-ops (no diagnostics; nothing is materialized); `connector/refresh`: invalidates the snapshot specs' adapters in `DataSourceAdapterCatalog` (as today); `connector/test`: adapter probe over the snapshot spec (as today); `connector/decisions`: `[]` (Q4).
- **S15 Runtime `model/view`, `model/resources`.** `model/view` `memberId` = a package model id (else InvalidRequest `UnknownMemberError`). Items = the nodes `MATCH (n:\`todl.Element\`) RETURN n` returns under the caller scope AND the S12 model filter, keyset-paged (S11), each mapped to `ModelMemberDto { id: public id, kind: concept, localId: text after the last '#' (external) or '.' of the id, namespace: concept text before its last '.', tier: Tier[Tier.Instance], isClass: false, attrs: visible scalar properties, edges: one { kind: EdgeKind[EdgeKind.Relationship], via: member, to } per visible link }`, `provenanceOf: {}`. `model/resources` on a runtime tenant answers `[]` (runtime holds no source resources: it compiles nothing).
- **S16 Data-changed push.** Protocol: `AppDataProtocol.Changed = new NotificationType<DataChangedPayload>('data/changed')`, `DataChangedPayload { commit: string /* decimal */; concepts: string[] /* sorted */ }`, `PragmaticClient.OnDataChanged(handler)` (resubscribed on reconnect like `OnGraphChanged`). Server: `DataChangedPush` subscribes the environment engine's `CommitApplied` once per host (re-subscribed after a reopen). Concepts of a commit: `CreateNode.Concept`; other ops' public ids via `ConceptOf` on one `AccessScope.System` reader opened on receipt; an id it cannot resolve (deleted) via `Identity.Parse(id)` → binding concept, else the root `todl.Element`; an `Upgrade` / `SchemaChange` commit → `['todl.Element']`. A concept covers its subconcepts (clients treat an ancestor as "maybe yours"). Per runtime connection whose gate allows `cypher/query`: concepts filtered by `ScopeReach.MayRead(scope, concept, catalog)` (false iff an applicable Rows entry is the constant False, or `Default: Deny` with no applicable entry), coalesced over `CoalesceMs = 50` (latest commit, union of concepts), nothing sent when empty, stopped on connection dispose. External sources changed outside the engine are not pushed (no changefeed; §5.2). Dev tenants keep `solution/graphChanged` only.
- **S17 Clean cut-over (§9).** Nothing is imported: `applications/<app>/data/` (builtin documents and `__shares`) and any previously built environment instance are left on disk untouched and unread; ARCHITECTURE.md names them as dead data an operator may delete.
- **S18 Dev connectors.** The dev host describes with TODL `ExternalCatalogDescriber` (Task 1, `LocalConnector: TodlNames.FileConnector`) and installs a `DataSourceConnector` per external plan beside the `TodlFileConnector`; a recompile that changes the connector set reopens the memory engine (S2's rule; dev data lives in `.todl` files, so nothing is lost).
- **S19 One Cypher.** Every server import of TODL `Cypher` moves to the engine's `Cypher` (`@pragmatic-tech-ai/graph`) and wire DTO types to TODL `CypherWire`: `CypherParamConverter` uses the engine `ParameterValue`; `RefuseInvalidReadQuery` uses the engine `CypherParser` (`HasWrites`, final projection Skip/Limit); `ReferencedLabels` use goes.

## Global Constraints

- Layering: the engine never imports TODL, the server or identity; TODL imports the engine only under `src/engine-bridge/**`; the server may import both. Every runtime decision is compiled into the `AccessScope`; no endpoint filters or masks rows or members itself (spec §2 anti-goals).
- Dev and runtime share the engine-side classes named in S1; do not add a second implementation of anything S1 lists.
- Runtime compiles nothing: only compiled `model.json` packages are read (`EnvironmentCatalogComposer`); no compiler or language service is resolved on a runtime tenant for these endpoints.
- External data is never cached across queries or transactions (spec §5.2, §12); no server-side row memo.
- Wire shapes of every existing method and DTO stay unchanged; the only protocol addition is `data/changed` (S16).
- Prerequisites: pragmatic-graph 0.2.0 (M2.1) and TODL 0.54.0 (M2.2) built locally (`file:` siblings: rebuild `dist` before dependents see changes; `npm install` is forbidden — it breaks the workspace symlinks, M1.4 ruling T3-b).
- Code style (global CLAUDE.md): OOP, no module-level functions or mutable state, Allman braces, PascalCase interfaces and public methods, `private static readonly` PascalCase constants for every reused literal and user-facing text (reasons, messages, file names, keys), enums for fixed sets, `dispose()` teardown, tests in `tests/` subfolders, LF line endings.
- Every task ends green: server `npm test`, `npm run build`, `npx tsc -p tsconfig.json --noEmit`; TODL tasks also `npm test`, `npm run typecheck`, `npm run build` in TODL; protocol tasks `npm test` + `npm run build` in pragmatic-protocol. A test that writes through an endpoint not yet switched and reads through a switched one is ported in the switching task to seed its data directly into the environment engine (`EnvironmentFixture.Seed`).
- Each task deletes the code its switch made dead (no leftovers) and updates `ARCHITECTURE.md` in the commit that moves a seam. Fix every review finding, including minors.
- Branches: server `feat/runtime-graph-on-engine`, TODL `feat/runtime-cutover`, protocol `feat/data-changed`. No push; the controller merges and publishes.

## Review Focus

1. A redeploy drops a package that another app still delivers, or two apps' deploys race: the shared package's data must survive, and the environment must never end up composed from a set nobody validated. → Task 6 tests `package still delivered by another app keeps its data` and `concurrent deploys are serialized and both land`.
2. A principal never calls `application/open` (or opens a permissive app) to dodge a restrictive app policy: the scope must be identical either way. → Task 7 test `binding an app does not change the scope`.
3. A delete of a shared record followed by a create with the same public id: the new record must not inherit the old grants. → Task 10 test `recreated record is not widened by old grants`.
4. The worker loses the tenant lease mid-request, then another worker (or a restart) opens the same LMDB: the second open must succeed after the first host disposes, and see every committed write. → Task 5 tests `lease loss disposes the engine` and `reopen after restart sees committed data`.
5. A commit lands between two pages of a long runtime `cypher/query`: page 2 continues after page 1's last row (no repeat, no skip); a policy-file edit between pages stales the cursor. → Task 4 test `commit between pages neither repeats nor skips`; Task 7 test `policy edit stales the cursor`.

---

## File structure

- `src/host/engine/` (purpose-free, shared): `graph-engine-host.ts` (`IGraphEngineHost`, `IEngineSnapshot`), `access-scope-source.ts` (renamed from `dev-access-scope-source.ts`: `AccessScopeSource`, `IGraphScope`, `IGraphScopeSource`, `IScopeRules`, `ScopeSchema`), `dev-scope-rules.ts`, `engine-cypher-query.ts` (renamed from `dev-cypher-query.ts`), `cypher-keyset-page.ts`, `engine-write-failure.ts`, `engine-connector-service.ts`, `connector-set-key.ts`, `scope-reach.ts`, `engine-instance-view.ts`, `principal-digest.ts` (`ConnectorPrincipalDigest` moved from `connector-read-authorization.ts`); dev-specific files keep their names.
- `src/host/environment/` (runtime): `environment-engine-host.ts`, `environment-deliveries.ts`, `promote-record-store.ts` (the `LoadedGraphStore` record, moved), `environment-scope-rules.ts`, `share-widening.ts`, `service-scopes.ts` (`ShareServiceScope`, `AssignScope`, `DeleteGrantsScope`), `environment-data-writer.ts`, `environment-share-service.ts`, `environment-assign-service.ts`, `environment-cypher-execute.ts`, `environment-model-view.ts`, `data-changed-push.ts`, `tests/environment-fixture.ts`.
- pragmatic-protocol: `src/dto/wire-dtos.ts` (`DataChangedPayload`), `src/contracts/app-data-protocol.ts` (`Changed`), `src/client/pragmatic-client.ts` (`OnDataChanged`).
- TODL: `src/engine-bridge/environment/ExternalCatalogDescriber.ts` (Task 1); deletions (Task 15).

---

### Task 1: TODL — `ExternalCatalogDescriber` (shared by dev and environment)

**Repo:** `D:/architecture-agent/TODL`.

**Files:**
- Create: `src/engine-bridge/environment/ExternalCatalogDescriber.ts`
- Modify: `src/engine-bridge/environment/EnvironmentCatalogComposer.ts` (steps 4–6 delegate to it), `src/engine-bridge/index.ts`
- Test: `src/engine-bridge/environment/tests/ExternalCatalogDescriber.test.ts`

**Interfaces:**
- Consumes: M2.2 `IExternalConnectorPlan`, `ExternalIdentity`, `SnapshotDescriber`, `ConnectorPlanEmitter.PlanFor`, `EnvironmentCatalogError`.
- Produces:
  - `interface IExternalCatalogOptions { readonly DefaultConnector: string; readonly LocalConnector: string /* where builtin and todl-file bindings are routed (M2.2 T3) */ }`
  - `interface IExternalCatalog { readonly Description: ISnapshotDescription; readonly Connectors: readonly IExternalConnectorPlan[]; readonly Identity: ExternalIdentity; readonly Diagnostics: readonly IDescribeDiagnostic[] }`
  - `class ExternalCatalogDescriber { static Describe(snapshot: MetadataSnapshot, plans: readonly ModelConnectorPlan[], options: IExternalCatalogOptions): IExternalCatalog }` — merges specs by T2 identity, rewrites builtin/`todl-file` bindings to `LocalConnector` (T3), checks T4 prefixes, describes with external bindings emitted; the same `EnvironmentCatalogError` codes as the composer.

- [ ] **Step 1: Failing tests:** `routes builtin bindings to the local connector` (`LocalConnector: 'todl-file'` → binding `Connector === 'todl-file'`; `'engine'` → `'engine'`); `external binding is described and planned` (a sql binding gives one plan named by T2 and a description binding to it); `composer output is unchanged` (the M2.2 composer tests still pass and `Compose(...).Description` deep-equals before/after the refactor on the composer fixture); `conflicting connector specs are rejected` (`ConflictingConnector`).
- [ ] **Step 2: Run** `npx tsx --conditions=development --test src/engine-bridge/environment/tests/ExternalCatalogDescriber.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** by moving the composer's steps 4–6 into the describer; the composer calls it with `{ DefaultConnector: BindingTable.EngineStorage, LocalConnector: BindingTable.EngineStorage }`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine-bridge): external catalog describer shared by dev and environment`.

### Task 2: Server — purpose-free engine seam and scope source

**Files:**
- Create: `src/host/engine/graph-engine-host.ts`, `src/host/engine/dev-scope-rules.ts`, `src/host/engine/principal-digest.ts`
- Rename/modify: `dev-access-scope-source.ts` → `access-scope-source.ts`; `dev-cypher-query.ts` → `engine-cypher-query.ts`; `depth-scope-compiler.ts` (bypass); `dev-graph-engine-host.ts` (implements `IGraphEngineHost`); `dev-model-view.ts`, `dev-cypher-execute.ts`, `src/pragmatic-server.ts`, `src/host/server-connection-handler.ts` (names only); `connector-read-authorization.ts` (re-export removed, importers updated); `ARCHITECTURE.md`
- Test: rename `tests/dev-access-scope-source.test.ts` → `tests/access-scope-source.test.ts`, `tests/dev-cypher-query.test.ts` → `tests/engine-cypher-query.test.ts`; extend `tests/depth-scope-compiler.test.ts`

**Interfaces:**
- Produces:
  - `interface IEngineSnapshot { readonly Description: ISnapshotDescription; readonly CellMapper: EngineCellMapper; readonly Models: readonly string[]; readonly Connectors: readonly IExternalConnectorPlan[]; readonly Identity: ExternalIdentity | undefined }` (`DevSnapshot` extends it; Connectors `[]` and Identity undefined until Task 3)
  - `interface IGraphEngineHost { Engine(): Promise<GraphEngine>; Snapshot(): Promise<IEngineSnapshot>; Description(): Promise<ISchemaDescription>; readonly Changed: ISignal<void> }`; `IDevGraphEngine extends IGraphEngineHost`.
  - `interface IGraphScope { readonly Scope: AccessScope; readonly Digest: string; Placement(modelId?: string): Cypher.INodePlacement }` (was `IDevScope`), `interface IGraphScopeSource { ScopeFor(ctx): Promise<IGraphScope>; readonly Dropped: ISignal<void> }` (was `IDevScopeSource`).
  - `class ScopeSchema { readonly Engine; readonly Description; readonly Version; readonly Catalog: EngineSchemaCatalog }`
  - `interface IPreparedRules { Policy(facts: PrincipalFacts, context: AccessContext): Promise<{ Scope: AccessScope; Diagnostics: readonly string[] }>; Bypass(context: AccessContext): Promise<ReadonlySet<string>>; Finish(scope: AccessScope, context: AccessContext): Promise<AccessScope>; Placement(defaults: IPlacementDefaults, modelId: string | undefined): Cypher.INodePlacement; readonly Digest: string }`
  - `interface IScopeRules { Prepare(schema: ScopeSchema): Promise<IPreparedRules>; readonly Changed: ISignal<void> }`
  - `class AccessScopeSource implements IGraphScopeSource, IDisposable { constructor(host: IGraphEngineHost, security: ITenantSecuritySource | undefined, identityConfigured: boolean, rules: IScopeRules, diagnostics?: IScopeDiagnostics) }` — M1 algorithm unchanged; the policy part, bypass, finish and placement come from `rules`; `Digest` appends `prepared.Digest`; `rules.Changed` drops the cache. `IDevScopeDiagnostics` → `IScopeDiagnostics`, `DevAccessScopeError` → `AccessScopeError`.
  - `class DevScopeRules implements IScopeRules { constructor(host: IDevGraphEngine, solutionName: () => Promise<string | undefined>) }` — `Policy` = `FromRepository`, `Bypass` = ∅, `Finish` = identity, `Placement` = M1 `DevNodePlacement` (a missing `modelId` throws `InvalidArgument`), `Digest` = `''`, `Changed` never raised.
  - `DepthScopeCompiler.Compile(evaluator, principal, description, hasSecurityModel, options?: { Bypass?: ReadonlySet<string>; Skip?: (concept: string) => boolean })` — `Bypass` / `Skip` concepts get no Rows, Writes, HiddenExact or ReadOnlyExact entries.
  - `class EngineCypherQuery implements IGraphCypherQuery { constructor(host: IGraphEngineHost, scopes: () => Promise<IGraphScopeSource>) }` (was `DevCypherQuery`; `IDevCypherQuery` → `IGraphCypherQuery`; `TimeoutCode` unchanged).

- [ ] **Step 1: Failing tests:** `bypassed concept has no depth entries` (a governed and an ungoverned concept, `Bypass {ungoverned}` → no Rows/Writes key for it, the governed entries unchanged); `skipped concept has no entries`; `rules finish is applied last` (a fake `IScopeRules` whose `Finish` ANDs `IdIn{x}` → a scan returns x only); `rules digest keys the cache` (two digests → two compiles); `rules Changed drops the cache`. Every renamed M1 test keeps its assertions.
- [ ] **Step 2: Run** `npx tsx --test src/host/engine/tests/*.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the rename and extraction (behaviour-preserving for dev).
- [ ] **Step 4: Run** the server checks. Expected: PASS, every M1 test (incl. `scope-invariant.test.ts`) unchanged in assertions.
- [ ] **Step 5: Commit** `refactor(engine): purpose-free engine seam, scope rules strategy, depth bypass`.

### Task 3: Server — dev host federates external bindings

**Files:**
- Create: `src/host/engine/connector-set-key.ts`
- Modify: `src/host/engine/dev-snapshot-source.ts` (describe through `ExternalCatalogDescriber` with plans `ConnectorPlanEmitter.PlanFor(repository, modelId)` per accepted model, `LocalConnector: TodlNames.FileConnector`), `src/host/engine/dev-graph-engine-host.ts` (installs `DataSourceConnector`s; reopen on connector-set change), `src/pragmatic-server.ts` (passes `DataSourceAdapterCatalog` + services), `ARCHITECTURE.md`
- Test: `src/host/engine/tests/dev-external-bindings.test.ts`

**Interfaces:**
- Consumes: Task 1; M2.2 `DataSourceConnector.Open(plan, adapters, services, identity, description)`.
- Produces: `class ConnectorSetKey { static Of(plans: readonly IExternalConnectorPlan[]): string }`; `DevSnapshot.Connectors` / `Identity` filled.

- [ ] **Step 1: Failing tests** (an InMemory adapter registered in the catalog for a `sql` spec, as in TODL `ExternalFixture`): `dev cypher reads an external binding` (`MATCH (c:\`crm.Customer\`) RETURN c.name` → `['Acme']`, two runs → two adapter calls); `dev scope filters fetched rows` (a policy hiding `name = 'Acme'` → no row); `adding a connector reopens the engine` (save a model with a new connector → `Engine()` returns a new instance, `.todl` seed data still present); `unchanged connector set upgrades in place` (same instance after a save).
- [ ] **Step 2: Run** `npx tsx --test src/host/engine/tests/dev-external-bindings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** S18 (reopen waits for in-flight writes to settle, as the upgrade drain already does).
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): dev engine federates external connector bindings`.

### Task 4: Server — keyset cursors for engine Cypher pages

**Files:**
- Create: `src/host/engine/cypher-keyset-page.ts`
- Modify: `src/host/engine/engine-cypher-query.ts`, `ARCHITECTURE.md`
- Test: `src/host/engine/tests/cypher-keyset-page.test.ts`, extend `tests/engine-cypher-query.test.ts`

**Interfaces:**
- Produces: `class CypherKeysetPage { static Resolve(params: PageParams, fingerprint: string, limits: PagingLimits, cap?: number): CypherKeysetPage; readonly After: Cypher.CypherCursor | undefined; readonly Size: number; NextCursor(next: Cypher.CypherCursor | undefined): string | undefined }` (S11; a malformed, foreign-fingerprint or undecodable cursor → `CursorStaleError`).

- [ ] **Step 1: Failing tests:** `cursor round-trips` (Resolve(NextCursor(c)) has `After` equal to c); `foreign fingerprint is stale`; `garbage cursor is stale`; on the dev engine: `pages concatenate to the full result` (25 rows, page 10 → 10/10/5, equal to the unpaged result), `commit between pages neither repeats nor skips` (a create sorting before the cursor after page 1 → page 2 starts exactly after page 1's last row), `upgrade between pages stales the cursor` (M1 test, kept), `another principal's cursor is stale`.
- [ ] **Step 2: Run** `npx tsx --test src/host/engine/tests/cypher-keyset-page.test.ts src/host/engine/tests/engine-cypher-query.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** S11 in `EngineCypherQuery` (`Limits: { After, RowCap, Cancel }`; `Settled` compares `SchemaVersion` only). Update the M1 test whose assertion was "a commit stales the cursor" to the new rule and record it as a declared behaviour change in ARCHITECTURE.md.
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): keyset cursors for engine cypher pages`.

### Task 5: Server — environment deliveries and `EnvironmentEngineHost`

**Files:**
- Create: `src/host/environment/environment-deliveries.ts`, `src/host/environment/promote-record-store.ts` (`PromoteRecordStore`: `LoadedGraphStore`'s `Read`/`Save` over `graphs/loaded-graph.json`, moved), `src/host/environment/environment-engine-host.ts`, `src/host/environment/tests/environment-fixture.ts`
- Modify: `src/pragmatic-server.ts` (`EnvironmentEngine()` memoized for Runtime purpose, disposed in `DoDispose` before the connectors host; `PragmaticServerOptions.environmentEngineStorage?: StorageKind`), `src/host/graphs/environment-graph.ts` (imports the moved store), `ARCHITECTURE.md`
- Test: `src/host/environment/tests/environment-deliveries.test.ts`, `src/host/environment/tests/environment-engine-host.test.ts`

**Interfaces:**
- Consumes: TODL `EnvironmentCatalogComposer`, `IEnvironmentCatalog`, `DeliveryChannel`, `IPackageDelivery`, `DataSourceConnector`, `StoragePackageSource`, `SystemPackage`; `PragmaticAppsRegistry`; Task 2–3 seam.
- Produces:
  - `class EnvironmentDeliveries { constructor(apps: PragmaticAppsRegistry, promote: PromoteRecordStore); Current(): Promise<readonly IPackageDelivery[]>; With(change: DeliveryChange): Promise<readonly IPackageDelivery[]> }`; `type DeliveryChange = { Channel: DeliveryChannel; Name: string; Packages: readonly Required<PackageRef>[] }` (replaces the same-name delivery of that channel).
  - `type EnvironmentSnapshot = IEngineSnapshot & { readonly Catalog: IEnvironmentCatalog; readonly Deliveries: readonly IPackageDelivery[] }` (`Models` = S12 list; `CellMapper = new EngineCellMapper(catalog.Snapshot)`).
  - `interface IEnvironmentDiagnostics { UpgradeFailed(error: unknown): void; ChangedHandlerFailed(error: unknown): void }`, `LoggerEnvironmentDiagnostics` (error names only).
  - `class EnvironmentEngineHost implements IGraphEngineHost, IDisposable { constructor(deliveries: EnvironmentDeliveries, packages: IStorage, adapters: DataSourceAdapterCatalog, services: IServiceProvider, storage: { Kind: StorageKind; Path: string }, diagnostics?: IEnvironmentDiagnostics); Engine(); Snapshot(): Promise<EnvironmentSnapshot>; Description(); Deliver<T>(change: DeliveryChange, persist: () => Promise<T>): Promise<T>; Redeliver(): Promise<void>; readonly Changed; dispose() }` — S2/S4; `Deliver` throws `EnvironmentCatalogError` before `persist` runs.
  - `EnvironmentFixture` (test): temp tenant dir, compiles test packages with TODL `compilePackage` into `packages/`, writes app manifests/live pointers and policy files, builds a Runtime `PragmaticServer` (identity optional), `Seed(rows)` writes through an `AccessScope.System` transaction, `Connect(principal)` returns a `PragmaticClient` over a socket pair.

- [ ] **Step 1: Failing tests:**
  - deliveries: `one delivery per live app plus the promote record`; `app without live pointer is not delivered`; `With replaces the same-named delivery`.
  - host: `opens with only the system package when nothing is delivered` (`todl.system.ShareGrant` in `Description()`); `opens over every delivery` (concepts of two apps and the promote set); `deliver validates before persisting` (incompatible majors → `EnvironmentCatalogError`, `persist` never called, engine unchanged); `same connector set upgrades in place` (same `Engine()` instance); `new connector reopens on the same store` (new instance; previously committed engine-storage data still readable); `reopen waits for readers` (a reader handed out before completes its scan); `upgrade failure marks stale and the next call retries` (a failing first `Upgrade` → `UpgradeFailed` reported; the next `Engine()` re-runs `Redeliver`); `lease loss disposes the engine` (registry `DisposeTenant` → engine disposed, store closed); `reopen after restart sees committed data` (LMDB; dispose host, new host on the same path → node present, no Upgrade commit when unchanged); `locked store is retried` (a held LMDB lock released after the first attempt → open succeeds; held throughout → fails after `OpenAttempts`).
- [ ] **Step 2: Run** `npx tsx --test src/host/environment/tests/environment-deliveries.test.ts src/host/environment/tests/environment-engine-host.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** S2, S3, S4 (host part).
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(environment): environment deliveries and engine host`.

### Task 6: Server — deploy and promote feed the environment engine

**Files:**
- Modify: `src/host/apps/app-ingest-service.ts` (an `IDeliveryGate` replaces `IAppCacheInvalidator`: validate + persist pointer + redeliver per S4), `src/pragmatic-server.ts` (`DeployApplication`, `LoadEnvironmentGraph`, `LoadedGraph` through `EnvironmentEngineHost.Deliver` and `PromoteRecordStore`; `InvalidateApp` and the `appGraphs` cache stay until Task 10 only as far as share/assign/write still read them), `ARCHITECTURE.md`
- Test: `src/host/environment/tests/environment-delivery.test.ts`; port `host/apps/tests/app-ingest-service.test.ts` cases that assert invalidation to the gate

**Interfaces:**
- Produces: `interface IDeliveryGate { Deliver<T>(change: DeliveryChange, persist: () => Promise<T>): Promise<T> }` (implemented by `EnvironmentEngineHost`); `AppIngestService(packages, applications, gate, logger)`.

- [ ] **Step 1: Failing tests:**
  - `deploy upgrades the environment in place` (deploy app A then B → both concepts described; A's seeded data still there).
  - `redeploy without a package discards its data` (A v2 drops package p → p's engine nodes gone; §4.3).
  - `package still delivered by another app keeps its data` (A and B both deliver p; A drops p → p's nodes intact).
  - `incompatible deploy is invalid and changes nothing` (B pins `p@2.0.0` while A pins `p@1.0.0` → `status: invalid`, reason names `p` and both apps; the live pointer of B is not written; engine version unchanged).
  - `promote joins the union` (graph/load of set S → its concepts described alongside the apps; `graph/loaded` returns the record).
  - `re-promote replaces the promote set only`.
  - `concurrent deploys are serialized and both land` (two deploys started together → both apps live, the description has both).
  - `upgrade failure after deploy reports failed and retries` (`status: failed`, reason `EnvironmentUpgradeFailedReason`; next query sees the app).
- [ ] **Step 2: Run** `npx tsx --test src/host/environment/tests/environment-delivery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** S4 end to end.
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(environment): deploy and promote feed one environment engine`.

### Task 7: Server — runtime access scope (`EnvironmentScopeRules`)

**Files:**
- Create: `src/host/environment/environment-scope-rules.ts`, `src/host/environment/share-widening.ts`, `src/host/engine/engine-instance-view.ts`
- Modify: `src/pragmatic-server.ts` (`EnvironmentScopes()` memoized `AccessScopeSource(EnvironmentEngine(), identity ? ReadAuthorization() : undefined, identity configured, new EnvironmentScopeRules(...))`, disposed before the host), `ARCHITECTURE.md`
- Test: `src/host/environment/tests/environment-scope-rules.test.ts`

**Interfaces:**
- Consumes: TODL `PolicyScopeCompiler.FromRules`, `ShareGrantScope`, `SystemNames`, `ShareRight`, `ExternalIdentity.ReadOnly`, `EnvironmentNodePlacement`; `AccessPolicySetting.Load`; `TenantReadAuthorization` (`GovernedConceptsFor`, `HasSecurityModelFor`, `MembershipFor`, `EvaluatorForContext`); Task 2 `IScopeRules`.
- Produces:
  - `class EnvironmentScopeRules implements IScopeRules { constructor(host: EnvironmentEngineHost, apps: PragmaticAppsRegistry, appsStorage: IStorage, security: TenantReadAuthorization | undefined, diagnostics?: IScopeDiagnostics) }` — S5, S6; `Changed` raised on host `Changed`.
  - `class ShareWidening { static Apply(scope: AccessScope, subjects: IShareSubjects, catalog: EngineSchemaCatalog): AccessScope }` (S5 Finish a, b).
  - `class EngineInstanceView implements IInstanceView { static async Of(reader: GraphReader, publicId: string): Promise<EngineInstanceView | undefined> }` (concept, fields from `ReadNode`; used by S8/S9 evaluator calls).

- [ ] **Step 1: Failing tests** (`EnvironmentFixture`, identity on, a security model governing `crm.Account` at User level; app A owns `crm`, app B owns `notes` (ungoverned), promote set owns `ref` (ungoverned)):
  - `governed concept gets policy and depth` (A's policy `entity.region == principal.region` AND owner depth → only own rows in the region).
  - `ungoverned app-private concept is policy only` (`notes.Note` visible per B's policy, regardless of owner).
  - `ungoverned concept delivered twice is not bypassed` (A and B both deliver `shared` → depth None → invisible).
  - `promote-only ungoverned concept is denied` (no single owning app).
  - `two apps' rules on one concept both apply` (Q2: deny of either hides).
  - `malformed policy fails its own concepts closed` (A's file `{` → `crm.*` invisible and unwritable, `notes.*` unaffected, one diagnostic).
  - `binding an app does not change the scope` (Digest and visible set equal with and without `application/open`, for A and B).
  - `no security model is deny all` (every non-system concept invisible; create denied).
  - `shared record is visible through a grant` (principal grant `read` → visible; team grant via membership → visible; grant without `read` → not; grant under DenyAll → visible (parity)).
  - `grant rows are the principal's own` (`MATCH (g:\`todl.system.ShareGrant\`)` returns only grants to the caller's subjects).
  - `read-only binding refuses writes` (an external binding with `Writable: false` → CREATE Denied; the same concept bound writable in another model stays writable there).
  - `seeded node is read-only` (SET on a seeded node → Denied).
  - `policy edit stales the cursor` (edit A's file between pages → page 2 `CursorStale`).
  - `placement stamps defaults` (CREATE as a User-level principal → owner = principal id, owner = home package).
  - `no identity allows reads` (no identity → every row visible; seeded still read-only).
- [ ] **Step 2: Run** `npx tsx --test src/host/environment/tests/environment-scope-rules.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** S5, S6.
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(environment): runtime access scope (policy, depth bypass, shares, read-only)`.

### Task 8: Server — runtime `cypher/query`, `cypher/models`, `cypher/execute`, `application/open`

**Files:**
- Create: `src/host/environment/environment-cypher-execute.ts`, `src/host/engine/engine-write-failure.ts`
- Modify: `src/host/server-connection-handler.ts` (`cypherQuery: IGraphCypherQuery` and `cypherExecute` from both attach-args factories; `RunCypherQuery` / `RunCypherModels` / `RunCypherExecute` lose their purpose branches; `application/open` per S7), `src/host/engine/dev-cypher-execute.ts` (`DevWriteFailure` over `EngineWriteFailure`), `src/pragmatic-server.ts` (`EnvironmentCypher()`, `EnvironmentExecute()`; `EnvironmentGraphQuery`, `RequireEnvironmentGraph`, `appGraphProvider` query use removed), `src/host/pragmatic-server-host.ts`, `src/cluster/worker-host.ts`, `ARCHITECTURE.md`
- Delete: `src/host/paging/graph-data-digest.ts` + tests; `EnvironmentGraph`, `EnvironmentGraphOverlay`, `NoEnvironmentGraphError` in `host/graphs/environment-graph.ts` (the file goes; `IEnvironmentGraphHost`, reduced to `LoadEnvironmentGraph` / `LoadedGraph`, moves to `environment-engine-host.ts`) + `host/graphs/tests/{environment-graph,runtime-environment-graph}.test.ts`
- Test: `src/host/environment/tests/environment-cypher.test.ts`; port the runtime cases of `host/tests/cypher-surface.test.ts`, `cypher-paging*.test.ts`, `host/cypher/tests/graph-for-pragmatic-app*.test.ts` (read assertions only) to it; `src/cluster/tests/worker-host-app-serving.test.ts` runs a runtime `cypher/query` through WorkerHost

**Interfaces:**
- Produces: `class EngineWriteFailure { static Map(error: unknown): { Status: AppWriteStatus; Reason: string } | undefined }` (S10 table; undefined = not a write failure); `class EnvironmentCypherExecute implements IGraphCypherExecute { constructor(host: EnvironmentEngineHost, scopes: () => Promise<IGraphScopeSource>) ; Run(ctx, modelId: string | undefined, request: DevCypherRequest): Promise<CypherExecuteResultDto> }`; `interface IGraphCypherExecute` (dev `DevCypherExecute` implements it; dev still requires `modelId`).

- [ ] **Step 1: Failing tests:**
  - `runtime query reads engine and external data` (engine-storage rows + an external binding over an InMemory adapter in one `MATCH`).
  - `query without application/open is allowed and scoped`.
  - `runtime modelId filters to the package` (`modelId: 'crm'` → only crm-owned nodes; unknown → InvalidParams "model not found"); `cypher/models lists catalog packages` (sorted, no `todl.system`).
  - `runtime execute creates through placement` (CREATE → owner = home package, public id UUID; `revision` = latest commit).
  - `expectedRevision mismatch is Conflict`.
  - `execute into a read-only binding is Denied`.
  - `external create lands at the source` (CREATE on the external concept → adapter received the upsert; a follow-up query fetches it).
  - `open requires a live app` (unknown → InvalidParams, as today).
  - `worker host serves runtime cypher` (WorkerHost-attached connection).
- [ ] **Step 2: Run** `npx tsx --test src/host/environment/tests/environment-cypher.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** S1, S12, S13, S7.
- [ ] **Step 4: Run** the server checks; `grep -rn "GraphDataDigest\|EnvironmentGraphOverlay\|EnvironmentGraphQuery\|RuntimeModelScopeMessage" src` → no hits. Expected: PASS.
- [ ] **Step 5: Commit** `feat(environment): runtime cypher endpoints on the environment engine`.

### Task 9: Server — `data/write` on the engine

**Files:**
- Create: `src/host/environment/environment-data-writer.ts`, `src/host/environment/service-scopes.ts` (`DeleteGrantsScope` here; S8/S9 scopes join in Task 10)
- Modify: `src/host/runtime-write-payload-validator.ts` (over the engine description's definitions; reasons unchanged), `src/pragmatic-server.ts` (`WriteForPragmaticApp` → `EnvironmentDataWriter`; `RevokeSharesForDeletedRecords` removed), `ARCHITECTURE.md`
- Delete: `src/host/runtime-app-writer.ts`, `src/host/cypher/write-instance-gate.ts` (when its last importer goes) + their tests
- Test: `src/host/environment/tests/environment-data-writer.test.ts`; port every case of `host/tests/app-data-write-*.test.ts`, `runtime-app-writer.test.ts`, `runtime-write-payload-validator.test.ts` (assertions kept unless S10 changes them; each change listed in the commit message)

**Interfaces:**
- Produces: `class EnvironmentDataWriter { constructor(host: EnvironmentEngineHost, scopes: () => Promise<IGraphScopeSource>, validator: RuntimeWritePayloadValidator); Apply(ctx: AccessContext, operations: readonly AppWriteOpDto[]): Promise<AppWriteResultDto> }`; `class DeleteGrantsScope { static For(scope: AccessScope, grantIds: ReadonlySet<string>, catalog: EngineSchemaCatalog): AccessScope }`.

- [ ] **Step 1: Failing tests:** `create returns the placed id and is readable`; `update sets fields`; `delete removes the record`; `invalid op rolls back the batch` (op 2 unknown field → op 2 `invalid` "unknown field: x", ops 1 and 3 `failed` "atomic batch rolled back", nothing committed); `denied update leaves the batch uncommitted` (an update outside the scope → that op `denied`, the others rolled back); `seeded record cannot be updated` (`denied`); `connector conflict is conflict` (adapter reports `{Kind: conflict}` → `conflict`); `read-only binding is invalid or denied` (`denied` via scope S5c); `delete removes the record's grants in the same transaction` (grant node gone after commit; the commit holds both deletes); `relationship member is not writable` (`invalid`, today's reason).
- [ ] **Step 2: Run** `npx tsx --test src/host/environment/tests/environment-data-writer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** S10.
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(environment): data/write as one engine transaction`.

### Task 10: Server — shares and assign as graph data; app-graph path retired

**Files:**
- Create: `src/host/environment/environment-share-service.ts`, `src/host/environment/environment-assign-service.ts`
- Modify: `src/host/environment/service-scopes.ts` (`ShareServiceScope`, `AssignScope`), `src/pragmatic-server.ts` (share/assign methods over the new services), `src/host/server-connection-handler.ts` (`RuntimeAttachArgs` returns `{ applications, deployProvider, environmentGraphHost, cypherQuery, cypherExecute, data: IEnvironmentDataService }` where `IEnvironmentDataService { Write; Share; Unshare; ListShares; Assign }` all `(ctx, appName, params)`), both hosts, `ARCHITECTURE.md`
- Delete: `src/host/sharing/{share-service,share-store,share-grant-index,share-widening-instance-filter,share-widening-write-authorizer,share-widening-write-instance-gate,record-keyed-view,concept-id-fields,assign-service}.ts`; `src/host/cypher/{runtime-app-graph,app-connector-plan,filtered-graph-query}.ts`; `src/host/filtered-read-write-target-source.ts`; `PragmaticServer.{GraphForPragmaticApp,BaseGraphFor,BuildBaseFor,AppShareStore,ShareIndexFor,WriteInstanceGate,DepthFilterSource,WriteAuthorizerSource,AppPrivateConcepts,OwnConcepts,PushDownFor,ConnectorConcepts,ConceptIdsFor,InvalidateApp,DataRootFor}` and the `appGraphs` / `shareStores` caches; `src/host/connectors/{builtin-adapter-factory,builtin-bindings,builtin-store-engine,storage-document-session,sqlite-document-session}.ts`, `PlatformServices.CreateAppDataStore` (all three platforms), `PragmaticServerOptions.builtinStoreEngine`; their tests (`host/sharing/tests/*`, `host/cypher/tests/{runtime-app-graph,graph-for-pragmatic-app*,filtered-graph-query,server-record-sharing,server-record-assign,app-connector-plan,builtin-default-store,write-instance-gate}.test.ts`, `host/connectors/tests/*`, `filtered-read-write-target-source` tests) after porting surviving behaviour
- Test: `src/host/environment/tests/environment-sharing.test.ts`, `environment-assign.test.ts` (ports of `server-record-sharing.test.ts`, `server-record-assign.test.ts`, `host/sharing/tests/*` behaviour)

**Interfaces:**
- Produces: `class EnvironmentShareService { constructor(host, scopes, security: TenantReadAuthorization); Share(ctx, params: ShareParams): Promise<ShareResultDto>; Unshare(...); List(...) }`; `class EnvironmentAssignService { constructor(host, scopes, security); Assign(ctx, params: AssignParams): Promise<AssignResultDto> }`; `class ShareServiceScope { static For(scope, grantIds, catalog): AccessScope }`; `class AssignScope { static For(scope, concept, recordId, ownershipMembers: ReadonlySet<string>, catalog): AccessScope }`.

- [ ] **Step 1: Failing tests:** `share makes the record visible to the subject` (B cannot read r; A shares `read` with B → B's `cypher/query` returns r); `team share widens for members`; `update right widens writes` (B's `data/write` update on r → `applied`); `unshare removes visibility`; `unshare of absent grant is not-found`; `re-share updates the grant` (same id, rights replaced); `list shows the record's grants only` (two records, one listed); `share without the right is denied` (Share privilege absent and no `share` grant → `denied`); `share right via grant allows resharing`; `unknown team is invalid`; `grant writes are confined to the grant` (a crafted transaction under `ShareServiceScope` creating another grant id → `AccessError`); `user cypher cannot create grants` (`CREATE (:\`todl.system.ShareGrant\`)` → Denied); `recreated record is not widened by old grants` (share r, delete r via data/write, CREATE r with the same public id via Seed → B cannot see it); `shared external record` (grant on an external row → visible after the stub link); `assign changes the owner` (`applied`; owner field updated); `assign via share grant`; `assign cannot touch other members` (a crafted `AssignScope` transaction setting a non-ownership member → `MemberReadOnly`); `assign conflict maps to write conflict`.
- [ ] **Step 2: Run** `npx tsx --test src/host/environment/tests/environment-sharing.test.ts src/host/environment/tests/environment-assign.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** S8, S9; then delete the listed files and grep: `grep -rn "GraphForPragmaticApp\|ShareStore\|ShareGrantIndex\|ShareWidening\|RuntimeAppGraph\|AppConnectorPlan\|FilteredGraphQuery\|BuiltinBindings\|CreateAppDataStore\|SqliteDocumentSession\|StorageDocumentSession" src` → no hits.
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(environment): shares and assign as graph data; retire the app-graph path and builtin store`.

### Task 11: Server — `connector/*` on the engine (dev and runtime)

**Files:**
- Create: `src/host/engine/engine-connector-service.ts`
- Modify: `src/host/server-connection-handler.ts` (connector handlers over `IGraphConnectorService` from both attach-args; `connectorsFactory` Attach parameter removed; `solution/open` no longer invalidates a per-connection runtime), `src/pragmatic-server.ts` (`Connectors()` removed; `DevConnectors()` / `EnvironmentConnectors()`), both hosts, `ARCHITECTURE.md`
- Delete: `src/host/connector-service.ts`, `src/connectors/*` (`connector-runtime`, `connector-page-reader`, `connector-read-filter`, `connector-binding-resolver`, `solution-connector-planner`, `model-schema-types`), `src/host/{connector-hydrate-writer,connector-read-authorization,connector-instance-view,connector-writes,keyed-write-target-source,write-target-source,entity-instance-view}.ts` (each only when grep shows no other importer), `PragmaticServer.{ConnectorReadAuthorizationFor,ConnectorWriteAuthorizationFor}`, and their tests (`connectors/tests/*`, `host/tests/connector-*.test.ts`, `host/cypher/tests/connector-runtime-read.test.ts`) after porting
- Test: `src/host/engine/tests/engine-connector-service.test.ts` (dev and runtime fixtures; ports of `host/tests/connector-*.test.ts` and `tests/connector-*-e2e.test.ts` read/write assertions)

**Interfaces:**
- Produces: `interface IGraphConnectorService { List(); Prepare(modelId); Refresh(); RefreshModel(modelId); Read(ctx, params: ConnectorReadParams, limits); ReadPage(ctx, params, limits); WritePaged(ctx, params); WriteBack(ctx, params); Decisions(ctx, modelId, canonical); Test(modelId, connectorName) }` (wire DTOs as today); `class EngineConnectorService implements IGraphConnectorService { constructor(host: IGraphEngineHost, scopes: () => Promise<IGraphScopeSource>, adapters: DataSourceAdapterCatalog, services: IServiceProvider) }`.

- [ ] **Step 1: Failing tests** (run on both a dev and a runtime fixture unless noted): `read pages a binding through the scope` (hidden row absent; keyset pages concatenate); `readPage where filters at the engine` (`[{field: 'name', op: eq, value: 'Acme'}]` → one row; unknown field → InvalidParams); `read refuses where` (unchanged message); `writePaged upserts and deletes` (`applied` per op; the adapter holds the change); `writePaged outside the scope is denied` (`denied`; nothing written); `writePaged expectedVersion is invalid` (reason `ExpectedVersionUnsupported`); `writeBack deletes under the scope` (a deleted id the caller may not delete → failure, nothing removed — audit defect 2); `writeBack dirty reports nothing to flush`; `list shows the snapshot's bindings`; `decisions are empty`; `test probes the adapter`; `refresh invalidates the adapters`.
- [ ] **Step 2: Run** `npx tsx --test src/host/engine/tests/engine-connector-service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** S14; delete; `grep -rn "ConnectorRuntime\|ConnectorService\b\|ConnectorPageReader\|ConnectorHydrateWriter" src` → no hits.
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): connector endpoints on the engine; retire per-connection ConnectorRuntime`.

### Task 12: Server — runtime `model/view` and `model/resources`

**Files:**
- Create: `src/host/environment/environment-model-view.ts`
- Modify: `src/host/server-connection-handler.ts` (`ProjectModelView` / `ResourceHidden` over `IGraphModelView` from both attach-args; purpose branches removed), `src/host/model-member-builder.ts` (`FieldReadMaskGate` removed), `src/pragmatic-server.ts` (`FieldReadMaskSource` removed if unused), `ARCHITECTURE.md`
- Delete: `src/host/model-read-filter.ts`, `src/host/cypher/field-masked-graph-query.ts` (move any still-imported type first; `grep` decides), `TenantReadAuthorization.{ReadFilterFor,FieldReadMaskFor,WriteAuthorizerFor,WriteInstanceGateFor}` and the `AllowAll*Source` classes once unused, their tests (`model-read-filter.test.ts`, `field-masked-graph-query.test.ts`, `server-field-security.test.ts` runtime cases ported)
- Test: `src/host/environment/tests/environment-model-view.test.ts`

**Interfaces:**
- Produces: `interface IGraphModelView { Page(ctx, memberId: string | undefined, page: IDevModelViewPage): Promise<ModelViewPageDto>; Hidden(ctx, nodeId: string): Promise<boolean>; Resources(ctx, nodeId: string): Promise<ResolvedResourceDto[]> }` (dev `DevModelView` implements it, `Resources` = today's handler logic); `class EnvironmentModelView implements IGraphModelView`.

- [ ] **Step 1: Failing tests:** `model view lists the package's visible nodes` (a depth-hidden node absent — audit defect 3 closed at runtime); `hidden member is absent from attrs and edges`; `edge to an invisible target is dropped`; `unknown member is InvalidRequest`; `pages by keyset` (commit between pages: no repeat); `resources are empty at runtime`.
- [ ] **Step 2: Run** `npx tsx --test src/host/environment/tests/environment-model-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** S15; delete.
- [ ] **Step 4: Run** the server checks; `grep -rn "ModelReadFilter\|FieldMaskedGraphQuery\|IFieldReadMask" src` → no hits. Expected: PASS.
- [ ] **Step 5: Commit** `feat(environment): runtime model/view projected from the engine`.

### Task 13: Protocol + server — `data/changed` push

**Files:**
- Modify (pragmatic-protocol): `src/dto/wire-dtos.ts`, `src/contracts/app-data-protocol.ts`, `src/client/pragmatic-client.ts`, `src/index.ts` / `src/browser.ts` (barrel parity), `ARCHITECTURE.md`
- Create (server): `src/host/environment/data-changed-push.ts`, `src/host/engine/scope-reach.ts`
- Modify (server): `src/host/server-connection-handler.ts` (runtime connections subscribe; disposed with the connection), `src/pragmatic-server.ts` (`DataChanges()`), `ARCHITECTURE.md`
- Test: protocol `src/contracts/tests/contracts.test.ts` (method string), `src/client/tests/pragmatic-client-reconnect.test.ts` (resubscribe); server `src/host/environment/tests/data-changed-push.test.ts`, `src/host/engine/tests/scope-reach.test.ts`

**Interfaces:**
- Produces: `DataChangedPayload { commit: string; concepts: string[] }`; `AppDataProtocol.Changed`; `PragmaticClient.OnDataChanged(handler: (change: DataChangedPayload) => void): Disposable`; `class ScopeReach { static MayRead(scope: AccessScope, concept: string, catalog: EngineSchemaCatalog): boolean }`; `class DataChangedPush implements IDisposable { constructor(host: EnvironmentEngineHost, timer?: IUpgradeTimer); Subscribe(scope: () => Promise<IGraphScope>, send: (payload: DataChangedPayload) => void): IDisposable; static readonly CoalesceMs = 50 }`.

- [ ] **Step 1: Failing tests:** protocol `data/changed method string`, `OnDataChanged resubscribes after reconnect`; server `write pushes its concept` (data/write create of `crm.Account` → payload `{ commit: String(c), concepts: ['crm.Account'] }`); `unreadable concept is not pushed` (a connection whose scope denies `crm.Account` gets nothing); `delete is attributed to the root concept` (engine node delete → `['todl.Element']`); `external delete is attributed by its id`; `upgrade pushes the root`; `two commits within the window coalesce` (manual timer → one payload, latest commit, union); `disposed connection gets nothing`; `reopened engine keeps pushing` (connector-set reopen, then a write → pushed); `dev tenants get no data/changed`. `ScopeReach`: `False entry is unreachable`, `deny default without entry is unreachable`, `conditional entry is reachable`.
- [ ] **Step 2: Run** protocol `npm test`; server `npx tsx --test src/host/environment/tests/data-changed-push.test.ts src/host/engine/tests/scope-reach.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** S16 (protocol first, `npm run build` there, then the server).
- [ ] **Step 4: Run** protocol `npm test` + `npm run build`; server checks. Expected: PASS.
- [ ] **Step 5: Commit** protocol `feat(protocol): data/changed notification`; server `feat(environment): data-changed push from engine commits`.

### Task 14: Server — one Cypher, scope invariant for runtime, last retirements

**Files:**
- Modify: `src/host/cypher/cypher-param-converter.ts`, `cypher-result-mapper.ts`, `cypher-execute-result-mapper.ts`, `src/host/server-connection-handler.ts` (`RefuseInvalidReadQuery` on the engine parser), `src/host/connector-policy.ts`, every remaining `@pragmatic-tech-ai/todl` `Cypher` / `todl/graph-api` import (S19), `ARCHITECTURE.md`
- Create: `src/host/environment/tests/runtime-scope-invariant.test.ts` (shares its assertion helper with `host/engine/tests/scope-invariant.test.ts`, moved to `host/engine/tests/scope-invariant-assertions.ts`)
- Delete: whatever S19 leaves without importers; the runtime test files listed in the inventory that no longer exercise live code (`host/tests/runtime-*.test.ts`, `host/graphs/tests/*` for retired classes) after confirming their behaviour is ported

**Interfaces:**
- Consumes: Tasks 7–13.
- Produces: the runtime half of spec §12 "no endpoint returns a row or member outside its AccessScope": fixture = two apps + a promote set, an external binding, a share grant, three principals (unknown to the security model; BU reader; Org reader with a secured-field profile); per endpoint (`cypher/query` with and without `modelId`, `cypher/execute` RETURN, `connector/read`, `connector/readPage`, `model/view`, `data/shares/list`) every returned id is in `GraphReader.ScanNodes('todl.Element')` under `ScopeFor(ctx).Scope` (model-scoped: intersected with an independently built `OwnerIs` scan), and every returned member is readable under the identity `FieldSecurityEvaluator` for the node's concept; the permanent negative control (judge the Org reader by the BU reader's sets → must fail) is kept.

- [ ] **Step 1: Write** `runtime-scope-invariant.test.ts`. Expected: PASS once Tasks 7–13 are in; a failure is fixed in the owning task's code.
- [ ] **Step 2: Implement** S19; `grep -rn "Cypher\." src | grep -v "@pragmatic-tech-ai/graph"` → only engine-namespace uses; `grep -rn "from '@pragmatic-tech-ai/todl/graph-api'" src` → no hits.
- [ ] **Step 3: Run** the server checks. Expected: PASS.
- [ ] **Step 4: Commit** `refactor: server uses the engine's Cypher only; runtime scope invariant suite`.

### Task 15: TODL — delete the runtime paths the server no longer imports

**Repo:** `D:/architecture-agent/TODL` (then rebuild and re-run the server).

**Files:**
- Delete: `src/cypher/**` and the root `export * as Cypher` (`src/index.ts`); `src/graph-api/connector-runtime-graph-query.ts` + index export; `src/model-data/connector-prefetch.ts`, `connector-mirror-mapper.ts`, `conjunctive-query-filter-provider.ts` (each only when no TODL importer remains), `connector-working-copy.ts`, `federated-model-data-connector.ts`; `src/connectors/connector-runtime.ts`; `IDescribeOptions.EmitExternalBindings` (always emitted, M2.2 T14); their tests (`cypher/tests/*`, `graph-api/tests/connector-runtime-graph-query.test.ts`, `model-data/tests/{connector-prefetch,cypher-push-down-connector}.test.ts`, `authoring/tests/{cypher-reference-fields,model-draft-cypher-*}.test.ts` and `draft-cypher-harness.ts` when Cypher-only).
- Modify: `src/solution-services/todl-build-system/html-bundle/emit-remote-data-action.ts` (+ `remote-flavor.test.ts`) to emit `CypherWire` imports, `src/tests/reflection-client-exports.test.ts`, `package.json` (`0.55.0`), `ARCHITECTURE.md`, `pragmatic-graph/docs/integration/m2-runtime-inventory.md` (append "After M2.3": what was deleted, what remains — `GraphQuery`/`IGraphQuery`, `ModelDataSource`, the adapter family)
- Test: `src/tests/root-surface.test.ts` (create): the root entry exports `CypherWire` and no `Cypher`; `@pragmatic-tech-ai/todl/engine` still exports the M2.2 surface.

- [ ] **Step 1: Failing test** `root has no Cypher namespace` (`'Cypher' in root === false`, `root.CypherWire.CypherCellCodec` is a function).
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Delete**, then `grep -rn "src/cypher\|from '\.\./cypher\|ConnectorRuntimeGraphQuery\|ConnectorPrefetch\|ConnectorWorkingCopy\|FederatedModelDataConnector\|ConnectorRuntime\b\|EmitExternalBindings" src` in TODL, `src` in pragmatic-server and todl-connectors-host, and `apps plexus-core` in Plexus (excluding `*.generated.ts`) → no hits. Regenerate Plexus `framework-typings.generated.ts` with its generator only when that file has no foreign uncommitted change (M1.4 ruling F-c); otherwise report it in the finish message.
- [ ] **Step 4: Run** TODL `npm test`, `npm run typecheck`, `npm run build`; todl-connectors-host `npm test`; server checks. Expected: PASS.
- [ ] **Step 5: Commit** TODL `refactor!: retire TODL Cypher and the connector runtime paths (0.55.0)`.

### Task 16: Docs

**Files:**
- Modify: pragmatic-server `ARCHITECTURE.md` (rewrite "Cypher query path", "Named graphs", "Runtime data ops", "Connectors", "Identity / RBAC" and the "Where does X live?" table for the environment engine; rulings S1–S19 by id; declared behaviour changes: atomic `data/write`, keyset cursors no longer staled by commits, runtime `modelId`, `connector/decisions` empty, `writeBack` dirty no-op, runtime `model/resources` empty, dead on-disk data (S17), the LMDB volume requirement (Q7)); pragmatic-protocol `ARCHITECTURE.md` (`data/changed`, cursor semantics, the runtime meaning of `modelId`, `memberId`, record `id` = engine public id).
- Test: none (docs); verify links and symbol names by `grep`.

- [ ] **Step 1: Write** both docs; every class named exists (`grep -rn "class <Name>"` per name).
- [ ] **Step 2: Run** server and protocol checks once more. Expected: PASS.
- [ ] **Step 3: Commit** server `docs: environment engine architecture`; protocol `docs: data/changed and engine cursors`.

---

## Spec coverage (self-review map)

§6 write flow → S10, S13, S14 (Tasks 8–11); §7 access outside/inside → S5, S8, S9 (Tasks 2, 7, 10); §8 endpoints, cursors, push → S11–S16 (Tasks 4, 8, 11–13); §9 hosting, Dataverse, cut-over → S2–S4, S17 (Tasks 5–6); §10 retirements → Tasks 8–15; §11.1 → S3/S4 (one catalog from deploy and promote), S5 (bypass), S8 (shares as data), composer only (runtime compiles nothing); §12 invariants → Task 14 (scope suite per endpoint), Task 9 (write flow: a failure commits nothing), Task 3/8 (two queries fetch twice).
