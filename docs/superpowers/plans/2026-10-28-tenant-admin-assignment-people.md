# TA-11 Role & field-profile assignment, People tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the one consolidated Security model editor with `roleAssignment` (per-role: by claim / by person / by team) in a new People tab, `fieldSecurity.profileAssignment` (per-profile) in a "Who has this profile" section on the Fields tab, and an honest per-role holders summary + direct-assignment count - all on the same `SecurityModelDraft`, one Save.

**Architecture:** `roleAssignment` and `profileAssignment` are isomorphic (claim rules + per-principal overrides + per-team grants, each mapping to a `string[]` of ids). An abstract `SecurityModelAssignment` base holds the shared edit logic; two tiny concrete subclasses bind it to the concrete sections and id-fields (`roles`/`teamRoles` vs `profiles`/`teamProfiles`). The draft exposes `RoleAssignment`/`ProfileAssignment`, aggregates `Dirty`, adds `roleAssignmentAbsent` tracking + `EnsureRoleAssignment`, and drops an absent-and-empty `roleAssignment` in `ToDto()`. A read-only holders deriver produces the per-role summary + count. The VM exposes filtered-by-selection surfaces + row VMs; the view adds the People tab, the Who-has-this-profile section, and the role-list count. No new backend.

**Tech Stack:** TypeScript (admin/tenant-portal), Mural kit components, Observable VMs, tsx test runner.

**Spec:** `docs/superpowers/specs/2026-10-28-tenant-admin-assignment-people-design.md`

## Global Constraints

- OOP only; no module-level free functions or mutable module state. Allman braces. PascalCase public methods/interfaces. VMs extend `Observable`. `IDisposable`, not disposer lambdas.
- No inline string literals: hoist every user-facing/reused literal to `private static readonly`. Enums over string-literal unions.
- New `.ts` files pure ASCII + LF. After writing any file, byte-scan (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"`) - 0 non-ASCII, 0 CR. Never `sed -i` a CRLF file.
- Do not change `tenant-types.ts` DTO shapes, `tenant-app.ts`, or the org sections. The draft must round-trip every section it does not edit.
- Tests under `admin/tenant-portal/tests/`. Portal gate: `npm test` + `npm run typecheck` in `admin/tenant-portal`. Merged gate: server-root `npm test` + `npm run typecheck:tools` green.
- Nothing cross-tenant; reported capability == enforced; claim/team holders are never enumerated or counted as people.
- Interaction model stays teardown-safe (TA-10): in-place scalar edits call `vm.RefreshDirty()` only (no `Render`); add/remove/select rebuild via `Refresh()`.

## Review Focus

- **Shared claim rule:** a `roleAssignment` claim rule granting roles A and B; toggling A out leaves B in; the rule drops only when both are gone. (Task 1 tests.)
- **Optional roleAssignment round-trip:** a model loaded WITHOUT `roleAssignment` - add then remove a grant (net empty) -> `ToDto()` has `roleAssignment` absent; a kept grant -> present. (Task 1 tests.)
- **One Save, all sections:** a privilege + a field grant + an org edit + an assignment edit persist in a single `SetSecurityModel`. (Task 3 regression, extends TA-10.)
- **Honest empty holders:** a role granted only by a claim rule and a team (no direct principals) shows direct-count 0/"none direct" and still lists the claim + team rules; no fabricated number, no empty-looking tab. (Task 2 + Task 4 tests.)
- **Stale id in a grant:** an override/team grant listing a role/profile id no longer in the model - the filtered view omits it, does not crash, and `ToDto()` keeps it untouched (not silently dropped). (Task 1 tests.)

---

### Task 1: `SecurityModelAssignment` (abstract base + role/profile subclasses), draft wiring, round-trip

**Files:**
- Create: `admin/tenant-portal/src/security-model-assignment.ts`
- Modify: `admin/tenant-portal/src/security-model-draft.ts`
- Test: `admin/tenant-portal/tests/security-model-assignment.test.ts`

**Interfaces:**
- Consumes: `RoleAssignmentDto`, `RoleClaimRuleDto`, `RoleOverrideDto`, `TeamRoleGrantDto`, `FieldProfileAssignmentDto`, `FieldProfileClaimRuleDto`, `FieldProfileOverrideDto`, `FieldProfileTeamGrantDto`, `SecurityModelDto`, `FieldSecurityDto` from `tenant-types.js`.
- Produces (used by Tasks 2-3):
  - `abstract class SecurityModelAssignment` - shared logic, scoped by a target id (a role id or profile id). Public surface (all scoped to `targetId`, the selected role/profile):
    - `get Dirty(): boolean`
    - `ClaimGrants(targetId): readonly { index: number; claim: string; value: string }[]` (rules whose id-set includes targetId)
    - `AddClaimGrant(targetId): void` (append a fresh rule carrying only targetId; claim/value blank)
    - `SetClaim(index, claim): void`, `SetValue(index, value): void` (edit the rule at index)
    - `RemoveClaimGrant(targetId, index): void` (remove targetId from the rule at index; drop the rule when its id-set empties)
    - `PrincipalGrants(targetId): readonly string[]` (principalIds whose override includes targetId)
    - `AddPrincipalGrant(targetId, principalId): void` (add targetId to that principal's override, creating it; no-op if principalId blank)
    - `RemovePrincipalGrant(targetId, principalId): void` (drop targetId; remove the override when its id-set empties)
    - `TeamGrants(targetId): readonly string[]` (teamIds whose team-grant includes targetId)
    - `AddTeamGrant(targetId, teamId): void`; `RemoveTeamGrant(targetId, teamId): void` (same drop-empty rule)
    - `protected abstract` seam methods the subclasses implement: `Ensure(): { claimsMapping; overrides; teamGrants }` (bootstraps + returns the live arrays), `Peek()` (read without creating), `IdsOf(entry): string[]` (the live `roles`/`profiles` or `teamRoles`/`teamProfiles` array for a claim/override/team entry), and factories `NewClaim(claim,value,id)`, `NewOverride(principalId,id)`, `NewTeam(teamId,id)`.
  - `class RoleAssignmentSection extends SecurityModelAssignment` and `class ProfileAssignmentSection extends SecurityModelAssignment`, each constructed over the draft's live `SecurityModelDto`, implementing the seams for `roleAssignment` / `fieldSecurity.profileAssignment` respectively. `RoleAssignmentSection.Ensure()` bootstraps `model.roleAssignment = { claimsMapping: [], overrides: [], teamRoles: [] }`; `ProfileAssignmentSection.Ensure()` uses the draft's fieldSecurity bootstrap (profileAssignment is seeded there).
  - On `SecurityModelDraft`: `get RoleAssignment(): RoleAssignmentSection`, `get ProfileAssignment(): ProfileAssignmentSection`; `get Dirty()` now also ORs both sections' `Dirty`; a `roleAssignmentAbsent` flag set in the constructor; `EnsureRoleAssignment()`; `ToDto()` deletes `out.roleAssignment` when `roleAssignmentAbsent` and it is empty (no claim/override/team entries). `From(...)` builds fresh sections.

- [ ] **Step 1: Write failing tests** (`tests/security-model-assignment.test.ts`):
  - Add a claim grant for role r1 -> `ClaimGrants('r1')` shows one rule; set its claim/value; a second role r2 added to the SAME rule (construct the fixture so a rule lists [r1,r2]) and `RemoveClaimGrant('r1', i)` leaves r2 in it; removing r2 too drops the rule.
  - Add/remove principal grant and team grant; drop-empty behavior; blank principalId is a no-op.
  - `Dirty` flips on each real mutation; a fresh section over an unedited model is not dirty.
  - **Round-trip:** a model loaded WITHOUT `roleAssignment`: add a claim grant then remove it (net empty) -> `draft.ToDto().roleAssignment === undefined`; add and KEEP a grant -> `ToDto().roleAssignment` present with the grant. A model loaded WITH `roleAssignment` always round-trips it.
  - Profile side mirrored via `ProfileAssignmentSection` (profileAssignment inside fieldSecurity).
  - A grant listing a role id not in `model.roles` round-trips untouched and does not crash the filtered views.
- [ ] **Step 2: Run tests, verify fail** (`cd admin/tenant-portal && npm test`).
- [ ] **Step 3: Implement** the abstract base + two subclasses + draft wiring. Base logic is id-field-agnostic via the `IdsOf`/`New*` seams. Mirror `rolesAbsent`/`EnsureFieldSecurity` exactly for `roleAssignmentAbsent`/`EnsureRoleAssignment`.
- [ ] **Step 4: Run tests green.** Byte-scan both new/modified src files + the test.
- [ ] **Step 5: Commit** `feat(tenant-portal): SecurityModelAssignment - role + profile assignment on the draft`.

---

### Task 2: Role holders derivation + direct-assignment count

**Files:**
- Create: `admin/tenant-portal/src/role-holders.ts`
- Modify: `admin/tenant-portal/src/security-model-draft.ts` (add `RoleHoldersFor` + `DirectHolderCount`)
- Test: `admin/tenant-portal/tests/role-holders.test.ts`

**Interfaces:**
- Consumes: `RoleAssignmentDto`, `TeamDto` from `tenant-types.js` (team names for "members of `<team>`").
- Produces (used by Tasks 3-4):
  - `interface RoleHolderData { byPrincipal: readonly string[]; byClaim: readonly { claim: string; value: string }[]; byTeam: readonly { teamId: string; teamName: string }[]; directCount: number }`
  - `class RoleHoldersDeriver` with `static Holders(roleId: string, assignment: RoleAssignmentDto | undefined, teams: readonly TeamDto[]): RoleHolderData`. `directCount` = count of principal overrides granting roleId (the only enumerable set). `byTeam` resolves `teamName` from `teams` by id, falling back to the id when the team is gone (no invented name). Undefined assignment -> all empty, count 0.
  - On `SecurityModelDraft`: `RoleHoldersFor(roleId): RoleHolderData` (delegates with `this.model.roleAssignment` + `this.model.teams`) and `DirectHolderCount(roleId): number`. Read-only; never dirties.

- [ ] **Step 1: Write failing tests:** a role with 2 principal overrides + 1 claim rule + 1 team grant -> `directCount===2`, `byClaim` length 1, `byTeam` length 1 with the resolved name; a role granted ONLY by a claim rule and a team -> `directCount===0`, `byPrincipal` empty, `byClaim`/`byTeam` populated (honest empty-direct); a team grant whose team was removed -> `teamName` falls back to the id, no throw; undefined assignment -> empty, count 0.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement** `RoleHoldersDeriver.Holders` + the two draft methods. Hoisted literals; read-only.
- [ ] **Step 4: Run tests green.** Byte-scan.
- [ ] **Step 5: Commit** `feat(tenant-portal): honest role holders derivation + direct-assignment count`.

---

### Task 3: VM assignment surfaces (role + profile), row VMs, Save round-trips assignment

**Files:**
- Modify: `admin/tenant-portal/src/security-model-view-model.ts`
- Create: `admin/tenant-portal/src/assignment-claim-row.ts`, `assignment-principal-row.ts`, `assignment-team-row.ts`
- Test: `admin/tenant-portal/tests/security-model-view-model.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 (`draft.RoleAssignment`/`draft.ProfileAssignment`), Task 2 (`draft.RoleHoldersFor`/`DirectHolderCount`), existing VM patterns (property constants, `Refresh`/`RefreshDirty`, `Save`, selected role/profile ids).
- Produces (used by Task 4): on `SecurityModelViewModel` -
  - Role-assignment surfaces filtered to the selected role: getters `RoleClaimRows`, `RolePrincipalRows`, `RoleTeamRows` (row VMs) and `RoleHolders` (`RoleHolderData`); mutators `AddRoleClaimGrant()`, `SetRoleClaimGrant{Claim,Value}(index,v)`, `RemoveRoleClaimGrant(index)`, `AddRolePrincipalGrant(principalId)`, `RemoveRolePrincipalGrant(principalId)`, `AddRoleTeamGrant(teamId)`, `RemoveRoleTeamGrant(teamId)`.
  - Profile-assignment surfaces filtered to the selected profile: getters `ProfileClaimRows`, `ProfilePrincipalRows`, `ProfileTeamRows`; the same mutator set prefixed `Profile*`.
  - `DirectHolderCountFor(roleId): number` for the role list.
  - Property-changed constants for each new rows getter; `Refresh()` rebuilds and raises them; `ResetDraft()` clears+raises them. Scalar setters (`Set*Claim/Value`) call `RefreshDirty()` only (teardown-safe); add/remove call `Refresh()`.
  - Three thin delegating row-VM classes (like the TA-10 rows, rebuilt each Refresh): `AssignmentClaimRow` (index, claim, value + `SetClaim`/`SetValue`/`Remove`), `AssignmentPrincipalRow` (principalId + `Remove`), `AssignmentTeamRow` (teamId, teamName + `Remove`). Each carries the VM + whether it targets the role or profile side (constructor flag or two row types) so `Remove`/setters hit the right mutator.

- [ ] **Step 1: Write failing tests:** adding a role claim grant raises `RoleClaimRowsProperty` and the row appears; a scalar claim edit flips `Dirty` via `RefreshDirty` without a rows rebuild (row identity stable); `RoleHolders`/`DirectHolderCountFor` reflect the selected role; the profile side mirrors on the selected profile; **regression (extends TA-10):** load a model, make a privilege edit AND an org edit AND a role-assignment grant, `Save()` once -> the single captured `SetSecurityModel` payload carries the privilege, the org change, AND the new `roleAssignment` grant; 401 on Save still rethrows.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement** the row VMs + VM getters/mutators (role + profile), `Refresh`/`ResetDraft` extension, holder count. Follow the TA-10 mutator shape exactly (guard undefined draft; scalar->RefreshDirty, set-shape->Refresh).
- [ ] **Step 4: Run tests green.** Byte-scan every new/changed file.
- [ ] **Step 5: Commit** `feat(tenant-portal): VM role+profile assignment surfaces, row VMs, Save round-trips assignment`.

---

### Task 4: View - People tab, Who-has-this-profile section, role-list count

**Files:**
- Modify: `admin/tenant-portal/src/security-model-view.ts`
- Test: `admin/tenant-portal/tests/security-model-view.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3 VM surfaces; existing kit (`Tabs`, `Section`, `Act`, `StatusPill`, `Button`, `Checkbox`, `TextBox`, combo helpers) and the existing `RoleTabs`/Fields-tab builders.
- Produces: test seams - `RoleTabs` now has 4 entries ending in People; a `get PeopleHost(): StackPanel`; the Fields tab exposes a who-has-this-profile sub-host seam; the role-list rows show a direct-count affordance.

- [ ] **Step 1: Write failing tests:** `RoleTabs` has 4 entries, the 4th is People; the People tab for the selected role shows by-claim/by-person/by-team editors + the honest holders summary (direct count, claim rules listed, team rules listed with names); an empty-assignment role shows the "no one assigned yet" empty state + add affordances (no crash, no fake count); the Fields tab shows a Who-has-this-profile section for the selected profile with the same three editors; the role list shows each role's direct-assignment count; an in-place claim/principal edit does NOT rebuild (control survives, teardown-safe); `Dispose` tears down all subscriptions (SubscriptionCount seam stays flat across renders).
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement** the People tab (three editors binding to the Task 3 role surfaces + the holders summary rendered read-only), the Who-has-this-profile section appended to the Fields tab (profile surfaces), and the role-list direct-count label. Reuse the TA-10 teardown-safe patterns (scalar edits via `RefreshDirty`, set-shape via `Refresh`); track every subscription in the existing lists and dispose them; by-team add uses a picker over existing teams. All literals hoisted; ASCII escapes for any glyphs.
- [ ] **Step 4: Run tests green.** Portal `npm test` + `npm run typecheck`. Byte-scan the view + test.
- [ ] **Step 5: Commit** `feat(tenant-portal): People tab, Who-has-this-profile section, role-list assignment count`.
