# Security S2: engine enforcement gaps (pragmatic-graph) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the places where the engine's existing `AccessScope` enforcement falls short of spec §4.6, §5 and §6. Everything else the spec asks of the engine is already enforced; this plan pins that with tests.

**Architecture:** The engine keeps its engine-only `AccessScope`: concepts, aspects, members and predicates, with no knowledge of principals. This plan adds:
- two write-rule kinds, `Append` (edge source) and `AppendTo` (edge target);
- an `Endpoints` scope option for reified edge nodes (TODL `operator` targets: engine nodes with a From and a To relationship). Such a node is visible only when both endpoint nodes are visible, and creating, deleting, relinking or updating it is judged by its endpoints' Append/AppendTo rules (program ruling PR4);
- `SET n = {map}` that leaves members the scope makes read-only alone;
- redaction of commit errors under a read-restricting scope;
- refusal of the unscoped `EstimateCount` under such a scope;
- an opaque, engine-declared `ConnectorContext` on every reader and transaction. The engine passes it verbatim to every connector call, so a host can run each caller's connector work on that caller's connection.

A last task writes the matching amendment into the wave-2 external-writes plan.

**Tech Stack:** TypeScript 7, Node `node:test` via `tsx --test`, lmdb-js. The engine has one runtime dependency: `lmdb`.

**Spec:** `pragmatic-server/docs/superpowers/specs/2026-11-11-platform-security-architecture-design.md` (§4.6, §5, §6, §9.1–§9.3). Program index and shared contracts: `pragmatic-server/docs/superpowers/plans/2026-11-11-platform-security-program.md` (C6 in particular, and the program rulings PR1–PR18, which win over this plan; this plan carries PR3, PR4, PR8–PR12). Engine rulings: `pragmatic-graph/docs/decisions.md` (R63–R70, R80, R83, R85, R86, R92–R94, R98–R103).

**Repo and branch:** `D:/architecture-agent/pragmatic-graph`, new branch `feat/security-s2-enforcement` from `main`.
- Leave the other worktrees (`pragmatic-graph-03` on `feat/0.3-versions-fetch`, `pragmatic-graph-flaky`) alone. Leave the uncommitted doc edits on `main` alone too.
- If wave 1 (`feat/0.3-versions-fetch`) merges first, rebase onto it. Task 6 touches `FetchSession`, `FederatedReads`, `GraphTransaction` and `WriteCoordinator`, which wave 1 also changes. Wave 1's `GraphTransaction.Fetch` must pass the transaction's context through its session.

## Findings: what the spec needs vs. what the engine does

Every candidate gap from the program index, confirmed or ruled out by reading the code and the existing tests. **Real** gaps get a task.

| # | Candidate | Verdict | Evidence |
|---|---|---|---|
| 1 | A hidden member is indistinguishable from an absent one in WHERE, ORDER BY, aggregates and IS NULL | **Handled** (pinned by Task 1) | `ReadNode` omits hidden members (R80), so `CypherNode.Properties` lacks them. `PropertyAccess.Evaluate` (`src/cypher/Expression.ts:73-80`) gives Null for a missing field, exactly as for an unset one. Predicates use Kleene logic (R39). Existing test: `ReaderSource.test.ts` "hidden member reads null in RETURN" (RETURN and `=` only). ORDER BY, aggregates, IS NULL, IN, NOT, coalesce and HiddenExact on Cypher are untested. |
| 2 | `exists()`, map projections, `keys()` / `properties()` | **Not applicable** | The dialect has no `exists`, no map projection and no `properties()`. `keys()` (`FunctionRegistry.ts:177`) returns null for anything that is not a map. Any future addition must read through `NodeValue.Field` / `CypherNode.Properties`. Node cells list every visible property, with null for unset ones, and omit hidden members (R86 d). Clients therefore see "not present" for a hidden member, which reveals the schema but no value. Ruled PR11: accepted (hiddenness is per caller and field, not per record value). |
| 3 | Index choice | **Handled** | `CatalogSource.IndexFor` rejects any index with a member hidden on any type (`CatalogSource.ts:115-118`, R83 f). `GraphReader.SeekIndex` skips a node when a key member or a `Where` member is hidden (R65). Tested in `IndexSeek.test.ts`. |
| 4 | Push-down to connectors | **Handled** | `FederatedSource.UsableHint` (`FederatedSource.ts:439-449`) drops hint terms over any member hidden in the family. The engine re-checks every row (R101). External concepts carry no Hidden entries under C6 anyway. |
| 5 | Edge visible iff both endpoints visible, on every hop, in counts and variable-length paths | **Handled** (incoming count pinned by Task 1) | `GraphReader.Links` locates the source under the scope and keeps a far node only through `EngineNeighbor` → `VisibleById` (`GraphReader.ts:264-366`). `ReaderSource.Walk` serves Expand, ExpandInto and VarLengthExpand. Link fill uses `Links Out`. Tests in `ReaderSource.test.ts`: expand skips invisible targets, count excludes invisible, variable-length expand does not pass through an invisible node, optional match pads. Untested: counting incoming edges from an invisible source (§9.2 T3→P1). |
| 6 | Unique-index conflict against a hidden record carries no values or ids | **Handled for unique**, **real for neighbours** (Task 5) | `IndexStore.RequireUnique` throws `"Unique index already holds this value: " + index name`, with no value and no cause (`IndexStore.ts:203-214`). But `DuplicatePublicId` echoes the id (`BatchApplier.ts:255`, accepted in R69). `InvalidEdge` carries public ids plus an `EdgeError` cause with internal ids (`BatchApplier.ts:653`, `EdgeStore.ts:400`). A single-valued `SET a.rel = b`, where `a` already has an edge to a hidden node, fails with that message. `TransactionSink.MapCommitError` forwards `error.message`. |
| 7 | Optimistic-version conflict against a hidden record carries nothing | **Handled** | `ConflictError` messages carry only commit numbers (`ConflictHistory.ts:90`, `Committer.ts:1208,1217,1339`, `Reservations.ts`). R70 converts stale denials. External version conflicts (wave 1 V4) come from connectors, which are outside the model (§6). |
| 8 | Writes to `Writes.ReadOnly` members through every path | **Handled except `SET n = {map}`** (Task 4) | `WriteGate.CheckWrite` / `CheckReadOnly` gate every SetProperty, Link and Unlink (R92). `ReadOnlyMembers.test.ts` covers SET, REMOVE, the CREATE map, CREATE…SET, MERGE ON MATCH / ON CREATE and SET/REMOVE of a relationship. `SET n += {..}` is untested. **Gap:** `SetApplier.RemoveUnlisted` (`src/cypher/write/SetApplier.ts:46-54`) nulls every set property the map omits, read-only ones included. Under C6 the system fields are read-only on every non-assign write, so every `SET n = {..}` on an owned record fails with MemberReadOnly. |
| 9 | Edge creation and removal need append on the source and appendTo on the target (§5) | **Real** (Task 2) | R68: Link and Unlink are *Updates of their source*, with no rule on the target beyond visibility (`WriteGate.CheckOp` 319-339, `CheckWrite` 406-440). Pinned by `WriteScope.test.ts:274-276`. The scope cannot express append ≠ update, nor any appendTo. |
| 10 | Counts that reveal hidden records | **Real (small)** (Task 1) | `GraphReader.EstimateCount` (`GraphReader.ts:466-480`) is public and unscoped by design (R65 "cost if wrong"). Nothing in TODL, server or the host calls it. §2 anti-goal: no count may reveal a hidden record. |
| 11 | Per-user connector isolation (§6) | **Real** (Task 6) | No cross-transaction sharing today: one `FetchSession` per Cypher read (`CypherEngine.ReadSource`, `CypherEngine.ts:118-127`) and per transaction (`FederatedReads.Session`, R98), and one `WriteCoordinator` per commit (`GraphTransaction.ts:154`). Group commit merges engine batches only. **But** connectors are installed store-wide (`ConnectorSetup`), and `IGraphConnector.Begin()` and `IExternalConnector.Fetch(IFetchRequest)` carry nothing that says on whose behalf the call runs. A connector in caller's-identity mode cannot tell which token to use. |
| 12 | Wave-2 cross-row batching and compensation stay within one transaction's scope and principal | **Amendment** (Task 7) | `2026-11-10-external-write-versions-and-keys.md` E2/E4/E6/E10 never state the invariant. E4's pre-check names only "the gate's Create rules". E6 wraps engine rejections in `AggregateError`, which would bypass Task 5's redaction. |
| 13 | Reified edge concepts (TODL `operator` targets: an engine node with a From and a To relationship) are visible iff both endpoints are visible, on every read path, and are written only with append on From and appendTo on To (§5, PR4) | **Real** (Task 3) | Such a node is an ordinary node to the reader: `ScopeEvaluator.Decide` judges it by its own Rows/Default only (`ScopeEvaluator.ts:321-380`), so a direct `MATCH (a:Assignment)` or `count(a)` returns it while its To node is hidden. Its from/to links are Links of the edge node, so after Task 2 they would be judged by the edge node's own Append and the endpoint's AppendTo, not by Append on the From node; `WriteGate.CheckDelete` and SetProperty on it check only the edge node's Delete/Update. |

Engine error conventions found (they bind every task):
- Every deliberate error is a `GraphError` with `GraphErrorCode` (`src/errors/GraphError.ts`).
- Subclasses add their own `Code`: `AccessError` with `AccessErrorCode` (explicit numbers, always `GraphCode AccessDenied = 12`); `CommitError` with `CommitErrorCode` (implicit ordinals, category mapped by `CommitError.Category`); `EdgeError` with `EdgeErrorCode`; `ConflictError`; `ConnectorError(connector, phase, cause)` with `ConnectorPhase` (string enum).
- Enums are append-only. Messages are built from `private static readonly` constants.
- Cypher maps engine errors in `TransactionSink.MapCommitError` to `CypherWriteError` with `CypherWriteErrorCode`, keeping the engine error as cause.

## Global Constraints

- **Engine-only terms.** The engine never depends on a higher layer. It imports nothing from TODL, Mural, server, identity or connectors-host, exposes no type of theirs, and has no callback or host seam carrying their types. Upward communication is by signals only. New scope options speak of concepts, members and predicates. `ConnectorContext` is an engine-declared opaque string key that the engine never interprets.
- **OOP.** No module-level free functions and no mutable module-level state. Behaviour lives in classes; static members are allowed.
- **Allman braces** for classes, methods, constructors, accessors and control flow, with `else`/`catch`/`finally` on their own line. Object literals and block-bodied arrows stay inline. This is hand-maintained.
- **PascalCase** for interfaces and public methods.
- **No inline string literals.** Messages and reused keys are `private static readonly` PascalCase constants on their class. Structural single-use tokens may stay inline.
- **Enums over string literals.** Error enums are append-only: `AccessErrorCode` gains `AppendDenied = 7` and `AppendToDenied = 8`, and nothing else in this plan. Never renumber.
- **Tests live in `tests/` subfolders** next to the code (`src/<area>/tests/*.test.ts`). Storage-touching tests run on both MemoryStore and LMDB where the file already does (the `WriteScope.test.ts` / `ReadScope.test.ts` dual-backend `describe` loop).
- **Never run `npm install`.** Consumers use `node_modules/@pragmatic-tech-ai/*` junctions to built `dist`, and `npm install` breaks them. Run `npm run build` before a consumer needs a new symbol. LF line endings only.
- **Each task ends green:** `npm test` and `npm run typecheck` in pragmatic-graph. Single file: `npx tsx --test <file>`.
- **Rulings.** Record each new ruling in `docs/decisions.md`, numbered from the next free R number at merge time (wave 1/2 reserve R119–R128) and tagged `(security S2)`. Amend the ruling it changes in place with "Amended by …", as the file already does.
- Teardown goes through `dispose()`. Public storage APIs are async and never return live references.
- Fix every review finding, minors included. Commit only on the S2 branch. Merge locally. No push and no publish without the owner's explicit go-ahead.

## Review Focus

1. **Two users read the same External connector at the same time.** Each user's fetches must reach the connector with that user's context only, and neither result may contain the other's rows. → Task 6 test `concurrent reads keep their contexts and rows apart`.
2. **A non-admin `SET n = {..}` on an owned record.** Under C6 the system `owner` field is read-only on every non-assign write. The query must succeed and leave `owner` unchanged, not fail with MemberReadOnly. → Task 4 tests `SET n = {map} leaves read-only members untouched` and `on a created node too`.
3. **Replacing a single-valued relationship whose current edge points at a hidden node.** The commit fails; the error must not contain the hidden node's id, an internal id or the visible ends' ids. → Task 5 test `a cardinality conflict with a hidden edge carries no ids`.
4. **A host scope that still restricts links only through `Update`.** After Task 2, Link/Unlink follow `Append`. Under `Default: Allow`, an entry with only `Update` now leaves links allowed. The behaviour change must be deliberate and visible. → Task 2 test `an Update rule alone no longer governs links`, plus the consumer note in Task 8.
5. **A DETACH DELETE whose implied unlinks touch a target the writer has no AppendTo on.** R92 F-a keeps these governed by the Delete rule alone. The new rules must not make DETACH outcomes depend on visibility again. → Task 2 test `delete-implied unlinks ignore Append and AppendTo`. Ruled PR9: DETACH DELETE stays governed by the Delete rule alone.
6. **A reified edge node whose To endpoint is hidden.** It must not be returned by a direct MATCH, counted, or walked to, and it may not be created, deleted, relinked or updated without Append on its From node (and AppendTo on its To node for create, delete and relink). → Task 3 tests `a reified edge node with a hidden endpoint does not exist`, `endpoint rules govern create, delete and relink` and `an attribute update needs Append on From`.

---

### Task 1: Read-side conformance pins and scoped EstimateCount

**Files:**
- Create: `src/cypher/tests/HiddenNonexistence.test.ts`
- Modify: `src/GraphReader.ts` (`EstimateCount`, ~466-480)
- Modify: `src/access/tests/ReadScope.test.ts:223` (its "stays an unscoped upper bound" assertion is replaced)
- Modify: `docs/decisions.md` (amend R65's EstimateCount sentence)

**Interfaces:**
- Produces: `GraphReader.EstimateCount(conceptOrAspect: string): Promise<number>`. It throws `GraphError InvalidArgument` (constant `ErrEstimateScoped = 'EstimateCount needs a scope that restricts no read'`) when `!this.Scope.ReadsUnrestricted`, and is unchanged otherwise.

- [ ] **Step 1: Write the conformance tests.** The fixture has two `CypherFixture` stores with the same schema:
  - Concept `Employee { name, salary: Int, nationalId }`, with `Contractor : Employee`, and `Project { name }` and `Task { name, about -> Project }`.
  - Index `EmployeeSalary` on `Employee(salary)`.
  - Store **A** seed: `e1 {name 'a', salary 200000}`, `e2 {name 'b'}` (salary unset), `e3 {name 'c', salary 50000}`, `c1:Contractor {name 'd', salary 70000}`, `p1:Project`, `t3:Task -about-> p1`.
  - Store **B**: the same seed with no `salary` anywhere.
  - Scope `HidingSalary = Build({ Default: Allow, Hidden: Map[[Employee, {salary}]] })`.

  Test `a hidden member answers every query exactly as an absent one`: for each query below, `Rows(A, q, HidingSalary)` deepEquals `Rows(B, q, System)`.
  ```text
  MATCH (n:Employee) WHERE n.salary > 100000 RETURN n.name AS x ORDER BY x
  MATCH (n:Employee) WHERE n.salary IS NULL RETURN n.name AS x ORDER BY x
  MATCH (n:Employee) WHERE n.salary IS NOT NULL RETURN n.name AS x ORDER BY x
  MATCH (n:Employee) WHERE NOT (n.salary = 200000) RETURN n.name AS x ORDER BY x
  MATCH (n:Employee) WHERE n.salary IN [200000, 50000] RETURN n.name AS x ORDER BY x
  MATCH (n:Employee) WHERE n.salary = 200000 RETURN n.name AS x
  MATCH (n:Employee {salary: 200000}) RETURN n.name AS x
  MATCH (n:Employee) RETURN n.name AS x ORDER BY n.salary DESC, x
  MATCH (n:Employee) RETURN count(n.salary) AS c, sum(n.salary) AS s, min(n.salary) AS lo, max(n.salary) AS hi, avg(n.salary) AS a, collect(n.salary) AS l
  MATCH (n:Employee) RETURN coalesce(n.salary, -1) AS v, n.name AS x ORDER BY x
  MATCH (n:Employee) WITH n.salary AS s RETURN s, count(*) AS c
  ```
  Test `HiddenExact hides on the exact concept only`: under `HiddenExact: Map[[Contractor, {salary}]]`, `MATCH (n:Employee) WHERE n.salary > 60000 RETURN n.name AS x ORDER BY x` returns `['a']` (Contractor `d`'s 70000 is absent), and the same query under System returns `['a', 'd']`.

  Test `an incoming edge from an invisible source is neither walked nor counted` (§9.2), under `Rows: Map[[Task, False]]`:
  - `MATCH (p:Project)<-[r]-(t) RETURN count(r) AS c` gives `[0n]`;
  - `MATCH (p:Project)-[r]-(t) RETURN count(t) AS c` gives `[0n]`;
  - `MATCH (p:Project)<-[:about*1..2]-(x) RETURN x` gives `[]`.

  Under `Rows: Map[[Project, False]]`, `MATCH (t:Task) RETURN t` returns t3 with `links` = `{}`, and `MATCH (t:Task)-[:about]->(p) RETURN p` gives `[]`.

- [ ] **Step 2: Run the tests.** `npx tsx --test src/cypher/tests/HiddenNonexistence.test.ts`. Expected: PASS. These pins prove findings 1 and 5. If any assertion fails, it is a real gap: fix it in the reader or the operator the query uses, then record a ruling.

- [ ] **Step 3: Write the failing EstimateCount test.** In `ReadScope.test.ts`, replace line 223's assertion with `await assert.rejects(r.EstimateCount(ScopeFx.Ticket), e => e instanceof GraphError && e.GraphCode === GraphErrorCode.InvalidArgument)`. Add `it('EstimateCount answers under a read-unrestricted scope', …)`, which checks that a Writes-only scope (Default Allow, no Rows, no Hidden) still returns the slot count.

- [ ] **Step 4: Run to fail.** `npx tsx --test src/access/tests/ReadScope.test.ts`. Expected: FAIL (it resolves 1).

- [ ] **Step 5: Implement** the guard in `GraphReader.EstimateCount`. Update its doc comment: it is advisory and available only to scopes that restrict no read.

- [ ] **Step 6: Run** `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 7: Commit.** First amend R65's EstimateCount clause in `docs/decisions.md` ("Amended (security S2): refuses under a read-restricting scope, spec §2 anti-goal"), then:
  `git add src/cypher/tests/HiddenNonexistence.test.ts src/GraphReader.ts src/access/tests/ReadScope.test.ts docs/decisions.md && git commit -m "feat(access): pin hidden-member nonexistence; EstimateCount refuses under read-restricting scopes"`

### Task 2: Append and AppendTo write rules

**Files:**
- Modify: `src/access/AccessScope.ts` (`IWriteRules`)
- Modify: `src/access/AccessError.ts` (append codes)
- Modify: `src/access/WriteGate.ts`: `RuleKind`, `Rule`, `CheckOp` (Link/Unlink case), `CheckWrite`, the `updates` cache, and the class doc
- Modify: `src/access/ScopeValidator.ts:82` (validate the new predicates)
- Test: `src/access/tests/WriteScope.test.ts`: existing lines 274-276 and 409-411, plus new `it`s inside the dual-backend loop
- Modify: `docs/decisions.md` (new ruling; amend R68 and R92 F-a)

**Interfaces:**
- Produces, on `IWriteRules`:
  - `readonly Append?: Predicate`: checked on the **source** of a Link or Unlink that exists in the snapshot, on pre-batch values, *instead of* `Update`;
  - `readonly AppendTo?: Predicate`: checked on the **target** of a Link or Unlink that exists in the snapshot, on pre-batch values.

  Both may use graph predicates, as Update can. Hosts compile them from their own privileges: S3 rule 3 sets `Writes[K].Append = G(K, Depth(K, append))` and `Writes[K].AppendTo = G(K, Depth(K, appendTo))`, and pragmatic-server's `access-scope-conjunction.ts` conjoins both (program ruling PR3). Applicability follows the other kinds: entries keyed by the concept, an ancestor or a carried aspect, all of which must hold, with `Default` deciding when none defines the kind.
- Produces: `AccessErrorCode.AppendDenied = 7` and `AccessErrorCode.AppendToDenied = 8`.
- Unchanged:
  - SetProperty stays governed by `Update`.
  - `Hidden` and `ReadOnly` still apply to the relationship member on the source.
  - A node the batch created is exempt from Append and AppendTo, as from Update.
  - A delete-implied unlink (`WriteExemptions.Detaches`, R92 F-a) is exempt from Append and AppendTo (program ruling PR9: DETACH DELETE stays governed by the Delete rule alone).
  - Link and Unlink targets and siblings must still be visible (InvisibleNode first).

- [ ] **Step 1: Rewrite the existing assertions and add failing tests.**
  - Lines 274-276 become `it('an Update rule alone no longer governs links', …)`. Under `Writes [[Ticket, { Update: status = open }]]` (Default Allow), `Link('closed', About, 'p')` and `Unlink('linked', About, 'p')` are **allowed**, and SetProperty on 'closed' is still UpdateDenied.
  - Lines 409-411: the seed-team scope becomes `{ Update: readOnlySeed, Append: readOnlySeed, Delete: readOnlySeed }`, and the Link denial expects `AccessErrorCode.AppendDenied`.

  New tests:
  - `it('Link and Unlink are governed by the source Append rule')`: `Writes [[Ticket, { Append: status = open }]]`; `Link('closed', About, 'p')` is AppendDenied, naming `'closed'` and `Ticket`; `Unlink('linked', …)` (where linked has status closed) is AppendDenied; `Link('open', …)` is allowed.
  - `it('Link and Unlink need the target AppendTo rule')`: `Writes [[Person, { AppendTo: name = 'ok' }]]`; `Link('t', About, 'p')` (p.name ≠ 'ok') is AppendToDenied, and the message names op 0 and `'t'`; a target named 'ok' is allowed; Unlink of an existing edge to the denied target is AppendToDenied.
  - `it('a node the batch created is exempt from Append and AppendTo')`: under `Default: Deny` with Rows True and `{ Create: True }` on both concepts, CreateNode both ends and Link them; the write is allowed.
  - `it('delete-implied unlinks ignore Append and AppendTo')`: with `Append: False` on Ticket, `AppendTo: False` on Person and `Delete: True`, `t.DetachUnlink('linked', About, 'p'); t.DeleteNode('p')` is allowed. The same Unlink without the delete is AppendDenied.
  - `it('Append and AppendTo predicates are validated at Begin')`: `{ Append: Compare('nosuch', Eq, 'x') }` makes `Begin` reject with GraphError InvalidArgument naming `Ticket.nosuch`; the same for AppendTo.
  - `it('Append and AppendTo decisions are reads (stale permission conflicts)')`: mirror the existing "the gate reads are recorded" test with an AppendTo rule on the target's `name`, changed by a concurrent commit; the result is ConflictError.

- [ ] **Step 2: Run to fail.** `npx tsx --test src/access/tests/WriteScope.test.ts`. Expected: FAIL on the new codes and rules.

- [ ] **Step 3: Implement.**
  - `RuleKind` gains `Append = 4` and `AppendTo = 5`, and `WriteGate.Rule` maps them.
  - `CheckWrite(index, op, publicId, member, created, placed, detach, kind: RuleKind)`: SetProperty passes `Update`, Link/Unlink pass `Append`. The denial code is `UpdateDenied` for Update and `AppendDenied` for Append. Reason constants: `ErrAppend = 'an Append rule does not hold on the source'` and `ErrAppendTo = 'an AppendTo rule does not hold on the target: '`.
  - The per-node decision cache becomes per kind: `private readonly decided = new Map<RuleKind, Map<string, boolean>>()`.
  - New `private async CheckAppendTo(index: number, op: WriteOp, from: string, concept: string, to: string, created: CreatedNode | undefined, detach: boolean): Promise<void>`. It runs after `CheckReferenced` for the target and returns at once when `created !== undefined || detach`. Otherwise it takes `VisibleNode(to)` (already known visible), evaluates `Allows(node, RuleKind.AppendTo)` (cached), and throws `Denied(AppendToDenied, index, op, from, concept, ErrAppendTo + to)`. External nodes use `HoldsFetched`, as `Allows` already does.
  - `ScopeValidator`: the predicate loop covers `[rules.Create, rules.Update, rules.Delete, rules.Append, rules.AppendTo]`.
  - `AccessScope.Build` copies the new fields with the spread it already uses; nothing else changes. `WritesUnrestricted` needs no change.
  - Update the `IWriteRules` and `WriteGate` doc comments.

- [ ] **Step 4: Run** `npx tsx --test src/access/tests/WriteScope.test.ts`, then `npm test && npm run typecheck`. Expected: PASS. If `ReadOnlyMembers.test.ts` or a connector test relied on Update governing links, change its scope to state `Append` explicitly. Never weaken an assertion.

- [ ] **Step 5: Commit.** Record the new ruling (Append/AppendTo semantics, exemptions, why Update no longer governs links: spec §5 "append on the source and appendTo on the target") and amend R68 ("SetProperty and Link/Unlink as the edge's SOURCE are Updates" → Link/Unlink are Appends) and R92 F-a. Then:
  `git add src/access docs/decisions.md && git commit -m "feat(access): Append and AppendTo write rules govern links (spec §5)"`

### Task 3: `Endpoints`: reified edge nodes follow their endpoints

Program ruling PR4. A TODL `operator ==> : L (from, to)` reifies an edge as an engine node of concept `L` with two single-valued relationships, `from` and `to`. Spec §5 says an edge is visible iff both endpoints are visible and carries no privileges of its own. S3 gives edge concepts no Rows or Writes entries and lists them here instead.

**Files:**
- Modify: `src/access/AccessScope.ts` (`IEndpointMembers`, `IAccessScopeOptions.Endpoints`, `AccessScope.Endpoints`; `Build` copies it; `ReadsUnrestricted` also needs `Endpoints.size === 0`)
- Modify: `src/access/ScopeEvaluator.ts` (`Decide`: the endpoint conjunct after the Rows loop; new `EndpointsOf(concept)`, cached like `writes`)
- Modify: `src/access/WriteGate.ts` (`CheckOp` Link/Unlink case, `CheckDelete`, the SetProperty case, class doc)
- Modify: `src/access/ScopeValidator.ts` (validate Endpoints entries)
- Modify: `src/index.ts` (export `IEndpointMembers`)
- Test: `src/access/tests/EndpointScope.test.ts` (inside the dual-backend `describe` loop), `src/cypher/tests/EndpointVisibility.test.ts`
- Modify: `docs/decisions.md` (new ruling)

**Interfaces:**
- Consumes: Task 2 `IWriteRules.Append` / `AppendTo`, `AccessErrorCode.AppendDenied` / `AppendToDenied`, `RuleKind.Append` / `AppendTo`, the per-kind decision cache, `WriteGate.Allows`.
- Produces:
  ```ts
  /** The two relationship members of a reified edge concept (spec §5, PR4). */
  export interface IEndpointMembers { readonly From: string; readonly To: string }
  // IAccessScopeOptions
  readonly Endpoints?: ReadonlyMap<string, IEndpointMembers>;   // edge concept → its endpoint members
  // AccessScope
  public readonly Endpoints: ReadonlyMap<string, IEndpointMembers>;
  ```
  - Applicability: an entry applies to nodes of its concept and of its subconcepts (as Rows). Two applicable entries must name the same members (ScopeValidator).
  - Reads: in `ScopeEvaluator.Decide`, a node with an applicable entry is visible iff its own Rows/Default decision is True **and** the node at `From` and the node at `To` are each visible. The neighbour is judged by `Decide` under the same `Evaluation`, so the cycle guard, memo and budget apply (Kleene And). An unset endpoint member hides nothing. Every read path goes through `Decide` (`Visible`, `VisibleById`, `GraphReader.Links`, `SeekIndex`, `ReaderSource.Walk`), so direct MATCH, index seeks, counts, expands and variable-length paths all agree. `EstimateCount` refuses under such a scope (Task 1), because `ReadsUnrestricted` is false.
  - Writes, for a node `e` with an applicable entry. All decisions use pre-batch values. An endpoint node the batch created is exempt, and a delete-implied unlink stays exempt (PR9).
    - `Link`/`Unlink` of `e`'s `From` member: the `Append` rule must hold on the target (the From node), *instead of* Task 2's target AppendTo; the denial is `AppendDenied`. `Link`/`Unlink` of `e`'s `To` member: the `AppendTo` rule must hold on the target (the To node); the denial is `AppendToDenied`. This also applies when the batch created `e`, so creating an edge node is judged by its endpoints. `e`'s own Append rule is still checked as the source, as in Task 2.
    - `DeleteNode(e)`: besides `e`'s Delete rule, `Append` must hold on the node at `From` and `AppendTo` on the node at `To` (the edge is being removed).
    - `SetProperty` on an `e` the batch did not create: besides `e`'s Update rule, `Append` must hold on the node at `From`; the denial is `AppendDenied`.
  - No new `AccessErrorCode`. Reasons are `private static readonly` constants `ErrEndpointAppend = "an Append rule does not hold on the edge's From node: "` and `ErrEndpointAppendTo = "an AppendTo rule does not hold on the edge's To node: "`.
  - `ScopeValidator`: the concept exists; `From` and `To` are distinct, single-valued Relationship members of it; the concept is not bound to an External connector. Otherwise it throws GraphError InvalidArgument naming `<concept>.<member>`.

- [ ] **Step 1: Write the failing tests.** The fixture runs on both backends:
  - Concepts `Project { name }`, `Person { name }` and the edge concept `Assignment { role, from: { Kind: Relationship, Targets: [Person], Many: false }, to: { Kind: Relationship, Targets: [Project], Many: false } }`.
  - Seed: `alice:Person`, `p-shown:Project`, `p-hidden:Project`, `a1:Assignment` (alice → p-shown) and `a2:Assignment` (alice → p-hidden).
  - Scope `Edges = Build({ Default: Allow, Rows: [[Project, IdIn{p-shown}]], Endpoints: [[Assignment, { From: 'from', To: 'to' }]] })`.

  `EndpointScope.test.ts`:
  - `it('a reified edge node with a hidden endpoint does not exist')`: under Edges, `Visible('a2')` is false and `Visible('a1')` is true. `ReadsUnrestricted` is false, and `EstimateCount(Assignment)` rejects with InvalidArgument.
  - `it('endpoint rules govern create, delete and relink')`, under Edges plus `Writes [[Person, { Append: name = 'ok' }], [Project, { AppendTo: name = 'ok' }]]`:
    - `CreateNode('a3', Assignment); Link('a3', from, 'alice'); Link('a3', to, 'p-shown')` is AppendDenied on op 1 while alice's name is not 'ok'. With alice renamed 'ok' it is AppendToDenied on op 2, and with both named 'ok' it is allowed.
    - `DeleteNode('a1')` is AppendDenied until alice is 'ok', then AppendToDenied until p-shown is 'ok'.
    - Relinking `a1.to` from p-shown to another visible project needs AppendTo on both the old target (the Unlink) and the new one (the Link).
  - `it('an attribute update needs Append on From')`: `SetProperty('a1', role, 'lead')` is AppendDenied while alice fails the Append rule, and allowed once it holds. The To node's AppendTo is not consulted.
  - `it('a created endpoint is exempt')`: CreateNode of a Person and of an Assignment from it to p-shown passes the From check without an Append rule holding on the new Person.
  - `it('deleting an endpoint detaches its edge nodes under the Delete rule alone')`: with `Append: False` on Person and `Delete: True`, `t.DetachUnlink('a1', from, 'alice'); t.DeleteNode('alice')` is allowed (PR9).
  - `it('Endpoints entries are validated at Begin')`: an unknown member, `From === To`, a Many relationship, and a conflicting pair on a subconcept each make `Begin` reject with GraphError InvalidArgument.

  `EndpointVisibility.test.ts` (Cypher): for each query, the rows under Edges deepEqual the rows of a store seeded without `a2`, read under System.
  ```text
  MATCH (a:Assignment) RETURN a.role AS r ORDER BY r
  MATCH (a:Assignment) RETURN count(a) AS c
  MATCH (p:Person {name: 'alice'})<-[:from]-(a) RETURN count(a) AS c
  MATCH (a:Assignment)-[:to]->(p) RETURN p.name AS n
  ```

- [ ] **Step 2: Run to fail.** `npx tsx --test src/access/tests/EndpointScope.test.ts src/cypher/tests/EndpointVisibility.test.ts`. Expected: FAIL (no `Endpoints` option).

- [ ] **Step 3: Implement** as specified. `ScopeEvaluator.EndpointsOf(concept): IEndpointMembers | undefined` resolves the applicable entry once per concept. In `WriteGate`, the endpoint checks reuse `Allows(node, RuleKind.Append | RuleKind.AppendTo)` through Task 2's per-kind cache. Each decision is therefore a recorded read, and a concurrent change to an endpoint's rule inputs is a stale-permission ConflictError, as in Task 2.

- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** First record the ruling (Endpoints semantics, read-path coverage, write rules per op, exemptions; PR4), then:
  `git add src/access src/cypher/tests/EndpointVisibility.test.ts src/index.ts docs/decisions.md && git commit -m "feat(access): Endpoints scope option for reified edge nodes (spec §5, PR4)"`

### Task 4: `SET n = {map}` leaves read-only members alone

**Files:**
- Modify: `src/GraphTransaction.ts` (new public method)
- Modify: `src/index.ts` (export `WriteStage` from `./access/WriteStage.js`)
- Modify: `src/cypher/write/CypherSink.ts`, `TransactionSink.ts`, `ExplainSink.ts`, `SetApplier.ts:46-54`
- Test: `src/access/tests/ReadOnlyMembers.test.ts`
- Modify: `docs/decisions.md` (amend R85 i: replace semantics)

**Interfaces:**
- Produces: `GraphTransaction.ReadOnlyMembers(concept: string, stage: WriteStage): ReadonlySet<string>`. It returns what the write gate's evaluator returns (`ScopeEvaluator.ReadOnlyMembers` through `WriteEvaluator()`: ReadOnly for the stage plus ReadOnlyExact). The set is empty when `Scope.WritesUnrestricted`. This is scope metadata, so nothing is read or recorded (as `HiddenMembers`, R85 j).
- Produces: `ICypherSink.ReadOnlyMembers(publicId: string, concept: string): ReadonlySet<string>`.
  - `TransactionSink` answers with stage `Create` when `overlay.IsCreated(publicId)`, else `Update`.
  - `ExplainSink` returns an empty set.
- Behaviour: `SetApplier.RemoveUnlisted` skips every member in `sink.ReadOnlyMembers(id, node.Concept)`. A read-only member that the map *names* is still assigned, and the gate still refuses it.

- [ ] **Step 1: Write the failing tests** in `ReadOnlyMembers.test.ts`, using the file's `RoFx.Scope()` (owner read-only) and `OwnerPlacement`.
  - `test('SET n = {map} leaves read-only members untouched')`: `MATCH (k:Ticket {title: 'x'}) SET k = {title: 'y'}` succeeds; reading under System gives `owner` = `RoFx.U1` and `title` = `'y'`.
  - `test('SET n = {map} on a created node keeps its placed read-only default')`: `CREATE (n:Ticket {title: 'a'}) SET n = {title: 'b'} RETURN n.owner AS o` under a scope with owner in `ReadOnly.Create` and the placement default set; `o` is the placed owner.
  - `test('SET n = {map} naming a read-only member is refused')`: `RoFx.DeniedQuery(fx, "MATCH (k:Ticket {title: 'x'}) SET k = {title: 'y', owner: 'u2'}", RoFx.Owner)`.
  - `test('SET n += {map} with a read-only member is refused')`: `RoFx.DeniedQuery(fx, "MATCH (k:Ticket {title: 'x'}) SET k += {owner: 'u2'}", RoFx.Owner)`.
  - `test('SET n = {map} still nulls writable unlisted members')`: a Ticket with a writable nullable member set; after `SET k = {title: 'y'}` that member reads null.

- [ ] **Step 2: Run to fail.** `npx tsx --test src/access/tests/ReadOnlyMembers.test.ts`. Expected: the first two FAIL with CypherWriteError Denied (MemberReadOnly).

- [ ] **Step 3: Implement** the three members above and the skip in `RemoveUnlisted`. Update the `SetApplier` doc: "every property … that is set, not in the map and not read-only under the scope".

- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** First amend R85 (i) in `docs/decisions.md`, then:
  `git add src/GraphTransaction.ts src/index.ts src/cypher/write src/access/tests/ReadOnlyMembers.test.ts docs/decisions.md && git commit -m "fix(cypher): SET n = {map} leaves scope read-only members untouched"`

### Task 5: Commit errors reveal nothing under a read-restricting scope

**Files:**
- Create: `src/txn/CommitErrorRedactor.ts`
- Modify: `src/GraphTransaction.ts` (`Commit`: catch before `finally`)
- Test: `src/cypher/tests/ScopedCommitErrors.test.ts`
- Modify: `docs/decisions.md` (new ruling; amend R69's DuplicatePublicId sentence)

**Interfaces:**
- Produces: `export class CommitErrorRedactor { public static Redact(error: CommitError): CommitError }` (internal, not exported from the index). By code:
  - `DuplicatePublicId`: `new CommitError(code, 'Public id already exists')`, with no cause.
  - `NodeHasEdges`: `'Node still has relationships'`, with no cause.
  - `InvalidEdge`: `'Edge rejected: ' + text`, where the text comes from the cause's `EdgeErrorCode`:
    - `CardinalityExceeded` gives `'the relationship allows one outgoing edge per node'`;
    - `DuplicateEdge` gives `'the edge already exists'`;
    - any other code, or no `EdgeError` cause, gives `'the edge breaks a graph rule'`.

    The cause is replaced by `new EdgeError(sameCode, sameText)`, so a consumer that switches on `cause.Code` still works.
  - Every other code, `UniqueViolation` included, is returned as is. Its message names the index only and it has no cause; the test pins that.

  All texts are `private static readonly` constants.
- Behaviour: `GraphTransaction.Commit` rethrows `CommitErrorRedactor.Redact(error)` when `error instanceof CommitError && !this.Scope.ReadsUnrestricted`. That covers the Submit path and the write-through Prepare path, which throws unwrapped (`WriteCoordinator.Prepared`). System and read-unrestricted scopes keep the detailed messages.

- [ ] **Step 1: Write the failing tests.** Fixture:
  - `Project { code (unique index ProjectCode), name }` and `Person { name, manager: { Kind: Relationship, Targets: [Person], Many: false } }`;
  - seed: projects `proj-shown {code 'A'}` and `proj-hidden {code 'B'}`; persons `person-a`, `person-b` and `person-hidden`; and `person-a -manager-> person-hidden`;
  - scope `Hiding = Rows [[Project, IdIn{proj-shown}], [Person, IdIn{person-a, person-b}]]`.

  Tests:
  - `test('a unique conflict with a hidden record names neither value nor id')`: through the transaction API, under Hiding, `CreateNode('proj-new', Project); SetProperty('proj-new', code, 'B')`. The commit rejects with CommitError UniqueViolation; the message contains neither `'B'` nor `'proj-hidden'`, and `cause` is undefined.
  - `test('a duplicate public id of a hidden record carries no id')`: `CreateNode('proj-hidden', Project)` under Hiding gives code DuplicatePublicId and the message `'Public id already exists'`.
  - `test('a cardinality conflict with a hidden edge carries no ids')`: with names `'a'`/`'b'` seeded on person-a/person-b, Cypher `MATCH (x:Person {name: 'a'}), (y:Person {name: 'b'}) SET x.manager = y` under Hiding. It rejects with CypherWriteError Invalid. The message is exactly `'the write was rejected by the graph: Edge rejected: the relationship allows one outgoing edge per node'`. `cause` is CommitError InvalidEdge, and `cause.cause` is EdgeError CardinalityExceeded with the same text. No message in the chain contains `'person-'` or matches `/\d/`.
  - `test('System keeps detailed commit errors')`: under System the DuplicatePublicId message contains `'proj-hidden'`.

- [ ] **Step 2: Run to fail.** `npx tsx --test src/cypher/tests/ScopedCommitErrors.test.ts`. Expected: FAIL (the messages carry ids).

- [ ] **Step 3: Implement** `CommitErrorRedactor` and the catch in `Commit`.

- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** Record the ruling: redaction set; integrity over secrecy leaks one bit (§5); accepted one-bit cases are unique, duplicate id, single-valued cardinality and strict-delete NodeHasEdges (program ruling PR10: a conflict error under a restricted scope says only that something conflicts). Amend R69. Then:
  `git add src/txn/CommitErrorRedactor.ts src/GraphTransaction.ts src/cypher/tests/ScopedCommitErrors.test.ts docs/decisions.md && git commit -m "feat(txn): redact commit errors under read-restricting scopes (spec §5)"`

### Task 6: ConnectorContext: each caller's connector work on its own context

Program ruling PR12 (index C8): the context is optional at the engine and defaults to `Anonymous`. Consumers: S1 Task 11 (TODL `DataSourceConnector` forwards it to every data-source call) and S4 Task 12 (the server passes one on every reader, transaction and Cypher call). Both wait on this task.

**Files:**
- Create: `src/connectors/ConnectorContext.ts`
- Modify: `src/connectors/FetchContract.ts` (`IFetchRequest`), `src/connectors/GraphConnector.ts` (`Begin`), `src/connectors/FetchSession.ts` (constructor, `Request` ~163), `src/connectors/WriteCoordinator.ts` (constructor ~391, `Drive` ~603)
- Modify: `src/GraphReader.ts` (constructor, getter), `src/GraphTransaction.ts` (constructor, WriteCoordinator construction ~154), `src/GraphStore.ts:187-205`, `src/GraphEngine.ts:192-209`, `src/FederatedReads.ts:89`, `src/cypher/CypherEngine.ts` (`ICypherRunOptions`, `ReadSource` ~126, the BeginRead/Begin calls)
- Modify: `src/index.ts` (export `ConnectorContext` and `IBeginOptions`)
- Modify tests: `src/connectors/tests/FetchSession.test.ts:117`, `src/cypher/tests/FederatedRead.test.ts:269` (new constructor argument), `src/connectors/tests/FakeConnector.ts` and `FakeExternalConnector.ts` (record the contexts they get)
- Test: `src/connectors/tests/ConnectorContext.test.ts`
- Modify: `docs/decisions.md` (new ruling; amend R98)

**Interfaces:**
- Produces:
  ```ts
  /** On whose behalf a reader's or transaction's connector calls run (spec §6). Opaque: the engine compares and forwards it, never interprets it. */
  export class ConnectorContext
  {
      /** No caller identity: connectors with dedicated credentials accept it; caller's-identity connectors should refuse it. */
      public static readonly Anonymous: ConnectorContext;   // Key ''
      public readonly Key: string;
      /** GraphError InvalidArgument for a non-string or empty key. */
      public static For(key: string): ConnectorContext;
      public get IsAnonymous(): boolean;
  }
  export interface IBeginOptions { readonly Connector?: ConnectorContext }   // in GraphStore.ts; absent = Anonymous
  ```
  The class is frozen and has no other state.
- Signature changes:
  - `GraphStore.BeginRead(scope: AccessScope, options?: IBeginOptions)` and `Begin(scope, options?)`; `GraphEngine` mirrors both.
  - `GraphReader.Connector: ConnectorContext` (getter; a GraphTransaction inherits it).
  - `ICypherRunOptions.Connector?: ConnectorContext`, which `Execute` passes to the reader or transaction it opens.
  - `FetchSession` constructor: `(connectors, bindings, catalog, context: ConnectorContext)`, a required fourth argument.
  - `IFetchRequest.Context: ConnectorContext`, set by `FetchSession.Request` on every request, including Keys, Reverse and Resume continuations.
  - `IGraphConnector.Begin(context: ConnectorContext): Promise<IConnectorTransaction>`. This is source-compatible for implementers that declare no parameter.
  - `WriteCoordinator(setup, lateFailures, applied, context: ConnectorContext)`, whose `Drive` calls `connector.Begin(this.context)`.
- Invariants (doc comments plus ruling):
  - A FetchSession, a connector transaction and a WriteCoordinator each belong to exactly one reader or transaction, and therefore to one context.
  - The engine never caches, pools, batches or compensates connector work across readers or transactions.
  - Group commit merges engine batches only.

- [ ] **Step 1: Write the failing tests** in `ConnectorContext.test.ts`. Use `CypherFixture.Open` with an External `FakeExternalConnector` bound to `Ticket` and a Mirrored `FakeConnector` bound to `Note`, following `FederatedRead.test.ts`'s `FedFx`.
  - `test('For refuses an empty key; Anonymous has the empty key')`.
  - `test('concurrent reads keep their contexts and rows apart')`: the fake's `Override` returns row `ta` when `request.Context.Key === 'alice'` and `tb` otherwise. `Promise.all` of `Execute(System, 'MATCH (t:Ticket) RETURN t', { Connector: For('alice') })` and the same with bob gives alice `['ta']` and bob `['tb']`. Every logged request carries one of the two contexts, and the alice-query requests are only ever alice's.
  - `test('a transaction fetches and begins connectors with its context')`: `Execute(System, "MATCH (t:Ticket) SET t.title = 'x'", { Connector: For('carol') })` → every fetch has Key `'carol'`. A Cypher write creating a `Note` under `For('carol')` makes `FakeConnector` record a `Begin` with Key `'carol'`.
  - `test('without a context every call carries Anonymous')`: a plain `BeginRead(System)` and `Execute` without `Connector` → `Context === ConnectorContext.Anonymous` on every request and Begin.
  - `test('a transaction API commit begins connectors with the transaction context')`: `engine.Begin(System, { Connector: For('dave') })`, then CreateNode of a Note and Commit → Begin got `'dave'`.

- [ ] **Step 2: Run to fail.** `npx tsx --test src/connectors/tests/ConnectorContext.test.ts`. Expected: FAIL (no `ConnectorContext`).

- [ ] **Step 3: Implement.** Thread the context through every point listed above. `FederatedReads.Session` builds its FetchSession with `reader.Connector`, and `CypherEngine.ReadSource` with `reader.Connector`. Update the doc comments on `IGraphConnector`, `IExternalConnector.Fetch` and `FetchSession` with the invariants.

- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** First record the ruling (and amend R98: "one session per read or transaction, carrying its ConnectorContext"), then:
  `git add src docs/decisions.md && git commit -m "feat(connectors): ConnectorContext per reader and transaction, passed to Fetch and Begin (spec §6)"`

### Task 7: Amend the wave-2 external-writes plan

**Files:**
- Modify: `D:/architecture-agent/pragmatic-graph/docs/superpowers/plans/2026-11-10-external-write-versions-and-keys.md`. The file may carry other agents' uncommitted edits: stage only this file's hunks (`git add -p`).

- [ ] **Step 1: Apply the in-place edits** below (anchor on the quoted text; line numbers drift).
  - E2: after "A connector is `Begin`-ed at its first step and kept for the transaction's life." append " It is begun with the transaction's `ConnectorContext` (`Begin(context)`, security S2, ruling E11)."
  - E4, step 2: replace "Check every request: R29, and the gate's Create rules, judged hypothetically as for any create." with "Check every request: R29; the gate's Create rules, judged hypothetically as for any create; the scope's Hidden and ReadOnly.Create members over its Properties and Links (placement defaults exempt); and the AppendTo rule of every link target that exists in the snapshot (security S2)."
  - E6, "What the caller sees": replace "An engine rejection (ConflictError, CommitError, AccessError) is rethrown as-is" with "An engine rejection (ConflictError, CommitError, AccessError) is rethrown as the transaction surfaces it: a CommitError under a read-restricting scope is first redacted by `CommitErrorRedactor` (security S2), and the redacted error is also what goes into the AggregateError below".

- [ ] **Step 2: Insert the new ruling** directly after the E10 block (before `## Global Constraints`):
  ```markdown
  - **E11 One caller per transaction (security S2; platform security spec §6).** Connector work is never pooled, cached, batched or compensated across callers. The engine's unit of caller is the GraphTransaction and its `ConnectorContext`:
    - Every connector call a GraphTransaction makes runs on the `IConnectorTransaction` begun with that transaction's context. That covers `Fetch`, `Begin`, `Apply`, `Create`, `Undo`, `Commit`, `Revert`, and the compensation of an abort, a failed commit or a dropped transaction (`GraphStore.dispose()`'s Drop included). Fetches carry `IFetchRequest.Context`.
    - Write steps, batched clauses (E10), `CreateAssigned` groups, the step log, the version ledger (E5) and the fetch memo belong to one GraphTransaction. Nothing merges, reorders, replays or reuses them across two transactions, even when their contexts or scopes are equal. E10's cross-row batching is across the rows of one statement in one transaction only.
    - A version one transaction learned never guards another transaction's write.
    - Drop and store shutdown compensate each transaction separately, each on its own connector transactions and in its own reverse step order.
  ```

- [ ] **Step 3: Add the matching lines.**
  - In its `## Global Constraints`: "- **One caller per transaction (E11).** No connector state, step, batch or compensation crosses GraphTransactions; every connector call carries the transaction's `ConnectorContext`."
  - Append to its `## Review Focus`: "N. **Wave 2: two callers' batched writes stay apart.** → Task 2.4b test `concurrent batched creates keep their contexts`. Two transactions with contexts alice and bob each run a batched external CREATE at the same time. The fake connector sees two `Begin` calls with distinct contexts, each step carries only its own transaction's rows, and failing bob's step compensates only bob's (alice commits)." Number it after the last existing item.
  - Add that test name to Task 2.4b's test step, and `drop compensates each transaction on its own connector transactions` to Task 2.2's.

- [ ] **Step 4: Verify.** `git diff --stat docs/superpowers/plans/2026-11-10-external-write-versions-and-keys.md` shows only this file. Re-read E2, E4, E6, E10 and E11 together for consistency.

- [ ] **Step 5: Commit.**
  `git add -p docs/superpowers/plans/2026-11-10-external-write-versions-and-keys.md && git commit -m "docs(plan): wave-2 external writes stay within one transaction's caller (security S2)"`

### Task 8: Release gate

**Files:**
- Modify: `package.json` (`version`: next minor after whatever `main` holds at merge, e.g. `0.2.0` → `0.3.0`, or after wave 1's `0.3.0` → `0.4.0`, coordinated with the wave plans)
- Modify: `README.md` if it documents `IGraphConnector.Begin`, `IWriteRules`, `IAccessScopeOptions` or `EstimateCount`

- [ ] **Step 1: Write the consumer notes** into the release commit message and the new rulings:
  - Link/Unlink now follow `Append` and target `AppendTo`, not `Update`. A scope that relied on `Update` must add `Append` (pragmatic-server `src/host/engine/access-scope-conjunction.ts` enumerates IWriteRules' predicate members and must add both: PR3, S4 Task 9).
  - `AccessScope.Endpoints` (Task 3, PR4) exists. A scope with an entry is not read-unrestricted. A host that conjoins scopes must carry both scopes' entries (S4 Task 9), and S3 compiles every TODL edge concept into it.
  - `EstimateCount` refuses under read-restricting scopes.
  - `IGraphConnector.Begin(context)` and `IFetchRequest.Context` exist. TODL `DataSourceConnector` forwards them to every data-source call (S1 Task 11, PR12), and the server supplies one for every caller (S4 Task 12).
  - `FetchSession` needs a context.
- [ ] **Step 2: Run** `npm run typecheck && npm test && npm run build`. Expected: PASS, with `dist/` rebuilt so junctioned consumers see the new symbols.
- [ ] **Step 3: Commit** `git add package.json README.md && git commit -m "chore: release security S2 engine enforcement"`. Merge `feat/security-s2-enforcement` into `main` locally. Do not push or publish without the owner's go-ahead.

---

## Spec questions, ruled (program rulings in the index; they win over this plan)

1. **Update without read on a secured field.** Ruled PR8: the engine keeps refusing any write to a hidden member (HiddenMember, checked before ReadOnly; R68 and R92). S1 rejects a profile entry with update or create but no read at compile time (`security.write-without-read`), and C6 compiles "no read" to Hidden.
2. **DETACH DELETE and append/appendTo.** Ruled PR9: delete-implied unlinks, from hidden sources too, are governed by the deleted node's Delete rule only (R92 F-a). Deleting a reified edge node itself is not a cascade and follows Task 3 (PR4).
3. **One-bit leaks beyond uniqueness.** Ruled PR10: accepted, consistent with §5 uniqueness. Conflict errors under a restricted scope say only that something conflicts (Task 5). These still reveal that *some* hidden edge exists:
   - a strict (non-DETACH) DELETE of a node with an edge from a hidden record (R85 h);
   - a single-valued relationship replace against a hidden edge.
4. **Node cells omit hidden members but show unset ones as null.** Ruled PR11: node results omit hidden fields and show unset fields as null. Hiddenness is per caller and field, not per record value, so this reveals the schema, never a value or a filter result.
5. **ConnectorContext is optional and defaults to `Anonymous`.** Ruled PR12: optional at the engine. A caller's-identity connector must refuse Anonymous. S4 always passes a context: the caller for user-started work, the system principal for background work.
