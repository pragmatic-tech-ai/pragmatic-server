# TA-11 - Role & field-profile assignment, People tab (B1-5c) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD).
**Area:** Tenant Admin > Users & Access > Roles & permissions (the consolidated Security model editor).
**Builds on:** TA-9 (one draft / one Save) and TA-10 (`SecurityModelOrg`, the outer Roles/Organization mode switch, the derived Record-sharing view).
**Reconciliation:** `docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md` section 2 (table rows: role assignment, field-profile assignment) and section 4 item 11.

## Intent and why

The consolidated editor now describes what each role can do (TA-9), the org structure its
AccessLevels refer to (TA-10), and a plain-language Record-sharing projection (TA-10). The
remaining editable sections of the one `SecurityModelDto` are the **assignment** half - how
principals come to hold a role or a field profile:

- **`roleAssignment`** - claim-to-value rules that grant a set of roles, per-principal
  overrides that grant roles directly, and team-role grants. This is the real model behind
  the prototype's per-role "People" tab.
- **`fieldSecurity.profileAssignment`** - the identical shape for field profiles
  (claim rules, overrides, team-profile grants). This is how a field profile (TA-9, a
  first-class object) actually reaches a principal.

The two are **isomorphic**: claim rules, per-principal overrides, and per-team grants, each
mapping to a `string[]` of ids (role ids / profile ids). TA-11 edits both on the same draft,
with one Save, extending the TA-9 silent-drop guarantee to the last two sections.

It also adds the per-role **People** view the design calls for: who holds the selected role,
shown honestly - direct principals are listed, while claim and team rules are shown as the
rules they are (they grant the role dynamically to anyone the IdP matches, so the actual
set of people is not enumerable in the tenant-admin process and must not be faked).

Why now: a role or profile with no way to assign it is inert. This completes the Roles &
permissions surface; after TA-11 every section of `SecurityModelDto` the design covers is
editable on the one draft. The only deferred piece is the Administration tab (tenant-admin
RBAC, not part of `SecurityModelDto`).

## Goals

- Edit **`roleAssignment`**, scoped per selected role, in the **People** tab:
  - **By claim**: claim/value rules that grant the selected role; add a rule granting it,
    toggle the role out of a rule (dropping the rule when its role set empties).
  - **By person**: per-principal overrides granting the selected role; add/remove a
    principalId.
  - **By team**: team-role grants including the selected role; grant/revoke the role to an
    existing team (team ids come from TA-10's teams).
- Edit **`fieldSecurity.profileAssignment`**, scoped per selected profile, in a
  **"Who has this profile"** section on the Fields tab, symmetric to the People tab.
- A derived, honest **holders summary** per role: the direct principals listed; the claim
  rules and team grants shown as rules ("anyone whose `<claim>` is `<value>`", "members of
  `<team name>`"), never collapsed into a fabricated head count.
- A **people count** on each role in the role list = the number of **direct principal
  overrides** granting that role (the only enumerable set), labelled so it reads as direct
  assignments, with claim/team contributions indicated separately - not summed into a fake
  total.
- All of the above on the **same** `SecurityModelDraft` (one dirty, one `ToDto()`, one
  Save). One Save persists an assignment edit together with any role/field/org edit; no
  section dropped (the TA-9 guarantee extended to `roleAssignment` and `profileAssignment`).
- **Round-trip fidelity for the optional `roleAssignment` section**: `roleAssignment` is
  optional on `SecurityModelDto` and is not present on every loaded model. A draft that
  never touched it, or touched it and left it empty, must emit via `ToDto()` with
  `roleAssignment` **absent** (mirror the existing `rolesAbsent`/`fieldSecurityAbsent`
  handling). A real assignment edit makes it present. `profileAssignment` lives inside
  `fieldSecurity`, so it follows the existing `fieldSecurityAbsent` rule.

## Non-goals

- **Administration** sub-tab and **self-lockout** confirm - tenant-admin RBAC
  (`AdminCapabilitiesDto`), not part of `SecurityModelDto`; deferred (as in TA-9).
- The **Users-tab per-user "Roles" dialog** deferred in TA-8 - that user-centric surface
  binds to this assignment mechanism, but TA-11 builds the role/profile-centric editor on
  the security model; wiring the Users-tab dialog to it is a later, separate change.
- Any **new backend route or DTO field** - `roleAssignment` and `profileAssignment` already
  exist and already round-trip; this is UI + draft only, over the existing GET/SET.
- **Enumerating real people** behind claim/team rules, or a live head count of effective
  holders - the tenant-admin process cannot resolve IdP claims to principals; showing a
  number there would be dishonest.
- A **concept/field or role/profile catalog** picker - roles and profiles come from the
  model (TA-9); claim/value/principalId stay free text, consistent with the rest of the
  editor.
- Tenant-wide aggregation / apply-to-all-environments - the per-environment env strip stays.

## Anti-goals (a failure even if it "works")

- A second draft or a second Save for assignment - reintroduces the silent-drop. One draft,
  one Save.
- Emitting a `roleAssignment: { empty }` on a model that was loaded without one - that is a
  spurious model change the admin never made; the absent-tracking must drop it.
- Presenting claim/team rules as a concrete list of people, or showing a "People (n)" count
  that implies more certainty than the model supports - dishonest; the whole point of the
  tenant-admin honesty invariant.
- Toggling a role into a `roleAssignment` claim rule that silently corrupts a rule shared by
  other roles (the claim rules grant a *set* of roles) - editing one role must not drop
  another role from a shared rule.
- Anything cross-tenant/hive/platform; reported capability == enforced.

## Information architecture (the decided shape)

Within the TA-10 `SecurityModelView`, no new top-level pane:

- **People** becomes the **fourth** per-role tab: `[What they can do | Fields | Record
  sharing | People]`. It edits `roleAssignment` filtered to the selected role (by claim / by
  person / by team) and shows the honest holders summary. Empty state: an honest "no one is
  assigned this role yet" with the add affordances.
- **"Who has this profile"** is a section appended to the existing **Fields** tab, below the
  profile->securedField grid, editing `profileAssignment` filtered to the selected profile
  (by claim / by person / by team). Keeps profiles first-class.
- The **role list** (Roles pane) shows a per-role direct-assignment count next to each role,
  honestly labelled.
- The env strip, the one sticky save bar, and the ScreenHost states are unchanged and still
  shared.

Rationale: assignment is intrinsically per-role (People) and per-profile (Who has this
profile), matching the design's per-role sub-tab model; neither is tenant-wide, so neither
belongs in the Organization pane. Both edit the one draft and save together.

## Draft composition (the decided shape)

`roleAssignment` and `profileAssignment` are isomorphic, so compose **one generic
assignment mechanism** rather than two parallel helpers (DRY; the reconciliation's "compose
section helpers under the draft facade"):

- A `SecurityModelAssignment` helper (new file `security-model-assignment.ts`) operates on
  the three assignment arrays (claim rules, overrides, team grants) through a small
  **target adapter** that knows (a) how to bootstrap/read the concrete section
  (`roleAssignment` vs `fieldSecurity.profileAssignment`) and (b) which id-field it carries
  (`roles`/`teamRoles` vs `profiles`/`teamProfiles`). The draft exposes two configured
  instances: `get RoleAssignment()` and `get ProfileAssignment()`, each over the live model.
- The helper carries its own `Dirty`; `draft.Dirty` aggregates `this.dirty || org.Dirty ||
  roleAssignment.Dirty || profileAssignment.Dirty` (extend the TA-10 aggregation).
- The draft gains `roleAssignmentAbsent` tracking (mirror `rolesAbsent`), an
  `EnsureRoleAssignment()` (mirror `EnsureFieldSecurity`), and `ToDto()` drops an
  absent-and-empty `roleAssignment`. `profileAssignment` rides the existing
  `fieldSecurityAbsent` rule (it is created by `EnsureFieldSecurity` and dropped when
  fieldSecurity is dropped).
- A read-only **holders derivation** (`RoleHoldersFor(roleId)` / a focused deriver) produces
  the honest per-role summary (direct principals, claim rules, team grants) and the
  direct-assignment count, from `roleAssignment` + the org team names (for "members of
  `<team>`"). Read-only; never dirties.

## What's left to the builder (plan + implementation calls)

- Exact TS factoring of the generic helper + adapter (one class + adapter interface, or a
  small generic base) - builder's call, as long as roles and profiles share the mechanism
  and the round-trip + absent-tracking tests pass.
- Exact plain-language copy for the holders summary and the by-claim/by-person/by-team row
  labels (reuse TA-10 vocabulary where it fits; all hoisted to `private static readonly`).
- Row/VM-row shapes for the assignment editors (follow the TA-10 thin delegating row-VM
  pattern; rebuilt each Refresh); the record-sharing/People read-only rows follow the
  TA-10 `RecordSharingRowData` precedent (data exposed directly, no wrapper unless a seam
  needs it).
- Whether "add by team" offers a team picker (from TA-10 teams) or free-text team id -
  prefer the picker from existing teams for integrity; builder's call.
- The interaction model MUST stay teardown-safe (TA-10 ruling): scalar/in-place edits call
  `RefreshDirty()` only; add/remove/select rebuild via `Refresh()`.

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public, no inline string literals, enums over unions, VMs
  extend `Observable`, `IDisposable` not lambdas, tests under `admin/tenant-portal/tests/`.
- New `.ts` files pure ASCII + LF; byte-scan after every write. `sed -i` never on a CRLF
  file; `tenant-app.ts` untouched; no DTO shape changes in `tenant-types.ts`.
- Secrets/tokens out of scope; nothing cross-tenant; reported capability == enforced.
- Portal gate: `npm test` + `npm run typecheck` in `admin/tenant-portal`. Merged-result
  gate: server-root `test` + `typecheck:tools` green.

## Review focus (inputs no happy-path test exercises)

- A `roleAssignment` claim rule shared by two roles: toggling role A out of it must leave
  role B in it (and only drop the rule when both are gone).
- A model loaded WITHOUT `roleAssignment`: adding then removing a grant (net empty) emits
  `ToDto()` with `roleAssignment` still absent; a kept grant makes it present.
- One Save after edits across all four areas (a privilege, a field grant, an org edit, an
  assignment edit) persists every section in a single `SetSecurityModel`.
- A role granted only by a claim rule and a team (no direct principals): the People count is
  0/explicitly "none direct", and the holders summary still shows the claim and team rules -
  no fabricated number, no empty-looking tab.
- Removing a team (TA-10) that a `teamRoles`/`teamProfiles` grant references: the grant is
  already cleared by TA-10's removal integrity; TA-11's People/profile views must not
  resurrect or dangle it.
- A principal override or team grant that lists a role/profile id no longer in the model:
  the filtered per-role/per-profile view simply does not show it; it must not crash and must
  round-trip untouched (not silently dropped).
