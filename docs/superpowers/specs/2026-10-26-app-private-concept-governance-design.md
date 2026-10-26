# App-private concept governance — bound-app reads defer to app policy (design)

**Status:** approved for planning (AFK autonomous run; merge locally, never push).
**Project item:** `PVTI_lADOE0Zc984Biu4ozhDdtsU` (Kind=Feature) — "Bundled-app concept governance".
**Spun off from:** the control-plane-smoke 2b root-cause. A bundled app read zero of its own
instances because its per-app graph flows through the fail-closed org access-depth filter, which the
demo tenant security model (governing only `northwind.*`) grants nothing for `hello.greeting`.
**Governance decision (user, 2026-10-26):** an app's OWN concepts are governed by the app's
access-policy predicate ALONE; the org security-model depth filter does not apply to them. Org/shared
concepts stay fully governed. (Chosen over auto-grant-on-deploy and explicit-admin-grant.)

## Intent & why

When an app is deployed/bundled into a tenant, reading its own concepts flows through
`GraphForPragmaticApp`, whose instance filter is `Composite([app-policy predicate, org depth filter])`
(`src/pragmatic-server.ts:531-560`). The depth filter (`AccessDepthEvaluator.Allows`,
`todl-identity-engine/src/security/access-depth-evaluator.ts:132-138`) is FAIL-CLOSED: a concept the
tenant security model grants no read privilege on resolves to `EffectiveLevel == None` and is denied —
and because depth is ANDed after the predicate, no app-policy grant can override it. So a freshly
deployed app reads zero of its own data until an administrator hand-edits the tenant security model
(today only the smoke harness does this, via `WithBundledReadGrant`,
`admin/control-plane/control-plane-smoke.ts:555-566`).

The decision makes the architecture consistent with its own stated intent. The environment graph is
already read WITHOUT any depth filter ("RBAC is enforced at the policy gate, so no context is taken",
`src/pragmatic-server.ts:464-468`). An app's own concepts should likewise be governed by the app's
policy, not by an org security model that has no knowledge of them. The org depth filter continues to
govern exactly the concepts the model knows about.

## The rule (precise)

A concept is **app-private to the bound app** iff:

1. the bound app's OWN packages declare it — it appears in `nativeBase.Concepts()` (each `TypeInfo.fullName`,
   e.g. `hello.greeting`) AND its declaring model (`TypeInfo.model`) is one of the app's own
   `manifest.packages` ids. (The app's Domain loads `manifest.packages` AND their transitive
   dependencies deps-first — `Domain.load`, `domain.ts:106-120` — so `Concepts()` also returns
   prelude/base/shared-library concepts; the own-packages restriction excludes those, so an app cannot
   make a bundled library's concepts app-private merely by depending on it.) AND
2. the tenant security model has NO opinion on it — its full-name appears in NO role privilege (any
   action) and NO ownership rule of the tenant `ISecurityModelConfig`.

For an app-private concept the depth axis is satisfied unconditionally (the app-policy predicate, ANDed
alongside, remains the sole governor). For every other concept — including a concept the app declares
that the model DOES reference (a shared/org concept the model deliberately governs, readable or not) —
the depth filter behaves exactly as today. This is a per-concept-name rule, not a per-principal one, so
it cannot be used to escape org governance of a shared concept by simply lacking the role that grants it.

**Scope = concept-kind types.** `FilteredGraphQuery.Keep` keys every instance on `mirror.type.fullName`
(`src/host/cypher/filtered-graph-query.ts:65-72`), but relationship-*member* traversal (`Refs`/`Referrers`)
returns the TARGET concept's mirror — keyed by its concept type — so a concept-only bypass already covers
all concept reads and all ref traversal across the app's own graph. The only instances keyed by a
non-concept (relationship) type are REIFIED relationship instances (association classes); those are out of
scope (see non-goals). The app's own relationship *types* are therefore not added to the bypass set.

Field-level security still applies on top (the `FieldMaskedGraphQuery` wrapper is unchanged): app-private
means the depth/row axis defers to app policy, not that field masking is skipped.

## Decisions (mine, as the builder — AFK)

- **"Governed" = referenced anywhere in the model, not merely read-granted.** A concept the model names
  in any privilege (any action) or ownership rule is org-governed and keeps fail-closed depth behavior,
  even if the current principal happens to have no read grant for it. Only concepts the model never
  mentions defer to app policy. This preserves deliberate no-read restrictions and prevents shared-concept
  escalation. Source of truth: the tenant `ISecurityModelConfig` already loaded by the per-tenant
  `AccessDepthEvaluator`. Role-privilege concepts are reachable from the evaluator's `rolesById`;
  ownership-rule concepts are NOT currently exposed, so `FromConfig` captures `config.ownershipRules`
  concept names into a stored `ReadonlySet<string>` on the evaluator (the one place `config` is in hand)
  and `GovernedConcepts()` returns the union. `DenyAll()` stores the empty set.
- **App-own concept detection uses `TypeInfo.model`.** The server filters `nativeBase.Concepts()` to the
  types whose declaring model is in `new Set(manifest.packages.map(p => p.id))`. `TypeInfo.model`
  (`TODL reflection.ts`) reports the declaring manifest's model — the same axis the 2a `sameTypeAs` fix
  compares — so no new TODL API is needed.
- **The bypass is a generic primitive, not an app-aware one.** A new
  `ConceptBypassInstanceFilter` (todl-identity-engine) wraps an inner `IInstanceFilter` and a fixed
  `ReadonlySet<string>` of concept full-names: `Keep(view)` returns `true` when `view.Concept` is in the
  set, else delegates to the inner filter. It knows nothing about "apps"; the server computes the set.
  This keeps `todl-identity-engine` free of the server's app vocabulary (engine-never-calls-up) and sits
  naturally beside `CompositeInstanceFilter`/`AccessDepthInstanceFilter`.
- **The governed set comes from the read-filter source, not a new store read.** `IReadFilterSource` gains
  `GovernedConceptsFor(context): Promise<ReadonlySet<string>>`, implemented by `TenantReadAuthorization`
  off the same cached per-tenant evaluator (so it respects live `Invalidate` on security-model change) and
  by `AllowAllReadFilterSource` as the empty set (no identity means depth is allow-all anyway, so the bypass
  set is moot). A new `AccessDepthEvaluator.GovernedConcepts(): ReadonlySet<string>` gathers the names.
- **Change scoped to the bound-app path only.** Only `GraphForPragmaticApp` (`src/pragmatic-server.ts:543`)
  wraps its depth member in `ConceptBypassInstanceFilter`. `Graph`/`TenantGraphCache` (`:824`) and
  `ModelGraph` (`:844`) are dev-authoring graphs over the tenant's own repositories — not app-private —
  and are left byte-identical.
- **No access policy means app-private concepts are open to the app's authenticated principals.** An app with
  no `AccessPolicySetting` yields `FusionAccessPolicy.AllowAll`, so with the depth bypass its own concepts
  are readable by any principal that passes the coarse `readTenant` gate (field mask still applies). This
  is the intended meaning of "governed by app policy alone": the app owner opts into restriction by
  authoring a policy. Stated so a reviewer does not read it as a leak.
- **Deploy path stays governance-neutral.** `AppIngestService.Ingest` is NOT changed to write security-model
  grants (that was the rejected auto-grant option). An app becomes readable by virtue of declaring its own
  concepts, not by a privilege write.
- **Retire the smoke workaround as the integration proof.** `WithBundledReadGrant` and its `SetSecurityModel`
  call are removed from `control-plane-smoke.ts`; the bundled read must now pass purely from the new
  governance. This both proves the feature end-to-end and deletes the misleading "you must grant your own
  app" dance.

## Non-goals / anti-goals

- No change to org/shared concept governance: concepts the model references keep fail-closed depth.
- No implicit security-model writes on deploy (auto-grant was rejected).
- No change to the field-security (mask) axis, the coarse policy gate, or the environment-graph path.
- No change to the write axis (`IWriteAuthorizer`); this is a read-path decision. (If apps later need the
  same deference on writes, that is a separate item.)
- No new persistence or store read; the governed set is derived from the already-cached evaluator.
- **Reified relationship instances (association classes) are out of scope.** If a bundled app models a
  relationship AS a queryable instance (its own node, keyed by a relationship-kind type) and that type is
  not org-governed, it stays fail-closed on the bound-app path. Normal concept reads and ref traversal are
  fully covered (see "Scope = concept-kind types"); nothing in the current app set reads reified
  relationships (the removed `WithBundledReadGrant` granted a concept only and the smoke passed 38/38).
  Filed as a follow-up Feature rather than built speculatively (would need a TODL types-of-kind enumeration
  the codebase does not have today).

## Component shape (for the plan)

- `todl-identity-engine/src/security/concept-bypass-instance-filter.ts` (NEW) — `ConceptBypassInstanceFilter`
  implements `IInstanceFilter`; ctor `(inner: IInstanceFilter, bypass: ReadonlySet<string>)`; `Keep(view)`
  = `this.bypass.has(view.Concept) ? true : this.inner.Keep(view)`. Exported from the package index.
- `todl-identity-engine/src/security/access-depth-evaluator.ts` — add
  `GovernedConcepts(): ReadonlySet<string>` returning the union of every `concept` across all roles'
  privileges (from `rolesById`) and the ownership-rule concept names captured in `FromConfig` from
  `config.ownershipRules`. The `DenyAll()` evaluator returns an empty set. (No `OwnershipResolver` accessor
  needed — `FromConfig` captures the names directly, since `config` is only in hand there.)
- `pragmatic-server/src/host/cypher/read-filter-source.ts` — `IReadFilterSource` gains
  `GovernedConceptsFor(context): Promise<ReadonlySet<string>>`; `TenantReadAuthorization` implements it off
  the cached evaluator; `AllowAllReadFilterSource` returns the empty set.
- `pragmatic-server/src/pragmatic-server.ts` — `GraphForPragmaticApp`: compute
  `ownPackages = new Set(app.Manifest.packages.map(p => p.id))`,
  `appConcepts = new Set(nativeBase.Concepts().filter(t => ownPackages.has(t.model)).map(t => t.fullName))`,
  `governed = await source.GovernedConceptsFor(context)`, `bypass = appConcepts minus governed`, and wrap
  the depth member: `new ConceptBypassInstanceFilter(depth, bypass)` inside the existing
  `CompositeInstanceFilter`. The manifest is already reachable (`BaseGraphFor`/`ApplicationFor(name)`); thread
  it out of `BaseGraphFor` or re-read it. No other call site changes.
- `pragmatic-server/admin/control-plane/control-plane-smoke.ts` — remove `WithBundledReadGrant` + its
  `SetSecurityModel` grant block; the bundled read now passes from governance alone.

## Verification

- **Unit (`tsx --test`, no cluster):**
  - `ConceptBypassInstanceFilter`: a view whose `Concept` is in the bypass set is kept even when the inner
    filter denies; a view not in the set delegates (kept iff inner keeps). (todl-identity-engine)
  - `AccessDepthEvaluator.GovernedConcepts`: returns exactly the distinct concepts across role privileges +
    ownership rules; `DenyAll()` returns empty.
  - `GraphForPragmaticApp` (server): with a tenant model governing only `northwind.*` and an app declaring
    `hello.greeting`, a principal with no role reads its own `hello.greeting` instances (app-private
    deference) BUT reads no `northwind.*` it has no grant for (org governance intact); an app-declared
    concept that the model DOES govern stays fail-closed when the principal lacks the grant; an app-policy
    predicate that denies an app-private concept still denies (predicate remains sole governor); field mask
    still applies.
  - Asymmetry/scope: `Graph`/`ModelGraph` depth behavior unchanged (a concept the model denies stays denied
    on those paths).
- **Gated live smoke (`control-plane-smoke`, operator-run):** with `WithBundledReadGrant` removed, the
  bundled per-app read returns the app's own instances; OVERALL PASS (was 38/38 with the workaround).
- Full control-plane unit suite + todl-identity-engine suite green; `tsc` tools+tenant-admin+build+portal clean.
  todl-identity-engine rebuilt (`npm run build`) so pragmatic-server consumes the new `ConceptBypassInstanceFilter`
  + `GovernedConcepts` via the package symlink.

## Review focus (likely-to-bite, pin each in a task test)

1. **Shared-concept escalation:** a concept the model governs but the principal lacks the grant for must
   STAY denied on the bound-app path even if the app also declares it ("governed" = model references it,
   not per-principal level). Test with an app that declares a `northwind.*` concept.
2. **Predicate still governs:** an app-policy rule denying an app-private concept must still deny — the
   bypass only removes the depth axis, never the predicate. Test a deny policy over an app-private concept.
3. **Field mask intact:** a masked field on an app-private concept is still masked.
4. **Scope leak:** `Graph`/`ModelGraph`/environment-graph behavior must be byte-identical (no bypass leaks
   into the dev-authoring or environment paths).
5. **Live reload:** adding a privilege for a formerly app-private concept via `SetSecurityModel` must, after
   `Invalidate`, move it from the bypass set to governed on the next request (governed set is read from the
   same cached evaluator, so this follows, but pin it).
6. **Transitive-dependency leak:** a concept declared by a package the app depends on but does NOT own
   (not in `manifest.packages`) must NOT become app-private even if the org model never mentions it — the
   own-packages (`TypeInfo.model`) restriction, pinned with an app whose Domain loads a base package.
