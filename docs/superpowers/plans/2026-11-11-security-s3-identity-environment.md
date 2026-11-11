# S3 — Identity and Environment Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the identity layer the source of tier-1 organisation facts. That covers the reshaped environment security setting (C5), IdP group sync with teams = synced ∪ manual, disabled identities losing all access, the per-environment system principal (C7), local-IdP groups, per-user source tokens, and a `Tier1ScopeCompiler` that turns all of it plus S1's package security into one pragmatic-graph `AccessScope` (C6).

**Architecture:** `todl-identity` owns the contracts: vocabulary (C1, C4), the C5 setting and its validator, the directory snapshot and its sync, team membership rows, local groups, source tokens, and the system principal. `todl-identity-local` and `todl-identity-cloud` implement the directory source and the source-token provider for the local IdP and for Entra. `todl-identity-node` persists everything with validation. `todl-identity-engine` drops its tier-2 policy code. It rebases `BusinessUnitHierarchy`/`MembershipResolver`/`AccessDepthEvaluator`/`FieldSecurityEvaluator` onto package security plus the setting, and compiles them to an engine `AccessScope` using fixed system fields only (`owner`, `owningBusinessUnit`). It never reads an app-declared field.

**Tech Stack:** TypeScript 5.7 (ESM, NodeNext), node:test via `tsx --test`, `@pragmatic-tech-ai/graph` ^0.2.0 (AccessScope, Predicate), `@pragmatic-tech-ai/todl` (S1's `IPackageSecurity`/`IEnvironmentSecurity`, `IEnvironmentCatalog`, `ShareGrantScope`), `jose` ^6 (cloud only, already installed), `node:crypto`.

**Spec:** `pragmatic-server/docs/superpowers/specs/2026-11-11-platform-security-architecture-design.md`. The contracts are in `pragmatic-server/docs/superpowers/plans/2026-11-11-platform-security-program.md` (C1–C7; the index wins over this plan, the spec wins over the index). The index's program rulings PR1–PR18 win over this plan; S3 carries PR1–PR7, PR16–PR18.

## Global Constraints

- OOP only: every function is a method (instance or `static`) of a class. No module-level functions and no module-level mutable state; module-level `const` is allowed only for true compile-time constants and for `ServiceKey` declarations.
- Allman braces everywhere (class, method, control flow; `else`/`catch`/`finally` on their own line). Object literals, arrow bodies and true one-line `if (x) return;` stay inline. Keep each repo's existing semicolon style (`todl-identity-node` has no semicolons; the others do).
- PascalCase for every interface name and every public method/member. Plain JSON-mirroring data fields (the C5 setting shapes) keep camelCase.
- No inline string literals: user-facing text, keys, file names, claim names, URLs and parameter names are `private static readonly PascalCase` constants on their class.
- Enums over string literals for any fixed set of values (string enums when the value is persisted or crosses a wire).
- Tests live in a `tests/` subfolder next to the code (`src/<area>/tests/<name>.test.ts`), run by node:test through `tsx --test`.
- NEVER run `npm install` / `npm ci` (it breaks the workspace symlinks). A new sibling dependency is added to `package.json` and linked by hand with a directory junction (Task 9).
- Layering: `todl-runtime` → `todl` → identity packages. No identity package imports `pragmatic-server`, `pragmatic-protocol`, tenant-admin, Mural or Plexus. `todl-identity` imports nothing above `todl-runtime`. Only `todl-identity-engine` may import `@pragmatic-tech-ai/todl` and `@pragmatic-tech-ai/graph`.
- Siblings are consumed as built `dist`. After changing a package, run `npm run build` in it before testing dependents. Rebuild order: `todl-identity` → `todl-identity-host` → `todl-identity-local` → `todl-identity-node` / `todl-identity-cloud` → `todl-identity-engine`.
- GitHub tokens and all secrets (client secrets, upstream/source tokens, signing keys) are never echoed, logged, put in an `AuditEvent`, or written into test output.
- Research mode, no shims: retired types and members are deleted, not deprecated, and call sites are updated. The one exception is Task 7's one-time `SecurityModelMigration` on open (program ruling PR18): environments with old-shape settings exist in the field, and the migration rewrites them once; it is not a runtime shim. Branch is `feat/security-s3` in each identity repo (default branch `master`). Commit locally; never push.
- **Merge order (program ruling PR17):** the identity repos merge to `master` only when this whole plan is green, and together with S4 Task 9, which consumes the new surface. `pragmatic-server` stops compiling against these dists until then (see "Downstream breakage").
- `TODL` and `pragmatic-graph` are read-only for this plan: other agents have work in flight there.
- Prerequisite for Tasks 9–11: S1's tasks delivering `IPackageSecurity` / `IEnvironmentSecurity` (C2, with `EdgeConcepts` per PR4: S1 Tasks 7–8) and the `todl.system.Owned` aspect (C3) are merged in TODL, and TODL's `dist` is rebuilt. Task 11 also needs S2 Tasks 2–3 (Append/AppendTo, `Endpoints`) in pragmatic-graph's `dist`.

## Review Focus

1. **An identity disabled or deleted in the IdP that still has a manual team row and a direct role assignment.** It must get no access at all, including external concepts (scope `Default: Deny`), and the sync must revoke its sessions. Test: Task 11 `inactive principal compiles to a deny-all scope`, Task 4 `sync revokes sessions of newly deprovisioned identities`.
2. **A pack with no directory API (generic OIDC, Google).** Its snapshot is non-authoritative. Synced team membership falls back to the live token's groups. Absence from the snapshot must never be read as "deleted". Ruled PR7: with no directory to ask, a user disabled in such an IdP keeps access until their session expires; this is accepted and documented (Task 8). Test: Task 3 `non-authoritative snapshot takes synced rows from token groups and treats unknown users as active`.
3. **Stale or hostile environment overrides.** These are overrides that name a role, profile, concept or field no longer deployed, or that set a non-Org depth on an organisation-owned concept. They are ignored with a diagnostic. They never widen access, and they can still lower a default to None. Test: Task 10 `overrides lower defaults and stale overrides are dropped with diagnostics`.
4. **A subconcept, from another package, of an owned concept that has a secured field.** The secured field stays hidden on the subconcept's instances (`Hidden`, not `HiddenExact`), and each concept's depth rule judges only its own instances (`ConceptIs` guard). Test: Task 11 `secured field stays hidden on a subconcept and depth rules do not leak across concepts`.
5. **Two users asking for a source token for the same resource at the same time.** Each gets a token minted for their own identity. A missing or expired upstream session fails with `SourceTokenError`. It never falls back to app credentials or to another user's cached token. Test: Task 5 `cache never serves one principal's token to another`, Task 8 `missing upstream session rejects and never falls back`.

---

## File map

| Repo | Create | Modify | Delete |
|---|---|---|---|
| todl-identity | `src/security/base-role.ts`, `src/security/business-unit-hierarchy.ts` (moved), `src/security/security-model-validator.ts`, `src/core/system-principal.ts`, `src/directory/idp-directory-snapshot.ts`, `src/directory/idp-directory-source.ts`, `src/directory/idp-directory-store.ts`, `src/directory/idp-directory-sync.ts`, `src/directory/team-membership-rows.ts`, `src/authn/local-group-store.ts`, `src/authn/source-token-provider.ts`, `src/authn/per-user-source-token-cache.ts` | `src/security/security-model-config.ts`, `src/core/identity-enums.ts`, `src/provider/audit-sink.ts`, `src/provider/identity-store-set.ts`, `src/index.ts`, `src/testing/fakes.ts` | `src/security/tests/field-security-config.test.ts`, `src/security/tests/roles-config.test.ts` |
| todl-identity-host | `src/directory/in-memory-idp-directory-store.ts` | `src/index.ts` | — |
| todl-identity-local | `src/directory/local-directory-source.ts`, `src/tokens/local-source-token-provider.ts` | `src/accounts/local-account-store.ts`, `src/pack/local-identity-provider-pack.ts`, `src/index.ts` | — |
| todl-identity-node | `src/config/security-model-migration.ts`, `src/directory/file-idp-directory-store.ts` | `src/config/file-tenant-config-store.ts`, `src/accounts/file-account-store.ts`, `src/pack/file-identity-stores.ts`, `src/pack/server-identity-pack.ts`, `src/index.ts` | `src/config/tests/file-tenant-config-store.roles.test.ts` |
| todl-identity-cloud | `src/http/http-status-error.ts`, `src/directory/microsoft-graph-directory-source.ts`, `src/obo/upstream-token-vault.ts`, `src/obo/on-behalf-of-token-provider.ts` | `src/http/http-client.ts`, `src/http/fetch-http-client.ts`, `src/claims/claims-mapper.ts`, `src/pack/oidc-provider-profile.ts`, `src/pack/oidc-setting-keys.ts`, `src/pack/oidc-identity-provider-pack-base.ts`, `src/packs/microsoft-entra-profile.ts`, `src/packs/microsoft-entra-pack.ts`, `src/oidc/oidc-authenticator.ts`, `src/index.ts` | — |
| todl-identity-engine | `src/security/security-vocabulary.ts`, `src/security/effective-role-table.ts`, `src/security/tier1-diagnostic.ts`, `src/scope/tier1-catalog.ts`, `src/scope/tier1-scope-compiler.ts`, `src/scope/tier1-grants.ts` | `package.json`, `src/security/{tenant-security-model,membership-resolver,access-depth-evaluator,field-security-evaluator}.ts`, `src/index.ts`, `src/tests/dependency-resolution.test.ts`, `README.md` | `src/policy/**`, `src/authz/**`, `src/adapters/**`, `src/enforcement/**`, `src/security/{ownership-resolver,access-depth-instance-filter,allow-all-instance-filter,composite-instance-filter,concept-bypass-instance-filter,business-unit-hierarchy}.ts` and their tests |

**Downstream breakage (S4 owns the fix).** The following `pragmatic-server` files import symbols this plan deletes or reshapes: `src/host/{admin-service,connector-read-authorization,model-read-filter,server-connection-handler}.ts`, `src/host/cypher/{read-filter-source,write-instance-gate}.ts`, `src/host/engine/{depth-scope-compiler,dev-access-scope-source}.ts`, `src/host/sharing/{assign-service,share-grant-index,share-service}.ts`, `src/pragmatic-server.ts`, plus about 51 files under `src/` and `admin/` that read the retired C5 sections. `src/host/engine/depth-scope-compiler.ts` is superseded by `Tier1ScopeCompiler` and is deleted by S4.

---

### Task 1: Vocabulary, base roles, system principal (C1, C4, C7)

**Files:**
- Modify: `todl-identity/src/security/security-model-config.ts` (`PrivilegeAction`), `todl-identity/src/core/identity-enums.ts` (`PrincipalKind`), `todl-identity/src/index.ts`
- Create: `todl-identity/src/security/base-role.ts`, `todl-identity/src/core/system-principal.ts`
- Test: `todl-identity/src/security/tests/vocabulary.test.ts`, `todl-identity/src/core/tests/system-principal.test.ts`

**Interfaces:**
- Produces: `PrivilegeAction.Invoke = "invoke"` (appended after `Share`); `enum BaseRole { SystemAdministrator = "SystemAdministrator", BasicUser = "BasicUser", Reader = "Reader" }`; `PrincipalKind.System` (appended after `Machine`; numeric enum, append-only); `class SystemPrincipal { static IdFor(environmentId: string): string; static For(environmentId: string): Principal; static Is(principal: Principal): boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
test("PrivilegeAction carries invoke and keeps every existing token", () =>
{
    assert.deepEqual(Object.values(PrivilegeAction), ["create", "read", "update", "delete", "append", "appendTo", "assign", "share", "invoke"]);
});
test("BaseRole values equal their names", () =>
{
    assert.deepEqual(Object.entries(BaseRole).map(([k, v]) => k === v), [true, true, true]);
    assert.deepEqual(Object.values(BaseRole), ["SystemAdministrator", "BasicUser", "Reader"]);
});
test("system principal is per environment, System kind, no groups", () =>
{
    const p = SystemPrincipal.For("env-1");
    assert.equal(p.Id, "system:env-1");
    assert.equal(p.TenantId, "env-1");
    assert.equal(p.Kind, PrincipalKind.System);
    assert.deepEqual(p.Groups, []);
    assert.equal(SystemPrincipal.Is(p), true);
    assert.equal(SystemPrincipal.Is(new Principal("system:env-1", "env-1", PrincipalKind.User, new Map(), [])), false);
});
test("SystemPrincipal.For rejects an empty environment id", () =>
{
    assert.throws(() => SystemPrincipal.For(""));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd D:/architecture-agent/todl-identity && npx tsx --conditions=development --test src/security/tests/vocabulary.test.ts src/core/tests/system-principal.test.ts`
Expected: FAIL (`BaseRole` / `SystemPrincipal` not exported, `invoke` missing).

- [ ] **Step 3: Implement.** `SystemPrincipal.Is` requires both `Kind === PrincipalKind.System` and the `system:` prefix (`private static readonly Prefix = "system:"`). Export `BaseRole` and `SystemPrincipal` from `src/index.ts`.

- [ ] **Step 4: Run to verify pass.** Same command; expected PASS. Then `npm test` and `npm run typecheck` in `todl-identity`: all green.

- [ ] **Step 5: Commit** — `git add -A src && git commit -m "feat(identity): invoke privilege, BaseRole, per-environment system principal"`

---

### Task 2: Reshape `ISecurityModelConfig` (C5) and validate it

**Files:**
- Modify: `todl-identity/src/security/security-model-config.ts` (rewrite), `todl-identity/src/index.ts`
- Create: `todl-identity/src/security/business-unit-hierarchy.ts` (moved verbatim from `todl-identity-engine/src/security/business-unit-hierarchy.ts`, with its test moved to `todl-identity/src/security/tests/business-unit-hierarchy.test.ts`), `todl-identity/src/security/security-model-validator.ts`
- Delete: `src/security/tests/field-security-config.test.ts`, `src/security/tests/roles-config.test.ts`; rewrite `src/security/tests/security-model-config.test.ts`
- Test: `todl-identity/src/security/tests/security-model-validator.test.ts`

**Interfaces:**
- Produces (data shapes, camelCase fields per C5):
  - `IBusinessUnitConfig` (unchanged: `id`, `name`, `parent?`)
  - `IUserPlacementConfig { principalId: string; businessUnitId: string }`
  - `ITeamConfig { id: string; name: string; businessUnitId: string; idpGroups: readonly string[]; manualMembers: readonly string[] }`
  - `IRoleAssignmentConfig { role: string; principalIds: readonly string[]; teamIds: readonly string[] }`
  - `IProfileAssignmentConfig { profile: string; principalIds: readonly string[]; teamIds: readonly string[] }`
  - `IRoleOverrideConfig { role: string; concept: string; action: PrivilegeAction; level: AccessLevel }`
  - `IProfileOverrideConfig { profile: string; concept: string; field: string; read: boolean; update: boolean; create: boolean }`
  - `ISecurityModelConfig { businessUnits; users; teams; roleAssignments; profileAssignments; roleOverrides; profileOverrides }` (all `readonly` arrays of the above)
  - `BusinessUnitHierarchy`, `MalformedBusinessUnitTreeError` (now exported from `todl-identity`)
  - `enum SecurityModelIssueCode` (string values): `MalformedBusinessUnitTree = "malformedBusinessUnitTree"`, `UnknownSection = "unknownSection"`, `EmptyId = "emptyId"`, `DuplicateUser = "duplicateUser"`, `DuplicateTeam = "duplicateTeam"`, `UnknownBusinessUnit = "unknownBusinessUnit"`, `UnknownTeam = "unknownTeam"`, `DuplicateEntry = "duplicateEntry"`, `UnknownAction = "unknownAction"`, `UnknownLevel = "unknownLevel"`, `DuplicateOverride = "duplicateOverride"`
  - `class SecurityModelIssue { constructor(readonly Code: SecurityModelIssueCode, readonly Path: string, readonly Message: string) }`
  - `class InvalidSecurityModelError extends Error { readonly Issues: readonly SecurityModelIssue[] }`
  - `class SecurityModelValidator { static Validate(config: ISecurityModelConfig): readonly SecurityModelIssue[]; static AssertValid(config: ISecurityModelConfig): void }`
- Removed (no replacement): `OwnershipSourceKind`, `IOwnershipSource`, `IOwnershipRuleConfig`, `IMembershipConfig`, `IMembershipClaimRule`, `IMembershipOverride`, `IRoleConfig`, `IPrivilegeConfig`, `IRoleClaimRule`, `IRoleOverride`, `ITeamRoleGrant`, every `IField*Config` / `IFieldSecurityConfig` / `ISecuredFieldConfig`.

- [ ] **Step 1: Write the failing tests** (`security-model-validator.test.ts`, one `test` each, using a `ValidatorFx.Valid()` static fixture with BUs `contoso` → `sales`, `hr`, team `hr` linked to `hr-staff` with manual member `dana`):
  - `a valid model has no issues`: `assert.deepEqual(SecurityModelValidator.Validate(ValidatorFx.Valid()), [])`
  - `retired sections are rejected by name`: adding `ownershipRules: []` (cast through `unknown`) gives one issue `{ Code: UnknownSection, Path: "ownershipRules" }`; the same holds for `roles`, `roleAssignment`, `fieldSecurity`, `membership`.
  - `a second root is a malformed tree`: issue `MalformedBusinessUnitTree` at Path `businessUnits`.
  - `references must resolve`: a user placed in BU `nope` → `UnknownBusinessUnit` at `users[0].businessUnitId`; a team in BU `nope` → `UnknownBusinessUnit` at `teams[0].businessUnitId`; a role assignment with teamId `ghost` → `UnknownTeam` at `roleAssignments[0].teamIds[0]`.
  - `duplicates are rejected`: two placements for `dana` → `DuplicateUser`; two teams with id `hr` → `DuplicateTeam`; two `roleAssignments` for the same role → `DuplicateEntry`; two `roleOverrides` with the same (role, concept, action) → `DuplicateOverride`; two `profileOverrides` with the same (profile, concept, field) → `DuplicateOverride`.
  - `override vocabulary is checked`: `action: "write"` → `UnknownAction`; `level: "global"` → `UnknownLevel`.
  - `empty ids are rejected`: an empty team id, an empty manual member, or an empty principalId → `EmptyId`.
  - `AssertValid throws with every issue`: `assert.throws(() => SecurityModelValidator.AssertValid(bad), (e) => e instanceof InvalidSecurityModelError && e.Issues.length === 2)`.

- [ ] **Step 2: Run to verify failure.** `npx tsx --conditions=development --test src/security/tests/security-model-validator.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement.** Rewrite `security-model-config.ts` to the shapes above. Keep `PrivilegeAction`/`AccessLevel` in that file. Move `BusinessUnitHierarchy` unchanged. The validator collects issues; it does not throw on the first one. Tree errors come from `BusinessUnitHierarchy.FromConfig` caught as `MalformedBusinessUnitTreeError`, and while the tree is malformed BU references are not checked. Allowed top-level keys are a `private static readonly Sections` set of the seven C5 names. Role, profile and concept names are *not* checked against packages here, because the validator has no catalog (Task 10 does that check). Rewrite `security-model-config.test.ts` to one round-trip test of `IdentityConfig.SecurityModel` with the new shape. Update `src/index.ts` exports.

- [ ] **Step 4: Run to verify pass.** `npm test && npm run typecheck && npm run build` in `todl-identity` → green.

- [ ] **Step 5: Commit** — `git commit -am "feat(identity)!: environment security setting reshaped to C5 with validator; BU hierarchy moves to contracts"` (with the new files added).

---

### Task 3: Directory snapshot, team membership rows (synced ∪ manual)

**Files:**
- Create: `todl-identity/src/directory/idp-directory-snapshot.ts`, `todl-identity/src/directory/team-membership-rows.ts`
- Test: `todl-identity/src/directory/tests/team-membership-rows.test.ts`

**Interfaces:**
- Consumes: `ISecurityModelConfig` (Task 2), `Principal`, `PrincipalKind.System` (Task 1).
- Produces:
  - `enum IdpUserState { Enabled = "enabled", Disabled = "disabled", Deleted = "deleted", Unknown = "unknown" }`
  - `class IdpDirectorySnapshot { constructor(readonly TakenAt: Date, readonly Authoritative: boolean, users: ReadonlyMap<string, IdpUserState>, groups: ReadonlyMap<string, readonly string[]>); static NonAuthoritative(at: Date): IdpDirectorySnapshot; StateOf(principalId: string): IdpUserState; MembersOf(groupId: string): readonly string[]; IsActive(principal: Principal): boolean; Users(): ReadonlyMap<string, IdpUserState>; Groups(): ReadonlyMap<string, readonly string[]> }`. A principal the snapshot did not fetch is `Unknown`. `IsActive` is true for `Service` / `Machine` / `System` kinds. For a `User` it is true unless the state is `Disabled` or `Deleted`.
  - `enum MembershipOrigin { Synced = "synced", Manual = "manual" }`
  - `class TeamMembershipRow { constructor(readonly TeamId: string, readonly PrincipalId: string, readonly Origin: MembershipOrigin) }`
  - `class TeamMembershipRows { static For(config: ISecurityModelConfig, snapshot: IdpDirectorySnapshot): TeamMembershipRows; Rows(teamId: string): readonly TeamMembershipRow[]; TeamsOf(principal: Principal): readonly string[] }`

- [ ] **Step 1: Write the failing tests** (spec §9.1 Dana case; teams `hr` linked to `hr-staff` with manual `dana`, `managers` linked to `mgr`):
  - `synced rows come from linked groups and manual rows from manualMembers`: snapshot (authoritative) groups `hr-staff: [alice, dana]`, all users Enabled → `Rows("hr")` deep-equals `[Synced alice, Synced dana, Manual dana]` (sorted by PrincipalId, then Origin).
  - `removed from the IdP group keeps the manual row`: `hr-staff: [alice]` → `TeamsOf(dana)` is `["hr"]`; `Rows("hr")` has exactly one `dana` row, with origin Manual.
  - `disabled or deleted identity loses manual and synced membership`: dana `Disabled` → `TeamsOf(dana)` is `[]` and `Rows("hr")` has no `dana` row; the same holds for `Deleted`.
  - `non-authoritative snapshot takes synced rows from token groups and treats unknown users as active`: with `IdpDirectorySnapshot.NonAuthoritative(now)`, principal `bob` with `Groups: ["mgr"]` → `TeamsOf(bob)` is `["managers"]`; `snapshot.IsActive(bob)` is true; `Rows("managers")` lists no synced rows (none can be known).
  - `system principal is active and in no team`: `TeamsOf(SystemPrincipal.For("env"))` is `[]`, `IsActive` is true.

- [ ] **Step 2: Run to verify failure.** `npx tsx --conditions=development --test src/directory/tests/team-membership-rows.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In an authoritative snapshot the synced rows come from `snapshot.MembersOf(group)` for each linked group. In a non-authoritative one they come from `principal.Groups` at `TeamsOf` time. Inactive principals are filtered out of both origins.

- [ ] **Step 4: Run to verify pass.** `npm test` → green.

- [ ] **Step 5: Commit** — `git commit -m "feat(identity): IdP directory snapshot and team membership rows with origin"`

---

### Task 4: Directory source/store contracts, sync, in-memory store

**Files:**
- Create: `todl-identity/src/directory/idp-directory-source.ts`, `todl-identity/src/directory/idp-directory-store.ts`, `todl-identity/src/directory/idp-directory-sync.ts`, `todl-identity-host/src/directory/in-memory-idp-directory-store.ts`
- Modify: `todl-identity/src/provider/audit-sink.ts` (append `AuditEventKind.DirectorySync`), `todl-identity/src/provider/identity-store-set.ts`, `todl-identity/src/testing/fakes.ts`, both `src/index.ts`
- Test: `todl-identity/src/directory/tests/idp-directory-sync.test.ts`, `todl-identity-host/src/directory/tests/in-memory-idp-directory-store.test.ts`

**Interfaces:**
- Consumes: Task 3 types, `ISessionManager.RevokeAllFor(tenant, principalId)`, `IAuditSink`.
- Produces:
  - `class IdpDirectoryRequest { constructor(readonly GroupIds: readonly string[], readonly PrincipalIds: readonly string[]); static For(config: ISecurityModelConfig): IdpDirectoryRequest }`. Groups = every team's `idpGroups`. Principals = `users[].principalId` ∪ `teams[].manualMembers` ∪ `roleAssignments[].principalIds` ∪ `profileAssignments[].principalIds`. Both lists are de-duplicated and sorted.
  - `interface IIdpDirectorySource { readonly Authoritative: boolean; Snapshot(tenant: Tenant, request: IdpDirectoryRequest): Promise<IdpDirectorySnapshot> }`
  - `interface IIdpDirectoryStore { Get(tenantId: string): Promise<IdpDirectorySnapshot | null>; Save(tenantId: string, snapshot: IdpDirectorySnapshot): Promise<void> }`, `const IdpDirectoryStoreKey = new ServiceKey<IIdpDirectoryStore>("IdentityIdpDirectoryStore")`
  - `class IdpDirectorySyncResult { constructor(readonly Snapshot: IdpDirectorySnapshot, readonly Deprovisioned: readonly string[]) }`
  - `class IdpDirectorySync { constructor(source: IIdpDirectorySource, store: IIdpDirectoryStore, sessions: ISessionManager, audit: IAuditSink, now?: () => Date); Run(tenant: Tenant, config: ISecurityModelConfig): Promise<IdpDirectorySyncResult> }`
  - `IdentityStoreSet` gains `readonly IdpDirectory: IIdpDirectoryStore`.
  - `todl-identity-host`: `class InMemoryIdpDirectoryStore implements IIdpDirectoryStore`.
  - `todl-identity/testing`: `class FakeIdpDirectorySource implements IIdpDirectorySource` (constructor takes the snapshot to return; records the last request).

- [ ] **Step 1: Write the failing tests:**
  - `request covers linked groups and every referenced principal` — `IdpDirectoryRequest.For(cfg)` deep-equals the expected sorted lists.
  - `sync saves the snapshot and audits one DirectorySync event` — after `Run`, `store.Get(tenant.Id)` returns the same snapshot. Exactly one `AuditEvent` of kind `DirectorySync` is recorded, its `Detail` has the counts `users`, `groups` and `deprovisioned`, and it holds no member ids.
  - `sync revokes sessions of newly deprovisioned identities` — previous snapshot has dana `Enabled`, new one `Disabled`. `Deprovisioned` is `["dana"]` and `RevokeAllFor` is called once with (tenant, "dana"). A second `Run` with the same state revokes nothing more.
  - `a failing source leaves the stored snapshot untouched and rethrows` — the source throws; `Run` rejects; `store.Get` returns the previous snapshot.
  - Host: `in-memory store round-trips per tenant and returns null for unknown`.

- [ ] **Step 2: Run to verify failure.** `npx tsx --conditions=development --test src/directory/tests/idp-directory-sync.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Deprovisioned = principals whose new state is `Disabled` or `Deleted` and whose previous state (missing snapshot ⇒ `Unknown`) was neither. Sync does not schedule itself: poll vs push and the frequency are the host's choice (S4); spec §11 leaves them to the builder.

- [ ] **Step 4: Run to verify pass.** `npm test && npm run build` in `todl-identity`, then `npm run build && npm test` in `todl-identity-host` → green.

- [ ] **Step 5: Commit** in each repo: `feat(identity): IdP directory source/store contracts and sync with deprovision revocation`.

---

### Task 5: Local groups and source-token contracts

**Files:**
- Create: `todl-identity/src/authn/local-group-store.ts`, `todl-identity/src/authn/source-token-provider.ts`, `todl-identity/src/authn/per-user-source-token-cache.ts`
- Modify: `todl-identity/src/provider/identity-store-set.ts`, `todl-identity/src/index.ts`
- Test: `todl-identity/src/authn/tests/per-user-source-token-cache.test.ts`

**Interfaces:**
- Produces:
  - `class LocalGroup { constructor(readonly GroupId: string, readonly TenantId: string, readonly Name: string, readonly MemberIds: readonly string[]) }`, `class LocalGroupNotFoundError extends Error { readonly GroupId: string }`
  - `interface ILocalGroupStore { CreateGroup(tenant: Tenant, groupId: string, name: string): Promise<LocalGroup>; DeleteGroup(tenant: Tenant, groupId: string): Promise<void>; AddMember(tenant: Tenant, groupId: string, principalId: string): Promise<void>; RemoveMember(tenant: Tenant, groupId: string, principalId: string): Promise<void>; ListGroups(tenant: Tenant): Promise<readonly LocalGroup[]> }`
  - `IdentityStoreSet.Accounts` becomes `ILocalAccountStore & IPrincipalDirectory & ILocalGroupStore`.
  - `class SourceTokenRequest { constructor(readonly TenantId: string, readonly PrincipalId: string, readonly Resource: string) }`. Resource is the target audience/scope, e.g. `https://database.windows.net/.default`.
  - `class SourceToken { constructor(readonly Resource: string, readonly Value: PresentedSecret, readonly ExpiresAt: Date) }`
  - `enum SourceTokenFailure { NoUpstreamSession = "noUpstreamSession", ExchangeRejected = "exchangeRejected", PrincipalInactive = "principalInactive", UnsupportedPrincipal = "unsupportedPrincipal" }`, `class SourceTokenError extends Error { readonly Failure: SourceTokenFailure }`. The message never contains a token.
  - `interface ISourceTokenProvider { Acquire(request: SourceTokenRequest): Promise<SourceToken> }`, `const SourceTokenProviderKey = new ServiceKey<ISourceTokenProvider>("IdentitySourceTokenProvider")`. This contract is identity-free (strings, Date, `PresentedSecret`), so the host can hand it to a connector seam.
  - `class PerUserSourceTokenCache { constructor(skewMs?: number /* default 60_000 */); Get(request: SourceTokenRequest, now: Date): SourceToken | undefined; Put(request: SourceTokenRequest, token: SourceToken): void; Forget(tenantId: string, principalId: string): void }`. The key is (TenantId, PrincipalId, Resource).

- [ ] **Step 1: Write the failing tests:**
  - `cache never serves one principal's token to another` — Put for (t, alice, R). Get for (t, bob, R) is `undefined`, Get for (t2, alice, R) is `undefined`, and Get for (t, alice, R) returns the token.
  - `a token inside the skew window is a miss` — ExpiresAt = now + 30 s with the default skew → `undefined`.
  - `Forget drops every resource of that principal only`.
  - `SourceTokenError carries its failure and no secret` — `new SourceTokenError(SourceTokenFailure.ExchangeRejected).message` does not include any token text passed to the provider (assert the message equals the class's constant).

- [ ] **Step 2: Run to verify failure.** `npx tsx --conditions=development --test src/authn/tests/per-user-source-token-cache.test.ts` → FAIL.

- [ ] **Step 3: Implement** the contracts and the cache (a `Map` keyed by the three ids joined with `\u0000`).

- [ ] **Step 4: Run to verify pass.** `npm test && npm run build` → green.

- [ ] **Step 5: Commit** — `feat(identity): local group store and per-user source-token contracts`.

---

### Task 6: Local IdP — groups, directory source, local source tokens

**Files:**
- Modify: `todl-identity-local/src/accounts/local-account-store.ts`, `todl-identity-local/src/pack/local-identity-provider-pack.ts`, `todl-identity-local/src/index.ts`
- Create: `todl-identity-local/src/directory/local-directory-source.ts`, `todl-identity-local/src/tokens/local-source-token-provider.ts`
- Test: `todl-identity-local/src/accounts/tests/local-groups.test.ts`, `todl-identity-local/src/directory/tests/local-directory-source.test.ts`, `todl-identity-local/src/tokens/tests/local-source-token-provider.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  - `LocalAccountStore implements ILocalAccountStore, IPrincipalDirectory, ILocalGroupStore`. `Lookup` returns a `Principal` whose `Groups` are the ids of the groups that list the principal. The private `groups` map is replaced by group records.
  - `class LocalDirectorySource implements IIdpDirectorySource { readonly Authoritative = true; constructor(accounts: ILocalAccountStore, groups: ILocalGroupStore, now?: () => Date) }`. Each requested principal maps to `Enabled` / `Disabled` (from `LocalAccount.Disabled`), or `Deleted` when there is no account. Each requested group maps to its members, or `[]` when unknown.
  - `class LocalSourceTokenProvider implements ISourceTokenProvider { constructor(accounts: ILocalAccountStore, secrets: ISecretStore, now?: () => Date); Verify(tenantId: string, token: string, resource: string): Promise<string | null> }`. It returns an HS256 compact JWS built with `node:crypto` `createHmac`, with claims `{ iss: "todl-identity-local", sub, aud: resource, iat, exp: iat + 300 }`. The key is 32 random bytes kept in the secret store under `local-source-token-key/<tenantId>` and created on first use. `Verify` returns `sub` only when the signature, `aud`, `iss` and `exp` all hold.
  - `LocalIdentityProviderPack` gains `readonly Groups: ILocalGroupStore`, `readonly DirectorySource: IIdpDirectorySource`, `readonly SourceTokens: ISourceTokenProvider`.

- [ ] **Step 1: Write the failing tests:**
  - `groups: create, add, remove, list, and Lookup carries membership` — after `AddMember(t, "hr-staff", dana)`, `(await store.Lookup(dana, t)).Groups` deep-equals `["hr-staff"]`. Adding a member to an unknown group rejects with `LocalGroupNotFoundError`. A duplicate `CreateGroup` rejects. Groups of another tenant are invisible to `ListGroups`.
  - `directory source reports enabled, disabled, deleted and group members` — the request has principals `[alice, dana, ghost]` and groups `[hr-staff, none]`, with dana disabled → states `Enabled, Disabled, Deleted`; `MembersOf("none")` is `[]`; `Authoritative` is true.
  - `local source token is per user and verifiable for its resource only` — the token for alice verifies to `"alice"` for resource R, to `null` for resource R2, and to `null` after the clock passes `exp`. Bob's token differs and verifies to `"bob"`.
  - `disabled account cannot acquire a source token` — rejects with `SourceTokenError` whose `Failure` is `PrincipalInactive`; an unknown principal → `PrincipalInactive`; `SystemPrincipal.IdFor(t.Id)` → `UnsupportedPrincipal`.

- [ ] **Step 2: Run to verify failure.** `cd D:/architecture-agent/todl-identity-local && npx tsx --test src/accounts/tests/local-groups.test.ts src/directory/tests/local-directory-source.test.ts src/tokens/tests/local-source-token-provider.test.ts` → FAIL.

- [ ] **Step 3: Implement** as specified. The conformance suite (`src/pack/tests/conformance.test.ts`) must still pass unchanged.

- [ ] **Step 4: Run to verify pass.** `npm test && npm run build` → green.

- [ ] **Step 5: Commit** — `feat(identity-local): groups, authoritative directory source, local per-user source tokens`.

---

### Task 7: Node persistence — validated setting, migration, file groups, file directory store

**Files:**
- Modify: `todl-identity-node/src/config/file-tenant-config-store.ts`, `todl-identity-node/src/accounts/file-account-store.ts`, `todl-identity-node/src/pack/file-identity-stores.ts`, `todl-identity-node/src/pack/server-identity-pack.ts`, `todl-identity-node/src/index.ts`
- Create: `todl-identity-node/src/config/security-model-migration.ts`, `todl-identity-node/src/directory/file-idp-directory-store.ts`
- Delete: `src/config/tests/file-tenant-config-store.roles.test.ts`; rewrite `src/config/tests/file-tenant-config-store.security.test.ts`
- Test: `src/config/tests/file-tenant-config-store.security.test.ts`, `src/config/tests/security-model-migration.test.ts`, `src/accounts/tests/file-account-store.groups.test.ts`, `src/directory/tests/file-idp-directory-store.test.ts`

**Interfaces:**
- Consumes: `SecurityModelValidator`, `InvalidSecurityModelError` (Task 2), `ILocalGroupStore` (Task 5), `IIdpDirectoryStore` (Task 4), `LocalDirectorySource`, `LocalSourceTokenProvider` (Task 6).
- Produces:
  - `FileTenantConfigStore.Save` throws `InvalidSecurityModelError` before writing anything when the model is invalid. `Open` migrates each stored record whose `securityModel` has retired sections, validates it, and rewrites the file once if anything changed. A record that is still invalid after migration makes `Get(tenantId)` throw `InvalidSecurityModelError` (other tenants are unaffected).
  - Ruled PR18: the migration stays. It runs once per stored record on `Open`, rewrites the file, and is never consulted again for that record; nothing at runtime reads the old shape.
  - `class SecurityModelMigration { static NeedsUpgrade(raw: Readonly<Record<string, unknown>>): boolean; static Upgrade(raw: Readonly<Record<string, unknown>>): ISecurityModelConfig }`. `businessUnits` is kept. `teams[]` become `{ id, name, businessUnitId: owningBusinessUnit ?? <root id>, idpGroups, manualMembers }`. `idpGroups` = the values of `membership.claimsMapping` rules whose `claim === "group"` and whose `teams` include the team. `manualMembers` = the `principalId` of each `membership.overrides` entry whose `teams` include the team. `users` = `membership.overrides` that carry `homeBusinessUnit`. `roleAssignments`, `profileAssignments`, `roleOverrides` and `profileOverrides` start empty, because tenant-authored roles do not map onto package roles (spec §11; S4 seeds the creator as System Administrator). `ownershipRules`, `roles`, `roleAssignment`, `fieldSecurity` and `membership` are dropped. Retired key names are `private static readonly` constants.
  - `FileAccountStore implements ILocalAccountStore, IPrincipalDirectory, ILocalGroupStore`. `accounts.json` gains `groups: GroupRecord[]` (`{ groupId, tenantId, name, memberIds }`). `AccountRecord.groups` is removed. On `Open`, any legacy `AccountRecord.groups` entry becomes membership of a group with that id (name = id), and the file is rewritten.
  - `class FileIdpDirectoryStore implements IIdpDirectoryStore { static Open(storage: IStorage): Promise<FileIdpDirectoryStore> }`, file `idp-directory.json`. It stores `takenAt` (ISO), `authoritative`, `users: [id, state][]` and `groups: [id, members][]` per tenant.
  - `FileIdentityStores.Open` returns `IdpDirectory`. `ServerIdentityPackComposition` gains optional `DirectorySource?: IIdpDirectorySource` and `SourceTokens?: ISourceTokenProvider`. `ServerIdentityPack` exposes `readonly DirectorySource`, `readonly SourceTokens`, `readonly Groups: ILocalGroupStore`, `readonly IdpDirectory: IIdpDirectoryStore`, defaulting to `LocalDirectorySource` / `LocalSourceTokenProvider` over its accounts and secrets.

- [ ] **Step 1: Write the failing tests:**
  - `a C5 SecurityModel round-trips through Save/Get and a reopen` (rewrite of the existing security test, using the new shape).
  - `Save rejects an invalid model and writes nothing` — the model has a team in an unknown BU. `Save` rejects with `InvalidSecurityModelError`; after a reopen, `Get` returns the previous config.
  - `a legacy record is migrated on open and rewritten once` — seed `tenant-config.json` (via `JsonFile`) with the old shape. Its team `hr` has `owningBusinessUnit: "hr"`, its `membership.claimsMapping` has `{ claim: "group", value: "hr-staff", teams: ["hr"] }`, its overrides have `{ principalId: "dana", homeBusinessUnit: "hr", teams: ["hr"] }`, and it also has `ownershipRules` and `fieldSecurity`. After `Open`, `Get` returns teams `[{ id: "hr", name, businessUnitId: "hr", idpGroups: ["hr-staff"], manualMembers: ["dana"] }]` and users `[{ principalId: "dana", businessUnitId: "hr" }]`, with no retired keys left in the raw file.
  - `migration: NeedsUpgrade is false for a C5 model`.
  - `file groups persist across reopen and feed Lookup` (mirror of the Task 6 local test over `FileAccountStore`); `legacy account groups become group records on open`.
  - `file directory store round-trips states and members per tenant, survives reopen, unknown tenant is null`.

- [ ] **Step 2: Run to verify failure.** `cd D:/architecture-agent/todl-identity-node && npx tsx --test src/config/tests/*.test.ts src/accounts/tests/file-account-store.groups.test.ts src/directory/tests/file-idp-directory-store.test.ts` → FAIL.

- [ ] **Step 3: Implement** as specified. Keep the repo's no-semicolon style.

- [ ] **Step 4: Run to verify pass.** `npm test && npm run build` → green (including the existing `server-identity-pack*` and `package.integration` tests, updated only where the store-set shape changed).

- [ ] **Step 5: Commit** — `feat(identity-node): validated C5 persistence with one-shot migration, file groups, file directory store`.

---

### Task 8: Cloud — Entra directory sync over Microsoft Graph, on-behalf-of source tokens

**Files:**
- Create: `todl-identity-cloud/src/http/http-status-error.ts`, `todl-identity-cloud/src/directory/microsoft-graph-directory-source.ts`, `todl-identity-cloud/src/obo/upstream-token-vault.ts`, `todl-identity-cloud/src/obo/on-behalf-of-token-provider.ts`
- Modify: `README.md` (the PR7 note below), `src/http/http-client.ts`, `src/http/fetch-http-client.ts`, `src/claims/claims-mapper.ts`, `src/pack/oidc-provider-profile.ts`, `src/pack/oidc-setting-keys.ts`, `src/pack/oidc-identity-provider-pack-base.ts`, `src/oidc/oidc-authenticator.ts`, `src/packs/microsoft-entra-profile.ts`, `src/packs/microsoft-entra-pack.ts`, `src/testing/fake-oidc-idp.ts`, `src/index.ts`
- Test: `src/directory/tests/microsoft-graph-directory-source.test.ts`, `src/obo/tests/on-behalf-of-token-provider.test.ts`, `src/packs/tests/microsoft-entra.golden.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  - `IHttpClient.GetJson(url: string, bearer?: string): Promise<unknown>` (sends `Authorization: Bearer <bearer>` when given). Non-2xx responses throw `class HttpStatusError extends Error { readonly Status: number }` (replacing the bare `Error`).
  - `OidcProviderProfile` gains `public readonly SubjectClaim: string` (constructor parameter, default `"sub"`). `ClaimsMapper` takes the subject claim from the profile. `MicrosoftEntraProfile` uses `"oid"`, so principal ids equal Graph object ids (ids change for existing Entra users; research mode).
  - `OidcSettingKeys.ApiScope = "apiScope"`. When set, the pack appends it plus `offline_access` to the requested scopes.
  - `class UpstreamTokens { constructor(readonly AccessToken: string, readonly RefreshToken: string | null) }`; `class UpstreamTokenVault { constructor(secrets: ISecretStore); Put(tenantId: string, principalId: string, tokens: UpstreamTokens): Promise<void>; Get(tenantId: string, principalId: string): Promise<UpstreamTokens | null>; Delete(tenantId: string, principalId: string): Promise<void> }`. The secret reference is `upstream-token/<tenantId>/<principalId>`.
  - `OidcAuthenticatorOptions.Vault?: UpstreamTokenVault`. When present, a successful `Authenticate` stores `access_token` / `refresh_token` from the token response under the mapped principal.
  - `class MicrosoftGraphDirectorySource implements IIdpDirectorySource { readonly Authoritative = true; constructor(http: IHttpClient, secrets: ISecretStore, settings: ReadonlyMap<string, string>, now?: () => Date) }`. It gets an app token with `client_credentials` at `https://login.microsoftonline.com/<aadTenantId>/oauth2/v2.0/token`, scope `https://graph.microsoft.com/.default`. Groups come from `GET https://graph.microsoft.com/v1.0/groups/<id>/transitiveMembers/microsoft.graph.user?$select=id,accountEnabled`, following `@odata.nextLink`; a 404 group yields `[]`. Users come from `GET https://graph.microsoft.com/v1.0/users/<id>?$select=id,accountEnabled`: `accountEnabled` false → `Disabled`, 404 → `Deleted`. Any other error rejects the whole snapshot, so a partial snapshot never deprovisions anyone.
  - `class OnBehalfOfTokenProvider implements ISourceTokenProvider { constructor(opts: { Http: IHttpClient; Discovery: OidcDiscovery; Resolved: OidcResolvedConfig; Secrets: ISecretStore; Vault: UpstreamTokenVault; ApiScope: string; Cache?: PerUserSourceTokenCache; now?: () => Date }) }`. The cache is consulted first. Then the vault: no entry → `SourceTokenError(NoUpstreamSession)`. If the stored assertion's `exp` (read with jose `decodeJwt`) is within the skew and a refresh token exists, the provider refreshes (`grant_type=refresh_token`, `scope=<ApiScope>`) and stores the result. It then POSTs to the token endpoint with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `client_id`, `client_secret`, `assertion`, `scope=<request.Resource>` and `requested_token_use=on_behalf_of`. `ExpiresAt` comes from `decodeJwt(access_token).exp`, falling back to now + `expires_in`. Any token-endpoint failure → `SourceTokenError(ExchangeRejected)`. `SystemPrincipal` ids → `UnsupportedPrincipal`.
  - `MicrosoftEntraPack` exposes `readonly DirectorySource: IIdpDirectorySource` and `readonly SourceTokens: ISourceTokenProvider` (built only when `ApiScope` is set; otherwise `SourceTokens` throws `UnsupportedPrincipal` for every request). The generic OIDC and Google packs expose neither. The host then uses a non-authoritative snapshot (Review Focus 2).
  - Ruled PR7 (documented in `README.md` under "Directory sync" and on the two pack classes' doc comments): with a non-directory IdP (generic OIDC, Google), a user disabled or deleted in the IdP keeps access until their current session expires, because nothing can tell the platform sooner. Admins who need immediate revocation remove the user's assignments and manual team rows, or use an IdP with a directory API.

- [ ] **Step 1: Write the failing tests** (a recording `IHttpClient` fake; unsigned JWTs built in the test for `decodeJwt`):
  - `graph source maps enabled, disabled, deleted and pages group members` — two pages of `hr-staff`, user `dana` with `accountEnabled: false`, `ghost` → 404 → states `Enabled/Disabled/Deleted` and members from both pages. Every Graph GET carried the app bearer, and the bearer value is never in an error message.
  - `graph source rejects on a 500 and returns no partial snapshot`.
  - `entra principal id is the oid claim` (golden test extension: `Principal.Id === payload.oid`).
  - `authenticator stores upstream tokens when a vault is configured` — `vault.Get(t, oid)` returns the access and refresh tokens from the fake token response.
  - `obo exchanges the stored assertion for the requested resource` — the POST fields equal the jwt-bearer set above, with `scope` = R; the returned `Value.Reveal()` is the fake access token and `ExpiresAt` is its `exp`.
  - `obo refreshes an expired assertion first`.
  - `missing upstream session rejects and never falls back` — empty vault → `NoUpstreamSession`, and no POST is made.
  - `obo never serves alice's token to bob` — two principals with different stored assertions get different tokens; the cache holds two entries.

- [ ] **Step 2: Run to verify failure.** `cd D:/architecture-agent/todl-identity-cloud && npx tsx --test src/directory/tests/*.test.ts src/obo/tests/*.test.ts src/packs/tests/microsoft-entra.golden.test.ts` → FAIL.

- [ ] **Step 3: Implement** as specified. Update `fake-oidc-idp.ts` so its token response carries `access_token` / `refresh_token` and the `oid` claim.

- [ ] **Step 4: Run to verify pass.** `npm test && npm run build` → green (the conformance and cross-provider suites included).

- [ ] **Step 5: Commit** — `feat(identity-cloud): Entra directory sync via Graph, on-behalf-of per-user source tokens`.

---

### Task 9: Engine — retire tier-2 policy code, add graph dependency, `SecurityVocabulary` (C1)

**Files:**
- Delete (with tests) — the evidence is each file's own doc comment and imports:

| File | Why it is tier 2 / retired |
|---|---|
| `src/policy/policy-catalog.ts` | reads `MetaKind.Policy` nodes / `access-policy.json` rule JSON (spec §8 retired) |
| `src/policy/policy-predicate-compiler.ts` | evaluates `entity.<field>` predicates over app data; deny-overrides fusion |
| `src/authz/fusion-access-policy.ts` | fuses RBAC with per-concept policy entity filters (`EntityFilterFor`) |
| `src/adapters/policy-instance-filter.ts`, `policy-push-down.ts`, `policy-query-filter-provider.ts` | policy filters and connector query push-down: tier 2, and connectors are outside the model (§6) |
| `src/enforcement/identity-enforcement.ts` (+ `tests/recording-adapter.ts`, `connector-enforcement`, `crm-golden`) | facade over `PolicyCatalog` |
| `src/security/concept-bypass-instance-filter.ts` | exists for the "ungoverned / app-private concept" bypass (retired §8) |
| `src/security/composite-instance-filter.ts` | the "deny-wins AND" composition of policy + depth (retired §8) |
| `src/security/access-depth-instance-filter.ts`, `allow-all-instance-filter.ts` | in-memory `IInstanceFilter` path; tier 1 is enforced by the engine through `AccessScope` (§5) |

- Kept as tier 1 (rebased in Task 10): `src/security/{tenant-security-model,membership-resolver,access-depth-evaluator,field-security-evaluator}.ts`. `business-unit-hierarchy.ts` moved to `todl-identity` in Task 2; delete the engine copy and its test here and import from `@pragmatic-tech-ai/todl-identity`.
- Modify: `package.json`, `src/index.ts`, `src/tests/dependency-resolution.test.ts`, `README.md` (description and surface)
- Create: `src/security/security-vocabulary.ts`
- Test: `src/security/tests/security-vocabulary.test.ts`

**Interfaces:**
- Consumes: S1's `SecurityAction`, `SecurityDepth` (C1) from `@pragmatic-tech-ai/todl`; `PrivilegeAction`, `AccessLevel`, `BaseRole` (Task 1).
- Produces: `class SecurityVocabulary { static ActionOf(action: SecurityAction): PrivilegeAction; static DepthOf(depth: SecurityDepth): AccessLevel; static Actions(): ReadonlyMap<SecurityAction, PrivilegeAction>; static Depths(): ReadonlyMap<SecurityDepth, AccessLevel> }`. These are exhaustive value maps declared as `private static readonly` `Map`s, and an unmapped value throws.

- [ ] **Step 1: Add the dependency without installing.** In `package.json` `dependencies` add `"@pragmatic-tech-ai/graph": "file:../pragmatic-graph"` and fix the description (drop "policy-predicate compiler, fusion access policy"). Link it by hand: `cmd //c mklink /J "D:\architecture-agent\todl-identity-engine\node_modules\@pragmatic-tech-ai\graph" "D:\architecture-agent\pragmatic-graph"`. Verify with `ls -la node_modules/@pragmatic-tech-ai/` (the junction resolves to the same `pragmatic-graph` directory TODL links, so `Predicate` classes are one module instance).

- [ ] **Step 2: Write the failing test**

```ts
test("every SecurityAction maps to the PrivilegeAction with the same value and back", () =>
{
    assert.deepEqual([...Object.values(SecurityAction)].sort(), [...Object.values(PrivilegeAction)].sort());
    for (const a of Object.values(SecurityAction)) assert.equal(SecurityVocabulary.ActionOf(a), a as string);
});
test("every SecurityDepth maps to the AccessLevel with the same value and back", () =>
{
    assert.deepEqual([...Object.values(SecurityDepth)].sort(), [...Object.values(AccessLevel)].sort());
    for (const d of Object.values(SecurityDepth)) assert.equal(SecurityVocabulary.DepthOf(d), d as string);
});
test("an unmapped value throws", () =>
{
    assert.throws(() => SecurityVocabulary.ActionOf("write" as SecurityAction));
});
```
If S1 exports a mirrored base-role list (C4), add `BaseRole` equality against it here as a fourth test.

- [ ] **Step 3: Run to verify failure.** `cd D:/architecture-agent/todl-identity-engine && npx tsx --test src/security/tests/security-vocabulary.test.ts` → FAIL.

- [ ] **Step 4: Implement**, delete the retired files, and update `src/index.ts`. Rewrite `dependency-resolution.test.ts` so it resolves `AccessScope`/`Predicate` from `@pragmatic-tech-ai/graph`, `ShareGrantScope` from `@pragmatic-tech-ai/todl/engine` and `BaseRole` from `@pragmatic-tech-ai/todl-identity`. It must no longer touch `PolicyPredicateCodec`.

- [ ] **Step 5: Run to verify pass.** `npx tsx --test src/security/tests/security-vocabulary.test.ts src/tests/dependency-resolution.test.ts` → PASS. (The full suite goes green in Task 10.)

- [ ] **Step 6: Commit** — `refactor(identity-engine)!: retire tier-2 policy/fusion/adapter/instance-filter code; add graph dependency and SecurityVocabulary`.

---

### Task 10: Engine — rebase the security model onto package security + C5

**Files:**
- Modify: `src/security/tenant-security-model.ts`, `src/security/membership-resolver.ts`, `src/security/access-depth-evaluator.ts`, `src/security/field-security-evaluator.ts`, `src/index.ts`
- Create: `src/security/effective-role-table.ts`, `src/security/tier1-diagnostic.ts`
- Delete: `src/security/ownership-resolver.ts`, tests `ownership-resolver.test.ts`, `access-depth-filters.test.ts`, `access-depth-governed-concepts.test.ts`, `concept-bypass-instance-filter.test.ts`; rewrite `tenant-security-model.test.ts`, `membership-resolver.test.ts`, `access-depth-evaluator*.test.ts`, `field-security-evaluator.test.ts`, `assign-writes.test.ts`
- Test: `src/security/tests/effective-role-table.test.ts` plus the rewritten files

**Interfaces:**
- Consumes: `IEnvironmentSecurity`, `IPackageSecurity` (C2, S1); `SecurityVocabulary` (Task 9); `TeamMembershipRows`, `IdpDirectorySnapshot` (Task 3); `SecurityModelValidator`, `BusinessUnitHierarchy` (Task 2); `BaseRole`, `SystemPrincipal` (Task 1).
- Produces:
  - `enum Tier1DiagnosticCode` (numeric, append-only): `UnknownAssignedRole = 1, UnknownAssignedProfile, OverrideUnknownRole, OverrideUnknownConcept, OverrideUnknownProfile, OverrideUnknownField, NonOrganizationDepthOnUnownedConcept`; `class Tier1Diagnostic { constructor(readonly Code: Tier1DiagnosticCode, readonly Subject: string, readonly Message: string) }`.
  - `class TenantSecurityModel { static FromConfig(config: ISecurityModelConfig, directory: IdpDirectorySnapshot): TenantSecurityModel` (throws `InvalidSecurityModelError` via `SecurityModelValidator.AssertValid`)`; static Empty(): TenantSecurityModel; Config(): ISecurityModelConfig; Hierarchy(): BusinessUnitHierarchy; Directory(): IdpDirectorySnapshot; Membership(): MembershipResolver; IsActive(principal: Principal): boolean; PlacementOf(principal: Principal): IPrincipalPlacement; TeamBusinessUnit(teamId: string): string | undefined }`. `MalformedSecurityModelError` is removed. `interface IPrincipalPlacement { readonly PrincipalId: string; readonly HomeBusinessUnitId: string }`: a principal without a placement, and the system principal, sit at the root (C7). S4 adapts this into C3's `PrincipalFacts`.
  - `class MembershipResolver { constructor(config: ISecurityModelConfig, hierarchy: BusinessUnitHierarchy, rows: TeamMembershipRows); Resolve(principal: Principal): IMembership }`. `IMembership { homeBusinessUnit: string; teams: readonly string[] }`; teams are active rows only.
  - `class EffectiveRoleTable { static Build(security: IEnvironmentSecurity, overrides: readonly IRoleOverrideConfig[], concepts: ReadonlySet<string>): EffectiveRoleTable; HasRole(role: string): boolean; Level(role: string, concept: string, action: PrivilegeAction): AccessLevel; Diagnostics(): readonly Tier1Diagnostic[] }`. The roles are every `BaseRole` value (always present) plus every package `Roles[].Name`. Defaults are the package `Roles` and `BaseRoleContributions` (max depth when one role lists the same (concept, action) twice). A `roleOverrides` entry then *replaces* the default for its (role, concept, action). An override for an unknown role, or for a concept not in `concepts`, is dropped with a diagnostic. Callers pass the engine-stored concepts minus the edge concepts (`security.EdgeConcepts`, PR4), so an override on an edge concept is dropped as `OverrideUnknownConcept`. On a concept not in any package's `OwnedConcepts`, any level other than `None` / `Organization` is read as `None`, with diagnostic `NonOrganizationDepthOnUnownedConcept`.
  - `class AccessDepthEvaluator { static For(security: IEnvironmentSecurity, model: TenantSecurityModel, concepts: ReadonlySet<string>): AccessDepthEvaluator; static DenyAll(): AccessDepthEvaluator; EffectiveRoles(principal: Principal): ReadonlySet<string>; RoleSources(principal: Principal): readonly RoleSource[]; SourceLevel(source: RoleSource, action: PrivilegeAction, concept: string): AccessLevel; IsSystemAdministrator(principal: Principal): boolean; EffectiveLevel(principal: Principal, action: PrivilegeAction, concept: string): AccessLevel; IsOwned(concept: string): boolean; MembershipOf(principal: Principal): IMembership; AssignWrites(concept: string, ownerId: string, ownerIsTeam: boolean, owningBu: string | undefined): IAssignComputation; Model(): TenantSecurityModel; FieldSecurity(): FieldSecurityEvaluator; Diagnostics(): readonly Tier1Diagnostic[] }`.
    - Effective roles are the `roleAssignments` naming the principal directly, plus those naming one of its active teams, plus `SystemAdministrator` for `SystemPrincipal.Is(principal)`. An inactive principal has none. An assigned role the table lacks is skipped (it shows up in `Diagnostics()` as `UnknownAssignedRole`).
    - Role sources (program ruling PR5, Dataverse semantics): `class RoleSource { constructor(readonly Roles: ReadonlySet<string>, readonly BusinessUnitId: string, readonly TeamId: string | undefined) }`. `AccessDepthEvaluator.RoleSources(principal): readonly RoleSource[]` returns one direct source (the roles assigned to the principal directly, plus SystemAdministrator for the system principal, with `BusinessUnitId` = the principal's home BU), then one source per active team that holds at least one role (`BusinessUnitId` = `TeamBusinessUnit(team)`), sorted by team id. Sources with no roles are omitted. `SourceLevel(source: RoleSource, action: PrivilegeAction, concept: string): AccessLevel` is the max level over that source's roles. `EffectiveLevel` stays the max over every source; it is used for `Tier1Grants.Level` and for the System Administrator test, never to pick a BU.
    - `AssignWrites` keeps `AssignOutcome` (`Writes`, `Unsupported` = concept not owned, `UnknownTeam`, `UnknownBusinessUnit`, `OwningBusinessUnitRequired` = user owner with no resolvable BU). Its writes are always the C3 fixed fields `owner` and `owningBusinessUnit`, using S1's `SystemNames` constants. A team owner gets the team's BU. A user owner gets their placement BU.
    - Removed: `Allows`, `CreateDefaults`, `GovernedConcepts`, `ReachOf`, `MalformedRolesError`, `FromConfig`.
  - `class FieldSecurityEvaluator { static For(security: IEnvironmentSecurity, assignments: readonly IProfileAssignmentConfig[], overrides: readonly IProfileOverrideConfig[], membership: MembershipResolver): FieldSecurityEvaluator; static Open(): FieldSecurityEvaluator; IsSecured(concept: string, field: string): boolean; SecuredFields(): readonly { readonly Concept: string; readonly Field: string }[]; CanReadField(principal: Principal, concept: string, field: string): boolean; CanWriteField(principal: Principal, concept: string, field: string, action: PrivilegeAction.Create | PrivilegeAction.Update): boolean; Diagnostics(): readonly Tier1Diagnostic[] }`.
    - The secured set is the union of `SecuredFields` across packages.
    - A profile's entries are its package defaults. A `profileOverrides` entry replaces the {read, update, create} triple for its (profile, concept, field).
    - An override or assignment naming an unknown profile, or a field that is not secured, is dropped with a diagnostic. Profiles reach a principal directly or through an active team.
    - `MalformedFieldSecurityError` is removed.

- [ ] **Step 1: Write the failing tests** (an `EngineSecurityFx` static fixture builds the `hr` and `projects` `IEnvironmentSecurity` of spec §9.1/§9.2 as plain C2 object literals, `EdgeConcepts` included):
  - `base roles exist without contributions` — `table.HasRole("SystemAdministrator")`, `HasRole("Reader")` are true with an empty `Packages` map.
  - `contributions and package roles give defaults` — `Level("BasicUser", "hr.Employee", Read) === BusinessUnit`, `Level("projects.ProjectManager", "projects.Project", Read) === BusinessUnitAndChildren`.
  - `overrides lower defaults and stale overrides are dropped with diagnostics` — an override `projects.ProjectManager / projects.Project / read / businessUnit` → `BusinessUnit`. An override to `none` → `None`. An override on role `gone.Role` → ignored with diagnostic `OverrideUnknownRole`. An override on concept `gone.Thing` → ignored with diagnostic `OverrideUnknownConcept`. An override setting `user` on an unowned concept → `None` with diagnostic `NonOrganizationDepthOnUnownedConcept`.
  - `effective roles come from direct and team assignments of active principals only` — Bob holds `projects.ProjectManager` through team `managers` (synced). Once his snapshot state is `Disabled`, `EffectiveRoles(bob)` is empty.
  - `role sources keep each team's unit` (PR5) — Erin is placed in `sales`, holds `BasicUser` directly and `projects.ProjectManager` through team `mkt` (BU `marketing`). `RoleSources(erin)` deep-equals `[{ Roles: {BasicUser}, BusinessUnitId: "sales", TeamId: undefined }, { Roles: {projects.ProjectManager}, BusinessUnitId: "marketing", TeamId: "mkt" }]`, and `SourceLevel(sources[1], Read, "projects.Project") === BusinessUnitAndChildren`.
  - `system principal is System Administrator and sits at the root` — `IsSystemAdministrator(SystemPrincipal.For("env"))` is true; `PlacementOf(...).HomeBusinessUnitId === hierarchy.RootId()`.
  - `field security: profile via team grants read and update; override can revoke` — Dana (manual `hr` member) can read and update `hr.Employee.Salary`. A Sales manager cannot read it. Overriding `Compensation / hr.Employee / Salary` to `read: false` removes Dana's read.
  - `assign computes the fixed system fields` — team owner `hr` → writes `[{ field: "owner", value: "hr" }, { field: "owningBusinessUnit", value: "hr" }]`. A non-owned concept → `Unsupported`. Unknown team → `UnknownTeam`.

- [ ] **Step 2: Run to verify failure.** `npx tsx --test src/security/tests/*.test.ts` → FAIL.

- [ ] **Step 3: Implement** to the interfaces above. `TenantSecurityModel.Empty()` is a root-only tree with `IdpDirectorySnapshot.NonAuthoritative(new Date(0))`.

- [ ] **Step 4: Run to verify pass.** `npm test && npm run typecheck && npm run build` → green.

- [ ] **Step 5: Commit** — `feat(identity-engine)!: security model rebased on package security, C5 teams/placements, effective roles with overrides`.

---

### Task 11: Engine — `Tier1ScopeCompiler` (C6)

**Merge order:** the identity repos merge together with S4 Task 9 (program ruling PR17). **Waits on:** S2 Tasks 2 and 3 (`IWriteRules.Append`/`AppendTo`, `IAccessScopeOptions.Endpoints`) merged in pragmatic-graph and its `dist` rebuilt.

**Files:**
- Create: `src/scope/tier1-catalog.ts`, `src/scope/tier1-scope-compiler.ts`, `src/scope/tier1-grants.ts`
- Modify: `src/index.ts`, `README.md`
- Test: `src/scope/tests/tier1-scope-compiler.test.ts` (unit, scope shape), `src/scope/tests/tier1-scope.integration.test.ts` (end-to-end over `GraphStore.OpenMemory()`)

**Interfaces:**
- Consumes: Task 10 types (`RoleSource`, `RoleSources`, `SourceLevel`); `AccessScope`, `AccessDefault`, `And`, `Or`, `Not`, `In`, `Compare`, `CompareOp`, `ConceptIs`, `Predicate`, `ISchemaDescription`, `IWriteRules`, `IEndpointMembers` from `@pragmatic-tech-ai/graph`; `ShareGrantScope`, `ShareRight`, `SystemNames`, `TodlNames` from `@pragmatic-tech-ai/todl/engine`; `IEnvironmentSecurity` (C2, with `EdgeConcepts`, PR4).
- Produces:
  - `interface ITier1Catalog { readonly Description: ISchemaDescription; readonly HomeModels: ReadonlyMap<string, string> }`. TODL's `IEnvironmentCatalog` satisfies it structurally, which keeps tests free of `MetadataSnapshot`. `class Tier1Catalog { static EngineStoredConcepts(catalog: ITier1Catalog): ReadonlySet<string> }`. A non-aspect definition is external iff (1) a `Description.Bindings` entry has `Concept === c`, or (2) an entry has no `Concept` and its `Model === HomeModels.get(c)`, or (3) no entry matches and `Description.DefaultConnector !== undefined`. Every other non-aspect definition is engine-stored.
  - `class Tier1ScopeCompiler { static Compile(principal: Principal, security: IEnvironmentSecurity, model: TenantSecurityModel, catalog: ITier1Catalog): AccessScope; static CompileAssign(principal: Principal, security: IEnvironmentSecurity, model: TenantSecurityModel, catalog: ITier1Catalog): AccessScope; static Grants(principal: Principal, security: IEnvironmentSecurity, model: TenantSecurityModel, catalog: ITier1Catalog): Tier1Grants; static Diagnose(security: IEnvironmentSecurity, model: TenantSecurityModel, catalog: ITier1Catalog): readonly Tier1Diagnostic[] }`
  - `class Tier1Grants { IsSystemAdministrator(): boolean; Level(action: PrivilegeAction, concept: string): AccessLevel; Covers(action: PrivilegeAction, concept: string): Predicate }`. These are the unguarded depth predicates over the fixed fields (per role source, PR5), for S4's share / invoke checks, which `AccessScope` cannot express. Append and AppendTo are compiled into the scope (rule 3, PR3).

**Compile rules** (spec §5, C6 and the program rulings; `owners` = [principal id, ...active team ids], `home` = placement BU, `sources` = `RoleSources(principal)` from Task 10):

- `Depth(K, a)` (program ruling PR5): the Or, over every role source `s` in `sources`, of `DepthAt(K, SourceLevel(s, a, K), s.BusinessUnitId)`. A role assigned directly is judged against the principal's home BU, and a role held through a team against that team's BU. The Or drops `False` terms, is `True` when any term is `True`, is the single term when only one remains, and is `False` when none remains.
- `DepthAt(K, level, bu)` for owned K: Organization → `True`; BusinessUnitAndChildren → `In(owningBusinessUnit, [bu, ...DescendantsOf(bu)])`; BusinessUnit → `Compare(owningBusinessUnit, Eq, bu)`; User → `In(owner, owners)` for every source; None → `False`. For unowned K: Organization → `True`, else `False`. A concept no effective role covers is therefore invisible (spec §4.3).

1. Inactive principal (`model.IsActive` false) → `AccessScope.Build({ Default: AccessDefault.Deny })`.
2. System Administrator → `AccessScope.Build({ Default: Allow, Writes: { [Owned]: { ReadOnly: { Create: {owner, owningBusinessUnit}, Update: {owner, owningBusinessUnit} } } } })`. Reads stay unrestricted. Only assign (rule 7) writes the system fields. Ruled PR1: this deviation from C6's `AccessScope.System` is accepted, and S1's `SystemFieldGuard` applies over it as over every runtime scope.
3. Otherwise `Default: Allow`, because concepts bound to external connectors get no entries and stay outside the model (§6). Every engine-stored concept K except `TodlNames.Element`, `TodlNames.Term`, `SystemNames.ShareGrant` and the edge concepts (`security.EdgeConcepts`, rule 6) gets these entries:
   - `Rows[K] = G(K, Or(Depth(K, read), W(read)))`
   - `Writes[K] = { Create: G(K, Depth(K, create)), Update: G(K, Or(Depth(K, update), W(update))), Delete: G(K, Or(Depth(K, delete), W(delete))), Append: G(K, Depth(K, append)), AppendTo: G(K, Depth(K, appendTo)), ReadOnly }` (program ruling PR3: links follow Append on the source and AppendTo on the target, not Update).
   - `W(r)` = `ShareGrantScope.Widening(subjects, r)` for owned K, and `False` for unowned K.
   - `G(K, p)`: `p` is `True` → `True`; `p` is `False` → `Not(ConceptIs K)`; otherwise `Or([Not(ConceptIs K), p])`. This is the R93 own-concept guard: a parent's rule never judges a subconcept's instances.
4. Field security: for each secured (K, f) the principal cannot read, add f to `Hidden[K]`. `Hidden`, not `HiddenExact`, so subconcepts and carriers inherit it. A readable secured field without update goes into `Writes[K].ReadOnly.Update`, and one without create into `Writes[K].ReadOnly.Create`. (S1 rejects a profile entry that writes without reading, PR8.)
5. System fields: `Writes[SystemNames.Owned] = { ReadOnly: { Create: {owner, owningBusinessUnit}, Update: {owner, owningBusinessUnit} } }`. Placement defaults (`GraphTransaction.SetDefault`) are exempt per R92.
6. Platform concepts and edges:
   - Ruled PR6: platform vocabulary is readable by all and writable by none at runtime. `Rows[TodlNames.Term] = True`; `TodlNames.Element` gets no Rows entry (one would apply to every concept below it, and Default Allow already admits its own instances). The Create, Update and Delete of both `Writes[TodlNames.Term]` and `Writes[TodlNames.Element]` are guarded `False`, so they bind only those concepts' own instances (taxonomy terms are platform schema, ruling F-b).
   - `Rows[ShareGrant] = G(ShareGrant, ShareGrantScope.GrantRows(subjects))`, and its Create / Update / Delete are guarded `False` (the share service writes grants as the system principal). `subjects` = `{ PrincipalId, Teams: active team ids }`.
   - Edge concepts (program ruling PR4): every `security.EdgeConcepts` entry becomes `Endpoints[Concept] = { From, To }` (S2 Task 3), with no Rows and no Writes entry. Such a node is visible iff both endpoint nodes are visible, and the engine judges its writes by its endpoints' Append/AppendTo rules from rule 3. The System Administrator scope (rule 2) and the inactive scope (rule 1) carry no `Endpoints`.
7. `CompileAssign`: the same as `Compile`, except that for owned K `Writes[K].Update = G(K, Or(Depth(K, assign), W(assign)))` and `Writes[Owned]` has no `ReadOnly`. For a System Administrator it is `AccessScope.Build({ Default: Allow })`. Ruled PR2: this is the assign scope S1's `OwnershipAssignment.Assign` requires, and S4 opens assign operations under it.

- [ ] **Step 1: Write the failing unit tests** (a `Tier1Fx` with an `ISchemaDescription` literal: aspect `todl.system.Owned` {owner, owningBusinessUnit}; `todl.Element`; `todl.Term`; `todl.system.ShareGrant`; `hr.Employee` (Owned; Name, Salary, NationalId); `projects.Project`, `projects.Task` (Owned); `projects.Assignment` (edge concept: single-valued relationships `from` → `hr.Employee`, `to` → `projects.Project`, listed in `EdgeConcepts`); BUs `contoso` → `sales`, `marketing`; team `mkt` in `marketing`; `contractors.Contractor extends hr.Employee` (Owned, another package, no contributions); `sales.Account` bound by `Bindings: [{ Model: "sales", Concept: "sales.Account", Connector: "crm" }]`; `HomeModels` accordingly):
  - `inactive principal compiles to a deny-all scope` — `scope.Default === AccessDefault.Deny` and `scope.Rows.size === 0`, even with a manual `hr` row and a direct `BasicUser` assignment.
  - `system administrator reads unrestricted but cannot write system fields` — `scope.ReadsUnrestricted` is true, and `scope.Writes.get("todl.system.Owned")?.ReadOnly?.Update` has `owner`.
  - `external concepts get no entries and default allow` — `scope.Rows.has("sales.Account") === false`, `scope.Default === Allow`.
  - `uncovered engine concept is invisible` — Reader, with no contributions on `projects.Task` → `Rows.get("projects.Task")` deep-equals `new Not(new ConceptIs("projects.Task"))`.
  - `depth encodes over the fixed system fields only` — Sales Basic User: `Rows.get("hr.Employee")` deep-equals `Or([Not(ConceptIs hr.Employee), Or([Compare(owningBusinessUnit, Eq, "sales"), Widening(read)])])`. Assert that `Predicate.MemberNames` of every Rows entry ⊆ {`owner`, `owningBusinessUnit`, `subjectKind`, `subjectId`, `read`, `update`, `delete`}. This pins the anti-goal "no decision reads an app-declared field".
  - `secured field stays hidden on a subconcept and depth rules do not leak across concepts` — `Hidden.get("hr.Employee")` has `Salary` (inherits to `contractors.Contractor`). The `hr.Employee` row's guard is `ConceptIs("hr.Employee")` exactly. `Rows.get("contractors.Contractor")` is its own guarded `False`.
  - `field profile grants read; update absent makes it read-only` — a profile `{Salary: read}` → `Salary` is not hidden, and `Writes.get("hr.Employee").ReadOnly.Update` has it.
  - `append and appendTo compile from their own depths` (PR3) — with BasicUser contributing `append = user` and `appendTo = businessUnit` on `projects.Project`, `Writes.get("projects.Project").Append` deep-equals `G(projects.Project, In(owner, owners))` and `.AppendTo` deep-equals `G(projects.Project, Compare(owningBusinessUnit, Eq, "sales"))`; with no append privilege, `Append` is the guarded `False`. Neither depends on the update level.
  - `edge concepts are governed by their endpoints only` (PR4) — `scope.Endpoints.get("projects.Assignment")` deep-equals `{ From: "from", To: "to" }`; `Rows.has("projects.Assignment")` and `Writes.has("projects.Assignment")` are false; a System Administrator's and an inactive principal's scopes carry no `Endpoints`.
  - `a role held through a team judges BU depth against the team's unit` (PR5) — Erin (home `sales`) holds `projects.ProjectManager` through `mkt` with an override to read `businessUnit`, and BasicUser directly with read `user`. `Rows.get("projects.Project")` deep-equals `G(projects.Project, Or([In(owner, ["erin", "mkt"]), Compare(owningBusinessUnit, Eq, "marketing"), Widening(read)]))`: no term names `sales`.
  - `platform vocabulary is readable by all and writable by none` (PR6) — `Rows.get("todl.Term")` is `True`; `Rows.has("todl.Element")` is false; `Writes.get("todl.Term")` and `Writes.get("todl.Element")` have Create, Update and Delete equal to the guarded `False`, for a Basic User and for a principal with no roles.
  - `CompileAssign lifts system-field read-only and gates update by assign depth` — and it is the scope S1's `OwnershipAssignment.Assign` runs under (PR2): an integration step assigns a Project to `mkt` under it and commits.
  - `Grants exposes levels for append/share/invoke` — `Grants(...).Level(PrivilegeAction.Invoke, "projects.Project")` equals the contributed level.
  - `scope validates against the catalog` — `ScopeValidator` (or `GraphStore.BeginRead` in the integration test) accepts every compiled scope for the fixture description.

- [ ] **Step 2: Write the failing integration test** (fixture pattern from `pragmatic-graph/src/access/tests/ReadScope.test.ts`: `GraphStore.OpenMemory()`, `Upgrade(description)`, create nodes under `AccessScope.System` with `owner`/`owningBusinessUnit` set, then `BeginRead(Tier1ScopeCompiler.Compile(...))`). It checks spec §9.2:
  - Alice (Sales, Project Member) sees P1 (hers) and P2 (Bob's, shared with a ShareGrant `read: true`), and does not see T3 (Carol's).
  - Project Manager with BU+children on `contoso` sees all projects; after the environment override to BU only, they see only those in their BU.
  - Dana disabled → `BeginRead` with her scope sees nothing.
  - PR5: Erin, a Sales user holding Project Manager (read overridden to BU) via the Marketing team `mkt`, sees Marketing's projects and not Sales' projects that are not hers.
  - PR4: an `Assignment` whose `to` project Alice cannot see is neither returned by `MATCH (a:projects.Assignment) RETURN a` nor counted by `RETURN count(a)`.

- [ ] **Step 3: Run to verify failure.** `npx tsx --test src/scope/tests/*.test.ts` → FAIL.

- [ ] **Step 4: Implement** to the rules above. Hoist every name to `private static readonly` constants, or take it from S1's `SystemNames` / `TodlNames`.

- [ ] **Step 5: Run to verify pass.** `npm test && npm run typecheck && npm run build` → green. Then rebuild-check the dependents inside the identity family: `npm run build` in `todl-identity-node` and `todl-identity-cloud` → green.

- [ ] **Step 6: Commit** — `feat(identity-engine): Tier1ScopeCompiler — package security + environment setting to engine AccessScope`.

---

## Self-review notes

- Spec coverage: §4.1 → Tasks 3, 4, 6, 7, 8. §4.2 → Tasks 2, 10 (placement, root default). §4.3 (base roles, package roles, overrides, effective role, uncovered → SA only) → Tasks 1, 10, 11. §4.4 fixed fields → Task 11 rules 3 and 5 (owner backfill: S4 Task 13, ruled PR16). §4.5 sharing → Task 11 `W`. §4.6 → Tasks 10, 11 rule 4. §5 depth → Task 11. §5.1 system principal → Tasks 1, 10. §6 per-user tokens → Tasks 5, 6, 8. §8 retirements → Tasks 2, 9, 10. §9.5 local groups → Tasks 6, 7. Engine-side edge visibility, nonexistent-field and conflict rules are S2's; S3 compiles edge concepts into S2's `Endpoints` (PR4, Task 11 rule 6) and Append/AppendTo into `Writes` (PR3, rule 3). Program rulings carried: PR1 (rule 2), PR2 (rule 7), PR3 (rule 3), PR4 (rules 3, 6), PR5 (Tasks 10, 11), PR6 (rule 6), PR7 (Task 8), PR16 (above), PR17 (Global Constraints, Task 11), PR18 (Task 7). tenant-admin UX and environment creation are S4's.
- Type names are consistent across tasks: `IdpDirectorySnapshot`, `TeamMembershipRows`, `EffectiveRoleTable`, `Tier1Diagnostic`, `ITier1Catalog`, `Tier1Grants`, `SourceTokenRequest`/`SourceToken`/`ISourceTokenProvider`.
