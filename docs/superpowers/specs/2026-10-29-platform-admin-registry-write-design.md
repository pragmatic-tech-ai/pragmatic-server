# PA-R1 - Platform Admin Registry Write v1 (manifest publish + tenant gating) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; user chose "Registry write (publish/gate)" at the backend-vs-polish fork). Proceeds to plan + SDD. This is the Platform Admin portal's FIRST operator-initiated platform WRITE. The backend mutation endpoints already exist and are already Full-operator-only via the central authorization gate; this spec wires Full-gated UI to them. No new backend, no new authorization rule.
**Area:** Platform Admin portal (`admin/portal/`) only. Zero control-plane source change (endpoints exist). Control-plane tests MAY gain coverage asserting the gate, but no new route.
**Builds on:** PA-8R Registry READ (`ReleasesView` / `ReleaseDetailView`, manifest list), PA-9 Release Policy READ (`ReleasePolicyView` gated/selected sections), PA-13 operator role gate (`OperatorContext.CanMutate` / `MutatingAct` / `Act` / `ActVariant`), the `ClientsView` Create flow (the portal's one existing write path, mirrored here), PA-15 `SectionContainerView` (`ReleasesView` extends it; `ListPrimaryAction` + Custom state).

## Context

The operator plane can now READ everything it computes (manifests, gating, selections, operators, rollouts), but the portal cannot WRITE anything except client/tenant/hive create (which already ships). Two registry writes have server endpoints with no UI:

- **Publish a manifest version.** `POST /api/manifests` body `{ version, image, notes? }` -> `deployments.Publish(version, image, notes?)` -> returns the `ManifestDto` (`{ id, image, notes?, publishedAt, withdrawn? }`; `id` IS the version). The portal lists manifests (`ReleasesView`) but offers no way to add one.
- **Gate / ungate a version for a tenant.** `POST /api/tenants/:id/gating` body `{ version }` -> `deployments.Gate(tenantId, version)` -> `204`. `DELETE /api/tenants/:id/gating/:version` -> `deployments.Ungate(tenantId, version)` -> `204`. The portal lists the gating allowlist (`ReleasePolicyView` gated section) but offers no way to change it.

Both endpoints are MUTATIONS, so the central authorization gate (`OperatorAuthorization.Authorize`) already permits them for Full operators only (`role === Full` -> true; a non-Full role passes only non-mutating methods + logout). Wiring the UI therefore needs NO authorization change: the portal gates each action with `OperatorContext.MutatingAct`, which produces an `Act` that stays visible but disabled (with a "Requires role: Operator" tooltip) for an Observer - reported == enforced, because the server would reject the same mutation with 403.

## Recon findings (binding) + rulings

1. **Zero control-plane source change.** `POST /api/manifests`, `POST|DELETE /api/manifests/:version/withdrawn`, `POST /api/tenants/:id/gating`, `DELETE /api/tenants/:id/gating/:version` all exist and are Full-gated by the central gate. Ruling: this spec adds NO route and NO `OperatorAuthorization` change. It MAY add a control-plane host test asserting that an Observer (ReadOnly) gets 403 on `POST /api/manifests` and on the gating writes (locking the invariant the UI relies on), but that is test-only.

2. **Scope = publish + gate/ungate (the named slice). Withdraw/restore DEFERRED.** The user chose "publish/gate". Manifest withdraw/restore (`POST|DELETE /api/manifests/:version/withdrawn`) lives on `ReleaseDetailView` (built inside `ReleasesView.BuildDetail`, not in `app.ts`), needing operator + a refresh callback threaded down through the detail builder - a distinct surface. Ruling: DEFER withdraw/restore to a filed Feature (PA-R2); ship the two clean form-based write surfaces (Releases publish, ReleasePolicy gate/ungate). The `withdrawn` state is already shown read-only (the `WithdrawnBanner`); only the toggle is deferred. Cost if wrong: a follow-up spec, no rework (the api-client write seam this spec adds is reused).

3. **Writes are form-based, never per-row.** The kit `DataTable` renders text-only cells (`cell: r => string`); it has no per-row action column. Ruling: do NOT extend `DataTable` with an action column (kit change beyond scope). Gate and ungate are driven from an action row + a small form (tenant + version), mirroring `ClientsView` Create; publish is `ReleasesView.ListPrimaryAction` + a Custom-state form. Cost if wrong: slightly more clicks than a per-row button; avoids a cross-cutting kit change under a security-sensitive first-write spec.

4. **Full-gated via `MutatingAct`, honest about denial.** Every write action is built with `operator.MutatingAct(label, onClick, variant?)` so an Observer sees it disabled with the needed-role hint - never hidden, never silently enabled. Ruling: reported == enforced; the portal never fabricates a success it cannot perform, and the gate the UI shows is the same gate the server enforces. Destructive-leaning actions (ungate) use `ActVariant.Danger`.

5. **Reuse, no new primitive.** Forms use raw `mural` `TextBox` fields exactly as `ClientsView.BuildCreate` does (the portal has no kit form/select/dialog primitive; the deferred `ConfirmDialog`/`Steps` primitives are NOT built here - YAGNI). `ReleasesView` already has `SectionContainerView` Custom-state machinery (`EnterCustom`/`SwapScreen`); `ReleasePolicyView` (a plain `ScreenHost` single-screen view) gains a `mode` sub-state keyed in its content builder, rebuilt fresh per render (the view's existing fresh-slot-per-render invariant extends to the form).

6. **Threading operator in.** `ReleasesView` and `ReleasePolicyView` ctors gain `operator: OperatorContext` (second param, after `client`), mirroring `ClientsView(client, operator)`. `app.ts` constructs both post-shell where `this.operator` is defined; mirror the `ClientsView`/`SettingsView` guard (`const operator = this.operator; if (operator !== undefined) { ... }`). Cost if wrong: nil - the guard already exists for two other views.

7. **Refresh after write.** After a successful publish/gate/ungate the view returns to its list/normal state and re-fetches (the single source of truth is the server read, never an optimistic local mutation). Gate/ungate re-run `ReleasePolicyView.Refresh()`; publish returns to the Releases list and refreshes it. No optimistic row insertion (avoids reported != enforced if the server rejects).

## Goals

- Let a Full operator publish a new manifest version and gate/ungate a version for a tenant, from the portal, hitting the existing Full-gated endpoints.
- Keep every write visibly gated: an Observer sees the actions disabled with a needed-role hint, matching what the server enforces.
- Reuse the `ClientsView` Create pattern and the `MutatingAct`/`Act` gate; add no kit primitive, no backend route, no authorization rule.

## Non-goals / deferred (filed as Features)

- **Manifest withdraw / restore** (PA-R2) - the `/api/manifests/:version/withdrawn` toggle on `ReleaseDetailView`.
- Picker UX for tenant / version (ComboBox/typeahead): forms use raw `TextBox` like the existing Create forms; a selection primitive is a later kit Feature.
- A confirm dialog for ungate (no `ConfirmDialog` primitive; `ActVariant.Danger` + the needed-role gate are the v1 safety). Gate/ungate are reversible (re-gate / re-ungate), so no irreversible action is exposed.
- Bulk gating, scoped rules, channels, min-version, holds, adoption ledger (PA-9 full-G5 deferreds, unchanged).
- Any change to client/tenant/hive/graph write paths.

## Anti-goals (a failure even if it "works")

- A write action that an Observer can actually trigger (must be disabled + hinted; the server would 403 anyway, but the UI must not imply success).
- Optimistically showing a published/gated row before the server confirms (reported != enforced on rejection).
- Re-deriving or faking the published/gated state client-side instead of re-fetching after the write.
- Adding a per-row action column to `DataTable`, a new dialog/select primitive, a new route, or an `OperatorAuthorization` change under this spec.
- Inline user-facing literals; cross-app import (`admin/tenant-portal`); a form that double-parents on a second render.

## Information architecture (decided shape)

Portal (`admin/portal/src/`):

- `api-client.ts` - add four write methods on `ControlPlaneClient`, each a thin `Send` call mirroring `CreateClient`/`DeleteClient`:
  - `PublishManifest(version: string, image: string, notes?: string): Promise<ManifestDto>` -> `POST /api/manifests` body `{ version, image, notes? }` (omit `notes` when empty).
  - `SetManifestWithdrawn(version, withdraw)` is NOT added here (deferred PA-R2).
  - `Gate(tenantId: string, version: string): Promise<void>` -> `POST /api/tenants/:id/gating` body `{ version }`.
  - `Ungate(tenantId: string, version: string): Promise<void>` -> `DELETE /api/tenants/:id/gating/:version` (version path-encoded).
  - Hoist new route constants / path builders next to the existing ones (`GatingItemRoute(tenantId, version)` mirroring `ItemRoute`).

- `create-manifest-view-model.ts` (NEW) - `extends Observable`, mirrors `CreateClientViewModel`: holds the in-flight state, `Submit()` calls `client.PublishManifest(...)`, exposes validation (version + image required) and a busy/error flag. Hoist all labels/messages as `private static readonly`.

- `releases-view.ts` - gains `operator: OperatorContext` (2nd ctor param). Override `ListPrimaryAction(): Act | undefined` to return a Full-gated "Publish version" `Act` (`operator.MutatingAct`), opening a Custom-state publish form via `EnterCustom()` + `SwapScreen(BuildPublish())` (mirror `ClientsView.ShowCreate`/`BuildCreate`). The form: `TextBox` version, `TextBox` image, `TextBox` notes (optional), a Full-gated submit `Act` + a cancel `KeyActivatedButton`; on submit success -> `ShowList()` (the base re-runs `LoadRows`). An error line mirrors `ClientsView`.

- `gating-form.ts` (NEW) or inline in the view - a small form Visual (tenant id `TextBox` + version `TextBox`) reused by gate and ungate; keep it a private builder on `ReleasePolicyView` if that is simpler (DRY within the view).

- `release-policy-view.ts` - gains `operator: OperatorContext` (2nd ctor param) and a `mode` sub-state (Normal | Gate | Ungate). The content builder renders either the existing three sections plus an action row with two Full-gated `Act`s ("Gate version" Primary, "Ungate version" `Danger`), or the gating form for the active mode. Submitting calls `client.Gate` / `client.Ungate` then returns to Normal and `Refresh()`es (re-fetch). Fresh slots per render (the invariant already in the file extends to the form slot); `ClearSlots` resets the form slot; survives a second `Refresh()`.

- `app.ts` - pass `operator` to `new ReleasesView(this.client, operator)` and `new ReleasePolicyView(this.client, operator)` under the existing `operator !== undefined` guard pattern.

Control plane (`admin/control-plane/`): tests only (no source). Add/confirm a host test that `POST /api/manifests` and the gating writes return 403 for a ReadOnly operator and 2xx for Full - locking the gate the portal depends on. If such coverage already exists, note it and add nothing.

Tests:

- Portal (`admin/portal/tests/`):
  - `api-client-platform.test.ts` - `PublishManifest` issues `POST /api/manifests` with `{version, image, notes?}` and returns the parsed `ManifestDto`; `Gate` issues `POST /api/tenants/:id/gating` `{version}`; `Ungate` issues `DELETE /api/tenants/:id/gating/:version` (version encoded). Mirror the `CreateClient`/`DeleteClient` cases.
  - `releases-view.test.ts` - the publish `Act` is present; for an Observer it is disabled with the needed-role hint (assert `Enabled === false` + `DisabledHint`); submitting the publish form (as Operator) calls `PublishManifest` and returns to the list (which re-fetches); a second render does not double-parent the form.
  - `release-policy-view.test.ts` - the gate/ungate action row renders; Observer sees them disabled + hinted; gate submit calls `client.Gate` then `Refresh`; ungate submit calls `client.Ungate` then `Refresh`; a second `Refresh()` is safe (no double-parent) with the form slot reset.
  - `create-manifest-view-model.test.ts` - validation (version + image required; notes optional/omitted when blank); `Submit()` delegates to `client.PublishManifest`; error surfaces.
- Control-plane (`admin/control-plane/tests/`, `npx tsx --test`): a ReadOnly operator gets 403 on `POST /api/manifests` and on gate/ungate; a Full operator succeeds (if not already covered).

## Constraints (inherited, binding)

- OOP; Allman braces; PascalCase public methods/interfaces; enums over string-literal unions; view-models extend `Observable`; `IDisposable` not lambdas; tests under `tests/`.
- No inline user-facing / reused string literals - hoist to `private static readonly` (route paths, body keys `version`/`image`/`notes`, button labels, field placeholders, error/empty text, mode labels).
- New `.ts`: pure ASCII, LF. Byte-scan every written `.ts`: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`. `control-plane-host.ts` has 6 PRE-EXISTING non-ASCII bytes - this spec does not touch it; if any CP source IS touched, add no non-ASCII. Match EOL (all LF).
- HONESTY: reported == enforced. Every write action is gated with `MutatingAct` (same gate the server enforces); no optimistic local mutation; re-fetch after write. Never expose a raw internal ref; the four endpoints carry none (version/image/notes/tenantId only).
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; portal `npm test` + `npm run typecheck` in `admin/portal`. BOTH green on the merged result.
- No cross-app import (`admin/tenant-portal`); forms survive a second render / `Refresh()` (fresh slot per render - a Visual holds one parent); add no kit primitive, no route, no authorization rule.

## Review focus (inputs no happy-path test exercises)

- An Observer (ReadOnly) viewing Releases / Release Policy -> every write `Act` is VISIBLE but disabled with the "Requires role: Operator" hint (never hidden, never enabled). (View tests + CP 403 test.)
- Publish with a blank version or blank image -> the submit is blocked / validated, no `POST` fires. (VM test.)
- Publish with blank notes -> the body omits `notes` (not `notes: ""`). (api-client + VM test.)
- Ungate a (tenant, version) pair that is not currently gated -> the server responds; the view re-fetches and reflects the true state (no fabricated removal). (View test with a client fake.)
- A version string needing URL encoding (e.g. containing `/` or `+`) in ungate -> correctly path-encoded in the `DELETE`. (api-client test.)
- A second `Refresh()` of `ReleasePolicyView` while a gating form was open -> rebuilds cleanly, no double-parent, form slot reset. (View test.)
- The publish form rendered twice (open, cancel, re-open) -> fresh fields each time, no double-parent. (ReleasesView test, mirroring the Clients Create double-parent guard.)
