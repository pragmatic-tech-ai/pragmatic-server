# TA-10 Org structure, ownership, membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the one consolidated Security model editor with the organization structure (business-unit tree, teams), membership rules/overrides, ownership rules, and a derived per-role Record-sharing view - all on the same `SecurityModelDraft` and the same `SecurityModelView`, with one Save.

**Architecture:** A composed `SecurityModelOrg` helper owns the four org sections of the shared `SecurityModelDto` (business units, teams, membership, ownership rules) plus removal integrity; `SecurityModelDraft` constructs it over its own model and forwards, aggregating `Dirty`. A read-only record-sharing derivation projects a role's privilege levels + ownership into plain language. `SecurityModelViewModel` exposes the new surfaces and row view-models; `SecurityModelView` restructures into an outer Roles / Organization mode switch, with Record sharing as a third per-role tab and four tenant-wide sub-editors in the Organization pane. No new backend.

**Tech Stack:** TypeScript (admin/tenant-portal), Mural kit components, Observable VMs, tsx test runner.

**Spec:** `docs/superpowers/specs/2026-10-28-tenant-admin-org-structure-design.md`

## Global Constraints

- OOP only; no module-level free functions or mutable module state. Allman braces. PascalCase for public methods and interfaces. VMs extend `Observable`. `IDisposable`, not disposer lambdas.
- No inline string literals: every user-facing or reused literal is a `private static readonly` on its class. Enums over string-literal unions.
- New `.ts` files are pure ASCII and LF line endings. Escape `— … · ○ ◔ ◑ ◕ ●` as escape sequences; after writing any file, byte-scan it (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"`) and confirm 0 non-ASCII, 0 CR. Never run `sed -i` on a CRLF file.
- Do not touch `tenant-app.ts`, `tenant-types.ts` DTO shapes, or any assignment section (`roleAssignment`, `fieldSecurity.profileAssignment`). The draft must round-trip those untouched.
- Tests live under `admin/tenant-portal/tests/`. Portal gate: `npm test` + `npm run typecheck` in `admin/tenant-portal`. Merged-result gate: server-root `npm test` + `npm run typecheck:tools` green.
- Nothing cross-tenant; reported capability == enforced; record sharing is read-only (no edit control over derived data).

## Review Focus

- **BU removal cascade:** removing a business unit referenced by a team (`owningBusinessUnit`), a membership rule and override (`homeBusinessUnit`), and an ownership-rule source clears every reference; `ToDto()` contains no dangling id. (Task 1 tests.)
- **Team removal cascade:** removing a team referenced by membership rules and overrides clears it from both `teams` arrays. (Task 1 tests.)
- **Re-parent cycle:** `SetBusinessUnitParent` that would make a unit its own ancestor is a guarded no-op; no infinite walk. (Task 1 tests.)
- **One Save, both panes:** an org edit plus a role edit in the same session persist in a single `SetSecurityModel`; neither section dropped. (Task 4 regression test, extends TA-9.)
- **Empty org sections:** a model with empty `businessUnits`/`teams` and empty membership renders an honest empty state with an Add action, not a blank grid or crash. (Task 5 tests.)
- **Stale level reference:** a role granting "Business unit" level on a concept whose owning unit was removed still produces a record-sharing sentence in generic scope words, inventing no unit name. (Task 3 tests.)

---

### Task 1: `SecurityModelOrg` helper - business units, teams, removal integrity

**Files:**
- Create: `admin/tenant-portal/src/security-model-org.ts`
- Modify: `admin/tenant-portal/src/security-model-draft.ts` (construct + forward org surface, aggregate `Dirty`)
- Test: `admin/tenant-portal/tests/security-model-org.test.ts`

**Interfaces:**
- Consumes: `SecurityModelDto`, `BusinessUnitDto`, `TeamDto`, `MembershipDto`, `OwnershipRuleDto` from `tenant-types.js`.
- Produces (used by Tasks 2-4):
  - `class SecurityModelOrg` constructed `new SecurityModelOrg(model: SecurityModelDto)` over the draft's live model reference.
  - `get Dirty(): boolean`
  - `get BusinessUnits(): readonly BusinessUnitDto[]`
  - `AddBusinessUnit(name: string): string` (returns new id, scheme `bu-<slug>-<n>`, mirrors draft's role id scheme)
  - `RenameBusinessUnit(id: string, name: string): void`
  - `SetBusinessUnitParent(id: string, parent: string | undefined): void` (cycle-guarded no-op)
  - `RemoveBusinessUnit(id: string): void` (clears `teams[].owningBusinessUnit`, `membership.claimsMapping[].homeBusinessUnit`, `membership.overrides[].homeBusinessUnit`, and any `ownershipRules[]` source whose `kind` denotes a unit and `value === id`)
  - `get Teams(): readonly TeamDto[]`
  - `AddTeam(name: string): string` (id scheme `team-<slug>-<n>`)
  - `RenameTeam(id: string, name: string): void`
  - `SetTeamOwningBusinessUnit(id: string, businessUnitId: string | undefined): void`
  - `RemoveTeam(id: string): void` (clears id from `membership.claimsMapping[].teams` and `membership.overrides[].teams`)
  - On `SecurityModelDraft`: `get Org(): SecurityModelOrg` (test seam + VM access); `get Dirty()` returns `this.dirty || this.org.Dirty`; `SecurityModelDraft.From(...)` builds a fresh `SecurityModelOrg`.

- [ ] **Step 1: Write failing tests** in `tests/security-model-org.test.ts`:
  - `AddBusinessUnit` returns a unique id and appends; a second unit with the same name gets a distinct id.
  - `SetBusinessUnitParent` sets `parent`; re-parenting a unit under its own descendant is a no-op (parent unchanged).
  - `RemoveBusinessUnit` on a unit referenced by a team's `owningBusinessUnit`, a membership rule's and override's `homeBusinessUnit`, and an ownership-rule unit source clears all four references and removes the unit.
  - `AddTeam`/`RenameTeam`/`SetTeamOwningBusinessUnit` behave; `RemoveTeam` clears the id from a membership rule's and override's `teams` arrays.
  - After each mutation `Dirty` is true; a freshly constructed helper over an unedited model is not dirty.
  - A draft loaded from a full model, edited only in business units, emits via `ToDto()` with `teams`/`membership`/`ownershipRules`/`roles`/`roleAssignment`/`fieldSecurity` structurally unchanged.
- [ ] **Step 2: Run tests, verify they fail** (`cd admin/tenant-portal && npm test`). Expected: failures referencing `SecurityModelOrg` / `draft.Org`.
- [ ] **Step 3: Implement** `SecurityModelOrg` in `security-model-org.ts` (Allman, hoisted literals, id scheme mirroring `SecurityModelDraft.RoleId`). Cycle guard walks `parent` chain from the proposed parent up; if it reaches `id`, no-op. Removal integrity iterates the dependent arrays in place. Wire `SecurityModelDraft`: field `private readonly org`, construct in ctor over `this.model`, add `get Org()`, fold into `get Dirty()`.
- [ ] **Step 4: Run tests, verify pass.** Byte-scan both new/modified files for ASCII + LF.
- [ ] **Step 5: Commit** `feat(tenant-portal): SecurityModelOrg helper - business units, teams, removal integrity`.

---

### Task 2: Membership and ownership-rule editing on `SecurityModelOrg`

**Files:**
- Modify: `admin/tenant-portal/src/security-model-org.ts`
- Test: `admin/tenant-portal/tests/security-model-org.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `SecurityModelOrg`, `MembershipClaimRuleDto`, `MembershipOverrideDto`, `OwnershipRuleDto`, `OwnershipSourceDto`.
- Produces (used by Task 4): on `SecurityModelOrg` -
  - `get Membership(): MembershipDto`
  - `AddMembershipRule(): void` (append `{ claim: '', value: '' }`)
  - `SetMembershipRuleClaim(index: number, claim: string): void`; `SetMembershipRuleValue(index, value)`; `SetMembershipRuleHomeBusinessUnit(index, businessUnitId: string | undefined)`; `ToggleMembershipRuleTeam(index, teamId: string): void`
  - `RemoveMembershipRule(index: number): void`
  - `AddMembershipOverride(): void` (append `{ principalId: '' }`); `SetMembershipOverridePrincipal(index, principalId)`; `SetMembershipOverrideHomeBusinessUnit(index, businessUnitId?)`; `ToggleMembershipOverrideTeam(index, teamId)`; `RemoveMembershipOverride(index)`
  - `get OwnershipRules(): readonly OwnershipRuleDto[]`
  - `AddOwnershipRule(concept: string): void` (append with a default `owningBusinessUnit: { kind: '', value: '' }`; no-op if concept already has a rule)
  - `SetOwningSourceKind(concept, kind)`; `SetOwningSourceValue(concept, value)`; `SetOwnerSourceKind(concept, kind)`; `SetOwnerSourceValue(concept, value)` (first owner setter creates the optional `owner` source; clearing both kind and value removes `owner`)
  - `RemoveOwnershipRule(concept: string): void`
  - All mutators set the helper's dirty flag.

- [ ] **Step 1: Write failing tests:** add a membership rule and set claim/value/home BU/toggle a team (toggle twice removes); remove a rule by index; same for overrides; add an ownership rule for a concept (duplicate concept is a no-op), set owning source kind/value, set then clear owner source (owner removed when both blank), remove rule; each mutation flips `Dirty`; a round-trip edited only in membership leaves business units / teams / ownership / roles / assignment structurally unchanged.
- [ ] **Step 2: Run tests, verify fail** (missing methods).
- [ ] **Step 3: Implement** the membership + ownership methods on `SecurityModelOrg`. Index-bounds guards make out-of-range calls no-ops. `ToggleTeam` adds to / removes from the `teams` array (creating it if absent, deleting it when empty).
- [ ] **Step 4: Run tests, verify pass.** Byte-scan.
- [ ] **Step 5: Commit** `feat(tenant-portal): membership and ownership-rule editing on SecurityModelOrg`.

---

### Task 3: Record-sharing derivation

**Files:**
- Create: `admin/tenant-portal/src/record-sharing.ts`
- Modify: `admin/tenant-portal/src/security-model-draft.ts` (add `RecordSharingFor(roleId)`)
- Test: `admin/tenant-portal/tests/record-sharing.test.ts`

**Interfaces:**
- Consumes: `RoleConfigDto`, `OwnershipRuleDto`, `PrivilegeAction`/`AccessLevel`/`LevelCycle`/`Actions` from `security-model-draft.js`.
- Produces (used by Task 4):
  - `interface RecordSharingRowData { concept: string; scopeText: string; canShare: boolean; canAssign: boolean }`
  - `class RecordSharingDeriver` with `static Rows(role: RoleConfigDto | undefined, ownershipRules: readonly OwnershipRuleDto[]): readonly RecordSharingRowData[]`
  - On `SecurityModelDraft`: `RecordSharingFor(roleId: string): readonly RecordSharingRowData[]` delegating to the deriver with the role's privileges + `ownershipRules`. Read-only; never sets dirty.

- [ ] **Step 1: Write failing tests:** for a role with `read@organization` on `Account` -> one row, concept `Account`, scope text naming the organization scope, `canShare`/`canAssign` false; adding `share@user` sets `canShare` true; the broadest level across a concept's actions drives `scopeText` (e.g. `read@user` + `update@businessUnit` -> business-unit scope); a concept present only as `share`/`assign` still lists with those flags and a "no direct record access" scope; a role whose level references a now-removed unit yields generic scope words (the deriver takes no unit names, so this is structural - assert no throw and a non-empty `scopeText`); an undefined role yields `[]`.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement** `RecordSharingDeriver.Rows`: group the role's privileges by concept; the scope is the maximum `AccessLevel` in `LevelCycle` order across the concept's non-share/assign actions, mapped to hoisted plain-language scope text; `canShare`/`canAssign` are presence of a `share`/`assign` privilege above `None`. `ownershipRules` informs a trailing "(records owned per the ownership rules)" clause only when a rule exists for the concept. Add `RecordSharingFor` on the draft.
- [ ] **Step 4: Run tests, verify pass.** Byte-scan.
- [ ] **Step 5: Commit** `feat(tenant-portal): record-sharing derivation over levels + ownership`.

---

### Task 4: `SecurityModelViewModel` - org surfaces, row VMs, Save round-trips all

**Files:**
- Modify: `admin/tenant-portal/src/security-model-view-model.ts`
- Create: `admin/tenant-portal/src/business-unit-row.ts`, `team-row.ts`, `membership-rule-row.ts`, `ownership-rule-row.ts`, `record-sharing-row.ts`
- Test: `admin/tenant-portal/tests/security-model-view-model.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 1-3 draft surface (`draft.Org.*`, `draft.RecordSharingFor`), existing VM patterns (property-changed constants, `RefreshDirty`, `Save`, `Busy`).
- Produces (used by Task 5): on `SecurityModelViewModel` -
  - getters `BusinessUnitRows`, `TeamRows`, `MembershipRuleRows`, `MembershipOverrideRows`, `OwnershipRuleRows`, `RecordSharingRows` returning the row VMs for the current selection; property-changed constants for each.
  - mutators forwarding to the draft org: `AddBusinessUnit`/`RenameBusinessUnit`/`SetBusinessUnitParent`/`RemoveBusinessUnit`; team equivalents; membership rule/override add/set/toggle/remove; ownership add/set/remove - each calls the draft then `RefreshDirty()` and raises the relevant rows property.
  - row VM classes (each extends `Observable`, carries the stable key/index it edits and a back-reference to invoke the VM): `BusinessUnitRow`, `TeamRow`, `MembershipRuleRow`, `MembershipOverrideRow`, `OwnershipRuleRow`, `RecordSharingRow`.
  - `Save()` unchanged in contract but now also round-trips org edits (it already emits the whole `draft.ToDto()`).

- [ ] **Step 1: Write failing tests:** adding a business unit raises `BusinessUnitRowsProperty` and the row appears; editing a membership rule's claim surfaces through its row and marks `Dirty`; **regression (extends TA-9):** load a model, make a role privilege edit AND add a business unit, call `Save()` once -> the single `SetSecurityModel` payload contains both the new privilege and the new unit; a save that fails with 401 still rethrows to login (unchanged); `RecordSharingRows` reflects the selected role.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement** the row VM classes and the VM getters/mutators. Row VMs hold a back-reference to the VM (constructor-injected) and their key; setters call the VM mutator. The VM rebuilds row arrays on demand from the draft (portal render-rebuild pattern). Reuse `RefreshDirty`/`Busy`/`Save` unchanged.
- [ ] **Step 4: Run tests, verify pass.** Byte-scan every new/modified file.
- [ ] **Step 5: Commit** `feat(tenant-portal): VM org surfaces, row view-models, Save round-trips org + roles`.

---

### Task 5: `SecurityModelView` - Roles / Organization mode switch, Organization pane, Record sharing tab

**Files:**
- Modify: `admin/tenant-portal/src/security-model-view.ts`
- Test: `admin/tenant-portal/tests/security-model-view.test.ts` (extend)

**Interfaces:**
- Consumes: Task 4 VM surface; existing kit (`Tabs`, `ScreenHost`, `Section`, `Act`, `KeyValueGrid`, `Button`, `Border`); existing per-role `Tabs`.
- Produces: test seams - `get Mode(): Tabs` (outer Roles/Organization switch), `get OrgTabs(): Tabs` (Business units | Teams | Membership | Ownership rules), `get RoleTabs(): Tabs` (now 3 entries incl. Record sharing), and host getters for each org sub-editor body.

- [ ] **Step 1: Write failing tests:** the outer `Mode` has entries Roles and Organization; the Roles pane shows the role list and a 3-entry per-role tab strip ending in Record sharing; the Organization pane shows a 4-entry tab strip and no role list; an empty-org model renders an empty-state Add action in the Business units sub-editor (not a crash); switching mode does not lose unsaved edits (the shared draft/save bar persist); `Dispose` tears down all subscriptions (assert via a subscription-count or no-leak seam consistent with TA-9).
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement** the restructure: introduce the outer mode `Tabs`; move the existing role list + per-role tabs under the Roles entry and append the Record sharing tab (renders `RecordSharingRows` read-only - scope text + share/assign pills, no edit control); build the Organization entry with four sub-editors binding to the Task 4 VM rows (BU tree with indent by `parent` depth + Add/Rename/Reparent/Remove; teams with owning-BU selector; membership rules + overrides editors; ownership-rules editor). Keep env strip + save bar + `ScreenHost` shared and outside both panes. Track every subscription in the existing `IDisposable[]` and dispose it. All literals hoisted; ASCII escapes for any glyphs.
- [ ] **Step 4: Run tests, verify pass.** Portal `npm test` + `npm run typecheck` green. Byte-scan the view for ASCII + LF.
- [ ] **Step 5: Commit** `feat(tenant-portal): Roles/Organization mode switch, org sub-editors, Record sharing tab`.
