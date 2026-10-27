# Tenant-Admin "Field Security" — field-security designer (SP-ADMIN B1-4) — Design

**Status:** design
**Date:** 2026-10-27
**Repo:** `pragmatic-server`, `admin/tenant-portal` (ships one-per-hive). Branch off `master`.
**Program:** Backlog Program 2 → SP-ADMIN → Spec B → B1 (tenant-admin identity UI). Fourth B1 slice, after B1-1 (Users & Access @add9890), B1-2 (Service Tokens @b35b720), B1-3 (Roles & Privileges @8679125).
**Builds on:** B1-3 directly — it **shares and extends the `SecurityModelDraft`** B1-3 introduced, reuses the same VM plumbing (busy-counter / load-token / `FailWith` / `Forbidden` state), the same env picker, and the same `DataGridTemplateColumn` mechanism — now with **checkbox cells** (read/update/create booleans) instead of B1-3's cycling `AccessLevel` button.

## Intent

Let a tenant operator manage an environment's **field-level security** from the portal: declare which (concept, field) pairs are secured, define field-security **profiles**, and for a selected profile edit a matrix of secured fields × {read, update, create} as checkboxes — then save the whole security model back. This edits `securityModel.fieldSecurity`; it is the second consumer of `DataGridTemplateColumn` and completes the security-model designer pair (roles in B1-3, fields here) over one shared draft.

## Goals

- A **Field Security** screen reached from a new top-bar nav entry, environment-scoped (same env picker as B1-1..B1-3).
- Load/save the environment's `SecurityModelDto` via the **existing** GET/PUT `admin/security-model` routes (client methods already exist from B1-3). **No server changes.**
- **Secured-field management:** the `securityModel.fieldSecurity.securedFields` list of `{ concept, field }`. Add a secured field (free-text concept + field) and remove one; removing a secured field also strips its grants from every profile (no orphan grants).
- **Profile picker** over `fieldSecurity.profiles[]` (`FieldProfileDto{id,name,grants}`). Add a profile (name → new id, empty grants) and delete one — mirroring B1-3's role picker.
- For the selected profile, a **field-grant matrix `DataGrid`**: one row per secured field (concept · field), three columns Read / Update / Create, each cell a **`Checkbox`** bound to that profile's grant boolean. A grant whose three flags are all false is treated as absent (no field access).
- **Save** (PUT the whole mutated model) and **Revert**; a dirty indicator; the full **states** matrix (loading / empty / populated / error / permission-denied), errors as the backend's generic strings, 401 → login, 403 → permission-denied.
- **Round-trip safety (extended):** editing field security preserves every other section — `businessUnits, teams, membership, ownershipRules, roles, roleAssignment`, and `fieldSecurity.profileAssignment` — byte-for-byte; and editing field security must not disturb B1-3's role editing on the same shared draft (and vice versa).

## Non-goals / anti-goals (this spec)

- **A server concept/field catalog op** — still none; secured fields are free-text entry. → remains the deferred Project **Feature** (shared with B1-1/B1-3).
- **Field-profile assignment** (`fieldSecurity.profileAssignment` — claims/overrides/team-profile mapping) — preserved untouched; its editor is a later slice (with B1-5 org structure).
- **Org structure** (business units, teams, membership, ownership) — B1-5.
- **Role/privilege editing** — that is B1-3; this slice touches only `fieldSecurity`.
- **Cross-environment aggregation** — env-scoped, consistent with R1 across B1.

## Rulings

- **R1 — UI-only, existing routes.** Reuse the GET/PUT `admin/security-model` surface and the client's `GetSecurityModel`/`SetSecurityModel` (added in B1-3). No server code. *Cost if wrong:* n/a.
- **R2 — extend the shared `SecurityModelDraft`.** The same draft that owns the whole model for B1-3 gains field-security editing; `ToDto()` emits both the edited `roles` and the edited `fieldSecurity`, preserving all other sections. *Why:* one source of truth, and the recon committed B1-4 to share B1-3's draft. *Cost if wrong:* if the two editors' state ever conflicts, split into a role-draft and a field-draft over a common base — but they edit disjoint sections, so sharing is clean. This is the load-bearing decision; a round-trip test pins that field edits preserve roles and role edits preserve fieldSecurity.
- **R3 — secured-field rows = the model's `securedFields` list + free-text add; remove strips grants.** No catalog. Removing a secured field also removes any matching `{concept,field}` grant from every profile, so no profile keeps a grant to a field that is no longer secured. *Cost if wrong:* an orphan grant would be dead data the engine ignores; the strip keeps the model clean.
- **R4 — checkbox cells; all-false grant == absent.** Each matrix cell is a `Checkbox` for one (profile, securedField, permission). A `FieldGrantDto` whose read/update/create are all false is dropped from the profile's `grants` (absent = no access), mirroring B1-3's None-removes-entry. *Why:* the house pattern's `DataGridTemplateColumn` + `Checkbox` (two-way-capable) is the right control for booleans; absent==deny matches the engine. *Cost if wrong:* a redundant all-false entry is harmless; the normalization just keeps the saved model minimal.
- **R5 — profile picker + add/delete (mirror B1-3 role picker); `profileAssignment` preserved, not edited.** *Cost if wrong:* assignment editing is an additive later slice.
- **R6 — env-scoped, top-bar entry.** A **Field Security** nav entry + the shared env picker; `ITenantNavigator.ShowFieldSecurity()`. *Cost if wrong:* consistent with B1-1..B1-3.
- **R7 — reuse the B1-3 VM plumbing and source interface.** A `FieldSecurityViewModel` parallel to `RolesPrivilegesViewModel` (same busy-counter / load-token / `FailWith` / `Forbidden`-state shape) and a `FieldGrantRow` parallel to `PrivilegeRow`. The VM consumes the existing `IRolesPrivilegesSource` (= `ISecurityModelSource` + `ListEnvironments`) — it needs exactly that (security model + env list); the client already satisfies it. *Cost if wrong:* the interface name is role-flavored; a future rename to a neutral `ISecurityModelAdminSource` is trivial and touches two consumers.

## Architecture

**Server:** no changes.

**UI (`admin/tenant-portal/src/`):**

| File | Role |
|---|---|
| `security-model-draft.ts` | **MODIFY** — extend with field-security state + methods: `get SecuredFields(): readonly SecuredFieldDto[]`, `get Profiles(): readonly FieldProfileDto[]`, `SelectedProfileId`, `FieldGrant(concept, field, permission): boolean` (selected profile's grant, absent→false), `SetFieldGrant(concept, field, permission, value)`, `AddProfile(name): string`, `DeleteProfile(id)`, `AddSecuredField(concept, field)`, `RemoveSecuredField(concept, field)` (also strips matching grants from all profiles); `ToDto()` now also emits the edited `fieldSecurity` (with a `fieldSecurityAbsent` guard mirroring `rolesAbsent`). Add local `enum FieldPermission { Read='read', Update='update', Create='create' }` + `const FieldPermissions = [Read, Update, Create]`. All existing B1-3 role methods and tests stay green. |
| `field-grant-row.ts` | `FieldGrantRow` — plain row: `Concept`, `Field`, `Label` (concept · field), `IsGranted(permission: FieldPermission): boolean`, `Toggle(permission, value): void` (delegates to the draft). Holds the (concept, field) + a draft reference. |
| `field-security-view-model.ts` | `FieldSecurityViewModel extends Observable` — env list+selection, the shared `SecurityModelDraft`, profile list + selected profile, secured-field rows, busy/error/state/dirty/Forbidden; `LoadEnvironments`/`SelectEnvironment`/`LoadModel`/`SelectProfile`/`AddProfile`/`DeleteProfile`/`AddSecuredField`/`RemoveSecuredField`/`Save`/`Revert`/`RefreshDirty`. Reuses B1-3's busy-counter + load-token + `FailWith` + `Forbidden` state verbatim in shape. Consumes `IRolesPrivilegesSource`. |
| `field-security-view.ts` | `FieldSecurityView extends TenantViewBase` ctor `(source: IRolesPrivilegesSource)` — env picker strip, profile picker strip + add/delete-profile, the secured-field matrix `DataGrid` (a `DataGridTextColumn` "Field" showing concept · field + three `DataGridTemplateColumn`s Read/Update/Create whose `CellTemplate` builds a `Checkbox` reflecting `row.IsGranted(permission)`; on click → `row.Toggle(permission, cb.IsChecked)` + `vm.RefreshDirty()` in place, no grid rebuild), an add-secured-field form (concept `TextBox` + field `TextBox` + button), remove-secured-field on the selected row, Save/Revert + dirty indicator, states. All mutating handlers gated via a `WhenIdle` guard while `vm.Busy`. `get Grid()` seam; `Dispose()` releases grid + listeners. |
| `tenant-types.ts` | Add `ITenantNavigator.ShowFieldSecurity(): void`. (All field-security DTOs were copied in B1-3.) |
| `tenant-app.ts` | **Field Security** top-bar entry + `ShowFieldSecurity()` (`this.Show(new FieldSecurityView(this.client))`). |
| `tests/fake-tenant-control-plane.ts` | Enrich the seeded security model's `fieldSecurity` so e2e has ≥2 secured fields and ≥1 profile with grants (optional; the GET/PUT routes already exist from B1-3). |

**`DataGridTemplateColumn` usage (second app use, checkbox variant):** three columns, one per `FieldPermission`. Each column's `CellTemplate = new DataTemplate(data => …)` where `data` is the `FieldGrantRow`; the factory, closing over its permission, builds a `Checkbox` with `IsChecked = row.IsGranted(permission)` and an `AddClickHandler` that (guarded by `WhenIdle`) calls `row.Toggle(permission, cb.IsChecked)` (→ draft `SetFieldGrant`) and `vm.RefreshDirty()`. The "Field" column is a `DataGridTextColumn` on the row's `Label`. The grid is a view field re-fed via `ItemsSource` only when the profile or secured-field set changes; per-cell toggles mutate in place.

## Trust-boundary / security UX

- No secrets; field security is configuration.
- **Round-trip integrity is the security-relevant property** (now across two editors sharing one draft): silently dropping `roles`, `roleAssignment`, or `profileAssignment` when saving field edits would weaken the environment. R2 + a round-trip test (load a full model with both `roles` and `fieldSecurity`, toggle one field cell, assert every non-`fieldSecurity` section — including `roles` and `profileAssignment` — is byte-identical in the PUT body) pin it, plus a regression test that B1-3's role edit still preserves `fieldSecurity`.
- Errors are the backend's generic strings; 401 → login; 403 → permission-denied state; 404 cross-tenant/unknown env.

## Testing

- **UI:** `tsx --test` draft tests (field-grant read/absent→false; set/toggle; all-false removes the grant; AddProfile/DeleteProfile; AddSecuredField/RemoveSecuredField strips grants; **round-trip**: toggling a field cell preserves roles + roleAssignment + profileAssignment + org sections; **regression**: a role edit still preserves fieldSecurity). VM tests against a fake `IRolesPrivilegesSource` (load populates profiles+securedFields+matrix; select-profile swaps the matrix; toggle sets the draft; save sends a model whose non-fieldSecurity sections equal the loaded ones; revert reloads; 401 rethrow; 403→Forbidden; load-token stale guard). View tests at the B1-3 altitude: the matrix renders one row per secured field and one checkbox per permission via the `Grid` seam (realized-grid walk); toggling a cell flips its state + the dirty indicator; profile picker / add-secured-field / remove / Save-Revert / states render distinctly. Enrich the e2e fake seed.
- Gates: `npm --prefix admin/tenant-portal test` + `typecheck`; `npm run typecheck:tools`. No mural rebuild. LF for new files; match pre-existing CRLF (`tenant-app.ts` + its test are CRLF; `tenant-types.ts` + `fake-tenant-control-plane.ts` are LF; `security-model-draft.ts` + its test are LF). OOP/Allman/PascalCase/no-inline-literals; VMs extend `Observable`.

## Left to the plan

Exact signatures on the extended `SecurityModelDraft`/`FieldGrantRow`/`FieldSecurityViewModel`/`FieldSecurityView`; the `FieldPermission` display-label + column-key constants home; the profile-id generator (reuse the role-id slug approach); the secured-field row key/label format (concept · field) and dedup rule; the checkbox cell template; the legend/header text; DataGrid column widths; and task decomposition (likely: extend draft + round-trip/regression tests → VM + FieldGrantRow → view + checkbox matrix → nav wiring).
