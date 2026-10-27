# Tenant-Admin "Roles & Privileges" — security-role privilege matrix (SP-ADMIN B1-3) — Design

**Status:** design
**Date:** 2026-10-27
**Repo:** `pragmatic-server`, `admin/tenant-portal` (ships one-per-hive). Branch off `master`.
**Program:** Backlog Program 2 → SP-ADMIN → Spec B → B1 (tenant-admin identity UI). Third B1 slice, after B1-1 (Users & Access, merged-local @add9890) and B1-2 (Service Tokens, merged-local @b35b720).
**Builds on:** the B1-1/B1-2 house pattern (imperative Mural view + `Observable` VM, env picker, `DataGrid`) and the Mural `DataGrid` (Spec B0, mural `main` @8ee9a5f1). **First in-app use of `DataGridTemplateColumn`.**

## Intent

Give a tenant operator a visual **security-role privilege matrix** for a selected environment: pick one of the environment's security-model roles and edit, for every concept, the access level granted to each of the eight privilege actions (create/read/update/delete/append/appendTo/assign/share) through a grid of cycling cells — then save the whole security model back. This replaces hand-editing the `securityModel.roles[].privileges[]` JSON. It is the first consumer of `DataGridTemplateColumn`, and it introduces the `SecurityModelDraft` the field-security designer (B1-4) will share.

## Goals

- A **Roles & Privileges** screen reached from a new top-bar nav entry, environment-scoped (same env picker as B1-1/B1-2).
- Load the environment's `SecurityModelDto` via the **existing** `GET /tenant-api/environments/:name/admin/security-model` route; save via the **existing** `PUT` route. **No server changes.**
- A **role picker** over `securityModel.roles[]` (the custom security-model roles — `RoleConfigDto{id,name}`, distinct from the five identity grant roles). Add a role (name → new `RoleConfigDto` with a generated id and empty privileges) and delete a role.
- For the selected role, a **privilege matrix `DataGrid`**: one row per concept, one column per privilege action (8), each cell a **cycling `AccessLevel` control** (none → user → businessUnit → businessUnitAndChildren → organization → none). A first "Concept" text column identifies the row.
- **Add a concept** row via a free-text field (the concept set otherwise derives from the model — see R2); the new row starts at `none` for every action.
- **Save** (PUT the whole mutated model) and **Revert** (reload); a dirty indicator; the full **states** matrix (loading / empty / populated / error / permission-denied), errors surfaced as the backend's generic strings, 401 → login.
- **Round-trip safety:** every section of the model the matrix does not edit (businessUnits, teams, membership, ownershipRules, roleAssignment, fieldSecurity) is preserved byte-for-byte across load→edit→save.

## Non-goals / anti-goals (this spec)

- **A server concept/field catalog op** — none exists; the matrix derives its concept set from the model and allows free-text add (R2). → remains the deferred Project **Feature** (shared with B1-4), as filed from B1-1.
- **Field-security designer** (`securityModel.fieldSecurity`) — B1-4, which **shares the `SecurityModelDraft`** this spec introduces.
- **Org structure** (business units, teams, membership, ownership, role/profile assignment editing) — B1-5. This spec edits only `roles[].privileges[]`; it preserves the rest untouched.
- **Role rename** — add + delete only in v1; rename is an additive later change.
- **Cross-environment aggregation** — env-scoped, consistent with B1-1's R1.

## Rulings

- **R1 — UI-only, existing routes.** GET/PUT security-model already exist on the per-environment REST surface (`tenant-api-endpoint.ts`, `AdminGetSecurityModel`/`AdminSetSecurityModel`), policy-gated `administer`. B1-3 adds no server code. *Cost if wrong:* n/a — verified in recon.
- **R2 — concepts derive from the model + free-text add; no catalog.** The row set is the sorted union of concepts appearing in `roles[].privileges[].concept`, `ownershipRules[].concept`, and `fieldSecurity.securedFields[].concept`, plus any the operator adds by typing. *Why:* there is no backend list of valid concepts, and a matrix needs rows; the model itself is the best available source. *Cost if wrong:* when the catalog Feature lands, the free-text field becomes a picker — additive, no rework of the matrix.
- **R3 — PUT the whole model; edit only `roles`.** The route replaces the entire `SecurityModelDto`, so the VM loads the full model into a `SecurityModelDraft`, mutates only `roles[].privileges[]`, and resends the whole draft. All other sections are carried verbatim. *Why:* partial PUT is not offered by the route; dropping a section would silently wipe BUs/teams/field-security. *Cost if wrong:* a round-trip test catches any dropped section before merge; this is the spec's load-bearing correctness property.
- **R4 — copy the full nested `SecurityModelDto` shape into `tenant-types.ts` verbatim.** The portal never imports `pragmatic-protocol` types; it copies wire shapes. The full nested tree (BusinessUnit/Team/Membership/Ownership/RoleConfig/Privilege/RoleAssignment/FieldSecurity DTOs) is copied so the draft is strongly typed and round-trips losslessly. *Why:* honest round-trip + B1-4 reuses the same types for field-security. *Cost if wrong:* a protocol shape change must be mirrored here — the same maintenance the other copied DTOs already carry.
- **R5 — cycling `AccessLevel` cell, not a ComboBox.** The portal house pattern has no ComboBox. Each matrix cell is a `Button` whose label is the current level's short symbol; clicking advances to the next level and writes back to the draft in place (no full-grid re-render). A legend maps symbols → level names. *Why:* matches the Dataverse privilege-wheel idiom and the portal's no-ComboBox, button-strip convention (B1-2 duration strip). *Cost if wrong:* if cycling proves clumsy for 8 columns, a per-cell button strip or a future ComboBox is a localized cell-template swap.
- **R6 — introduce `SecurityModelDraft`, shared with B1-4.** A class owning the loaded model, the dirty flag, role selection, the derived concept set, the per-cell mutations, and the `ToDto()` that produces the model to PUT. B1-4 extends the same draft with field-security editing. *Cost if wrong:* if the B1-4 sharing is awkward, the draft is still the right single-responsibility home for B1-3's state.
- **R7 — env-scoped, top-bar entry.** A **Roles & Privileges** nav entry + the shared env picker; `ITenantNavigator.ShowRolesPrivileges()`. *Cost if wrong:* consistent with B1-1/B1-2.

## Architecture

**Server:** no changes. GET returns `SecurityModelDto | null`; PUT body `{ securityModel }` → `200`. Ownership/auth unchanged (`OwnedEnv` + `TenantAuthGate`; cross-tenant/unknown → 404; RBAC `administer`).

**UI (`admin/tenant-portal/src/`):** mirrors B1-1/B1-2.

| File | Role |
|---|---|
| `security-model-draft.ts` | `SecurityModelDraft` — holds the loaded `SecurityModelDto`, selected role id, dirty flag; derives the concept set (R2); exposes `LevelFor(concept, action)` / `SetLevel(concept, action, level)` / `CycleLevel(concept, action)`, `AddRole(name)` / `DeleteRole(id)`, `AddConcept(name)`, and `ToDto()` that returns the full model with the edited `roles[].privileges[]`. Pure state + logic, no Mural types — unit-testable and reused by B1-4. |
| `privilege-row.ts` | `PrivilegeRow` — plain per-concept row object the matrix `DataGrid` binds: `Concept` + a cell accessor per action, backed by the draft. Built fresh per role/concept-set change. |
| `roles-privileges-view-model.ts` | `RolesPrivilegesViewModel extends Observable` — env list+selection, the `SecurityModelDraft`, role list + selected role, matrix rows, busy/error/state, dirty; `LoadEnvironments`/`SelectEnvironment`/`LoadModel`/`SelectRole`/`AddRole`/`DeleteRole`/`AddConcept`/`CycleCell`/`Save`/`Revert`. Reuses B1-1/B1-2 busy-counter + load-token + 401-rethrow (`FailWith`). Consumes `ISecurityModelSource`. |
| `roles-privileges-view.ts` | `RolesPrivilegesView extends TenantViewBase` — env picker strip, role picker strip + add/delete-role, the matrix `DataGrid` (a `DataGridTextColumn` "Concept" + eight `DataGridTemplateColumn`s whose `CellTemplate` builds the cycling `AccessLevel` button for that action), add-concept field, a legend, Save/Revert buttons + dirty indicator, states. `get Grid()` seam; `Dispose()` releases grid + listeners. |
| `tenant-api-client.ts` | `GetSecurityModel(env)` / `SetSecurityModel(env, model)` via `Send<T>` + the `/admin/security-model` leaf; `implements ISecurityModelSource`. |
| `tenant-types.ts` | Full nested `SecurityModelDto` shape (R4) + `ISecurityModelSource`; `ITenantNavigator.ShowRolesPrivileges()`. |
| `tenant-app.ts` | **Roles & Privileges** top-bar entry + `ShowRolesPrivileges()` (`new RolesPrivilegesView(this.client)`). |
| `tests/fake-tenant-control-plane.ts` | `/admin/security-model` GET/PUT routes for e2e (GET returns a seeded model; PUT echoes/stores it). |

**`DataGridTemplateColumn` usage (first app use):** eight columns, one per `PrivilegeAction`. Each column's `CellTemplate = new DataTemplate(data => …)` where `data` is the `PrivilegeRow`; the factory, closing over its action, builds a `Button` whose content is the symbol for `row.LevelFor(action)` and whose click calls `row.Cycle(action)` (→ draft `CycleLevel`), updates the button content in place, and notifies the VM (dirty). Column header is the action name. The Concept column is a `DataGridTextColumn`. The grid is a view field, re-fed via `ItemsSource` only when the role or concept set changes (per-cell edits mutate in place, no re-feed) — the B1-1/B1-2 suppress-selection discipline applies.

## Trust-boundary / security UX

- No secrets in this slice. The security model carries no credentials; it is configuration.
- **Round-trip integrity is the security-relevant property:** silently dropping `fieldSecurity` or `roleAssignment` on save would weaken the environment's security posture. R3 + a round-trip test (load a full model, edit one cell, assert every other section is byte-identical in the PUT body) pin it.
- Errors are the backend's fixed generic strings surfaced verbatim; 401 → `ShowError` → `ShowLogin`; 403 → permission-denied state; 404 cross-tenant/unknown env.

## Testing

- **UI:** `tsx --test` VM tests against a fake `ISecurityModelSource` (load populates roles+concepts+matrix; select-role swaps the matrix; cycle advances and wraps; add-role/add-concept; save calls `SetSecurityModel` with a model whose untouched sections equal the loaded ones and whose selected role's privileges reflect the edits; revert reloads; error/self states). A dedicated **round-trip test** asserts R3. View tests at the B1-1/B1-2 altitude: the matrix renders one row per concept and one cell per action via the `Grid` seam; cycling a cell updates its label; role picker / add-concept / Save-Revert / legend / states render; dirty indicator reflects edits. Extend the e2e fake with the routes.
- Gates: `npm --prefix admin/tenant-portal test` + `typecheck`; `npm run typecheck:tools`. (DataGrid already in mural `dist` — no mural rebuild.) LF for new files; match pre-existing CRLF (the tenant-portal EOL map from B1-1/B1-2 applies: `tenant-api-client.ts`/`tenant-app.ts` + their tests are CRLF; `tenant-types.ts`/`fake-tenant-control-plane.ts` are LF; new files LF). OOP/Allman/PascalCase/no-inline-literals; VMs extend `Observable`.

## Left to the plan

Exact signatures on `ISecurityModelSource`/`TenantApiClient`/`SecurityModelDraft`/`PrivilegeRow`; the `AccessLevel` cycle order + symbol/label constants home; the eight-action column key/header constants; the role-id generator; the concept-sort + dedup rule; the legend layout; DataGrid column widths; and task decomposition (likely: DTOs+client+fake routes → `SecurityModelDraft` + concept derivation + round-trip → VM + `PrivilegeRow` → view + matrix `DataGridTemplateColumn` + cells + legend → nav wiring).
