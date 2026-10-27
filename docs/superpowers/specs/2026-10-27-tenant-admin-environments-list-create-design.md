# Tenant-Admin Environments List & Create (SP-ADMIN TA-4) — Design

**Status:** design
**Date:** 2026-10-27
**Repo:** `pragmatic-server`, portal `admin/tenant-portal/*` (+ a client method; the server create route already exists). Branch off `master`.
**Program:** Backlog Program 2 → SP-ADMIN → Admin-apps build → Tenant Admin. Fourth tenant spec (after TA-1 kit @114195d, TA-2 shell @ad5b9d7, TA-3 profile/permissions @d524b5f). Reconciliation: `docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md` §1.2, §3.
**Design source:** `dev-kit/design/admin-apps/src/tenant.jsx` — `Environments` (list), `CreateEnv` (dialog), `lifecycle` (bulk actions); brief §5.2.

## Intent

Replace the TA-2 interim host under the **Environments** nav section — currently the old hive-first `tenant-tree-view` — with the design's real Environments experience: a searchable, selectable table of the tenant's environments with status/health/version/live-URL at a glance, bulk Start/Restart/Stop, a row that opens the existing Environment detail, and a Create-environment dialog. This closes the first half of the brief's environment loop and retires the hive-first tree model for good.

## The design-vs-reality reconciliation (the spec's spine)

The prototype is fiction grounded in a Capability-Maps demo; the real server models environments differently. Re-implement the design's **layout, behaviour, states, and copy** against the **real fields and existing reads**, never inventing a backend:

| Design (prototype) | Real server | TA-4 decision |
|---|---|---|
| Create: Type = Production/Staging/Sandbox + version + size | POST `{name, template, type}`; `Template`={dev-blank,demo-contoso,runtime-postgres}, `EnvType`={development,runtime}; no version/size | Create dialog offers **Template + Type** (real enums). Drop version (adopt-time, TA-6) and size (unmodeled). |
| Name regex `^[a-z][a-z0-9-]{2,30}$` + dup check | server: non-empty string; 409 `EnvironmentExistsError` on dup | Keep the **client regex + dup-against-loaded-list** for UX; the 409 is the backstop. |
| Columns: Status, Health, Application+version, Live URL | `EnvironmentDto` has only `status` (EnvStatus); health/version/liveURL absent from it | **Join existing reads:** Status from the DTO; Health + running version from `GetHealth(hiveId)` joined by `environmentName` (`ready`→pill, `runningImage`→version); Live URL from the DTO's `httpUrl`. **No `EnvironmentDto` change.** |
| 4-step provision animation; `https://<id>.<baseDomain>/...` preview | create returns the DTO (status provisioning/unknown); events socket fires `environment-created`; no baseDomain on the wire | **No fake step animation; no fabricated URL preview.** Show the real created env + let the events socket drive status. Dialog keeps the reassurance copy only. |

## Goals

- An **`EnvironmentsView`** (replacing the interim tree under Environments) built on the TA-1 kit + Mural `DataGrid`:
  - `Section` titled "Environments" (sub "Running workspaces in your hive. Each serves Capability Maps at its own address.") with a **Create environment** `Act` (gated on `envs`).
  - A **`ScreenHost`** 5-state wrapper: loading (Table skeleton), empty (the design's "No environments yet" + a Create action), error, populated. (No denied state — any tenant session may list envs; create/bulk are gated per-action via `Act`.)
  - A **search/filter box** (Mural `TextBox`) filtering rows by name/id/version (design `searchKeys`, placeholder "Filter environments").
  - A **DataGrid** with columns: **Environment** (name + `environmentId . template` sub), **Status** (`StatusPill`), **Application** (running version from the health join, "—" when unknown), **Health** (`StatusPill`), **Live URL** (`httpUrl` link when running, else status-appropriate text). A **selection checkbox** column + a **select-all** header checkbox over the filtered rows.
  - A **bulk toolbar** (shown when a selection exists): `Act` Start (on stopped), Restart (on running), Stop (on running), each gated on `envs`, iterating the per-name client methods; plus the static note "Deleting is one environment at a time."
  - A **row opens** the existing `EnvironmentDetail` via `Navigator.ShowEnvironmentDetail(env)` (the preserved seam).
  - **Live updates** via the events socket (reuse the tree VM's reload logic, extended to also reload on `health-changed` since health is now shown).
- An **`EnvironmentsViewModel`** (`Observable`): load = `ListEnvironments` + per-distinct-hive `GetHealth` joined by `environmentName`; row projection; search filter; a selection set (by `environmentName`); bulk start/stop/restart; `ApplyEvent`; busy-counter + load-token (newer-wins) + error state, matching the B1/TA VM conventions.
- A **`CreateEnvironmentDialog`** (Mural `Dialog`): Name `TextBox` (validate `^[a-z][a-z0-9-]{2,30}$` + not-in-loaded-names, with the design's two error messages), **Template** picker (dev-blank/demo-contoso/runtime-postgres), **Type** picker (development/runtime), reassurance copy; Cancel + a **Create** `Act` disabled until valid; on success → refresh the list (events socket also fires) and `ShowEnvironmentDetail` the new env. 409 → inline "An environment with this name exists."
- A **`CreateEnvironment(name, template, type)`** client method (POST `/tenant-api/environments`, returns `EnvironmentDto`); the test fake gains a POST `/tenant-api/environments` branch.
- **Portal enum mirrors** for `Template`/`EnvType`/`EnvStatus` (per the enums-over-string-unions house rule; the portal currently widens them to `string`).
- **Shell rewire:** `tenant-app.ts` `ShowEnvironments` builds the new list; `OnTenantEvent` routes to it; the `tenant-tree-view` comes off the nav.

## Non-goals / anti-goals (this spec)

- **Column sorting.** Mural `DataGrid` has no sort seam; building click-to-sort headers is disproportionate now. The search filter + a small list suffice; sorting is a later polish (TA-16). Search IS included.
- **Delete.** Per the design ("Deleting is one environment at a time") delete lives on the Environment **detail** — TA-5, behind a new `DELETE` route. TA-4 only shows the note.
- **Version/size at create, adopt, release matrix, the fail-closed verify banner** — TA-6. **Env detail redesign, tabs, logs drawer** — TA-5. **Overview cards** — TA-7. **Real provision progress / ops drawer** — TA-14.
- **Extending `EnvironmentDto`** with health/version/bundle/liveURL fields — deferred to the specs that own that data (TA-5/TA-6/TA-15); TA-4 joins existing reads instead.
- **A new bulk server route** — none exists; bulk iterates per-name actions.
- **Reaching `HiveDetail` from the tenant nav** — the hive-first model is retired (see R6).

## Rulings

- **R1 — Create dialog uses the real create fields, not the prototype's.** Name (validated client-side by the design regex + dup-against-loaded-names) + **Template** (dev-blank/demo-contoso/runtime-postgres) + **Type** (development/runtime). No version, no size (not part of the real create; version is adopt-time = TA-6, size is unmodeled). No fabricated address preview (no baseDomain on the wire); keep only the reassurance copy ("Runs in your hive. It takes a few minutes; you can leave this page."). *Why:* designs give layout/behaviour/copy/states; the fields must match the real op; never invent a backend model. *Cost if wrong:* adding version/size later is a dialog + route change, additive.
- **R2 — list columns are backed by existing reads joined, with no `EnvironmentDto` change.** Status from the DTO (`EnvStatus`); Health and running version from `GetHealth(hiveId)` joined by `environmentName` (`ready` true→`PillKind.Healthy`, false→`PillKind.Failing`; `runningImage`→the Application cell, "—" when absent); Live URL from the DTO's `httpUrl` (link when `running`, else "Stopped"/"Not serving" text). The health join is **best-effort**: if a hive's `GetHealth` fails or lacks an entry, Status/URL still render and Health/version show "—". *Why:* avoids a premature DTO expansion owned by TA-5/6/15; honest columns from real data today. *Cost if wrong:* a later `EnvironmentDto` field replaces the join; the column stays.
- **R3 — selection + bulk via a VM selection set + a checkbox column + select-all over filtered rows.** The VM holds a `Set<string>` of selected `environmentName`s; a `DataGridTemplateColumn` renders a Mural `Checkbox` per row; a header checkbox toggles all currently-filtered rows. The bulk toolbar's Start/Restart/Stop `Act`s (gated on `envs`, undefined=permissive) iterate `Start/Stop/RestartEnvironment` per selected name of the eligible status, then clear the selection and reload. *Why:* the design is explicitly selectable + bulk; no bulk server route exists. *Cost if wrong:* n/a.
- **R4 — column sorting deferred; search included.** (See non-goals.) *Cost if wrong:* additive later.
- **R5 — live updates reuse the tree VM's reload logic, extended to `health-changed`.** `environment-created`→reload; `environment-changed`/`environment-deleted`→reload if the env is currently shown; `health-changed`→reload (new vs the tree, because the list now shows health). Load uses a generation/token guard (newer-wins) and swallows failures. *Why:* the list surfaces health, so health events must refresh it. *Cost if wrong:* a spurious reload at worst.
- **R6 — retire the "My Hives" tree entirely; `HiveDetail` leaves the tenant nav.** The env list replaces the interim tree under Environments and reaches `EnvironmentDetail` via `ShowEnvironmentDetail`. The tree reached `HiveDetail` via hive nodes; the design's tenant app has no hive navigation (the hive is fixed/singular — identity plate + Connection status TA-12 + Settings TA-13 own hive info). Keep `hive-detail-view.ts`/`tenant-tree-view*.ts` files in the tree (unreferenced) for TA-12/13 to reuse or retire, but remove them from navigation and the shell's wiring. *Why:* the design drops the hive-first two-pane model. *Cost if wrong:* re-adding a hive entry is a nav item; reversible.
- **R7 — Create success shows the real env + live updates; no fake provision animation.** On 201, refresh the list (the returned DTO appears; the events socket also fires `environment-created`) and `ShowEnvironmentDetail` the new env (design navigates to it). The new env shows its real status (provisioning/unknown/running) and the socket drives subsequent status. No simulated 4-step progress (that invents progress the server doesn't report; real provision progress is TA-14). *Why:* honesty. *Cost if wrong:* TA-14 adds a real ops/progress surface, additive.

## Architecture

**New files (`admin/tenant-portal/src/`, Allman, no inline literals, VM extends `Observable`, LF):**

| File | Role |
|---|---|
| `environments-view-model.ts` | `EnvironmentsViewModel extends Observable` — load (`ListEnvironments` + per-hive `GetHealth` join), `Rows` projection (`EnvironmentRow`), `Filter` text + filtered `Rows`, `Selected: Set<string>` + toggle/select-all/clear, bulk `StartSelected`/`StopSelected`/`RestartSelected`, `ApplyEvent`, busy-counter, load-token, error. |
| `environment-row.ts` | `EnvironmentRow` — one grid row: `Name`, `EnvironmentId`, `Template`, `Status: EnvStatus`, `Health: PillKind`, `Version: string` ("—" when unknown), `Url: string | undefined`, `IsRunning`, `IsStopped`, `Selected` (bound to the VM set), plus the backing `EnvironmentDto` for `ShowEnvironmentDetail`. |
| `environments-view.ts` | `EnvironmentsView extends TenantViewBase` — `Section` + `Act` Create + search `TextBox` + `DataGrid` (checkbox col, Environment, Status pill cell, Application, Health pill cell, Live URL) + bulk toolbar, wrapped in `ScreenHost`; row-open → `ShowEnvironmentDetail`; `envs` gating; opens `CreateEnvironmentDialog`. |
| `create-environment-dialog.ts` | `CreateEnvironmentDialog extends Dialog` — Name `TextBox` + validation, Template/Type pickers (Mural `ComboBox` or a button strip), Cancel + Create `Act`; `onCreated(env)` callback. |

**Modified:** `tenant-types.ts` (add `enum Template`/`EnvType`/`EnvStatus` mirrors + retype `EnvironmentDto.{template,type,status}` to them; add `CreateEnvironmentParams`; `IEnvironmentsSource` = `ListEnvironments` + `GetHealth` + `Start/Stop/RestartEnvironment` + `CreateEnvironment`); `tenant-api-client.ts` (`CreateEnvironment(name, template, type): Promise<EnvironmentDto>`); `tenant-app.ts` (`ShowEnvironments` builds `EnvironmentsView`; `OnTenantEvent` routes to it; drop the `tree` host + `ShowTree`; keep `ShowEnvironmentDetail`/`MarkEnvironmentsActive`); `tests/fake-tenant-control-plane.ts` (POST `/tenant-api/environments` branch: validate fields, push an `environment-created` event, return a new `EnvironmentDto`).

**Section → view:** Environments → `EnvironmentsView` (was the interim `TenantTreeView`). `EnvironmentDetail` still reached via the preserved `ShowEnvironmentDetail(env)` seam; Environments stays the active nav item on detail (`MarkEnvironmentsActive`).

## Trust-boundary / security UX

- Create and bulk actions are `envs`-gated via `Act` (visible-when-denied, undefined=permissive) — consistent with TA-3; the server does **not** capability-gate env create/lifecycle (any tenant admin), so the gate is honest only as a UX hint, not a claimed server denial. The list read itself is open to any tenant session (no denied state).
- Live URL is the server's own `httpUrl`; no secret, no cross-tenant data. The list is already tenant-scoped server-side.
- No hive switcher, no cross-tenant/hive affordance; retiring the tree removes the last hive-first navigation.

## Testing

- **VM** (`tests/environments-view-model.test.ts`, `tsx --test`, hand-rolled fake source): load joins environments + health (status from DTO, health/version from the join, "—" when absent, URL from httpUrl); search filters by name/id/version; select/toggle/select-all over filtered rows; bulk Start acts only on stopped-and-selected, Stop/Restart only on running-and-selected, then clears + reloads; `ApplyEvent` (created→reload, changed/deleted→reload-if-present, health-changed→reload); load-token newer-wins; a failed health join degrades to "—" without failing the list.
- **View** (`tests/environments-view.test.ts`): renders the grid with the five columns + checkbox col; empty state carries a Create action; Create `Act` and bulk `Act`s are disabled when `Capabilities.envs === false` and enabled when `true`/`undefined`; a row open calls `ShowEnvironmentDetail` with the backing DTO; the search box filters; the bulk toolbar appears only with a selection.
- **Create dialog** (`tests/create-environment-dialog.test.ts`): Create disabled until the name matches the regex and is not a duplicate; both error messages; Template/Type default and change; success calls `CreateEnvironment` with the chosen values and fires `onCreated`; a 409 shows the duplicate message inline.
- **Client/fake/shell:** `CreateEnvironment` POSTs the right body and returns the DTO; the fake serves POST `/environments` (+ emits `environment-created`); `tenant-app` `ShowEnvironments` builds `EnvironmentsView` and `OnTenantEvent` reloads it; the tree is no longer referenced by the shell.
- **Gates:** `npm --prefix admin/tenant-portal test` + `typecheck`; `npm run typecheck:tools`; control-plane suite stays green (only the client + fake change there is portal-side). Files **LF**, **pure ASCII** (straight apostrophes; em dash `—` in `.ts`) — python byte-scan, not grep. Preserve each touched file's existing EOL (all TA-4 targets are LF; `tenant-app.ts` is CRLF — match it). OOP/Allman/PascalCase/no-inline-literals; VM extends `Observable`; enums over unions.

## Left to the plan

The Template/Type picker widget (Mural `ComboBox` vs a kit-styled button strip — recon: no kit select primitive); the exact checkbox-column + select-all construction (`DataGridTemplateColumn` + `Checkbox`); whether the health join fetches `GetHealth` per distinct hive once or per row (recommend once per distinct hiveId, cached in the load); the `EnvironmentRow.Selected` two-way binding vs VM-set-plus-refresh; how `Application`/version renders a raw `runningImage` (show the image tag or a parsed version — recommend the trailing tag after `:`); whether to keep `ShowTree` on `ITenantNavigator` (recommend remove, with the tree files left unreferenced); and task decomposition (likely: (1) enums + `CreateEnvironment` client + fake POST; (2) `EnvironmentsViewModel` + `EnvironmentRow`; (3) `EnvironmentsView` grid + search + bulk + states; (4) `CreateEnvironmentDialog`; (5) shell rewire + retire tree + nav tests).
