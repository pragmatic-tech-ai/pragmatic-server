# Platform Admin Settings Write v1 (invite/create operator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Full-operator-gated "Invite operator" form (email + masked password + role) to Settings, wiring the existing `POST /api/operators`; an Observer never sees it, the server owns the password rule, and a successful create re-fetches the roster (no optimistic row).

**Architecture:** Portal-only. `OperatorContext` gets a `ReadOnlyWireRole` constant (single home for the wire strings). `ControlPlaneClient` gets `CreateOperator(email, password, role)`. A new `CreateOperatorViewModel extends Observable` holds validation + submit. `SettingsView` (a single-screen `ScreenHost` view) gains a `SettingsMode { Normal, Invite }` sub-state: an "Invite operator" Full-gated `Act` in the `CanMutate` branch, and an invite form (email `TextBox`, password `TextBox` with `IsPassword`, role `ComboBox` defaulting to ReadOnly) when in Invite mode; submit re-fetches via `Refresh()`. No backend/route/authz/kit/control-plane-test change.

**Tech Stack:** TypeScript (ESM, `.js` specifiers); portal `@pragmatic-tech-ai/mural` (`TextBox.IsPassword`, `ComboBox`) + the portal `kit` + `node:test` with the `Application.current` harness.

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-operator-invite-design.md`

## Global Constraints

- OOP; Allman braces; PascalCase public methods/interfaces; enums over string-literal unions; view-models extend `Observable`; `IDisposable` not lambdas; tests under `tests/`.
- No inline user-facing / reused string literals - hoist to `private static readonly` (body keys email/password/role, action/field labels, placeholders, error text, mode strings). Role wire strings single-homed on `OperatorContext` (`FullWireRole`/`ReadOnlyWireRole`).
- New/edited `.ts`: pure ASCII, LF. Byte-scan each written `.ts`: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`. `control-plane-host.ts` NOT touched. Match EOL (all LF).
- HONESTY / SECURITY: the invite action is gated with `operator.MutatingAct` (== server 403); the password travels ONLY in the POST body (like `Login`), never logged/echoed/stored beyond the in-flight form; the SERVER owns the min-length rule (surface its 400 message, do NOT hardcode the number); NO optimistic roster row - re-fetch after create.
- No cross-app import (`admin/tenant-portal`). The form survives a second render / `Refresh()` (fresh slot per render - a Visual holds one parent). Add no kit primitive, no route, no authorization rule, no control-plane test.
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; portal `npm test` + `npm run typecheck` in `admin/portal`. BOTH green on the merged result.

## Review Focus

- An Observer in Settings -> NO "Invite operator" action (gets the `DeniedStatePanel`); the server already 403s `POST /api/operators` for ReadOnly (locked by PA-13's rbac test, unchanged). -> Task 3.
- Blank email / blank password / no role -> submit is a no-op with a required-field line; no POST. -> Task 2 + Task 3.
- A password shorter than the server minimum -> the server 400s and its message shows (the portal did NOT pre-judge length). -> Task 3 (fake returning the 400 message).
- The password box masks glyphs (`IsPassword === true`); the password is only in the POST body (never logged/URL). -> Task 3 asserts `IsPassword`; review asserts no logging.
- After a successful create the roster reflects the server via a re-fetch (`ListOperators` re-called), not an optimistic insert. -> Task 3.
- A second `Refresh()` with the invite form open rebuilds cleanly (form slot + mode reset, no double-parent). -> Task 3.
- The role `ComboBox` defaults to ReadOnly; its two options map to `'full'`/`'readonly'`. -> Task 3.

---

### Task 1: `OperatorContext.ReadOnlyWireRole` + `ControlPlaneClient.CreateOperator`

**Files:**
- Modify: `admin/portal/src/operator-context.ts`, `admin/portal/src/api-client.ts`
- Test: `admin/portal/tests/api-client-platform.test.ts`

**Interfaces:**
- Consumes: existing `POST /api/operators` `{email,password,role}` -> `201 {email}`; the private `Send`, `OperatorsRoute`, `MethodPost`; existing `OperatorContext.FullWireRole`.
- Produces: `OperatorContext.ReadOnlyWireRole = 'readonly'` (public static readonly); `ControlPlaneClient.CreateOperator(email: string, password: string, role: string): Promise<void>`.

- [ ] **Step 1: Write failing test** - `CreateOperator('a@x.test','pw','readonly')` issues `POST /api/operators` with body `{ email: 'a@x.test', password: 'pw', role: 'readonly' }` (mirror the `CreateClient` test; assert method + URL + parsed body).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** - add `ReadOnlyWireRole = 'readonly'` on `OperatorContext` next to `FullWireRole`. Add `CreateOperator` on `ControlPlaneClient`: `Send<unknown>(ControlPlaneClient.OperatorsRoute, { method: MethodPost, body: JSON.stringify({ [EmailKey]: email, [PasswordKey]: password, [RoleKey]: role }) })` with the three body keys hoisted as `private static readonly` (reuse any that already exist, e.g. a login `password` key).
- [ ] **Step 4: Byte-scan both touched files** -> `0 0 N`.
- [ ] **Step 5: `npm test` + `npm run typecheck` in `admin/portal`; commit** (`feat(portal): CreateOperator client + ReadOnlyWireRole`).

---

### Task 2: `CreateOperatorViewModel`

**Files:**
- Create: `admin/portal/src/create-operator-view-model.ts`
- Test: `admin/portal/tests/create-operator-view-model.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient.CreateOperator` (Task 1); `Observable`.
- Produces: `class CreateOperatorViewModel extends Observable` with `CanSubmit(email, password, role): boolean`, `async Submit(email, password, role): Promise<void>`, a busy flag + error-message surface (mirror `CreateManifestViewModel` exactly - read it first).

- [ ] **Step 1: Read `create-manifest-view-model.ts`** and mirror its structure (seam interface, `Observable` base, busy/error, change keys, Submit error handling).
- [ ] **Step 2: Write failing VM tests** - `CanSubmit('','pw','readonly')`, `CanSubmit('a@x','','readonly')`, `CanSubmit('a@x','pw','')` are false; `CanSubmit('a@x','pw','readonly')` true; `Submit(' a@x ','pw','readonly')` calls the client sink's `CreateOperator('a@x','pw','readonly')` (email trimmed, password verbatim) - assert via a fake sink capturing args; a thrown client error surfaces on the error property and clears busy.
- [ ] **Step 3: Run, verify fail.**
- [ ] **Step 4: Implement** - mirror `CreateManifestViewModel`: a narrow sink interface (`ICreateOperatorSink` with `CreateOperator`), `CanSubmit` (email + password non-blank after trimming email, role non-empty), `Submit` (trim email, password verbatim), busy/error with change keys. Hoist all literals.
- [ ] **Step 5: Byte-scan** -> `0 0 N`. `npm test` + `npm run typecheck` in `admin/portal`; commit (`feat(portal): CreateOperatorViewModel`).

---

### Task 3: "Invite operator" form on `SettingsView`

**Files:**
- Modify: `admin/portal/src/settings-view.ts`
- Test: `admin/portal/tests/settings-view.test.ts`

**Interfaces:**
- Consumes: `CreateOperatorViewModel` (Task 2); `ControlPlaneClient.CreateOperator` (Task 1); `OperatorContext.MutatingAct` / `RoleLabel` / `FullWireRole` / `ReadOnlyWireRole`; kit `Act`/`ActVariant`; `mural` `TextBox` (`IsPassword`) + `ComboBox` (mirror `CreateHiveView`'s `AddPicker`: `ItemsSource = items.map(...)`, `SelectedIndex`, read the selected item's value on submit).
- Produces: `SettingsMode { Normal, Invite }`; the Full-gated invite flow on `SettingsView` (ctor unchanged - `app.ts` already mounts it with operator + email).

- [ ] **Step 1: Read `settings-view.ts` (its `BuildContent`, `CanMutate` branch, fresh-slot `ClearSlots`), `release-policy-view.ts` (the `GatingMode` sub-state + `EnterMode` re-render-without-fetch + fresh form slot), `create-hive-view.ts` (`ComboBox` `AddPicker` + how the selected value is read on submit), and `login-view.ts` (`passwordBox.IsPassword = true`).**
- [ ] **Step 2: Write failing view tests** (build the operator via the same wire strings existing settings tests use - Full vs read):
  - For a FULL operator the "Invite operator" `Act` is present in the Operators section; for an OBSERVER it is absent (the Observer sees the `DeniedStatePanel`).
  - `EnterMode(Invite)` renders the form (email box, password box, role ComboBox); the password box has `IsPassword === true`; the role ComboBox defaults to ReadOnly (its selected value is the readonly wire).
  - Submit (Full) with valid fields calls `client.CreateOperator(email, password, role)` then re-fetches the roster (`ListOperators` call count increases) and returns to Normal.
  - Blank-field submit is a no-op (`CreateOperator` NOT called) with a required-field error line, staying in Invite mode.
  - A server 400 (fake `CreateOperator` rejects with a message) shows that message on the error line and stays in Invite mode.
  - A second `Refresh()` with the form open rebuilds cleanly (no double-parent); `ClearSlots` resets the form slot + mode.
- [ ] **Step 3: Run, verify fail.**
- [ ] **Step 4: Implement** - add `enum SettingsMode { Normal, Invite }` (module-level) + `private mode = SettingsMode.Normal` + a fresh `formSlot` rebuilt in `BuildContent`. Hold a `CreateOperatorViewModel`. In the `CanMutate` branch of the Operators section, add a FRESH Full-gated "Invite operator" `Act` (`operator.MutatingAct(InviteLabel, () => this.EnterMode(SettingsMode.Invite))`); when `mode === Invite`, build the form into a fresh `formSlot`: email `TextBox`, password `TextBox` (`IsPassword = true`), role `ComboBox` (two items: `RoleLabel(FullWireRole)->FullWireRole`, `RoleLabel(ReadOnlyWireRole)->ReadOnlyWireRole`; `SelectedIndex` -> the ReadOnly option), a Full-gated submit `Act`, a cancel `KeyActivatedButton(-> EnterMode(Normal))`, an error `TextBlock`. `EnterMode(m)`: set `mode`, re-render via the existing content path WITHOUT a fetch. Submit: read the role from the ComboBox's selected item value; `CanSubmit` guard (else a hoisted required-field line); `try { await this.createModel.Submit(email, password, role); this.mode = Normal; await this.Refresh() } catch { error line }`. `ClearSlots` resets `formSlot` + `mode = Normal`. Hoist every literal. NEVER log the password.
- [ ] **Step 5: Run view tests -> PASS.** Byte-scan `settings-view.ts` -> `0 0 N`.
- [ ] **Step 6: `npm test` + `npm run typecheck` in `admin/portal`; root `npm run typecheck:tools`; re-run `npx tsx --test admin/control-plane/tests/*.test.ts` to confirm the merged tree; commit** (`feat(portal): invite/create an operator from Settings (Full-gated)`).
