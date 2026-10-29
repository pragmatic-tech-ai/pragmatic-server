# Platform Admin Registry Write v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Full-gated portal UI to the existing manifest-publish and tenant-gating control-plane endpoints: a Full operator can publish a manifest version (Releases) and gate/ungate a version for a tenant (Release Policy); an Observer sees the actions disabled with a needed-role hint.

**Architecture:** Portal-only. `ControlPlaneClient` gains four thin write methods over the existing `Send`. `ReleasesView` (a `SectionContainerView`) gets a "Publish version" `ListPrimaryAction` + a Custom-state form mirroring `ClientsView` Create. `ReleasePolicyView` (a `ScreenHost` single-screen view) gets a Normal/Gate/Ungate `mode` sub-state with an action row + a reused gating form. Every write action is built with `OperatorContext.MutatingAct`, so it is visibly gated to Full operators exactly as the server enforces. No new backend route, no `OperatorAuthorization` change, no new kit primitive.

**Tech Stack:** TypeScript (ESM, `.js` specifiers); portal `@pragmatic-tech-ai/mural` + the portal `kit` + `node:test` with the `Application.current` harness; control-plane `node:http` host + `node:test` (`npx tsx --test`) for the gate assertion.

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-registry-write-design.md`

## Global Constraints

- OOP; Allman braces; PascalCase public methods/interfaces; enums over string-literal unions; view-models extend `Observable`; `IDisposable` not lambdas; tests under `tests/`.
- No inline user-facing / reused string literals - hoist to `private static readonly` (route paths, body keys `version`/`image`/`notes`, button labels, field placeholders, error/empty/mode text).
- New `.ts`: pure ASCII, LF. Byte-scan every written `.ts`: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`. `control-plane-host.ts` has 6 PRE-EXISTING non-ASCII bytes and is NOT a source target of this spec; if any CP source is touched, add none. Match EOL (all LF).
- HONESTY: reported == enforced. Every write action is gated with `operator.MutatingAct` (same gate the server enforces); NO optimistic local mutation; re-fetch after every write. No raw internal ref exposed (the endpoints carry only version/image/notes/tenantId).
- No cross-app import (`admin/tenant-portal`). Forms survive a second render / `Refresh()` (fresh slot per render - a Visual holds exactly one parent). Add no kit primitive, no route, no authorization rule.
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; portal `npm test` + `npm run typecheck` in `admin/portal`. BOTH green on the merged result.

## Review Focus

- An Observer (ReadOnly) on Releases / Release Policy -> every write `Act` is VISIBLE but disabled with the needed-role hint (never hidden, never enabled). -> Task 3 + Task 4 (+ Task 5 proves the server 403).
- Publish with blank version or blank image -> submit blocked, no `POST` fires. -> Task 2.
- Publish with blank notes -> body omits `notes` (not `notes: ""`). -> Task 1 + Task 2.
- A version string needing URL encoding in ungate -> correctly path-encoded in the `DELETE`. -> Task 1.
- A second `Refresh()` of `ReleasePolicyView` with a gating form open -> rebuilds cleanly, form slot reset, no double-parent. -> Task 4.
- Publish form opened, cancelled, re-opened -> fresh fields, no double-parent. -> Task 3.

---

### Task 1: `ControlPlaneClient` write methods (publish, gate, ungate)

**Files:**
- Modify: `admin/portal/src/api-client.ts`
- Test: `admin/portal/tests/api-client-platform.test.ts`

**Interfaces:**
- Consumes: existing `POST /api/manifests` `{version,image,notes?}` -> `ManifestDto`; `POST /api/tenants/:id/gating` `{version}` -> 204; `DELETE /api/tenants/:id/gating/:version` -> 204; the existing private `Send<T>(route, {method, body})`, `ItemRoute`, `MethodPost`/`MethodDelete`, `TenantsRoute`, `ManifestsRoute`.
- Produces: `PublishManifest(version: string, image: string, notes?: string): Promise<ManifestDto>`; `Gate(tenantId: string, version: string): Promise<void>`; `Ungate(tenantId: string, version: string): Promise<void>`.

- [ ] **Step 1: Write failing tests** (mirror the `CreateClient` / `DeleteClient` cases with the fetch fake): `PublishManifest('1.2.0','img:1.2.0','note')` issues `POST /api/manifests` with body `{version:'1.2.0',image:'img:1.2.0',notes:'note'}` and returns the parsed `ManifestDto`; `PublishManifest('1.2.0','img:1.2.0')` (no notes) omits the `notes` key from the body; `Gate('t1','1.2.0')` issues `POST /api/tenants/t1/gating` with body `{version:'1.2.0'}`; `Ungate('t1','1.2.0')` issues `DELETE /api/tenants/t1/gating/1.2.0`; `Ungate('t1','a/b+c')` path-encodes the version in the URL.
- [ ] **Step 2: Run the new tests, verify they fail.**
- [ ] **Step 3: Implement** the three methods. Hoist a `GatingSegment = 'gating'` path builder `GatingRoute(tenantId)` = `ItemRoute(TenantsRoute, tenantId) + PathSeparator + GatingSegment` and `GatingItemRoute(tenantId, version)` = `GatingRoute(tenantId) + PathSeparator + encodeURIComponent(version)` next to the existing route builders. `PublishManifest` builds the body object conditionally (`const body = { version, image }; if (notes && notes.length > 0) body.notes = notes`) and `Send<ManifestDto>(ManifestsRoute, { method: MethodPost, body: JSON.stringify(body) })`. `Gate` -> `Send<unknown>(GatingRoute(tenantId), { method: MethodPost, body: JSON.stringify({ version }) })`. `Ungate` -> `Send<unknown>(GatingItemRoute(tenantId, version), { method: MethodDelete })`. Hoist the body-key literals as `private static readonly` if not already present.
- [ ] **Step 4: Byte-scan `api-client.ts`** -> non-ASCII 0, CR 0.
- [ ] **Step 5: `npm test` + `npm run typecheck` in `admin/portal`; commit** (`feat(portal): ControlPlaneClient publish/gate/ungate write methods`).

---

### Task 2: `CreateManifestViewModel`

**Files:**
- Create: `admin/portal/src/create-manifest-view-model.ts`
- Test: `admin/portal/tests/create-manifest-view-model.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient.PublishManifest` (Task 1); `Observable`; `ManifestDto`.
- Produces: `class CreateManifestViewModel extends Observable` with `CanSubmit(version: string, image: string): boolean` (both non-blank after trim), `async Submit(version: string, image: string, notes: string): Promise<ManifestDto>` (delegates to `client.PublishManifest`, passing `notes` only when non-blank), and a busy/error surface mirroring `CreateClientViewModel` (read that file first and match its shape: property names, change keys, error string home).

- [ ] **Step 1: Read `create-client-view-model.ts`** and mirror its structure (busy flag, error message, change-notification keys, `Observable` base).
- [ ] **Step 2: Write failing VM tests**: `CanSubmit('','img')` and `CanSubmit('1.0','')` are false; `CanSubmit('1.0','img')` is true; `Submit('1.0','img','')` calls `client.PublishManifest('1.0','img', undefined)` (or omits notes) - assert via a client fake capturing args; `Submit` surfaces a thrown error on the error property and clears busy.
- [ ] **Step 3: Run, verify fail.**
- [ ] **Step 4: Implement** the VM. Hoist all labels/messages as `private static readonly`. `Submit` trims inputs; passes `notes.trim().length > 0 ? notes.trim() : undefined`.
- [ ] **Step 5: Byte-scan** -> `0 0 N`. `npm test` + `npm run typecheck` in `admin/portal`; commit (`feat(portal): CreateManifestViewModel`).

---

### Task 3: `ReleasesView` publish action + form + `app.ts` wiring

**Files:**
- Modify: `admin/portal/src/releases-view.ts`, `admin/portal/src/app.ts`
- Test: `admin/portal/tests/releases-view.test.ts`

**Interfaces:**
- Consumes: `CreateManifestViewModel` (Task 2); `OperatorContext.MutatingAct`; kit `Act`/`ActVariant`/`KeyActivatedButton`/`PageHeader`/`Section`; `mural` `TextBox`; the `SectionContainerView` protected `EnterCustom`/`SwapScreen`/`ShowList` + overridable `ListPrimaryAction`.
- Produces: `ReleasesView` ctor `(client: ControlPlaneClient, operator: OperatorContext)`; a Full-gated publish flow.

- [ ] **Step 1: Read `clients-view.ts`** (`ListPrimaryAction`, `ShowCreate`, `BuildCreate`, `Submit`, `Box`, the double-parent-safe `Act` per render) and mirror it for publish.
- [ ] **Step 2: Write failing view tests** (use the `Application.current` harness + a `ControlPlaneClient` fake; mirror existing `releases-view.test.ts` setup): the publish `Act` exists after render; for an Observer operator it is disabled (`Enabled === false`) with a non-empty `DisabledHint`; for a Full operator, opening the form, filling version+image, and submitting calls the client's `PublishManifest` and returns to the list (a second `LoadRows` fetch fires); opening -> cancel -> re-opening the form does not throw (no double-parent).
- [ ] **Step 3: Implement**: add `operator` as the 2nd ctor param (store it). Hold a `CreateManifestViewModel`. Override `ListPrimaryAction()` to build a FRESH `Act` each call via `operator.MutatingAct(PublishLabel, () => this.ShowPublish())` (an `Act` holds one parent). `ShowPublish()` -> `EnterCustom()` + `SwapScreen(BuildPublish())`. `BuildPublish()` builds a `PageHeader` + version/image/notes `TextBox`es + a Full-gated submit `Act` (`operator.MutatingAct(SubmitLabel, () => void this.Submit(...))`) + a cancel `KeyActivatedButton(() => void this.ShowList())`, mirroring `BuildCreate`. `Submit(version, image, notes)` -> guard `createModel.CanSubmit`, `await createModel.Submit(...)`, then `this.ShowList()`; on error show an error line like `ClientsView`. Hoist all literals. In `app.ts`, change the Releases mount to `const operator = this.operator; if (operator !== undefined) { this.Mount(new ReleasesView(this.client, operator)) }` (mirror the Clients mount guard).
- [ ] **Step 4: Byte-scan** both touched files -> non-ASCII 0, CR 0.
- [ ] **Step 5: `npm test` + `npm run typecheck` in `admin/portal`; commit** (`feat(portal): publish a manifest version from Releases (Full-gated)`).

---

### Task 4: `ReleasePolicyView` gate / ungate + `app.ts` wiring

**Files:**
- Modify: `admin/portal/src/release-policy-view.ts`, `admin/portal/src/app.ts`
- Test: `admin/portal/tests/release-policy-view.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient.Gate`/`Ungate` (Task 1); `OperatorContext.MutatingAct`; kit `Act`/`ActVariant`/`Section`/`KeyActivatedButton`; `mural` `TextBox`/`StackPanel`; the view's existing `host`/`Inputs`/`ClearSlots`/`BuildContent`/fresh-slot invariant.
- Produces: `ReleasePolicyView` ctor `(client: ControlPlaneClient, operator: OperatorContext)`; a Normal/Gate/Ungate `mode` enum driving the content builder.

- [ ] **Step 1: Write failing view tests**: an action row with "Gate version" + "Ungate version" `Act`s renders in the content; for an Observer both are disabled + hinted; for a Full operator, entering the Gate mode, filling tenant+version, and submitting calls `client.Gate('t','v')` then triggers a re-fetch (`ListGating` called again); the Ungate mode calls `client.Ungate('t','v')` then re-fetches; a second `Refresh()` while a gating form is open rebuilds with no double-parent and the form slot reset.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement**: add `operator` as the 2nd ctor param. Add `private enum`-equivalent via a hoisted `GatingMode` enum (`Normal`, `Gate`, `Ungate`) and a `private mode = GatingMode.Normal` field + a fresh `formSlot` rebuilt per `BuildContent` (mirror `gatedSlot`/`targetSlot`/`rolloutSlot`). In `BuildContent`, after the three existing sections, append an action row (`StackPanel`) with two Full-gated `Act`s (`operator.MutatingAct(GateLabel, () => this.EnterMode(GatingMode.Gate), ...)`, ungate with `ActVariant.Danger`); when `mode !== Normal`, also build the gating form (tenant `TextBox` + version `TextBox` + a Full-gated submit `Act` + cancel) into `formSlot`. `EnterMode(m)` sets `this.mode = m` and re-renders via `this.ShowModel(this.model)` (or an equivalent host update that rebuilds content). Submit -> `await client.Gate/Ungate`, set `mode = Normal`, `await this.Refresh()`. `ClearSlots()` resets `formSlot` and `mode = Normal`. Keep a single private `BuildGatingForm(submit: () => void)` builder reused by both modes (DRY). Hoist every literal (labels, placeholders, mode text). In `app.ts`, change the Release Policy mount to pass `operator` under the `operator !== undefined` guard.
- [ ] **Step 4: Byte-scan** both touched files -> non-ASCII 0, CR 0.
- [ ] **Step 5: `npm test` + `npm run typecheck` in `admin/portal`; commit** (`feat(portal): gate/ungate a version for a tenant from Release Policy (Full-gated)`).

---

### Task 5: Control-plane gate assertion (ReadOnly 403, Full 2xx)

**Files:**
- Modify/Test: the control-plane host test file that already exercises operator-role gating (reuse it; otherwise `admin/control-plane/tests/control-plane-host-registry-write-authz.test.ts`)

**Interfaces:**
- Consumes: the existing host test harness (how it authenticates as Full vs ReadOnly vs anon, seeds a hive/tenant/manifest).

- [ ] **Step 1: Check existing coverage** - grep the CP host tests for an assertion that a ReadOnly operator is 403 on a mutation. If `POST /api/manifests` and gating writes are already proven Full-only, note it in the report and SKIP adding duplicates (make this task a no-op with a ledger note). Otherwise continue.
- [ ] **Step 2: Write failing tests** (if needed): authenticated as ReadOnly -> `POST /api/manifests` `{version,image}` returns 403; `POST /api/tenants/:id/gating` `{version}` returns 403; `DELETE /api/tenants/:id/gating/:version` returns 403. Authenticated as Full -> each returns its documented 2xx (200/201 for publish, 204 for gate/ungate). Unauthenticated -> 401.
- [ ] **Step 3: Run; they should already pass if the central gate is correct** (this task asserts an existing invariant, not new behavior - if a test FAILS it has found a real gate hole; stop and rule). Byte-scan the test file -> `0 0 N`.
- [ ] **Step 4: `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; commit** (`test(control-plane): registry writes are Full-operator-only`).
