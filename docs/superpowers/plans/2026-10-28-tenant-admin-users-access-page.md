# Tenant Admin: Users & Access page (accounts + tokens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the three identity screens into one "Users & Access" page with Users / Roles & permissions / Tokens tabs, re-skin the Users and Tokens surfaces to the design treatment, and add the two kit primitives the Tokens surface needs — all portal-only over existing reads.

**Architecture:** A new `UsersAccessPageView` (kit `Tabs`, whole-page denied gate, lazy per-tab load) embeds the existing `UsersAccessView`, `RolesPrivilegesView` and `ServiceTokensView`, replacing `UsersAccessHubView`'s button strip. Two new kit primitives — `OnceSecret` (shown-once reveal) and `SecretTable` (by-reference list) — re-skin the Tokens surface. The Users surface swaps its DataGrid for custom account rows (StatusPill + role chips + "You" tag) and upgrades disable/self-lockout to the kit `ConfirmDialog`. No server route, DTO, protocol or identity-package change.

**Tech Stack:** TypeScript, Mural (`@pragmatic-tech-ai/mural`), Observable view-models (`@pragmatic-tech-ai/todl-runtime`), node:test + the existing `fake-tenant-control-plane.ts`.

**Spec:** `docs/superpowers/specs/2026-10-28-tenant-admin-users-access-page-design.md`

## Global Constraints

- **Portal-only.** No change to any server route, DTO, `AdminProtocol` method, or the `todl-identity` package. Build on `GetAdminSnapshot`/`CreateAccount`/`DisableAccount`/`GrantRole`/`RevokeRole`/`ListTokens`/`IssueToken`/`RevokeToken` as they are.
- **Deferred GAPs — never fabricate:** no invitation-style (passwordless) create, no Enable action, no last-sign-in column, no named business roles (chips show the real `TenantRole` grant roles), no tenant-wide aggregation (per-env picker stays), no live tab-label counts. An honest absence beats a fabricated reassurance.
- **Secrets by reference:** a token secret is shown only through `OnceSecret` at issue time, dismissed behind an explicit "I have stored it" gate, never re-displayed; the list (`SecretTable`) is by-reference only.
- **401 drops to login:** every tab's load/action routes a 401 to `Navigator.ShowLogin()` via `TenantViewBase.ShowError` / the VM rethrow, never a swallowed error (the TA-7 session-death lesson).
- **No `ITenantNavigator` churn:** embed the three views directly as tab content; leave `ShowServiceTokens`/`ShowRolesPrivileges`/`ShowFieldSecurity` on the interface and `tenant-app.ts` (used by `tenant-app.test` + fakes; `ShowFieldSecurity` still needed until TA-9).
- **EOL:** `tenant-app.ts` and `tenant-api-client.ts` are **CRLF**; `tenant-types.ts`, all `kit/*`, all view/VM/row files and all new files are **LF**. Verify every new/edited file with a byte scan; never flip an existing file's EOL.
- **ASCII only** in `.ts`: escape em dash as `—`, ellipsis as `…`, middot as `·` — never a raw non-ASCII byte. Byte-scan every new file.
- **Conventions:** OOP (methods on classes, no free functions/module state), Allman braces, PascalCase public members and interfaces, enums over string unions, VMs extend `Observable`, no inline string literals (hoist to `private static readonly`), `Disposable` not lambdas, tests under `tests/`.
- **Verify green:** `npm test` in `admin/tenant-portal` (full suite) and `npm run typecheck` (or the portal's typecheck script) clean before each task's commit.

## Review Focus

- **Access denied** (`Capabilities.access === false`) → whole-page denied `ScreenHost` naming the permission + owner, not a blank or a half-page. (Task 5 test.)
- **Capability unknown** (navigator unattached / `Capabilities` undefined) → permissive, tabs shown, no spurious denial. (Task 5 test.)
- **First activation of a never-loaded tab** → loads once; switching back does not reload or lose state; one tab's load error does not blank the others. (Task 5 test.)
- **Own row / own last role** → "You" tag shows; self-disable and self-revoke trigger the self-lockout confirm, never a silent lockout. (Task 3 + Task 4 tests.)
- **Token issue then dismiss** → secret shown once, copyable, gone after "I have stored it"; list row by-reference with no secret; Revoke denied (future role) shows the disabled `Act` naming the permission. (Tasks 1, 2, 6 tests.)
- **401 from any tab's load/action** → drops to login, never swallowed or stale. (Task 4 + Task 6 tests.)
- **Disabled vs active account** → correct `StatusPill`; disable confirm states the real consequences (signed out everywhere, records/history stay, tokens stop working). (Task 4 test.)

---

### Task 1: kit `OnceSecret` primitive

**Files:**
- Create: `admin/tenant-portal/src/kit/once-secret.ts` (LF)
- Modify: `admin/tenant-portal/src/kit/index.ts` (LF) — add `export { OnceSecret } from './once-secret.js'` and `export type { OnceSecretInputs } from './once-secret.js'`
- Test: `admin/tenant-portal/tests/kit-once-secret.test.ts` (LF)

**Interfaces:**
- Produces: `OnceSecretInputs { title: string; value: string; hint?: string; onDone: () => void }`; `class OnceSecret extends StackPanel` with constructor `(inputs: OnceSecretInputs)`. Test seams: `get Value(): string` (the revealed value as rendered), `get Stored(): boolean` (whether the gate has been pressed), `PressStore(): void` (simulate the "I have stored it" click → calls `onDone` once). Renders: a title line, a read-only value field (showing `value`), an optional hint line, and a single "I have stored it" button; never re-renders or retains the value after `PressStore`.

- [ ] **Step 1: Write failing tests** in `kit-once-secret.test.ts`:
  - `OnceSecret renders the title, value and hint` — construct with `{ title: 'API token', value: 'pmt_abc', hint: 'Expires in 90 days.', onDone }`; assert `Value === 'pmt_abc'` and the title/hint text appear among rendered lines.
  - `PressStore calls onDone exactly once and marks Stored` — a counter in `onDone`; `PressStore()`; assert `Stored === true` and counter is 1; a second `PressStore()` does not increment (gate is one-shot).
  - `the value is not exposed after storing` — after `PressStore()`, `Value === ''` (or the value node is removed); assert the raw value no longer appears in rendered text.
- [ ] **Step 2: Run tests, verify they fail** (`OnceSecret` not defined / wrong shape).
- [ ] **Step 3: Implement `OnceSecret`** in `once-secret.ts` following `kit/banner.ts`/`kit/section.ts` composition (hoist every literal to `private static readonly`; Allman; ASCII — escape any ellipsis as `…`). Use a Mural read-only `TextBox` for the value and a `Button` for the gate; `onDone` fires once, after which the value node is cleared.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Byte-scan** `once-secret.ts` for non-ASCII/EOL (`python -c "b=open(r'...','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` → 0 non-ascii, 0 CR).
- [ ] **Step 6: Commit** (`feat(tenant-portal): kit OnceSecret shown-once reveal primitive`).

### Task 2: kit `SecretTable` primitive

**Files:**
- Create: `admin/tenant-portal/src/kit/secret-table.ts` (LF)
- Modify: `admin/tenant-portal/src/kit/index.ts` (LF) — add `export { SecretTable } from './secret-table.js'` and `export type { SecretTableInputs, SecretRow } from './secret-table.js'`
- Test: `admin/tenant-portal/tests/kit-secret-table.test.ts` (LF)

**Interfaces:**
- Consumes: `PillKind`, `StatusPill`, `Act` from the kit.
- Produces: `SecretRow { reference: string; note?: string; status: PillKind; revoked: boolean }`; `SecretTableInputs { rows: readonly SecretRow[]; canRevoke: boolean; need?: string; onRevoke: (reference: string) => void }`; `class SecretTable extends StackPanel` with constructor `(inputs: SecretTableInputs)`. Test seams: `get RowCount(): number`, `RevokeAct(index: number): Act` (the per-row Revoke action), `ReferenceAt(index: number): string`. Each row renders reference + optional note + a `StatusPill(status)` + a Revoke `Act` (gated on `canRevoke`, `need` as the hint; disabled when the row is already `revoked`); renders no secret value.

- [ ] **Step 1: Write failing tests** in `kit-secret-table.test.ts`:
  - `renders one row per secret with reference, note and status pill` — two rows; assert `RowCount === 2`, `ReferenceAt(0)` matches, a `StatusPill` child with the expected `Kind` per row.
  - `Revoke is enabled when canRevoke and the row is live` — `canRevoke: true`, row `revoked: false`; `RevokeAct(0).Enabled === true`; pressing it calls `onRevoke` with that reference.
  - `Revoke is disabled and names the permission when denied` — `canRevoke: false, need: 'the Manage users & access permission'`; `RevokeAct(0).Enabled === false` and `DisabledHint` contains the need.
  - `a revoked row cannot be revoked again` — row `revoked: true`, `canRevoke: true`; `RevokeAct(0).Enabled === false`.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement `SecretTable`** in `secret-table.ts` (rows as horizontal `StackPanel`s inside a vertical panel; reuse `StatusPill` and `Act`; hoist literals; Allman; ASCII). Revoke `Act`: `can = canRevoke && !row.revoked`, `need`, `variant: ActVariant.Danger`, `onClick: () => onRevoke(row.reference)`.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Byte-scan** `secret-table.ts` (0 non-ascii, 0 CR).
- [ ] **Step 6: Commit** (`feat(tenant-portal): kit SecretTable by-reference secret list`).

### Task 3: Users tab re-skin — account rows, pills, chips, "You" tag, confirm dialog

**Files:**
- Modify: `admin/tenant-portal/src/account-row.ts` (LF) — add `public readonly Roles: readonly string[]` (distinct grant roles, the source of `RolesText`) used for chips.
- Modify: `admin/tenant-portal/src/users-access-view-model.ts` (LF) — add `public get CurrentPrincipalId(): string` returning the injected id (for the "You" tag). No behavioural change.
- Modify: `admin/tenant-portal/src/users-access-view.ts` (LF) — replace the accounts `DataGrid` with a vertical list of clickable account rows (email + role chips + `StatusPill` + "You" tag); replace the inline disable/self-lockout confirm strips with a hosted kit `ConfirmDialog`.
- Test: `admin/tenant-portal/tests/users-access-view.test.ts` (LF), `admin/tenant-portal/tests/users-access-view-model.test.ts` (LF, if present) — extend.

**Interfaces:**
- Consumes: `StatusPill`, `PillKind` (`Active`/`Disabled`), `ConfirmDialog`/`ConfirmTone` from the kit; `AccountRow.Roles`, `UsersAccessViewModel.CurrentPrincipalId`.
- Produces: unchanged public surface of `UsersAccessView` except new test seams: `get AccountRows(): StackPanel` (the list host), `RowFor(principalId): StackPanel | undefined`, `get ActiveConfirm(): ConfirmDialog | undefined`. Keep `get Grid` removed only if no test needs it — otherwise leave a compatibility note; prefer replacing grid-based tests.

- [ ] **Step 1: Write failing tests** (extend `users-access-view.test.ts`):
  - `an account row shows a status pill, role chips and no "You" tag for others` — snapshot with an active account holding roles `[Admin, Editor]` and a different principal as current; assert the row has a `StatusPill` of `PillKind.Active`, a chip per distinct role, and no "You" tag.
  - `the signed-in admin's own row carries the "You" tag` — current principal matches an account; assert that row renders the "You" tag text.
  - `a disabled account shows the Disabled pill` — account `disabled: true` → `PillKind.Disabled`.
  - `disabling another account opens a ConfirmDialog with the consequences copy` — select another account, invoke disable; assert `ActiveConfirm` is present, tone Danger, and its rendered lines include the signed-out-everywhere / records-stay / tokens-stop consequences; confirming calls the source `DisableAccount`.
  - `self-disable routes through the self-lockout confirm` — current principal's own row; disable → the confirm (self path) appears and only on confirm does `DisableAccount` fire (reuse the existing `PendingKind.DisableSelf` path).
  - (VM test, if file present) `CurrentPrincipalId returns the injected id`.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement.** In `account-row.ts` compute `Roles` as the de-duplicated grant-role list (the array `RolesText` already joins). In the VM add the `CurrentPrincipalId` getter. In `users-access-view.ts`: build a vertical `StackPanel` of rows (one horizontal panel per `AccountRow`: email text, a chips panel — one small bordered `TextBlock` per role, a "You" tag `TextBlock` when `row.PrincipalId === vm.CurrentPrincipalId`, a `StatusPill` keyed `row.Disabled ? Disabled : Active`); clicking a row calls `vm.SelectAccount(row.PrincipalId)`. Host a kit `ConfirmDialog` (AddChild/RemoveChild, one at a time, per TA-5 R8) for disable and self-lockout, driven by the VM `Pending` state; keep the grants/grant-role section. Hoist every literal (`YouTag = 'You'`, the three consequence strings, headings) to `private static readonly`; Allman; ASCII.
- [ ] **Step 4: Run full portal suite, verify pass** (adjust any grid-based assertions removed with the grid).
- [ ] **Step 5: Byte-scan** the three edited files (0 non-ascii; 0 CR — all LF).
- [ ] **Step 6: Commit** (`feat(tenant-portal): re-skin Users list with pills, role chips, You tag, confirm dialog`).

### Task 4: Tokens tab re-skin — SecretTable list + OnceSecret reveal

**Files:**
- Modify: `admin/tenant-portal/src/service-token-row.ts` (LF) — add `public readonly PillKind: PillKind` derived from the existing status (`Active`→`PillKind.Active`, `Expired`→`Expired`, `Revoked`→`Revoked`), so the view maps rows to `SecretRow` without re-deriving.
- Modify: `admin/tenant-portal/src/service-tokens-view.ts` (LF) — replace the tokens `DataGrid` + selected-section + `MakeRevealPanel` with a `SecretTable` (by-reference rows, per-row Revoke) and an `OnceSecret` reveal; keep the env picker and issue form.
- Test: `admin/tenant-portal/tests/service-tokens-view.test.ts` (LF) — extend/retarget.

**Interfaces:**
- Consumes: `SecretTable`/`SecretRow` (Task 2), `OnceSecret` (Task 1), `PillKind`, `ConfirmDialog`; `ServiceTokenRow.PillKind`.
- Produces: new test seams on `ServiceTokensView`: `get Table(): SecretTable | undefined`, `get Reveal(): OnceSecret | undefined`, `get ActiveConfirm(): ConfirmDialog | undefined`. `get Grid` removed (retarget its tests).

- [ ] **Step 1: Write failing tests** (retarget `service-tokens-view.test.ts`):
  - `issued tokens render in a SecretTable by reference with no secret` — two tokens loaded; assert `Table.RowCount === 2`, references shown, and the raw secret string never appears in rendered text.
  - `issuing a token reveals it once through OnceSecret, then dismisses` — issue; assert `Reveal` present with the issued value; `Reveal.PressStore()` → `Reveal` gone and `vm.DismissSecret` effected (secret no longer rendered).
  - `revoking a token confirms then calls the source` — press `Table.RevokeAct(0)`; assert `ActiveConfirm` appears (tone Danger, body states the token stops working immediately); confirm → source `RevokeToken` with that reference.
  - `revoke is denied without the capability` — construct the view in a denied context (or pass `canRevoke=false` via the page's capability) → `Table.RevokeAct(0).Enabled === false` naming the permission. (If capability is only known at the page level, assert the view defaults to enabled and leave the gated case to Task 5's page test — note which.)
  - `a 401 during load drops to login` — source throws 401 → navigator `ShowLogin` called (existing pattern).
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement.** In `service-token-row.ts` add the `PillKind` mapping. In `service-tokens-view.ts`: map `vm.Rows` → `SecretRow[]` (`reference: TokenRef`, `note: 'Owner: ' + PrincipalId` or principal, `status: PillKind`, `revoked: Revoked`); render a `SecretTable` whose `onRevoke(ref) → vm.RequestRevoke(ref)`; host a kit `ConfirmDialog` bound to `vm.Pending` (confirm → `vm.ConfirmPending`, cancel → `vm.CancelPending`); render `OnceSecret` from `vm.IssuedSecret` (`onDone → vm.DismissSecret`). Remove the DataGrid, the selected-section, and `MakeRevealPanel`. `canRevoke` comes from the capability the page passes (default permissive true when unknown — add an optional constructor flag or read `Navigator.Capabilities.access`). Hoist literals; Allman; ASCII.
- [ ] **Step 4: Run full portal suite, verify pass.**
- [ ] **Step 5: Byte-scan** the two edited files (0 non-ascii; 0 CR — LF).
- [ ] **Step 6: Commit** (`feat(tenant-portal): Tokens tab via SecretTable and OnceSecret`).

### Task 5: `UsersAccessPageView` — three-tab consolidated page

**Files:**
- Create: `admin/tenant-portal/src/users-access-page-view.ts` (LF)
- Delete: `admin/tenant-portal/src/users-access-hub-view.ts`
- Delete/replace: `admin/tenant-portal/tests/users-access-hub-view.test.ts` → `admin/tenant-portal/tests/users-access-page-view.test.ts` (LF)

**Interfaces:**
- Consumes: kit `Tabs`, `ScreenHost`; `UsersAccessView`, `RolesPrivilegesView`, `ServiceTokensView`; `ITenantNavigator`, `IUsersAccessSource & IRolesPrivilegesSource & ITokensSource` (the `client` implements all).
- Produces: `class UsersAccessPageView extends TenantViewBase` with constructor `(source, currentPrincipalId: string)`. Test seams: `get Tabs(): Tabs`, `get Users(): UsersAccessView`, `get Roles(): RolesPrivilegesView`, `get Tokens(): ServiceTokensView`, `get DeniedHost(): ScreenHost | undefined`. `AttachNavigator` attaches to all three children and (re)builds allowed/denied; `Refresh` loads the active tab; `Dispose` disposes all three.

- [ ] **Step 1: Write failing tests** in `users-access-page-view.test.ts`:
  - `shows three tabs: Users, Roles & permissions, Tokens` — assert the `Tabs` entries' labels in order.
  - `denied when access capability is false` — navigator with `Capabilities.access === false` → `DeniedHost` present (naming the permission + owner); tabs not shown.
  - `permissive when capability is unknown` — navigator with `Capabilities` undefined → tabs shown, no denied host.
  - `the Users tab loads on mount; the Tokens tab loads on first activation` — spy the fake source; assert Users' snapshot read happened after `Refresh`, Tokens' read did not until `Tabs.Select(tokensIndex)`, and selecting back to Users does not re-read.
  - `attaches the navigator to each embedded view` — a fake navigator; assert a 401 raised from the Tokens view routes to `ShowLogin` (navigator reached the child).
  - `Dispose disposes all three views` — spy disposes.
- [ ] **Step 2: Run tests, verify fail.**
- [ ] **Step 3: Implement `UsersAccessPageView`** mirroring `UsersAccessHubView`'s allowed/denied build (keep the denied `ScreenHost` config — `what: 'Users & Access'`, `need: 'the Manage users & access permission'`, `who: Navigator.OwnerContact`), but build a kit `Tabs` of the three views instead of the button strip. On `Tabs.onSelect`, lazily `Refresh` the newly-activated view once (track a loaded-set). `AttachNavigator` forwards to all three and recomputes allowed vs denied. Hoist labels/denied literals to `private static readonly`; Allman; ASCII.
- [ ] **Step 4: Run full portal suite, verify pass** (hub test deleted; page test green).
- [ ] **Step 5: Byte-scan** `users-access-page-view.ts` (0 non-ascii; 0 CR — LF).
- [ ] **Step 6: Commit** (`feat(tenant-portal): UsersAccessPageView consolidates Users/Roles/Tokens into tabs`).

### Task 6: Shell wiring

**Files:**
- Modify: `admin/tenant-portal/src/tenant-app.ts` (CRLF) — `ShowSection(NavSection.UsersAccess)` builds `new UsersAccessPageView(this.client, this.currentPrincipalId)`; drop the `UsersAccessHubView` import; keep `ShowServiceTokens`/`ShowRolesPrivileges`/`ShowFieldSecurity` (R2) and their imports if still referenced by those methods.
- Test: `admin/tenant-portal/tests/tenant-app.test.ts` (CRLF) — update the UsersAccess assertion to expect `UsersAccessPageView`; keep the existing `ShowServiceTokens/RolesPrivileges/FieldSecurity` direct-call assertions.

**Interfaces:**
- Consumes: `UsersAccessPageView` (Task 5).

- [ ] **Step 1: Update/author tests** — `ShowSection(NavSection.UsersAccess)` shows a `UsersAccessPageView`; the three standalone navigator methods still show their respective views (unchanged).
- [ ] **Step 2: Run, verify the UsersAccess assertion fails** (still building the hub).
- [ ] **Step 3: Implement** the wiring swap in `tenant-app.ts` (preserve CRLF; the file stays CRLF — do not reformat line endings).
- [ ] **Step 4: Run full portal suite, verify pass.**
- [ ] **Step 5: Byte-scan** `tenant-app.ts` — confirm it is still CRLF (`b.count(13) === b.count(10)`), 0 non-ascii.
- [ ] **Step 6: Commit** (`feat(tenant-portal): route Users & Access to the consolidated page`).
