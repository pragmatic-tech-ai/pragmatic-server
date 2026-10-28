# TA-10 - Org structure, ownership, membership (B1-5b) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD).
**Area:** Tenant Admin > Users & Access > Roles & permissions (the consolidated Security model editor).
**Builds on:** TA-9 (`SecurityModelViewModel` / `SecurityModelView` / `SecurityModelDraft`, one draft / one Save).
**Reconciliation:** `docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md` section 2 (table rows: org structure, membership, ownership, record-sharing view) and section 4 item 10.

## Intent and why

The PP security model is one document (`SecurityModelDto`) stored per environment and
replaced wholesale by `PUT admin/security-model`. TA-9 landed the two richest sections
(roles x privilege levels, field profiles x secured fields) on one draft with one Save,
closing the cross-screen silent-drop. The remaining editable sections of that same
document are the **organization structure** the privilege levels refer to:

- **Business units** (a tree; each unit optionally has a parent) and **teams** (each
  optionally owned by a business unit). These are what the AccessLevels
  "Business unit" and "BU and children" actually *mean* - without them those levels
  grant access to nothing nameable.
- **Membership**: how incoming principals are sorted into a home business unit and
  teams, by claim-to-value rules plus per-principal overrides.
- **Ownership rules**: for each concept, which business-unit source owns its records
  and (optionally) which owner source - the thing that makes "records their business
  unit owns" a concrete set.

And one **derived** surface, not new data:

- **Record sharing**: a plain-language, per-role summary of *what records* a role can
  reach for each concept, read off the role's AccessLevels + the ownership rules + the
  org names. The prototype's "own / team / all" radio is exactly this view; in the real
  model it is a projection, never a stored field.

Why now: these sections are already DTO fields the server round-trips, and TA-9's draft
already deep-clones and preserves them untouched. A tenant admin cannot reason about
"Business unit" access until they can see and edit the units, teams, membership, and
ownership that give those levels referents. This is the second half of making the one
consolidated editor complete; assignment (who holds which role / profile) is TA-11.

## Goals

- Edit **business units** as a tree: add, rename, remove, and re-parent a unit; the
  tree is derived from `parent` pointers.
- Edit **teams**: add, rename, remove, set a team's owning business unit.
- Edit **membership**: claim-to-value rules (each mapping to a home business unit and/or
  teams) and per-principal overrides (home business unit and/or teams).
- Edit **ownership rules**: per concept, an owning-business-unit source and an optional
  owner source (each source is a `{ kind, value }` pair).
- Show a **Record sharing** per-role derived view: for each concept the role touches, a
  plain-language sentence describing the record scope and whether the role can
  share/assign, read from levels + ownership + org names.
- All of the above live on the **same** `SecurityModelDraft` (one dirty flag, one
  `ToDto()`, one Save) and the **same** `SecurityModelView` / `SecurityModelViewModel`.
  One Save persists an org edit and a role edit together (the TA-9 silent-drop guarantee
  extended to the new sections).
- **Referential integrity on removal**: removing a business unit clears it from team
  `owningBusinessUnit`, membership `homeBusinessUnit` (rules and overrides), and
  ownership rule sources that point at it by id; removing a team clears it from
  membership `teams` (rules and overrides). No dangling id survives into `ToDto()`.
- Round-trip tests: a model loaded, lightly edited in one section, and emitted via
  `ToDto()` preserves every other section byte-for-byte (structurally), including the
  TA-9 sections and the untouched `roleAssignment` / `fieldSecurity.profileAssignment`.

## Non-goals

- **Assignment** (`roleAssignment`, `fieldSecurity.profileAssignment`) and the **People**
  sub-tab - that is TA-11. TA-10 does not touch those sections; the draft must continue
  to round-trip them untouched.
- A **concept/field catalog** picker - concepts and fields stay free text (as in
  TA-9/B1-3/B1-4); the catalog op is a filed backend Feature, not this spec.
- Any **new backend route or model field** - every section here already exists in
  `SecurityModelDto`; this is UI + draft only, over the existing GET/SET.
- Tenant-wide aggregation or "apply to all environments" - the editor stays
  per-environment (the env strip from TA-9 is kept).
- Validation of claim semantics against a real IdP - rules are free-form
  claim/value text, consistent with the rest of the editor.

## Anti-goals (a failure even if it "works")

- Reintroducing a second draft or a second Save for the org sections - that is the exact
  silent-drop TA-9 removed. One draft, one Save, full stop.
- Letting a removed business unit or team leave dangling ids in membership, teams, or
  ownership rules - a saved model with a `homeBusinessUnit` pointing at a deleted unit is
  a corruption the admin cannot see.
- Presenting record sharing as editable stored data - it is a read-only projection; an
  edit control there would imply a field that does not exist and would desync from the
  levels it is derived from.
- Showing any other tenant's / hive's / platform's structure, or leaking internals -
  the Tenant Admin honesty invariant holds (reported == enforced; nothing cross-tenant).

## Information architecture (the decided shape)

`SecurityModelView` today is: env strip -> role list -> per-role `Tabs[What they can do |
Fields]` -> one sticky save bar -> `ScreenHost` states. Org structure is **tenant-wide**,
not per-role, so it cannot live under a role. The decided restructure, all inside the one
view / VM / draft / save bar / env strip:

- An outer two-way mode switch (segmented control via the kit `Tabs`): **Roles** and
  **Organization**.
- **Roles** pane = the existing role list + per-role inner tabs, now three:
  `[What they can do | Fields | Record sharing]`. "Record sharing" is the new per-role
  derived view.
- **Organization** pane = tenant-wide inner tabs:
  `[Business units | Teams | Membership | Ownership rules]`. No role list in this pane.
- The env strip, the dirty/save bar ("N unsaved changes", Discard, Save security model),
  and the `ScreenHost` loading/empty/error/denied states remain shared and outside both
  panes. A save flushes the whole draft regardless of which pane is showing.

Rationale: a tenant admin reasons about the org chart and ownership separately from
per-role permissions, but both edit one document and save together. One outer switch
keeps the two mental models distinct on screen while preserving the single-draft
guarantee underneath. The role list belongs only to the Roles pane because org structure
has no "selected role".

## Draft composition (the decided shape)

`SecurityModelDraft` is already 367 lines and the reconciliation calls for composing
section helpers under the draft facade. TA-10:

- Adds a composed **`SecurityModelOrg`** helper (new file `security-model-org.ts`) that
  holds the same `SecurityModelDto` reference the draft owns and exposes the business
  unit / team / membership / ownership operations plus its own `Dirty` flag and the
  removal-integrity logic. The draft constructs it over `this.model` and forwards the org
  surface through thin methods/getters, so callers still see one draft facade.
- The draft's `Dirty` becomes `this.dirty || this.org.Dirty`. Rebasing on Save
  (`SecurityModelDraft.From(dto)`) builds a fresh draft + fresh org, so dirty resets
  naturally - no manual clean needed.
- Adds a **record-sharing derivation** (a focused helper, e.g. `RecordSharingDeriver`, or
  a method on the draft that composes role privileges + ownership + org names) returning
  plain-language rows for a given role id. Read-only; never sets dirty.
- `ToDto()` is unchanged in contract: deep-clone out, drop the TA-9 optional-absent
  sections, return. The org sections (`businessUnits`, `teams`, `membership`,
  `ownershipRules`) are **required** fields of `SecurityModelDto` and always present, so
  no absent-section bookkeeping is needed for them.

## What's left to the builder (plan + implementation calls)

- Exact id-minting scheme for business units and teams (follow the existing
  `role-<slug>-<n>` / `profile-<slug>-<n>` pattern in the draft; `bu-<slug>-<n>`,
  `team-<slug>-<n>`).
- Exact plain-language copy for the record-sharing sentences and the ownership/membership
  row labels (reuse the view's existing `LevelScopes` map and sentence fragments where
  they fit; all user-facing text hoisted to `private static readonly`).
- Cycle guard when re-parenting a business unit (a unit cannot become its own ancestor);
  the builder picks the guard (reject vs. no-op) and tests it.
- Row/VM-row component shapes for the four org sub-editors and the record-sharing list,
  following the TA-9 row conventions (`privilege-row.ts`, `field-grant-row.ts`): kit
  components, `inputs` interface, hoisted literals, test-seam getters.
- Whether membership/ownership editors use inline text fields or the kit `KeyValueGrid`;
  builder's call, consistent with the portal's existing controls.

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public, no inline string literals (hoist to
  `private static readonly`), enums over string-literal unions, VMs extend `Observable`,
  `IDisposable` not lambdas, tests under `tests/` subfolders.
- New `.ts` files pure ASCII (escape `—`, `…`, `·`, circle glyphs via
  `\uXXXX`); verify with a byte-scan after every write (the Write tool can turn escapes
  into literal chars).
- EOL discipline unchanged: new view/VM/row/helper/test files are **LF**; `tenant-app.ts`
  and its CRLF siblings are not touched by this spec. `sed -i` silently flips CRLF->LF -
  do not run it on CRLF files.
- Secrets/tokens never in scope here; nothing cross-tenant; reported capability ==
  enforced.
- Portal tests run via `npm test` + `npm run typecheck` in `admin/tenant-portal`;
  server-root `test` + `typecheck:tools` must stay green on the merged result.

## Review focus (inputs no happy-path test exercises)

- Removing a business unit that is referenced by a team, a membership rule, a membership
  override, and an ownership rule - all references clear, `ToDto()` has no dangling id.
- Removing a team referenced by membership rules and overrides - team ids clear from both.
- Re-parenting a business unit to create a cycle - guarded, no infinite tree walk.
- A model with empty org sections (fresh tenant) - the Organization pane shows an honest
  empty state with an Add action, not a crash or a blank grid.
- One Save after edits in both panes (an org edit + a role edit) - both persist in a
  single `SetSecurityModel`; neither section is dropped (the TA-9 regression, extended).
- A role whose levels reference business units that were since removed - the record
  sharing view degrades to plain scope wording without inventing a unit name.
