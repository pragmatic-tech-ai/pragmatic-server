# App-private concept governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bound app's own concepts become readable through its per-app graph governed by the app's access-policy predicate alone, while every concept the tenant security model references stays fail-closed as today.

**Architecture:** A generic `ConceptBypassInstanceFilter` (todl-identity-engine) wraps the org access-depth filter with a fixed set of concept full-names that unconditionally pass; the inner filter governs the rest. `GraphForPragmaticApp` computes that set as the app's OWN-package concepts (`TypeInfo.model` in `manifest.packages`) minus the concepts the tenant model references (`AccessDepthEvaluator.GovernedConcepts()` via a new `IReadFilterSource.GovernedConceptsFor`), and wraps only its depth member inside the existing `CompositeInstanceFilter`. No other graph path changes.

**Tech Stack:** TypeScript (NodeNext ESM), `tsx --test`. Two repos: `todl-identity-engine` (built to `dist`, consumed by `pragmatic-server` via the `@pragmatic-tech-ai/todl-identity-engine` symlink) and `pragmatic-server`.

**Spec:** `docs/superpowers/specs/2026-10-26-app-private-concept-governance-design.md`

## Global Constraints

- OOP: methods/statics on classes; no module-level free functions or mutable state.
- Allman braces; no inline string literals (hoist to `private static readonly` PascalCase). PascalCase interfaces + public methods.
- Tests live in `tests/` subfolders. NEVER `npm install` at repo root (breaks workspace symlinks).
- LF-only line endings. Co-author trailer on commits.
- **Cross-repo build order:** after any `todl-identity-engine/src` change, run its `npm run build` so `pragmatic-server` sees the new `dist` through the symlink before its own tests run.
- **No worktree:** work on a feature branch in each repo in place (the symlink dependency breaks under a detached worktree); branch both off their current tip.
- Scope is the READ path and the bound-app graph only. The Docker/Graph/ModelGraph/environment-graph paths stay byte-identical. No deploy-path (`AppIngestService`) change.

## Review Focus

1. **Shared-concept escalation** — a concept the model governs but the principal lacks the grant for must STAY denied on the bound-app path even if the app also declares it. (Task 3 test: app declares a model-governed concept; principal with no role reads none of it.)
2. **Predicate still governs** — an app-policy rule denying an app-private concept must still deny; the bypass removes only the depth axis. (Task 3 test: deny-policy over an app-private concept yields no instances.)
3. **Transitive-dependency leak** — a concept from a package the app depends on but does not own (not in `manifest.packages`) must NOT become app-private even when the model never mentions it. (Task 3 test: app whose Domain loads a base package; the base concept stays denied.)
4. **Field mask intact** — a masked field on an app-private concept is still masked. (Task 3 test.)
5. **Scope leak** — `Graph`/`ModelGraph`/environment-graph behavior byte-identical; the bypass never leaves `GraphForPragmaticApp`. (Task 3 test: a model-denied concept stays denied on `ModelGraph`.)

---

## Task 1: ConceptBypassInstanceFilter + AccessDepthEvaluator.GovernedConcepts (todl-identity-engine)

**Files:**
- Create: `todl-identity-engine/src/security/concept-bypass-instance-filter.ts`
- Modify: `todl-identity-engine/src/security/access-depth-evaluator.ts` (add `GovernedConcepts()`; capture ownership-rule concepts in `FromConfig`/`DenyAll`), `todl-identity-engine/src/index.ts` (export the new filter)
- Test: `todl-identity-engine/src/security/tests/concept-bypass-instance-filter.test.ts`, `todl-identity-engine/src/security/tests/access-depth-governed-concepts.test.ts`

**Interfaces:**
- Consumes: `IInstanceFilter`, `IInstanceView` (`@pragmatic-tech-ai/todl`); `ISecurityModelConfig` (`@pragmatic-tech-ai/todl-identity`).
- Produces:
  - `class ConceptBypassInstanceFilter implements IInstanceFilter` — ctor `(inner: IInstanceFilter, bypass: ReadonlySet<string>)`; `Keep(view: IInstanceView): boolean`.
  - `AccessDepthEvaluator.GovernedConcepts(): ReadonlySet<string>`.

- [ ] **Step 1: Write failing tests.**
  - `concept-bypass-instance-filter.test.ts`: (a) a view whose `Concept` is in the bypass set returns `true` even when the inner filter's `Keep` returns `false`; (b) a view whose `Concept` is NOT in the set returns the inner filter's result (both `true` and `false` cases); (c) an empty bypass set is a pass-through to the inner filter. Use a stub `IInstanceFilter` recording calls and a minimal `IInstanceView` (`{ Concept }`).
  - `access-depth-governed-concepts.test.ts`: (a) `FromConfig` with roles whose privileges name concepts across actions returns every distinct concept from `GovernedConcepts()`; (b) a concept named only in `ownershipRules` (no privilege) is included; (c) a concept named nowhere is absent; (d) `DenyAll().GovernedConcepts()` is empty.
- [ ] **Step 2: Run tests — expect fail** (`cd todl-identity-engine && npx tsx --test src/security/tests/concept-bypass-instance-filter.test.ts src/security/tests/access-depth-governed-concepts.test.ts`).
- [ ] **Step 3: Implement.** `ConceptBypassInstanceFilter.Keep` = `this.bypass.has(view.Concept) ? true : this.inner.Keep(view)`. In `access-depth-evaluator.ts`, `FromConfig` collects concept names from every `role.privileges[].concept` and every `config.ownershipRules[].concept` into a stored `ReadonlySet<string>` passed to the constructor (extend the private ctor with one field); `DenyAll` passes an empty set; `GovernedConcepts()` returns it. Hoist any new literals to `private static readonly`.
- [ ] **Step 4: Run tests — expect pass.** Then `npm run build` in `todl-identity-engine`.
- [ ] **Step 5: Commit** (branch `feat/app-private-concept-governance` in todl-identity-engine).

## Task 2: IReadFilterSource.GovernedConceptsFor (pragmatic-server)

**Files:**
- Modify: `pragmatic-server/src/host/cypher/read-filter-source.ts` (`IReadFilterSource` gains `GovernedConceptsFor`; `TenantReadAuthorization` and `AllowAllReadFilterSource` implement it)
- Test: `pragmatic-server/src/host/cypher/tests/read-filter-source.test.ts` (extend existing if present, else create under `tests/`)

**Interfaces:**
- Consumes: `AccessDepthEvaluator.GovernedConcepts()` (Task 1); the per-tenant cached evaluator already built by `TenantReadAuthorization.EvaluatorFor`.
- Produces: `IReadFilterSource.GovernedConceptsFor(context: AccessContext): Promise<ReadonlySet<string>>` — `TenantReadAuthorization` returns `(await this.EvaluatorFor(context.Tenant.Id)).GovernedConcepts()`; `AllowAllReadFilterSource` returns an empty set.

- [ ] **Step 1: Write failing tests.** In `read-filter-source.test.ts`: (a) `TenantReadAuthorization.GovernedConceptsFor(context)` over a store whose model governs `northwind.Order` returns a set containing `northwind.Order`; (b) the same instance reuses the cached evaluator (no second store read — assert the fake store's read count stays 1 across `ReadFilterFor` + `GovernedConceptsFor`); (c) after `Invalidate`, `GovernedConceptsFor` reflects an updated model; (d) `AllowAllReadFilterSource.GovernedConceptsFor` returns an empty set.
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** `GovernedConceptsFor` on the interface and both sources, reading from the cached evaluator so no extra store read occurs.
- [ ] **Step 4: Run tests — expect pass.**
- [ ] **Step 5: Commit** (branch `feat/app-private-concept-governance` in pragmatic-server, off master).

## Task 3: GraphForPragmaticApp bypass wiring + smoke-workaround removal (pragmatic-server)

**Files:**
- Modify: `pragmatic-server/src/pragmatic-server.ts` (`GraphForPragmaticApp`: compute own-package app concepts, subtract governed, wrap the depth member), `pragmatic-server/admin/control-plane/control-plane-smoke.ts` (remove `WithBundledReadGrant` + its `SetSecurityModel` grant block and the now-unused imports/constants)
- Test: `pragmatic-server/src/host/tests/graph-for-pragmatic-app-depth.test.ts` (extend the existing bound-app depth harness; create under `tests/` if absent), `pragmatic-server/src/host/tests/graph-scope-unchanged.test.ts` (or extend an existing ModelGraph test) for the scope-leak assertion

**Interfaces:**
- Consumes: `ConceptBypassInstanceFilter` (Task 1), `IReadFilterSource.GovernedConceptsFor` (Task 2), `nativeBase.Concepts()` returning `TypeInfo[]` (`.fullName`, `.model`), `app.Manifest.packages` (`{ id, version }[]`).
- Produces: a `GraphForPragmaticApp` whose depth member is `new ConceptBypassInstanceFilter(depth, bypass)`, `bypass = { app own-package concept full-names } \ { governed }`.

- [ ] **Step 1: Write failing tests** covering the Review Focus, against a tenant model governing only `northwind.*` and a bound app declaring `hello.greeting` (own package) plus — for the leak test — a base-package concept:
  - app-private read: a principal with no role reads its own `hello.greeting` instances. (RF: core behavior)
  - org governance intact: the same principal reads none of a `northwind.*` concept it has no grant for.
  - shared-concept escalation (RF 1): an app that ALSO declares a model-governed concept does not read it without the grant.
  - predicate still governs (RF 2): an app-policy rule denying `hello.greeting` yields zero instances despite the bypass.
  - transitive-dependency leak (RF 3): a concept from a package the app depends on but does not list in `manifest.packages` stays denied.
  - field mask intact (RF 4): a masked field on `hello.greeting` is still absent.
  - scope leak (RF 5): on `ModelGraph`/`Graph`, a model-denied concept stays denied (no bypass).
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** the wiring in `GraphForPragmaticApp` per the spec's Component shape (`ownPackages` from the manifest, `appConcepts` filtered by `TypeInfo.model`, `bypass = appConcepts \ governed`, wrap the depth member only). Thread the manifest out of `BaseGraphFor` or re-read via `ApplicationFor(name)`. Then remove `WithBundledReadGrant` and its grant block + dead imports/constants from `control-plane-smoke.ts`.
- [ ] **Step 4: Run tests — expect pass.** Then run the full control-plane + host unit suites and `tsc` (tools, tenant-admin, build, portal); confirm green. (The live `control-plane-smoke` is operator-run on docker-desktop and proves the end-to-end bundled read without the workaround.)
- [ ] **Step 5: Commit.**

---

## Self-Review

- **Spec coverage:** filter + `GovernedConcepts` (Task 1), `GovernedConceptsFor` source (Task 2), `GraphForPragmaticApp` wiring + smoke removal (Task 3). The reified-relationship non-goal is filed, not built. Covered.
- **Step scan:** each step writes one thing; test steps carry concrete assertions with spec values (`northwind.*`, `hello.greeting`).
- **Type consistency:** `ConceptBypassInstanceFilter(inner, bypass: ReadonlySet<string>)`, `GovernedConcepts(): ReadonlySet<string>`, `GovernedConceptsFor(context): Promise<ReadonlySet<string>>`, `TypeInfo.model`/`.fullName`, `manifest.packages[].id` — consistent across tasks.
- **Review Focus:** all five pinned to Task 3 tests; escalation/leak are the security-critical ones.
- **Proportion:** plan carries decisions + assertions, not code bodies; shorter than the spec.
