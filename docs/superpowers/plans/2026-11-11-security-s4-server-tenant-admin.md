# Security S4 — server, protocol and tenant-admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Runtime environments enforce tier-1 platform security from the environment's setting (C5) and the deployed packages' security (C2): the environment is created with its creator as System Administrator, every connection's engine scope is compiled by `Tier1ScopeCompiler` (C6), work no user started runs as the system principal (C7), deploys apply their security diff in the same step as the catalog swap and show it afterwards in the deploy result and the change log (program ruling PR14: no pre-deploy preview in v1), tenant-admin edits the setting through override editors, and every server-side tier-2 path is gone.

**Architecture:** The server keeps M2.3's engine seam (`AccessScopeSource` + `IScopeRules`, `EnvironmentEngineHost`); this plan changes what the rules compile (tier 1 instead of policy ∧ depth), adds an `EnvironmentSecuritySetting` (the C5 setting, cached, with a `Changed` signal) in place of `TenantReadAuthorization`, hooks a `DeliverySecurity` into `EnvironmentEngineHost.Deliver`, and extends the existing `admin/security-model/*` wire with catalog, team-member and change-log reads. tenant-admin keeps its one-draft security editor (TA-9/TA-10) but every role, profile, concept and secured field now comes from the environment's catalog; the admin edits only placement, teams, assignments and overrides.

**Tech Stack:** TypeScript (ESM, NodeNext), `tsx --test`; `@pragmatic-tech-ai/todl` (`/engine`), `@pragmatic-tech-ai/graph`, `todl-identity` / `todl-identity-engine` (S3), `pragmatic-protocol` 0.11.0 → 0.12.0; Mural (tenant-portal VMs).

**Spec:** `pragmatic-server/docs/superpowers/specs/2026-11-11-platform-security-architecture-design.md` (binding). Program index + contracts: `pragmatic-server/docs/superpowers/plans/2026-11-11-platform-security-program.md` (C2, C5, C6, C7 consumed; the index wins over this plan's naming, and its program rulings PR1–PR18 win over this plan). Builds on M2.3 `pragmatic-server/docs/superpowers/plans/2026-11-10-runtime-graph-on-engine.md` as amended by Task 1.

## Global Constraints

- Code style (global CLAUDE.md): OOP — no module-level functions or module-level mutable variables (module `const` only for true constants); Allman braces (object literals, arrow bodies and one-line blocks stay inline); PascalCase for every interface and public method; no inline string literals in TS — user-facing text and reused literals are `private static readonly` PascalCase constants (`.mu` labels stay inline); enums over string-literal sets; view models extend `Observable`, never `MuralBase`; `dispose()` teardown, `Disposable` not lambdas.
- Tests live in `tests/` subfolders next to the code (server `src/**/tests/`, control plane `admin/control-plane/tests/`, portal `admin/tenant-portal/src/**/tests/`, protocol `src/tests/`).
- Never run `npm install` (it breaks the workspace `file:` symlinks). Siblings are consumed as built `dist`: rebuild a sibling (`npm run build`) before a dependent sees its edits.
- Layering: the engine and TODL never call up; they only raise signals. Every runtime access decision is compiled into the engine `AccessScope`; no endpoint filters or masks itself. No decision reads an app-declared field (spec §2 anti-goal).
- Research mode: retired code is deleted, not shimmed; no compatibility path for the old `SecurityModelDto`. Stored old-shape settings are not read by the server either: S3 Task 7's one-time `SecurityModelMigration` rewrites them on `Open` (program ruling PR18; kept because environments exist in the field, and not a runtime shim).
- Server branch base is `master`; work on `feat/security-s4` in pragmatic-server and pragmatic-protocol. LF line endings only. No push; the controller merges and publishes.
- Every task ends green for each repo it touches: server `npm test`, `npm run build`, `npx tsc -p tsconfig.json --noEmit`; control plane `npx tsx --test admin/control-plane/tests/*.test.ts`, `npm run typecheck:tools`, `npm run build:tenant-admin`; portal (`admin/tenant-portal`) `npm test`, `npm run typecheck`; protocol `npm test`, `npm run build`. Each task updates `ARCHITECTURE.md` in the commit that moves a seam, deletes what it made dead, and fixes every review finding including minors.

## Review Focus

1. A deploy drops a concept or a role, a later deploy brings it back: the dropped override and the removed role's assignments must not reappear, and the change log must show both events. → Task 13 test `returned concept does not resurrect a dropped override`.
2. An admin saves an override the model cannot mean — a BU depth on an organisation-owned concept, any override on an external (connector) concept, any override of SystemAdministrator, an unknown role/concept/profile, a profile override on a field that is not secured: the save is refused with a fixed reason and the stored setting is unchanged. → Task 9 tests `catalog check rejects …` (one per code) and `refused set leaves the setting unchanged`.
3. One principal is both an IdP-synced and a manual member of a team: two rows are shown, removing the manual row keeps the synced one; removing the IdP group link keeps the manual one. → Task 5 test `both origins show two rows`, Task 10 test `team members carry origin`.
4. A setting edit or a deploy lands while a paged query is in flight: pages already served stay consistent, the next page under the changed security is `CursorStale`, an in-flight read finishes under the old security. → Task 9 test `security edit stales the cursor`, Task 13 test `in-flight read keeps the old security`.
5. Environment creation succeeds up to "healthy" but seeding its security fails (env server unreachable, refused set): no environment is left running without an administrator — the create rolls back like a bring-up failure. → Task 11 test `seed failure rolls the create back`.

---

## Shared wire shapes (pinned here; Task 3 mirrors them in the portal, Tasks 9, 10, 13 add them to the protocol)

Protocol `src/dto/wire-dtos.ts` (portal `src/tenant-types.ts` copies them verbatim, house ruling B1-3 R4). Action/level strings are the C1 values (`invoke` included).

```ts
export interface BusinessUnitDto { id: string; name: string; parent?: string }            // unchanged
export interface UserPlacementDto { principalId: string; businessUnitId: string }
export interface TeamDto { id: string; name: string; businessUnitId: string; idpGroups: string[]; manualMembers: string[] }
export interface RoleAssignmentDto { role: string; principalIds: string[]; teamIds: string[] }
export interface ProfileAssignmentDto { profile: string; principalIds: string[]; teamIds: string[] }
export interface RoleOverrideDto { role: string; concept: string; action: string; level: string }
export interface ProfileOverrideDto { profile: string; concept: string; field: string; read: boolean; update: boolean; create: boolean }
export interface SecurityModelDto { businessUnits: BusinessUnitDto[]; users: UserPlacementDto[]; teams: TeamDto[]; roleAssignments: RoleAssignmentDto[]; profileAssignments: ProfileAssignmentDto[]; roleOverrides: RoleOverrideDto[]; profileOverrides: ProfileOverrideDto[] }

export enum SecurityRoleKind { Base = 'base', Package = 'package' }
export interface PrivilegeDto { action: string; concept: string; level: string }           // unchanged
export interface SecurityRoleDto { name: string; kind: SecurityRoleKind; package?: string; defaults: PrivilegeDto[] }
export interface SecurityConceptDto { name: string; package: string; owned: boolean }
export interface SecuredFieldDto { concept: string; field: string }                         // unchanged
export interface FieldAccessDto { concept: string; field: string; read: boolean; update: boolean; create: boolean }
export interface SecurityProfileDto { name: string; package: string; defaults: FieldAccessDto[] }
export interface SecurityCatalogDto { roles: SecurityRoleDto[]; concepts: SecurityConceptDto[]; securedFields: SecuredFieldDto[]; profiles: SecurityProfileDto[] }

export enum TeamMemberOrigin { Synced = 'synced', Manual = 'manual' }
export interface TeamMemberDto { principalId: string; origin: TeamMemberOrigin }
export interface ListTeamMembersParams { teamId: string }

export interface RoleDefaultChangeDto { role: string; concept: string; action: string; before: string; after: string }
export interface ProfileDefaultChangeDto { profile: string; concept: string; field: string; before: FieldAccessDto | null; after: FieldAccessDto | null }
export interface SecurityChangesDto { at: string /* ISO */; delivery: string; version: string; roleDefaults: RoleDefaultChangeDto[]; profileDefaults: ProfileDefaultChangeDto[]; securedFieldsAdded: SecuredFieldDto[]; securedFieldsRemoved: SecuredFieldDto[]; roleOverridesDropped: RoleOverrideDto[]; profileOverridesDropped: ProfileOverrideDto[]; rolesRemoved: RoleAssignmentDto[]; profilesRemoved: ProfileAssignmentDto[] }
```

Deleted from the wire: `TeamDto.owningBusinessUnit`, `MembershipClaimRuleDto`, `MembershipOverrideDto`, `MembershipDto`, `OwnershipSourceDto`, `OwnershipRuleDto`, `RoleConfigDto`, `RoleClaimRuleDto`, the old `RoleOverrideDto` / `TeamRoleGrantDto` / `RoleAssignmentDto`, `FieldGrantDto`, `FieldProfileDto`, `FieldProfile{ClaimRule,Override,TeamGrant,Assignment}Dto`, `FieldSecurityDto`. `AppDeployResultDto` gains `securityChanges?: SecurityChangesDto`.

Methods (`AdminProtocol`, all `administer` in `PolicyGate`): existing `GetSecurityModel` / `SetSecurityModel` (new shape); `GetSecurityCatalog = RequestType0<SecurityCatalogDto, void>('admin/security-catalog/get')`; `ListTeamMembers = RequestType<ListTeamMembersParams, TeamMemberDto[], void>('admin/team-members/list')`; `ListSecurityChanges = RequestType0<SecurityChangesDto[], void>('admin/security-changes/list')`.

tenant-api (`/api/environments/<env>/admin/<leaf>[/<tail>]`, `TenantApiEndpoint.AdminPathPattern`): `security-model` GET/PUT (existing), `security-catalog` GET, `team-members/<teamId>` GET, `security-changes` GET. Reads need no capability; PUT keeps `AccessCapability`.

## Dependencies and order

| Task | Starts | Waits on |
|---|---|---|
| 1 M2.3 amendment | now | — |
| 2 retire server tier 2 | now (must merge before M2.3 starts, and before S1 Task 1 deletes TODL `PolicyScopeCompiler` on TODL `main`: PR17) | — |
| 3–8 tenant-admin portal | now (fake control plane) | Task 3 before 4–8; Task 6 before 7 |
| 9 S3 cutover | after M2.3 merged; the S3 identity repos merge together with this task (PR17) | **S2** Tasks 2–3 (Append/AppendTo, `Endpoints`); **S3** Tasks 2, 9–11 (C5 `ISecurityModelConfig`, `SecurityModelValidator`, `TenantSecurityModel.FromConfig(config, directory)`, `Tier1ScopeCompiler` C6, `Tier1Grants`, `AccessDepthEvaluator.AssignWrites`), S3 Task 7 (`FileTenantConfigStore` migration); **S1**: C2 `IEnvironmentCatalog.Security` (with `EdgeConcepts`), Task 9 `SystemFieldGuard`, Task 10 `OwnershipAssignment` |
| 10 IdP sync + admin catalog + team members | after 9 | **S1** C2; **S3** Tasks 3–4 (`IdpDirectorySync`, `IIdpDirectoryStore`, `TeamMembershipRows`) |
| 11 environment creation seed | after 9, 10 | — (S3 via 9) |
| 12 system principal + connector context | after 9 | **S3** C7 `system:<environmentId>` principal, Task 5 `ISourceTokenProvider` (Tasks 6–8 implementations); **S2** Task 6 `ConnectorContext`; **S1** Task 11 (data-source calls carry the context) |
| 13 deploy security diff + owner backfill (PR16) | after 9, 12 | **S1** C2 (+ C3 ownership fields and Task 10 `OwnershipAssignment` for the backfill); M2.3 Task 6 delivery sequence |
| 14 capstone e2e | last | **S1**, **S2**, **S3** complete; Tasks 9–13 |

## Program rulings this plan carries (answered owner questions)

- **PR13 Tenant purpose.** Development (dev-edit) tenants refuse the security setting (Task 9 `development tenant refuses the setting`; Task 10 reads refuse it too); access there is identity RBAC at the `PolicyGate` (spec §5.1). Only Runtime environments seed the creator as System Administrator (Task 11). The Development "create graph" tab stays (Task 3).
- **PR14 Deploy diff.** Recorded and shown after the deploy (the deploy result's `securityChanges` and the change log, Tasks 8 and 13); there is no pre-deploy preview in v1.
- **PR15 Profile overrides** may target any package's secured field, with the same freedom as role overrides (Tasks 7 and 9).
- **PR16 Owner backfill** when an upgrade adds `Owned` to a concept with live records is this plan's: Task 13, as the system principal, at deploy. S1 does not backfill.
- **PR17 Merge order.** Task 2 merges before S1 Task 1 (TODL `PolicyScopeCompiler` deletion) and before M2.3 starts. The S3 identity repos merge together with Task 9, because S3 breaks the server's imports.
- Also applied: PR1 (Task 9: `SystemFieldGuard` over every runtime scope), PR2 (Tasks 9, 13: assign under `CompileAssign` through `OwnershipAssignment`), PR3/PR4 (Task 9: `AccessScopeConjunction` carries Append, AppendTo and Endpoints), PR12 (Task 12), PR18 (Global Constraints).

---

### Task 1: Amend the M2.3 plan (doc only)

**Files:**
- Modify: `docs/superpowers/plans/2026-11-10-runtime-graph-on-engine.md` (append the section below after "Owner answers"; strike nothing above it)

**Interfaces:** none (plan text). M2.3's executor reads the amendment as binding.

- [ ] **Step 1: Append this section verbatim**

```markdown
## Amendment 2026-11-11 — platform security (security S4 Task 1)

Binding: `docs/superpowers/specs/2026-11-11-platform-security-architecture-design.md` §5, §6, §8 and
`docs/superpowers/plans/2026-11-11-platform-security-program.md` C6. Where this section and the text above
disagree, this section wins.

- **A1 Tier 2 is gone.** No `access-policy.json`, no model policy declarations, no `PolicyScopeCompiler` on
  either purpose (security S4 Task 2 removed them from `master`; this plan starts from that commit). The Q2
  answer ("both apps' policies apply, deny wins") and Q8 are void; the spec §11.1 "ungoverned app-private
  concepts are policy-only" bypass no longer applies. Review Focus 5's second clause reads "a security-setting
  edit between pages stales the cursor".
- **A2 Task 2.** `IPreparedRules` becomes `{ Records(context: AccessContext): Promise<{ Scope: AccessScope;
  Diagnostics: readonly string[] }>; Finish(scope, context): Promise<AccessScope>; Placement(defaults:
  IPlacementDefaults, modelId: string | undefined): Cypher.INodePlacement; readonly Digest: string }`.
  `AccessScopeSource(host, rules, diagnostics?)` no longer composes policy and depth itself: `Records` is the
  scope's record/field part, `Finish` follows; identity state moves into the rules. `DevScopeRules.Records` =
  M1's `DepthScopeCompiler.Compile(...)` alone. `DepthScopeCompiler` gains `Skip` only — no `Bypass`. Drop the
  test `bypassed concept has no depth entries`; add `rules records are the scope record part`.
- **A3 S5 rewritten.** `Final = Finish(Records)`. Runtime `Records`, interim until security S4 Task 9 replaces
  it with `Tier1ScopeCompiler` (C6): `DepthScopeCompiler.Compile(evaluator, principal, description, hasModel,
  { Skip: concept => the concept, or an ancestor, has an external binding in catalog.Identity })` — connector
  concepts get no Rows/Writes entries and fall to Default Allow (spec §6: connectors are outside the model).
  `Finish` (a)–(d) unchanged, except (a) widens engine-stored concepts only. `Digest` drops `PolicyDigest`.
- **A4 S8/S9.** Share, unshare, list and assign on an external record answer `invalid`
  `ExternalRecordReason = 'external records are outside platform security'`. The [O1]-tagged tests `shared
  external record` and `assign an external record` become `external record cannot be shared` / `external record
  cannot be assigned`; O1 remains for S10 and S14 only.
- **A5 Task 7 tests.** Remove: `governed concept gets policy and depth`, `ungoverned app-private concept is
  policy only`, `ungoverned concept delivered twice is not bypassed`, `promote-only ungoverned concept is
  denied`, `two apps' rules on one concept both apply`, `malformed policy fails its own concepts closed`,
  `unparseable rules are fatal for the app`, `policy on an unknown concept is ignored`, `numeric policy values
  are typed`, `policy edit stales the cursor`. Add: `governed concept gets depth` (User-level rule → own rows
  only); `external concept is outside the scope` (a principal holding nothing on the bound concept reads and
  writes its rows; no Rows/Writes key for it); `policy files are not read` (an `access-policy.json` in the app
  directory changes nothing); `security-model edit stales the cursor`. Consumes drops `FromRules`,
  `AccessPolicySetting`, `GovernedConceptsFor`, `IPolicyRuleSource`. `EnvironmentFixture` writes no policy files.
- **A6 Task 11.** `connector/*` reads and writes of connector-bound concepts are not gated by `Records` (A3);
  engine-stored concepts keep the caller scope.
- **A7 Task 14.** The runtime scope-invariant fixture uses depth-governed engine concepts plus one external
  binding whose rows every principal sees. Security S4 Task 9 rebases it on tier 1.
- **A8 Task 16.** Drop "whole-app fail-closed on any MalformedPolicy (R117)"; record A1–A7.
- **A9 Order.** This plan executes after security S4 Task 2 is on `master`; security S4 Task 9 follows this
  plan's merge and replaces `DepthScopeCompiler`, `TenantReadAuthorization` and the depth-based share/assign
  checks.
```

- [ ] **Step 2: Verify** `grep -n "Amendment 2026-11-11" docs/superpowers/plans/2026-11-10-runtime-graph-on-engine.md` → one hit; every test name A5 removes exists above it (`grep -c` per name ≥ 1).
- [ ] **Step 3: Commit** `docs(plan): amend M2.3 for platform security (tier 1, connectors excluded)`.

### Task 2: Server — retire tier 2

**Merge order (PR17):** merges to `master` before M2.3 starts and before S1 Task 1 (which deletes TODL `PolicyScopeCompiler`) reaches TODL `main`.

**Files:**
- Delete: `src/host/apps/access-policy-setting.ts`, `src/host/apps/tests/access-policy-setting.test.ts`, `src/host/tests/app-private-concept-governance.test.ts`
- Modify: `src/pragmatic-server.ts` (`WriteInstanceGate` predicate → `AllowAllInstanceFilter`; `GraphForPragmaticApp` without `IdentityEnforcement`/`PolicyCatalog`, filter = depth only, no `ConceptBypassInstanceFilter`; `PushDownFor(query, schema)` = `Cypher.CypherPushDown` alone; delete `AppPrivateConcepts`, `OwnConcepts`, `AppBase.ownConcepts`); `src/host/cypher/read-filter-source.ts` (`GovernedConceptsFor` removed from `IReadFilterSource` and both impls); `src/host/model-read-filter.ts` (`PolicyNodeGate` deleted; `ModelReadFilter(model, mask)` keeps every node, masks fields); `src/host/server-connection-handler.ts` (its two `ModelReadFilter` call sites); `src/host/engine/dev-access-scope-source.ts` (`SchemaState.Policies` and the `PolicyScopeCompiler` import deleted; no identity → `AccessScope.Build({ Default: AccessDefault.Allow })`; identity → `depth.Scope()` alone); `ARCHITECTURE.md` ("Push-down (runtime)", "DevAccessScopeSource", "Identity / RBAC")
- Test: update every test that wrote `access-policy.json` or a TODL `policy` (find with the grep in Step 3: `cypher/tests/pp-security-harness.ts`, `graph-for-pragmatic-app*.test.ts`, `engine/tests/{dev-access-scope-source,dev-cypher-query,dev-cypher-execute,dev-model-view,scope-invariant,dev-scope-fixture}.ts`, `host/tests/{runtime-app-surface,cypher-model-scoped,graph-scope-unchanged}.test.ts`, `tests/e2e/sp{0,1}-capstone-e2e.test.ts`); new cases in `src/host/tests/tier-two-retired.test.ts`

**Interfaces:**
- Produces: `ModelReadFilter(model: Repository, mask: IFieldReadMask)`; `IReadFilterSource { ReadFilterFor(ctx); HasSecurityModelFor(ctx) }`. TODL `PolicyScopeCompiler`, todl-identity-engine `PolicyCatalog` / `IdentityEnforcement` / `ConceptBypassInstanceFilter` have no server importer afterwards: S1 Task 1 deletes `PolicyScopeCompiler` once this task is on `master` (PR17), and S3 Task 9 deletes the others.

- [ ] **Step 1: Failing tests** in `src/host/tests/tier-two-retired.test.ts`: `access-policy file is ignored` (runtime app with an `access-policy.json` denying every row of `crm.Account`; a principal whose depth admits the row still reads it via `cypher/query`); `own concept the security model does not govern is denied` (the former app-private bypass case: `notes.Note` ungoverned → invisible, create `denied`); `dev model policy is ignored` (a saved `.todl` source declaring a read policy on `Order`; the dev `cypher/query` row set equals the same tenant without the policy); `runtime model view ignores model policies` (`model/view` lists an instance a model policy would hide).
- [ ] **Step 2: Run** `npx tsx --test src/host/tests/tier-two-retired.test.ts`. Expected: FAIL on all four.
- [ ] **Step 3: Delete and rewire** as listed; then `grep -rn "AccessPolicySetting\|access-policy\|PolicyScopeCompiler\|PolicyCatalog\|IdentityEnforcement\|ConceptBypassInstanceFilter\|GovernedConceptsFor\|AppPrivateConcepts\|OwnConcepts" src` → no hits. Port each listed test by deleting its policy-only cases and keeping depth/field/share assertions unchanged.
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `refactor!: retire tier-2 access policies, model policies and app-private governance`.

### Task 3: Portal — C5 setting, catalog and draft foundation

**Files:**
- Modify: `admin/tenant-portal/src/tenant-types.ts` (the shared wire shapes above; retired DTOs deleted; `ISecurityModelSource` gains `GetSecurityCatalog(env: string): Promise<SecurityCatalogDto>`, `ListTeamMembers(env: string, teamId: string): Promise<TeamMemberDto[]>`, `ListSecurityChanges(env: string): Promise<SecurityChangesDto[]>`); `src/tenant-api-client.ts` (those three over leaves `AdminSecurityCatalogLeaf = '/admin/security-catalog'`, `AdminTeamMembersLeaf = '/admin/team-members'` + `/` + `encodeURIComponent(teamId)`, `AdminSecurityChangesLeaf = '/admin/security-changes'`); `sections/users-access/security-model/security-model-enums.ts` (`PrivilegeAction.Invoke = 'invoke'`, appended to `Actions`); `security-model-draft.ts` (rewritten); `sections/users-access/users-access-page-view-model.ts` (Roles & permissions shown for `EnvType.Runtime` environments only, else `DevelopmentEnvironmentText = 'Development environments are governed by tenant access, not by a security setting.'`; PR13: the Development "create graph" tab stays as it is); `tests/fake-tenant-control-plane.ts` (C5 default model with a root unit, catalog fixture with the three base roles + `projects` roles, team members, change log; the three new GET leaves)
- Create: `security-model/security-overrides.ts`, `security-model/security-assignments.ts`
- Delete: `security-model/security-model-assignment.ts`, `record-sharing.ts`, `role-holders.ts` and their tests
- Test: `security-model/tests/security-model-draft.test.ts` (rewritten), `tests/security-overrides.test.ts`, `src/tests/tenant-api-client.test.ts` (three new routes)

**Interfaces:**
- Produces (portal):
  - `class SecurityModelDraft { constructor(model: SecurityModelDto, catalog: SecurityCatalogDto); readonly Catalog: SecurityCatalogDto; readonly Org: SecurityModelOrg; readonly Assignments: SecurityAssignments; readonly Overrides: SecurityOverrides; get Dirty(): boolean; ToDto(): SecurityModelDto }` — `ToDto()` emits exactly the seven C5 keys, deep-cloned.
  - `class SecurityOverrides { DefaultLevel(role, concept, action: PrivilegeAction): AccessLevel; OverrideLevel(role, concept, action): AccessLevel | undefined; EffectiveLevel(role, concept, action): AccessLevel; SetLevel(role, concept, action, level): void /* equal to default → override removed */; Reset(role, concept, action): void; DefaultField(profile, concept, field): FieldAccess; OverrideField(profile, concept, field): FieldAccess | undefined; EffectiveField(...): FieldAccess; SetField(profile, concept, field, permission: FieldPermission, value: boolean): void /* equal to default → removed */; ResetField(profile, concept, field): void; IsOrganizationOwned(concept): boolean; AllowedLevels(concept): readonly AccessLevel[] /* org-owned: [None, Organization] */ }`; `FieldAccess { Read: boolean; Update: boolean; Create: boolean }` (a class with a static `None`).
  - `class SecurityAssignments { Holders(role): { PrincipalIds: readonly string[]; TeamIds: readonly string[] }; AddPrincipal(role, id); RemovePrincipal(role, id); AddTeam(role, teamId); RemoveTeam(role, teamId); ProfileHolders(profile); AddProfilePrincipal / RemoveProfilePrincipal / AddProfileTeam / RemoveProfileTeam }` — an assignment with no holders is dropped from `ToDto()`.
  - Defaults come from `SecurityCatalogDto`; an override row whose role, concept or profile the catalog lacks is kept in `ToDto()` untouched (the server prunes on deploy, Task 13).

- [ ] **Step 1: Failing tests:** `round trip preserves every section` (load a full C5 model → `ToDto()` deep-equals it); `retired sections are not emitted` (`Object.keys(ToDto()).sort()` equals the seven keys); `override differing from default is stored` (`projects.ProjectManager`/`projects.Project`/read default `businessUnitAndChildren` → `SetLevel(…, businessUnit)` → one `roleOverrides` row); `override equal to default is removed`; `reset removes the override`; `organisation-owned concept allows none and organization only`; `field override equal to default is removed`; `invoke is a matrix action`; `client routes` (`GetSecurityCatalog('dev')` → GET `/api/environments/dev/admin/security-catalog`; `ListTeamMembers('dev','t 1')` → `/admin/team-members/t%201`; `ListSecurityChanges` → `/admin/security-changes`); `development environment hides the editor`; `development environment keeps the create-graph tab` (PR13).
- [ ] **Step 2: Run** `cd admin/tenant-portal && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the types, client methods, draft sections and fake control plane; the editor VM (`security-model-editor-view-model.ts`) loads model and catalog together (one busy run, `Promise.all`) and builds the draft from both; its retired members are removed in Tasks 4–8 (until then they compile against the new draft or are deleted here if they cannot).
- [ ] **Step 4: Run** portal `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenant-admin): C5 security setting and catalog-backed draft`.

### Task 4: Portal — business units and user placement

**Files:**
- Modify: `security-model/security-model-org.ts` (BU methods kept; `Users`, `PlaceUser(principalId, businessUnitId)`, `UnplaceUser(principalId)`, `CanRemoveBusinessUnit(id): boolean`; membership-rule, membership-override and ownership-rule methods deleted); `security-model-org-rows.ts` (`UserPlacementRowViewModel extends OrgRowViewModel`; `MembershipRuleRowViewModel`, `MembershipOverrideRowViewModel`, `OwnershipRuleRowViewModel` deleted); `security-model-editor-view-model.ts` (`OrgTab { BusinessUnits, People, Teams }`; `UserRows`, `NewUserPrincipalId`, `PlaceUserCommand`; ownership/membership members deleted); `security-model.resources.mu`, `security-model-text.ts`
- Test: `security-model/tests/security-model-org.test.ts` (rewritten)

**Interfaces:**
- Consumes: Task 3 `SecurityModelDraft.Org`.
- Produces: `SecurityModelOrg.PlaceUser(principalId: string, businessUnitId: string): void` (trimmed id; empty → no-op; an existing placement is replaced); `CanRemoveBusinessUnit(id)` false for the root (no parent) and for a unit with child units, placed users or teams; the row's remove button binds to it with `CannotRemoveUnitText = 'Move its units, people and teams first.'`.

- [ ] **Step 1: Failing tests:** `root cannot be removed`; `unit with placed users cannot be removed`; `unit with a team cannot be removed`; `placing a user twice replaces the placement`; `blank principal id places nobody`; `ownership and membership tabs are gone` (`OrgTabLabels` = BusinessUnits, People, Teams).
- [ ] **Step 2: Run** portal `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** portal `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenant-admin): business units and user placement over C5`.

### Task 5: Portal — teams with IdP group links and manual members

**Files:**
- Modify: `security-model-org.ts` (`AddTeam(name)` → `businessUnitId` = root; `SetTeamBusinessUnit`, `AddIdpGroup(teamId, group)`, `RemoveIdpGroup`, `AddManualMember(teamId, principalId)`, `RemoveManualMember`); `security-model-org-rows.ts` (`TeamRowViewModel` gains `IdpGroups`, `NewIdpGroup`, `AddIdpGroupCommand`, `Members: ObservableCollection<TeamMemberRowViewModel>`, `LoadMembersCommand`, `NewManualMember`, `AddManualMemberCommand`; new `TeamMemberRowViewModel extends Observable { PrincipalId; OriginText; CanRemove; RemoveCommand }`); `security-model-editor-view-model.ts` (Teams tab), `.mu` resources, `security-model-text.ts` (`SyncedText = 'From identity provider'`, `ManualText = 'Added here'`, `UnsavedManualText = 'Added here (not saved)'`)
- Test: `security-model/tests/team-members.test.ts`

**Interfaces:**
- Consumes: Task 3 `ISecurityModelSource.ListTeamMembers`.
- Produces: the members list = the server's rows for the saved team (each with its origin) plus this draft's unsaved `manualMembers` additions; a `Synced` row has `CanRemove` false; removing a `Manual` row calls `RemoveManualMember` (draft dirty). Teams list and members list never offer editing synced membership.

- [ ] **Step 1: Failing tests:** `synced member cannot be removed`; `both origins show two rows` (server rows `[{a, synced}, {a, manual}]` → two rows; remove the manual → one synced row remains, draft `manualMembers` lacks `a`); `removing an IdP group link keeps manual members`; `new team is placed in the root unit`; `unsaved manual member is marked unsaved`; `members load failure shows the error text and keeps the draft`.
- [ ] **Step 2: Run** portal `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** portal `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenant-admin): teams with IdP group links and manual members`.

### Task 6: Portal — role privilege override editor (repurposed B1-3/TA-9 matrix)

**Files:**
- Modify: `security-model-role-rows.ts` (`RoleItemViewModel` from `SecurityRoleDto`: `Name`, `KindText`, `PackageText`; `PrivilegeCellViewModel` reads `draft.Overrides`: `Glyph`/`LevelName` of the effective level, `DefaultText`, `IsOverridden`, `CycleCommand` over `AllowedLevels(concept)`, `ResetCommand` (enabled iff overridden and editable)); `security-model-editor-view-model.ts` (`Roles` = catalog roles, base first in `BaseRole` order then package roles by name; `RoleTab { Privileges, People }` (Fields moves to Task 7's profile list, RecordSharing deleted); `PrivilegeRows` = one row per catalog concept, sorted; `AddRoleCommand`, `DeleteRoleCommand`, `NewRoleName`, `AddConceptCommand`, `NewConceptName`, `RecordSharingRows` deleted); `.mu`, `security-model-text.ts` (`DefaultPrefix = 'Default: '`, `SystemAdministratorText = 'Full access to every record and field in this environment. Not editable.'`)
- Test: `security-model/tests/security-model-editor-view-model.test.ts` (roles part rewritten)

**Interfaces:**
- Consumes: Task 3 `SecurityOverrides`.
- Produces: selecting `SystemAdministrator` shows `SystemAdministratorText` instead of the matrix (`IsSystemAdministrator`); every other role is editable on every concept, including concepts of other packages (spec §4.3).

- [ ] **Step 1: Failing tests:** `cell shows default and override` (default `businessUnitAndChildren`, override `businessUnit` → glyph of BU, `DefaultText` names BU+children, `IsOverridden`); `reset restores the default`; `cycling to the default clears the override`; `organisation-owned concept cycles none and organization only`; `system administrator is not editable`; `cross-package override is allowed` (`projects.ProjectManager` read `hr.Employee` → stored); `roles cannot be added or deleted` (no such commands on the VM); `edits are refused without the users-and-access capability`.
- [ ] **Step 2: Run** portal `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** portal `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenant-admin): role privilege override editor`.

### Task 7: Portal — field-profile override editor (repurposed B1-4)

**Files:**
- Modify: `security-model-role-rows.ts` (`ProfileItemViewModel` from `SecurityProfileDto`; `FieldGrantRowViewModel` per catalog secured field: three checkbox properties bound to `EffectiveField`, `DefaultText`, `IsOverridden`, `ResetCommand`); `security-model-editor-view-model.ts` (`SecurityModelMode { Roles, Profiles, Organization, Changes }` — Profiles mode = profile list + field matrix + its People sub-tab; `AddProfileCommand`, `DeleteProfileCommand`, `NewProfileName`, `AddSecuredFieldCommand`, `NewFieldConcept`, `NewFieldName` deleted); `.mu`, `security-model-text.ts`
- Test: `security-model/tests/profile-overrides.test.ts`

**Interfaces:**
- Consumes: Task 3 `SecurityOverrides` field members; Task 6 cell conventions.
- Produces: rows = every secured field in the catalog (any package), sorted by concept then field; non-secured fields are never listed. Ruled PR15: a profile override may target any package's secured field, with the same freedom as role overrides (a `projects` profile may override `hr.Employee.Salary`).

- [ ] **Step 1: Failing tests:** `checkbox shows the default when not overridden`; `unchecking a default grant stores an override` (`Compensation` Salary read default true → uncheck → `profileOverrides` row `{read:false, update:true, create:false}`); `reset clears the field's override`; `only secured fields are listed`; `cross-package profile override is allowed` (PR15: `projects.Finance` / `hr.Employee` / `Salary` read → stored); `profiles cannot be added or deleted`.
- [ ] **Step 2: Run** portal `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** portal `npm test`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenant-admin): field-profile override editor`.

### Task 8: Portal — role/profile assignment and the security change log

**Files:**
- Modify: `security-model/assignment-editor-view-model.ts` (`AssignmentEditorViewModel` over `SecurityAssignments`: principal rows and team rows only; `AssignmentClaimRowViewModel`, `AddClaim`, `RemoveClaim`, `SetClaim`, `SetValue` deleted; one instance for the selected role (Roles › People), one for the selected profile (Profiles › People)); `security-model-editor-view-model.ts` (Changes mode); `.mu`, `security-model-text.ts`
- Create: `security-model/security-changes-view-model.ts` (`SecurityChangesViewModel extends Observable { Entries: ObservableCollection<SecurityChangeEntryViewModel>; HasNoEntries; Refresh(): Promise<void> }`, `SecurityChangeEntryViewModel extends Observable { HeadingText /* "<delivery> <version>, <UTC time>" */; Lines: readonly string[] }`)
- Test: `security-model/tests/assignment-editor-view-model.test.ts`, `tests/security-changes-view-model.test.ts`

**Interfaces:**
- Consumes: Task 3 `ISecurityModelSource.ListSecurityChanges`, `SecurityAssignments`.
- Produces: one plain-language line per change, from constant templates in `SecurityModelText` (`RoleDefaultTemplate = '{role}: {action} on {concept} changed from {before} to {after}'`, `RoleOverrideDroppedTemplate = '{role}: your override of {action} on {concept} was dropped'`, `RoleRemovedTemplate = 'Role {role} was removed with its assignments'`, `SecuredFieldAddedTemplate`, `SecuredFieldRemovedTemplate = '{concept}.{field} is no longer secured: everyone who can read the record can read it'`, profile equivalents); `NoChangesText = 'No deploy has changed security in this environment.'`.

- [ ] **Step 1: Failing tests:** `assign role to a team and a user`; `removing the last holder drops the assignment`; `no claim rules remain`; `profile people tab edits profile assignments`; `changes list shows a dropped override in plain words`; `secured flag removal is called out`; `empty change log shows the empty text`; `changes are newest first`.
- [ ] **Step 2: Run** portal `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** portal `npm test`, `npm run typecheck`; `npm run test:e2e` (the Playwright suite against the fake control plane: open Users & Access › Roles & permissions on a Runtime environment, override a cell, save, reload, the override persists). Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenant-admin): role and profile assignment, security change log`.

### Task 9: S3 cutover — C5 on the wire, tier-1 runtime scope, legacy depth retired

Waits on: **S3** (see the dependency table), **S1** (C2 `IEnvironmentCatalog.Security: EnvironmentSecurity` with `EdgeConcepts`; Task 9 `SystemFieldGuard`; Task 10 `OwnershipAssignment`), **S2** Tasks 2–3 (Append/AppendTo, `Endpoints`), M2.3 merged. **Merge order (PR17):** the S3 identity repos merge to `master` together with this task, because S3 breaks the server's imports. One task because consuming S3's built `dist` breaks every legacy depth importer at once (S3 "Downstream breakage" lists them).

**Files:**
- Protocol: Modify `src/dto/wire-dtos.ts` (C5 shapes and deletions from "Shared wire shapes"), `src/tests/admin-security-model-contract.test.ts`, `package.json` (`0.12.0`), `ARCHITECTURE.md`
- Server, create: `src/host/environment/environment-security-setting.ts`, `src/host/environment/security-setting-catalog-check.ts`, `src/host/security-model-wire.ts`
- Server, modify: `src/host/environment/environment-scope-rules.ts` (`Records` = tier 1), `src/host/engine/dev-scope-rules.ts` (`Records` = unrestricted), `src/host/engine/principal-facts.ts` (`HomeBusinessUnitId`), `src/host/environment/environment-share-service.ts` and `environment-assign-service.ts` (tier-1 privilege checks; assign through S1 `OwnershipAssignment`), `src/host/engine/access-scope-conjunction.ts` (`WriteRule.Append`, `WriteRule.AppendTo`; `Endpoints` carried), `src/host/admin-service.ts` (`SetSecurityModel` validation; Development tenants refused), `src/host/server-connection-handler.ts` (`GetSecurityModel`, `ParseSecurityModel`, `ParseConfigDto`, the `GetConfig` mapping through `SecurityModelWire`; `AdminSecurityModelUnavailableError` → InvalidRequest), `src/pragmatic-server.ts` (`SecuritySetting()` memoized per tenant; `ReadAuthorization()`, `SecurityModelReload()`, `FieldReadMaskSource()` and everything only they fed deleted), `ARCHITECTURE.md`
- Server, delete: `src/host/engine/depth-scope-compiler.ts` and test, `src/host/cypher/read-filter-source.ts` and its tests, and every file left without an importer (Step 3 grep)
- Control plane: Modify `admin/control-plane/admin-proxy.ts`, `environment-service.ts`, `tenant-api/tenant-api-endpoint.ts` (types only), their tests' fixtures
- Test: `src/host/environment/tests/{security-setting-catalog-check,environment-security-setting,environment-scope-rules}.test.ts`, `src/host/tests/{security-model-wire,admin-security-model-handler}.test.ts`, `src/host/engine/tests/access-scope-conjunction.test.ts`, `src/host/engine/tests/scope-invariant.test.ts` (dev: rewritten), `src/host/environment/tests/runtime-scope-invariant.test.ts` (rebased), `environment-sharing.test.ts`, `environment-assign.test.ts`

**Interfaces:**
- Consumes (S3 names, from `2026-11-11-security-s3-identity-environment.md`): `Tier1ScopeCompiler.Compile(principal, security: IEnvironmentSecurity, model: TenantSecurityModel, catalog: ITier1Catalog): AccessScope` (C6; `IEnvironmentCatalog` satisfies `ITier1Catalog`), `Tier1ScopeCompiler.CompileAssign(...)`, `Tier1ScopeCompiler.Grants(...): Tier1Grants` (`Covers(action, concept): Predicate`), `Tier1ScopeCompiler.Diagnose(security, model, catalog): readonly Tier1Diagnostic[]`, `Tier1Catalog.EngineStoredConcepts(catalog)`; `TenantSecurityModel.FromConfig(config, directory: IdpDirectorySnapshot)` (throws `InvalidSecurityModelError`), `TenantSecurityModel.Empty()`, `PlacementOf(principal).HomeBusinessUnitId`, `TeamBusinessUnit(teamId)`; `AccessDepthEvaluator.For(security, model, concepts).AssignWrites(...)`; todl-identity `SecurityModelValidator.Validate` / `InvalidSecurityModelError`, `BaseRole`, `IIdpDirectoryStore.Get`, `IdpDirectorySnapshot.NonAuthoritative(at)`; `FileTenantConfigStore` migrates old-shape stored settings on `Open` (S3 Task 7, PR18). C3 field names `owner`, `owningBusinessUnit`. S1: `SystemFieldGuard.Guard(scope)`, `OwnershipAssignment.Assign(transaction, record, IOwnerAssignment)`, `EnvironmentSecurity.OwnedConcepts()`. S2: `IWriteRules.Append` / `AppendTo`, `IAccessScopeOptions.Endpoints` / `AccessScope.Endpoints`.
- Produces:
  - `class EnvironmentSecuritySetting implements IDisposable { constructor(store: ITenantConfigStore, directory: IIdpDirectoryStore, tenant: Tenant); Config(): Promise<ISecurityModelConfig | undefined>; Model(): Promise<TenantSecurityModel> /* FromConfig(config, stored snapshot ?? NonAuthoritative(now)); Empty() when none is stored or Get throws InvalidSecurityModelError (fail closed, reported once per generation) */; Invalidate(): void; readonly Generation: number; readonly Changed: ISignal<void>; dispose() }`.
  - `enum SecuritySettingIssueCode { UnknownRole = 'UnknownRole', UnknownProfile = 'UnknownProfile', UnknownConcept = 'UnknownConcept', UnsecuredField = 'UnsecuredField', OrganizationOwnedDepth = 'OrganizationOwnedDepth', ExternalConcept = 'ExternalConcept', SystemAdministratorOverride = 'SystemAdministratorOverride' }`; `class SecuritySettingIssue { readonly Code; readonly Subject: string; get Message(): string /* fixed text per code */ }`; `class SecuritySettingCatalogCheck { static Issues(config: ISecurityModelConfig, catalog: IEnvironmentCatalog, model: TenantSecurityModel): readonly SecuritySettingIssue[] }` — the first five codes map S3's `Tier1ScopeCompiler.Diagnose` codes (`Tier1DiagnosticCode`) (`UnknownAssignedRole`/`OverrideUnknownRole` → UnknownRole, `UnknownAssignedProfile`/`OverrideUnknownProfile` → UnknownProfile, `OverrideUnknownConcept`, `OverrideUnknownField` → UnsecuredField, `NonOrganizationDepthOnUnownedConcept` → OrganizationOwnedDepth); `ExternalConcept` = an override on a concept outside `EngineStoredConcepts`; `SystemAdministratorOverride` = any `roleOverrides` row for `BaseRole.SystemAdministrator`. S3 tolerates these at compile (drops with a diagnostic); the admin save refuses them so the admin sees why. Structural issues stay S3's `SecurityModelValidator`.
  - `class SecurityModelWire { static ToDto(config: ISecurityModelConfig): SecurityModelDto; static FromDto(dto: SecurityModelDto): ISecurityModelConfig /* throws AdminEnumError on an unknown action or level */ }` — explicit field copies, no casts.
  - `EnvironmentScopeRules.Records(context)` = `SystemFieldGuard.Guard(Tier1ScopeCompiler.Compile(context.Principal, snapshot.Catalog.Security, await setting.Model(), snapshot.Catalog))` (PR1: the guard applies to every runtime scope, the System Administrator's included); `EnvironmentScopeRules.AssignRecords(context): Promise<AccessScope>` = `CompileAssign` with the same inputs, unguarded (PR2: the assign service's base scope); `Changed` raised on host `Changed` and setting `Changed`; `Digest` = JSON of `[setting.Generation, catalog package refs]`. No identity configured: `AccessScope.Build({ Default: Allow })` as before.
  - `DevScopeRules.Records` = `AccessScope.Build({ Default: AccessDefault.Allow })` (spec §5.1, PR13: authoring data is governed by RBAC at the `PolicyGate` only).
  - `AccessScopeConjunction` (PR3, PR4): `Rules` = `[Create, Update, Delete, Append, AppendTo]`, so M2.3's `Finish` conjoins the link rules like the others. The conjoined scope's `Endpoints` = the union of both scopes' entries; two entries for one concept with different members throw (a host bug, never a narrowing).
  - `PrincipalFacts { Id; HomeBusinessUnitId: string }` from `model.PlacementOf(principal)` — placement stamps `owner` / `owningBusinessUnit` from it (C3).
  - Share/assign: `CanShare` / `CanAssign` = a scan under `And(Grants(...).Covers(PrivilegeAction.Share | Assign, concept), IdIn{recordId})` returns the record, OR a visible grant with `share` / `assign`; assign takes the values from `AccessDepthEvaluator.AssignWrites(...)` (only `owner` and `owningBusinessUnit`) and records them with S1's `OwnershipAssignment.Assign` in a transaction opened under `CompileAssign`'s scope confined by M2.3's `AssignScope` (PR2); `AssignOutcome.Unsupported` (concept not owned) → `invalid` `OrganizationOwnedReason = 'the record is organisation-owned and has no owner'`.

- [ ] **Step 1: Failing tests:**
  - protocol `SetSecurityModelParams carries the C5 setting` (all seven arrays round-trip); `retired sections are gone` (a `// @ts-expect-error` assigning `ownershipRules`).
  - `security-model-wire`: `round trip is lossless`; `unknown level is refused`.
  - `catalog check rejects …` one test per `SecuritySettingIssueCode` (each config differs from a valid one by exactly the offending entry; assert the single code); `valid setting has no issues`; `profile override on another package's secured field is accepted` (PR15).
  - `access-scope-conjunction`: `conjunction keeps Append and AppendTo` (both scopes' Append predicates are And-ed, one-sided ones kept); `conjunction carries Endpoints` (union; a conflicting pair throws).
  - `admin-security-model-handler`: `set then get returns the setting`; `refused set leaves the setting unchanged` (a catalog issue, and separately an S3 `InvalidSecurityModelError`, → InvalidParams with the issue's fixed message; stored config byte-equal); `development tenant refuses the setting` (InvalidRequest); `set invalidates the scope` (next `ScopeFor` digest differs and the new override applies).
  - `environment-scope-rules`: `role grants rows at its depth` (`hr` contributes BasicUser read `hr.Employee` at BU; Sales user sees Sales-owned rows only); `override narrows a package role` (§9.2 ProjectManager read → BU); `uncovered concept is system administrator only`; `system administrator is unrestricted` (every row and every secured field); `secured field without read is nonexistent` (`WHERE e.Salary > 100000` returns nothing; same answer as a query on an absent property); `external concept is outside the scope` (kept from A5); `no setting stored is deny all`; `invalid stored setting is deny all and reported once` (store `Get` throws `InvalidSecurityModelError`); `disabled identity has no access` (SystemAdministrator assigned, stored directory snapshot marks the principal `Disabled` → no rows); `security edit stales the cursor`; `placement stamps owner and home unit`; `system fields are read-only for a system administrator` (PR1: `SET e.owner` → MemberReadOnly); `a team-held role judges business-unit depth at the team's unit` (PR5: a Sales user holding ProjectManager through a Marketing team reads Marketing's projects); `an edge to a hidden record is invisible` (PR4: `MATCH (a:projects.Assignment) RETURN count(a)` excludes an Assignment to a project the caller cannot see); `linking needs append and appendTo` (PR3: an Update-only grant no longer allows a link).
  - dev `dev scope ignores the security setting` (two principals, a setting assigning nothing → both read every row; the `PolicyGate` still refuses a principal without Read/Tenant).
  - share/assign: `share needs the share privilege at a covering depth`; `share via grant still allows resharing` (kept); `assign moves the owning unit with the new owner`; `assign to a team uses the team's unit`; `assign on an organisation-owned concept is invalid`.
- [ ] **Step 2: Run** `npx tsx --test src/host/environment/tests/*.test.ts src/host/tests/security-model-wire.test.ts src/host/tests/admin-security-model-handler.test.ts src/host/engine/tests/scope-invariant.test.ts`; protocol `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement**, protocol first (`npm run build` there), then server, then control plane. Rewrite the dev scope-invariant suite to "every gate-passing principal gets the same unrestricted scope; model confinement (`OwnerIs(modelId)`) unchanged"; rebase the runtime suite's three principals on tier 1 (no role; BasicUser via contribution at BU; Reader + `Compensation` profile), field readability judged by the compiled scope's `Hidden`, negative control kept. Then `grep -rn "DepthScopeCompiler\|TenantReadAuthorization\|ReadFilterSource\|FieldReadMask\|OwnershipResolver\|OwnershipSourceKind\|MalformedSecurityModelError\|fieldSecurity\|ownershipRules\|roleAssignment\b" src admin/control-plane` → no hits (`AccessDepthEvaluator` remains only for `AssignWrites`).
- [ ] **Step 4: Run** protocol, server and control-plane checks. Expected: PASS.
- [ ] **Step 5: Commit** protocol `feat!: C5 environment security setting on the wire (0.12.0)`; server `feat!: tier-1 runtime scope over the C5 setting; dev governed by RBAC only`.

### Task 10: IdP directory sync host and admin reads — security catalog, team members

Waits on: **S1** C2; **S3** Tasks 3–4 (`IdpDirectorySync`, `IdpDirectoryRequest`, `IIdpDirectoryStore`, `TeamMembershipRows`, `TeamMembershipRow { TeamId; PrincipalId; Origin: MembershipOrigin }`) and the pack's `DirectorySource` / `IdpDirectory` (S3 Task 7). S3 leaves "poll vs push and frequency" to S4: this task decides it.

**Files:**
- Protocol: Modify `src/dto/wire-dtos.ts` (catalog and team-member shapes), `src/contracts/admin-protocol.ts` (`GetSecurityCatalog`, `ListTeamMembers`), `src/tests/admin-security-model-contract.test.ts`
- Server: Create `src/host/environment/security-catalog-reader.ts`, `src/host/environment/idp-directory-sync-host.ts`; Modify `src/pragmatic-server.ts` (`DirectorySync()` memoized for Runtime tenants with identity, disposed before the setting), `src/host/admin-service.ts` (`SetSecurityModel` triggers a sync), `src/host/server-connection-handler.ts` (both methods; Development tenants → InvalidRequest as Task 9), `src/host/policy-gate.ts` (both `administer`), `ARCHITECTURE.md`
- Control plane: Modify `admin-proxy.ts` (`GetSecurityCatalog()`, `ListTeamMembers(teamId)` on the connection and the proxy), `environment-service.ts` (`AdminGetSecurityCatalog(name)`, `AdminListTeamMembers(name, teamId)`), `tenant-api/tenant-api-endpoint.ts` (`SecurityCatalogLeaf = 'security-catalog'`, `TeamMembersLeaf = 'team-members'` in `AdminPathPattern`; `AdminRead` serves both, the tail is the team id)
- Test: `src/host/environment/tests/{security-catalog-reader,idp-directory-sync-host}.test.ts`, `src/host/tests/admin-security-reads.test.ts`, `src/host/tests/policy-gate-admin.test.ts`, `admin/control-plane/tests/tenant-api-read.test.ts`

**Interfaces:**
- Produces:
  - `class IdpDirectorySyncHost implements IDisposable { static readonly IntervalMs = 300000; constructor(sync: IdpDirectorySync, setting: EnvironmentSecuritySetting, tenant: Tenant, timer?: ISyncTimer); RunNow(): Promise<void>; dispose() }` with `interface ISyncTimer { Every(ms: number, run: () => void): IDisposable }` (default `IntervalSyncTimer` over `setInterval`, unref'd) — polls: one run when the tenant's server starts serving, one after each admin `SetSecurityModel`, then every `IntervalMs` while the server lives (a `PragmaticServer` exists only while it holds the tenant lease, so one replica syncs); runs are serialized, a run requested during a run coalesces into one more; after a run `setting.Invalidate()` (S3's `Run` already revokes deprovisioned sessions and audits); a failing run is logged by error name and keeps the previous snapshot.
  - `class SecurityCatalogReader { static Read(catalog: IEnvironmentCatalog): SecurityCatalogDto }` — roles: the `BaseRole` values in enum order (`kind` Base, `defaults` = union of every package's `BaseRoleContributions` for that name, max depth per (concept, action) as S3's `EffectiveRoleTable`, sorted by concept then action; `SystemAdministrator` defaults `[]`), then package roles sorted by name (`kind` Package, `package` = declaring package model id); concepts: `Tier1Catalog.EngineStoredConcepts(catalog)` minus `todl.*`, `package` = `catalog.HomeModels`, `owned` = in some `OwnedConcepts`; secured fields and profiles: union over packages, sorted.
  - `ListTeamMembers` = `TeamMembershipRows.For(config, snapshot).Rows(teamId)` mapped to `TeamMemberDto` (S3 order: principal id, then origin); unknown team → InvalidParams `UnknownTeamMessage = 'unknown team'`.

- [ ] **Step 1: Failing tests:** `sync runs on start and after a setting change` (fake `IIdpDirectorySource` from `todl-identity/testing` records two requests); `sync interval is honoured` (manual timer); `concurrent sync requests coalesce`; `failed sync keeps the previous snapshot`; `sync invalidates the scope` (a principal disabled in the next snapshot loses access on the next `ScopeFor`); `catalog lists base roles first`; `base role defaults are the union of contributions` (`hr` and `projects` both contribute to BasicUser); `external concepts are not listed`; `organisation-owned concept is marked`; `empty environment lists the base roles only` (no deliveries → three roles, no concepts); `team members carry origin` (synced via linked group, manual, and one principal in both → that principal twice); `disabled identity is not listed`; `unknown team is invalid params`; `both reads require administer`; control plane `security-catalog route proxies the read`, `team-members route passes the team id` (tail decoded), `team-members without a tail is 404`.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement**; protocol `npm run build` before the server.
- [ ] **Step 4: Run** protocol, server and control-plane checks. Expected: PASS.
- [ ] **Step 5: Commit** protocol `feat: security catalog and team member reads`; server `feat(admin): IdP directory sync host, security catalog, team members with origin`.

### Task 11: Environment creation seeds the setting and its administrator

**Files:**
- Create: `admin/control-plane/environment-security-seed.ts`
- Modify: `admin/control-plane/environment-service.ts` (`Create(name, template, type, hostPort?, hiveId?, creatorPrincipalId?: string)`; private `AdminLeaseForRecord(rec)` extracted from `AdminLeaseFor` so Create can call the env before `registry.Put`; for `EnvType.Runtime` with a creator, after `WaitHealthy` (and demo seeding) inside the existing bring-up `try`: `SetSecurityModel(EnvironmentSecuritySeed.For(def.name, creator))`, then `GetSecurityCatalog()` must list `SystemAdministrator` — else throw `SecuritySeedError`); `tenant-api/tenant-api-endpoint.ts` (`RouteEnvCreate` passes `session.principalId`); `ARCHITECTURE.md` (control plane "environment creation")
- Test: `admin/control-plane/tests/environment-security-seed.test.ts`, `admin/control-plane/tests/environment-service.test.ts` (create cases), `tests/tenant-api-mutate.test.ts`

**Interfaces:**
- Consumes: Task 9 C5 wire, Task 10 `GetSecurityCatalog` on `IAdminProxy`.
- Produces: `class EnvironmentSecuritySeed { static readonly RootBusinessUnitId = 'root' /* any id works: S3 accepts one parentless unit as the root */; static For(environmentName: string, creatorPrincipalId: string): SecurityModelDto }` = `{ businessUnits: [{ id: root, name: environmentName }], users: [{ principalId: creator, businessUnitId: root }], teams: [], roleAssignments: [{ role: 'SystemAdministrator' /* BaseRole value, hoisted constant */, principalIds: [creator], teamIds: [] }], profileAssignments: [], roleOverrides: [], profileOverrides: [] }`. Development environments are not seeded (spec §5.1, PR13: Development tenants refuse the setting; only Runtime environments seed the creator as System Administrator). The base roles are platform code (C4): the catalog read proves the environment graph opened with them (spec §7).

- [ ] **Step 1: Failing tests:** `seed assigns the creator system administrator in the root unit`; `runtime create seeds through the proxy` (fake proxy records `SetSecurityModel` then `GetSecurityCatalog`, in that order); `development create is not seeded`; `seed failure rolls the create back` (proxy `SetSecurityModel` rejects → teardown and volume removal called, record `Failed`, `CreateFailedError`); `catalog without system administrator fails the create`; `create route passes the session principal`.
- [ ] **Step 2: Run** `npx tsx --test admin/control-plane/tests/environment-security-seed.test.ts admin/control-plane/tests/environment-service.test.ts admin/control-plane/tests/tenant-api-mutate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** control-plane checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenant-admin): environment creation seeds its security and administrator`.

### Task 12: System principal and per-caller connector context

Waits on: **S3** Task 1 C7 (`SystemPrincipal.For(environmentId): Principal`, `SystemPrincipal.IdFor(environmentId)`, `SystemPrincipal.Is(principal)`, `PrincipalKind.System`; S3 Task 10 makes it SystemAdministrator at the root); **S3** Task 5 `ISourceTokenProvider` / `SourceTokenRequest` / `SourceTokenError` and the packs' `SourceTokens` (S3 Tasks 6–8); **S2** Task 6 `ConnectorContext` / `IBeginOptions` / `ICypherRunOptions.Connector`; **S1** Task 11 (`IDataSourceAdapter` calls carry `IDataSourceContext`). Program ruling PR12.

**Files:**
- Create: `src/host/environment/system-principal-scope.ts`, `src/host/environment/caller-connector-context.ts`, `src/host/connectors/caller-credential-adapter-factory.ts`
- Modify: `src/pragmatic-server.ts` (`SystemScope(): Promise<IGraphScope>`, Runtime only, memoized per scope-source generation); `src/host/connection-authenticator.ts` (a principal whose id equals `SystemPrincipal.IdFor(tenant.Id)` or starts with `SystemPrincipalScope.ReservedPrefix` is refused like an unknown credential: a `User` with that id would own the system principal's records at User depth); `ARCHITECTURE.md` (rule: "work no user started — connector population, scheduled flows, agents, identity resolution, deploy backfill — opens its engine readers and transactions under `PragmaticServer.SystemScope()`; method bodies run as the caller"; rule: "every `BeginRead`, `Begin` and Cypher `Execute` passes a `ConnectorContext`: the caller's for user-started work, the system principal's for background work")
- Modify (PR12): every engine call site that opens a reader, a transaction or a Cypher run (`src/host/environment/environment-engine-host.ts`, the `IGraphScope` implementation, the Cypher and connector handlers; find them with the Step 3 grep) passes `{ Connector: CallerConnectorContext.For(context.Principal) }`; `src/pragmatic-server.ts` wraps the adapter factory it hands connectors-host (today `BuiltinAdapterFactory`; re-grep the registration) in `CallerCredentialAdapterFactory` with the identity pack's `SourceTokens`
- Test: `src/host/environment/tests/system-principal-scope.test.ts`, `src/host/tests/connection-authenticator.test.ts`, `src/host/environment/tests/caller-connector-context.test.ts`, `src/host/connectors/tests/caller-credential-adapter-factory.test.ts`

**Interfaces:**
- Produces: `class SystemPrincipalScope { static readonly ReservedPrefix = 'system:'; constructor(scopes: IGraphScopeSource, rules: EnvironmentScopeRules, tenant: Tenant); Scope(): Promise<IGraphScope>; AssignScope(): Promise<AccessScope> /* rules.AssignRecords for the system principal: unrestricted, system fields writable */ }` — `Scope()` builds an `AccessContext` for `SystemPrincipal.For(tenant.Id)` with no RBAC grants (it never passes the `PolicyGate`; it exists only in-process) and returns `scopes.ScopeFor(context)`. No server background worker exists today (connector rows are federated per query by the engine; flows, agents and identity resolution are not server-hosted); Task 13's backfill is the first consumer.
- Produces (PR12): `class CallerConnectorContext { static For(principal: Principal): ConnectorContext /* Key = principal id */; static System(tenant: Tenant): ConnectorContext /* Key = SystemPrincipal.IdFor(tenant.Id) */ }`. `SystemPrincipalScope.Scope()` opens with `System(tenant)`. No identity type enters TODL, connectors-host or the engine: they see only the opaque key.
- Produces (PR12): `class CallerCredentialAdapterFactory implements IDataSourceAdapterFactory { constructor(inner: IDataSourceAdapterFactory, tokens: ISourceTokenProvider, tenant: Tenant); readonly Kind; Open(connection: ResolvedConnection): Promise<IDataSourceAdapter> }`.
  - A connection with dedicated credentials gets the inner adapter unchanged, and the context is ignored.
  - A connection in caller's-identity mode (spec §6; re-grep `ResolvedConnection` for its credential-mode field) gets a `CallerCredentialAdapter`. On each `Query` / `QueryPage` / `Apply`, it calls `tokens.Acquire(new SourceTokenRequest(tenant.Id, context.Key, resource))` and runs the call on an inner adapter opened with that token. It keeps one inner adapter per principal, reopens it when the token is renewed, and never lends one principal's adapter or token to another.
  - An anonymous or missing context, and a `SourceTokenError`, fail the call with that error and never fall back to app credentials. The error message carries no token.

- [ ] **Step 1: Failing tests:** `system scope sees every record and secured field`; `records created under the system scope are owned by the system principal in the root unit`; `system scope follows a security reload` (setting change → a fresh scope, same rights); `development tenant has no system scope` (throws `NotRuntime`); `IdP principal cannot claim the system id` (authenticator refuses `system:env-1`); `every engine call carries the caller context` (a recording engine sees `For(alice)` on the reader, the transaction and the Cypher run of one `cypher/query` and one `cypher/execute`); `background work carries the system context`; `caller's-identity connection reads with each caller's token` (alice and bob concurrently; the fake provider sees two requests, each adapter call carries only its own token); `anonymous context is refused by a caller's-identity connection`; `a failed token acquisition never falls back`; `dedicated-credential connection ignores the context`.
- [ ] **Step 2: Run** the four test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Then `grep -rn "BeginRead(\|\.Begin(\|\.Execute(" src/host src/pragmatic-server.ts` → every runtime engine call passes `Connector` (dev-edit calls included, with the caller's context).
- [ ] **Step 4: Run** the server checks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(environment): system principal scope and per-caller connector context`.

### Task 13: Deploy and promote show and apply their security diff

Waits on: **S1** C2 (and C3 plus Task 10 `OwnershipAssignment` for the backfill), Tasks 9 and 12, M2.3 Task 6 (`EnvironmentEngineHost.Deliver`).

Ruled PR16: this task owns the owner backfill when an upgrade adds `Owned` to a concept with live records (server, as the system principal, at deploy); S1 does not backfill. Ruled PR14: the diff is recorded and shown after the deploy (deploy result and change log); there is no pre-deploy preview in v1.

**Files:**
- Create: `src/host/environment/security-deploy-diff.ts`, `src/host/environment/security-change-log.ts`, `src/host/environment/delivery-security.ts`
- Modify: `src/host/environment/environment-engine-host.ts` (ctor optional `security?: DeliverySecurity`; `Deliver` order below); `src/host/apps/app-ingest-service.ts` (`AppDeployResultDto.securityChanges`); `src/pragmatic-server.ts` (`DeliverySecurity` wired with `SecuritySetting()`, `SecurityChangeLog(GraphsStorage())`, `SystemScope()`); `src/host/server-connection-handler.ts` (`ListSecurityChanges`); `src/host/policy-gate.ts`; protocol `wire-dtos.ts` (`SecurityChangesDto` family, `AppDeployResultDto.securityChanges?`), `admin-protocol.ts` (`ListSecurityChanges`); control plane `admin-proxy.ts`, `environment-service.ts` (`AdminListSecurityChanges(name)`), `tenant-api-endpoint.ts` (`SecurityChangesLeaf = 'security-changes'`); `ARCHITECTURE.md`
- Test: `src/host/environment/tests/{security-deploy-diff,security-change-log,delivery-security}.test.ts`, `admin/control-plane/tests/tenant-api-read.test.ts`

**Interfaces:**
- Consumes: Task 9 `SecuritySettingCatalogCheck`, `EnvironmentSecuritySetting`; Task 12 `SystemPrincipalScope`; M2.3 `AssignScope.For`; S3 `TenantSecurityModel.Hierarchy()` root id.
- Produces:
  - `class SecurityDeployDiff { static Compute(current: IEnvironmentCatalog, prospective: IEnvironmentCatalog, setting: ISecurityModelConfig | undefined, model: TenantSecurityModel): SecurityDeployDiff; readonly Changes: Omit<SecurityChangesDto, 'at' | 'delivery' | 'version'>; readonly NewlyOwned: readonly string[]; readonly IsEmpty: boolean; Pruned(setting: ISecurityModelConfig): ISecurityModelConfig }` — role defaults compared per (role, concept, action) over package roles and base-role contribution unions (absent = `none`); profile defaults per (profile, concept, field); secured fields added/removed; dropped overrides and removed assignments = exactly the entries `SecuritySettingCatalogCheck.Issues(setting, prospective, model)` reports with codes UnknownRole, UnknownProfile, UnknownConcept, ExternalConcept, OrganizationOwnedDepth or UnsecuredField; `Pruned` removes those entries and nothing else; `NewlyOwned` = concepts in prospective `OwnedConcepts` that exist in `current` without the aspect.
  - `class SecurityChangeLog { static readonly FileName = 'security-changes.json'; static readonly MaxEntries = 50; constructor(storage: IStorage); Append(entry: SecurityChangesDto): Promise<void>; List(): Promise<SecurityChangesDto[]> /* newest first */ }` (atomic replace; a non-empty diff only).
  - `class DeliverySecurity { constructor(setting: EnvironmentSecuritySetting, log: SecurityChangeLog, system: SystemPrincipalScope); Diff(current, prospective): Promise<SecurityDeployDiff>; Commit(diff, delivery: string, version: string): Promise<SecurityChangesDto | undefined>; Backfill(diff, engine: GraphEngine): Promise<number> }`.
  - `EnvironmentEngineHost.Deliver` order (extends M2.3 S4): compose prospective (pure) → `Diff` → `persist()` → `Commit` (prunes the setting: fail-closed, it can only narrow access a moment early) → `Redeliver()` (catalog and its `Security` swap as one snapshot; scope caches drop on `Changed`, readers already open keep the old snapshot) → `Backfill` (each `NewlyOwned` concept's records with no `owner` get `owner = system:<env>`, `owningBusinessUnit = root`, one transaction per concept under `SystemPrincipalScope.AssignScope()` confined by M2.3 `AssignScope.For` to the system fields, each record written through S1's `OwnershipAssignment.Assign` (PR2); a failure is reported to `IEnvironmentDiagnostics.UpgradeFailed` and retried on the next `Redeliver`). Deploy answers `securityChanges` when non-empty; `graph/load` logs only.

- [ ] **Step 1: Failing tests:**
  - diff: `unchanged deploy has an empty diff`; `changed contribution is a role default change` (BasicUser read `hr.Employee` BU → User); `new secured field is listed` (§9.4 `Employee.Bonus`); `removed secured flag is listed`; `override on a removed concept is dropped`; `role the package no longer ships is removed with its assignments`; `override on a concept that became external is dropped`; `kept overrides survive` (§9.2 ProjectManager read → BU across a redeploy); `newly owned concept is reported`.
  - log: `entries are newest first and capped`; `empty diff is not logged`.
  - delivery: `deploy answers its security changes`; `deploy prunes the setting before the swap`; `returned concept does not resurrect a dropped override` (deploy v2 drops `hr.Review`, v3 restores it → no override, change log shows both); `in-flight read keeps the old security` (reader opened before the deploy still hides `Bonus` per old profile defaults; a new reader follows the new ones); `upgrade adding the aspect backfills to the system principal` (live `Employee` rows → `owner = system:<env>`, root unit; not visible to a BasicUser at User depth until assigned); `incompatible deploy leaves the setting untouched`; `promote is logged`; control plane `security-changes route proxies the list`.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement**; protocol `npm run build` before the server.
- [ ] **Step 4: Run** protocol, server and control-plane checks. Expected: PASS.
- [ ] **Step 5: Commit** protocol `feat: deploy security changes`; server `feat(environment): deploy security diff, setting prune, ownership backfill, change log`.

### Task 14: Capstone — the spec's user cases end to end

Waits on: S1, S2, S3 complete; Tasks 9–13.

**Files:**
- Create: `src/tests/e2e/security-capstone-e2e.test.ts` (over M2.3 `EnvironmentFixture`, real `PragmaticClient`s, the local IdP fake with groups from S3)
- Modify: `ARCHITECTURE.md` (new "Platform security (tier 1)" section: setting, scope rules, system principal, deploy diff, retired tier 2; the "Where does X live?" rows for `EnvironmentSecuritySetting`, `SecuritySettingCatalogCheck`, `IdpDirectorySyncHost`, `SecurityCatalogReader`, `DeliverySecurity`, `SystemPrincipalScope`); the spec's status line → "implemented (S1–S4)"

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the tests (expected to pass; a failure is fixed in the owning task's code):**
  - §9.1 `sales manager sees sales employees without salary`; `salary filter returns nothing for a caller without the profile` (same rows as `WHERE e.Missing > 100000`); `manual team member reads and updates salary`; `manual member keeps access after leaving the IdP group`; `disabled identity has no access`.
  - §9.2 `shared project is visible`; `hidden task is neither returned nor counted through an edge` (`MATCH (p {id: P1})<-[]-(t) RETURN count(t)` = 0 for Alice); `traversal to an invisible project yields nothing for its task owner`; `role override survives an upgrade`.
  - §9.3 `connector rows ignore roles` (a principal with no role reads the external `PriceList` rows); `caller's-identity connector reads as each caller` (PR12: two users' reads reach the source with their own tokens).
  - §5 edges `an assignment to a hidden project does not exist` (PR4: not returned, not counted).
  - §9.4 `upgrade widens the existing profile assignment` (HR → Compensation now covers Bonus) and `deploy result lists the changes`.
  - §9.5 `new environment's creator administers it` (control-plane create via the in-process runtime → creator reads every row; a test user with BasicUser sees per depth).
- [ ] **Step 2: Run** `npx tsx --test src/tests/e2e/security-capstone-e2e.test.ts`, then all server, control-plane, portal and protocol checks. Expected: PASS.
- [ ] **Step 3: Commit** `test(e2e): platform security capstone; docs: tier-1 architecture`.

---

## Self-review map (spec → task)

§4.1 teams, origins, disabled → Tasks 5, 10 (S3 derives); §4.2 BU tree, placement → Tasks 4, 9; §4.3 base/package roles, overrides, upgrade keeps overrides, removed roles dropped, bootstrap creator → Tasks 6, 9, 10, 11, 13; §4.4 ownership fields stamped, assign only, backfill (PR16) → Tasks 9, 13; §4.5 sharing → Task 9 (+ M2.3 A4); §4.6 field profiles, nonexistent fields → Tasks 7, 9, 14; §5 enforcement on engine storage → Task 9 (S2/S3 compile it); §5.1 acting principal, dev out of scope → Tasks 9, 12; §6 connectors outside → Task 1 (A3, A4, A6), Task 9; §7 graph with the environment, tenant-admin owns layer 2 → Tasks 3–8, 11; §8 retired / repurposed / changed / M2.3 → Tasks 1, 2, 6, 7, 9; §9 cases → Task 14; §11 migration → S3 Task 7 migrates stored settings on open (assignments start empty); Task 9 fails an unmigratable one closed; Task 11 seeds new environments; existing environments get their administrator re-assigned in tenant-admin. §11 IdP sync mechanics → Task 10 (poll). §6 per-user source credentials → Task 12 (PR12). Program rulings → see "Program rulings this plan carries".
