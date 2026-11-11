# Platform security program — plan index and shared contracts

**Spec:** `pragmatic-server/docs/superpowers/specs/2026-11-11-platform-security-architecture-design.md`
(owner-approved 2026-11-11). This file splits it into one plan per subsystem and pins the names
the plans share, so they can be written and built independently. When a plan and this file
disagree, this file wins; when this file and the spec disagree, the spec wins.

## Plans and order

| # | Plan | Repo(s) | Depends on |
|---|---|---|---|
| S1 | `2026-11-11-security-s1-package-declarations.md` — ownership aspect, package roles, base-role contributions, secured fields, field profiles; compiler rules; compiled `PackageSecurity`; environment composition (incl. `EdgeConcepts`, PR4); engine-maintained system fields; retire TODL tier-2 policy code; forward `ConnectorContext` to data-source calls (Task 11, PR12) | `TODL` | — (Task 11: S2 Task 6) |
| S2 | `2026-11-11-security-s2-engine-enforcement.md` — gaps in `AccessScope` enforcement: hidden members nonexistent everywhere in Cypher, edge visibility both endpoints on every hop, Append/AppendTo rules (Task 2, PR3), `Endpoints` for reified edge nodes (Task 3, PR4), conflict errors that reveal nothing under a scope, `ConnectorContext` (Task 6, PR12), per-user connector isolation note for wave 2 | `pragmatic-graph` | — |
| S3 | `2026-11-11-security-s3-identity-environment.md` — environment security setting reshape, IdP group sync + teams (synced ∪ manual), disabled identities, system principal, local-IdP groups, per-user source tokens; `Tier1ScopeCompiler` → engine `AccessScope` | `todl-identity`, `todl-identity-engine`, `todl-identity-local`, `todl-identity-node`, `todl-identity-cloud` | S1 (consumes `PackageSecurity`), S2 (scope semantics) |
| S4 | `2026-11-11-security-s4-server-tenant-admin.md` — environment creation seeds graph/base roles/creator as System Administrator; scope per connection from S3; deploy diff; tenant-admin override editors (repurposed B1-3/B1-4/TA-9), teams/manual members, BU placement; system principal and per-caller `ConnectorContext` for every engine call (Task 12); owner backfill (Task 13); retire server tier-2 paths; M2.3 policy-task rework | `pragmatic-server`, `pragmatic-protocol`, `admin/tenant-portal` | S1, S2, S3 |

S1 and S2 run in parallel. S3 starts when S1's Task delivering `PackageSecurity` is merged (Tasks 7–8, with `EdgeConcepts`); S3 Task 11 also needs S2 Tasks 2–3. S1 Task 11 waits on S2 Task 6; S4 Task 12 waits on S2 Task 6 and S1 Task 11. Merge order (PR17): S4 Task 2 before S1 Task 1 reaches TODL `main` and before M2.3; S3 together with S4 Task 9; M2.3 after S4 Task 2.
All four plans live in `pragmatic-server/docs/superpowers/plans/` (one program home).

## Shared contracts

### C1. Vocabulary (todl-identity owns; TODL mirrors by string value)
- `todl-identity` `PrivilegeAction` (existing): `create, read, update, delete, append, appendTo,
  assign, share` **+ new `invoke = "invoke"`**. The spec's "write" is `update`.
- `todl-identity` `AccessLevel` (existing): `none, user, businessUnit, businessUnitAndChildren,
  organization`.
- TODL cannot depend on todl-identity (it depends only on todl-runtime). TODL defines its own string
  enums `SecurityAction` and `SecurityDepth` with **identical member names and string values**;
  `todl-identity-engine` maps them with an exhaustive value-map class (`SecurityVocabulary`) and a
  test that fails if either enum gains a member the other lacks.

### C2. Compiled package security (S1 produces, S3/S4 consume)
Exported from `@pragmatic-tech-ai/todl`, attached to a compiled package as `Package.Security`:
```ts
export interface IPackageSecurity
{
    readonly OwnedConcepts: readonly string[];                 // qualified concept names taking todl.system.Owned
    readonly Roles: readonly IPackageRole[];                   // the package's own roles
    readonly BaseRoleContributions: readonly IPackageRole[];   // Name = a base role name (C4)
    readonly SecuredFields: readonly ISecuredField[];
    readonly FieldProfiles: readonly IFieldProfile[];
}
export interface IPackageRole { readonly Name: string; readonly Privileges: readonly ISecurityPrivilege[]; }
export interface ISecurityPrivilege { readonly Concept: string; readonly Action: SecurityAction; readonly Depth: SecurityDepth; }
export interface ISecuredField { readonly Concept: string; readonly Field: string; }
export interface IFieldProfile { readonly Name: string; readonly Fields: readonly IFieldProfileEntry[]; }
export interface IFieldProfileEntry { readonly Concept: string; readonly Field: string; readonly Read: boolean; readonly Update: boolean; readonly Create: boolean; }
```
- Package role and profile names are package-qualified (`projects.ProjectManager`).
- Every `Concept` in a package's security is one of that package's own concepts (compiler-enforced).
- Environment composition (`EnvironmentCatalogComposer`) exposes the union as
  `IEnvironmentSecurity { Packages: ReadonlyMap<packageName, IPackageSecurity> }` beside the
  composed catalog, swapped in the same step as the catalog.

### C3. System ownership aspect (S1)
- Aspect `todl.system.Owned` in the TODL SystemPackage. Fields: `owner` (reference to a principal
  or team id, string) and `owningBusinessUnit` (BU id, string). Names fixed; packages may not
  redeclare, rename, shadow, retype or write them.
- On create the engine bridge places them via `GraphTransaction.SetDefault`, from the transaction's
  acting principal facts (`PrincipalFacts`: principal id + home BU id), owner = principal,
  owningBusinessUnit = home BU (team owner → team's BU). Only the assign operation changes them.
- Edge concepts cannot take the aspect (compiler rejects).

### C4. Base roles (S3 owns the list)
`SystemAdministrator`, `BasicUser`, `Reader` — exported from `todl-identity` as `BaseRole` enum
(string values identical to the names). `SystemAdministrator` bypasses record and field checks
(compiles to `AccessScope.System`). TODL validates contribution names against a mirrored constant
list (same mechanism as C1).

### C5. Environment security setting (S3 owns, S4 edits)
`ISecurityModelConfig` becomes:
```ts
{
  businessUnits: IBusinessUnitConfig[];           // single-rooted tree (existing shape)
  users: { principalId: string; businessUnitId: string }[];
  teams: { id; name; businessUnitId; idpGroups: string[]; manualMembers: string[] }[];
  roleAssignments: { role: string; principalIds: string[]; teamIds: string[] }[];   // role = BaseRole or qualified package role
  profileAssignments: { profile: string; principalIds: string[]; teamIds: string[] }[];
  roleOverrides: { role: string; concept: string; action: PrivilegeAction; level: AccessLevel }[];
  profileOverrides: { profile: string; concept: string; field: string; read: boolean; update: boolean; create: boolean }[];
}
```
Removed: `ownershipRules`, `OwnershipSourceKind`, `roles`, `roleAssignment.claimsMapping`,
`fieldSecurity` (secured fields and profiles now come from packages). Membership rows are derived:
`synced` = IdP group members, `manual` = `manualMembers`; a disabled/deleted IdP identity is
excluded from both.

### C6. Scope compilation (S3 produces, S4 calls)
`todl-identity-engine` `Tier1ScopeCompiler.Compile(principal: Principal, security: IEnvironmentSecurity,
model: TenantSecurityModel, catalog): AccessScope` — effective roles = package/base defaults with
`roleOverrides` applied; visibility per §5 over `owner`/`owningBusinessUnit` + `ShareGrantScope`;
secured fields without read → `AccessScope.Hidden`; without update/create → `Writes.ReadOnly`;
system fields → `Writes.ReadOnly` for every non-assign write; uncovered concept → not visible;
SystemAdministrator → `AccessScope.System`. Concepts bound to an external connector are excluded
(no Rows entry; the scope's `Default` for them is Allow — connectors are outside the model).

### C7. System principal (S3 produces, S4 uses)
Per environment, id `system:<environmentId>`, home BU = root, role SystemAdministrator. Used for
work no user started. Method bodies run as the caller.

## Retired across the program
`access-policy.json`, model policy declarations, `PolicyScopeCompiler.FromRules`,
`OwnershipSourceKind.FromField`, app-private concept governance, the Q5 plan
(`pragmatic-graph/docs/superpowers/plans/2026-11-10-policy-membership-by-kind.md`).

## Program rulings (2026-11-11, cross-plan reconciliation — win over the four plans)

- **PR1 System Administrator scope** (S3 deviation accepted): `Default: Allow`, reads unrestricted, system
  fields read-only except under `CompileAssign`. S1's `SystemFieldGuard` applies to every runtime scope.
- **PR2 Assign scope:** S3 `Tier1ScopeCompiler.CompileAssign` is the assign scope S1's
  `OwnershipAssignment.Assign` requires (C9). S4 opens assign operations under it.
- **PR3 Append/AppendTo:** S2 Task 2 adds the engine rules; S3 rule 3 compiles
  `Writes[K].Append = G(K, Depth(K, append))` and `Writes[K].AppendTo = G(K, Depth(K, appendTo))`;
  S4's `access-scope-conjunction.ts` conjoins both. Links no longer follow `Update`.
- **PR4 Reified edge concepts** (TODL `operator` targets, which are engine nodes with from/to
  relationships): S1 adds `EdgeConcepts: readonly { Concept; From; To }[]` to `IPackageSecurity` and
  `IEnvironmentSecurity`. S2 adds an engine-terms scope option
  `Endpoints?: ReadonlyMap<concept, { From: member; To: member }>`: such a node is visible iff the
  nodes at both members are visible (on every read path, incl. direct MATCH and counts); creating,
  deleting or relinking it requires the `Append` rule on the From node and `AppendTo` on the To node;
  attribute updates require `Append` on the From node. S3 puts every edge concept in `Endpoints` and
  gives it no Rows/Writes entries.
- **PR5 BU depth source** (Dataverse semantics): a role assigned directly to a user evaluates
  BU / BU+children depth against the user's home BU; a role held through a team evaluates against
  that team's BU. User depth = owner ∈ {user, user's active teams} for both. S3 compiles each
  assignment source separately and ORs them.
- **PR6 Platform vocabulary concepts** (`todl.Term`, `todl.Element` handling as S3 rule 6) are
  readable by all and writable by none at runtime — platform schema, not app data.
- **PR7 Non-directory IdPs** (generic OIDC, Google): a disabled user keeps access until their
  session expires. Accepted; documented in S3.
- **PR8 Field profiles:** an entry with update or create but no read is rejected by the compiler
  (S1 diagnostic `security.write-without-read`); the engine's refusal stays.
- **PR9 DETACH DELETE** stays governed by the Delete rule alone.
- **PR10 One-bit leaks accepted:** conflict errors under a restricted scope say only that something
  conflicts; a plain DELETE or single-valued relink revealing that a hidden edge exists is
  accepted (consistent with spec §5 uniqueness).
- **PR11 Results:** node results omit hidden fields and show unset fields as null — hiddenness is
  per caller and field, not per record value.
- **PR12 ConnectorContext (C8):** S2's opaque `ConnectorContext` is optional at the engine. S1 makes
  TODL's `DataSourceConnector` forward it to every data-source call (data-source contract gains an
  optional context parameter). S4 always passes one for user-started work (the caller) and
  background work (the system principal), and resolves per-user source credentials by wrapping S3's
  `ISourceTokenProvider` in the data-source factory it hands connectors-host. No identity type
  enters TODL, connectors-host or the engine.
- **PR13 Tenant purpose:** Development (dev-edit) tenants refuse the security setting; access there
  is identity RBAC (spec §5.1 scope). Only Runtime environments seed the creator as System
  Administrator. The Development "create graph" tab stays.
- **PR14 Deploy diff:** recorded and shown after the deploy (change log) in v1; no pre-deploy
  preview.
- **PR15 Profile overrides** may target any package's secured field (same freedom as role
  overrides).
- **PR16 Owner backfill** when an upgrade adds `Owned` to a concept with live records: S4 Task 13
  owns it (server, as the system principal, at deploy); S1 does not.
- **PR17 Merge order:** S4 Task 2 (retire server tier-2) merges before S1's task that deletes TODL
  `PolicyScopeCompiler`; S3 merges together with S4 Task 9 (S3 breaks the server's imports);
  M2.3 starts after S4 Task 2.
- **PR18 S3 migration:** the one-time `SecurityModelMigration` on open is kept (environments exist
  in the field); it is not a runtime shim.
