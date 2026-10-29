# Platform Admin Polish (form-preserve + ComboOption) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Stop an events-WS auto-refresh from wiping an open write-form on the two single-screen views (preserving typed input, including the password, with NO draft storage); (2) replace the three duplicated ComboBox option classes with one shared kit `ComboOption`.

**Architecture:** Portal-only. Item 1: `SettingsView.Refresh` / `ReleasePolicyView.Refresh` early-return when a form mode is active, leaving the live form (and its `TextBox`es) untouched - the password stays only in the box (PA-S1 invariant). Item 2: a new `kit/combo-option.ts` `ComboOption { Label, Value }` replaces `HiveOption` / `RoleOption` / `ClientOption` at all three sites. No backend/route/authz/mural change.

**Tech Stack:** TypeScript (ESM, `.js` specifiers); portal `@pragmatic-tech-ai/mural` (`ComboBox`) + the portal `kit` + `node:test` with the `Application.current` harness.

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-polish-forms-combo-design.md`

## Global Constraints

- OOP; Allman braces; PascalCase public methods/interfaces; enums over string-literal unions; `IDisposable` not lambdas; tests under `tests/`.
- No inline reused literals. New/edited `.ts`: pure ASCII, LF. Byte-scan each: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`. Match EOL (all LF).
- PA-S1 PASSWORD INVARIANT (binding): the password is NEVER copied into a view field; the defer keeps it in the live `TextBox` only. Do NOT add a draft field for any form value.
- No cross-app import; no backend/route/authz/mural change. Gate (from `admin/portal`): `npm test` + `npm run typecheck`; then root `npm run typecheck:tools`. control-plane unaffected. BOTH green on the merged result.

## Review Focus

- Invite form half-typed (email/password/role) -> an events-WS `Refresh()` -> form + all typed values survive (password still only in the box). -> Task 2.
- Gate/ungate form typed (tenant/version) -> `Refresh()` -> survives. -> Task 2.
- After submit (mode->Normal) refresh RESUMES and re-fetches; after cancel the view shows current data (defer is not permanent). -> Task 2.
- `create-tenant` client picker still maps selection -> client ID after `.Id`->`.Value`. -> Task 1.
- No `HiveOption`/`RoleOption`/`ClientOption` or cross-view option import remains. -> Task 1 (grep).

---

### Task 1: shared kit `ComboOption`; migrate the 3 option classes

**Files:**
- Create: `admin/portal/src/kit/combo-option.ts`
- Modify: `admin/portal/src/kit/index.ts`, `admin/portal/src/create-hive-view.ts`, `admin/portal/src/create-tenant-view.ts`, `admin/portal/src/settings-view.ts`
- Test: the existing create-hive / create-tenant / settings view tests (adjust if they referenced the old class names).

**Interfaces:**
- Produces: `export class ComboOption { public constructor(public readonly Label: string, public readonly Value: string) {} }` (exported from `kit/index.ts`).

- [ ] **Step 1: Find the sites** - `grep -rnE "HiveOption|RoleOption|ClientOption" admin/portal` (expect create-hive-view, create-tenant-view, settings-view + any test refs).
- [ ] **Step 2: Create `kit/combo-option.ts`** with `ComboOption { Label, Value }` (Allman braces); export it from `kit/index.ts` alongside the other kit exports.
- [ ] **Step 3: Migrate each site**:
  - `create-hive-view.ts`: `HiveOption` -> `ComboOption` (the `new HiveOption(v, v)` items and the `SelectedItem as HiveOption` read); delete the local `HiveOption` class.
  - `settings-view.ts`: the local `RoleOption` -> `ComboOption` (items + `SelectedItem as RoleOption` read); delete `RoleOption`.
  - `create-tenant-view.ts`: `ClientOption` -> `ComboOption`; `new ClientOption(displayName, id)` -> `new ComboOption(displayName, id)`; the read `selected.Id` -> `selected.Value`; delete `ClientOption`.
  - Fix any test that referenced the old class names.
- [ ] **Step 4: Prove unified** - `grep -rnE "HiveOption|RoleOption|ClientOption" admin/portal` returns nothing. Byte-scan each touched file -> `0 0 N`.
- [ ] **Step 5: `npm test` + `npm run typecheck` in `admin/portal`; root `npm run typecheck:tools`; commit** (`refactor(portal): shared kit ComboOption replaces HiveOption/RoleOption/ClientOption`).

---

### Task 2: defer auto-refresh while a write-form is open

**Files:**
- Modify: `admin/portal/src/settings-view.ts`, `admin/portal/src/release-policy-view.ts`
- Test: `admin/portal/tests/settings-view.test.ts`, `admin/portal/tests/release-policy-view.test.ts`

**Interfaces:**
- Consumes: the existing `mode` field + `SettingsMode`/`GatingMode` enums; `Refresh()`.

- [ ] **Step 1: Write failing/updated view tests**:
  - `SettingsView`: enter Invite mode, type an email AND a password into the form boxes, call `Refresh()` (simulating the events-WS tick). Assert: still in Invite mode; the SAME email/password box instances are present with the typed `.Text` intact (not wiped). Then set mode Normal (or submit) and `Refresh()` -> the roster re-fetches (deferral lifted). Update the old "rebuilds cleanly on Refresh with form open" test to this intent.
  - `ReleasePolicyView`: enter Gate mode, type tenant + version, `Refresh()` -> still Gate, typed values intact; then Normal + `Refresh()` -> re-fetch resumes. Update the old second-Refresh test similarly.
- [ ] **Step 2: Run, verify the typed-value-survives assertions fail** (current behavior rebuilds/wipes).
- [ ] **Step 3: Implement** - at the top of each `Refresh()`, add an early return when a form is open and a model exists: `SettingsView` -> `if (this.mode !== SettingsMode.Normal) { return }`; `ReleasePolicyView` -> `if (this.mode !== GatingMode.Normal && this.model !== undefined) { return }`. Change nothing else (submit still sets mode Normal then Refresh; cancel still re-renders via EnterMode). Do NOT add any draft field.
- [ ] **Step 4: Run view tests -> PASS.** Byte-scan both files -> `0 0 N`. Confirm no draft field for the password was introduced (code self-check).
- [ ] **Step 5: `npm test` + `npm run typecheck` in `admin/portal`; root `npm run typecheck:tools`; commit** (`fix(portal): keep an open write-form (and its password) intact across an auto-refresh`).
