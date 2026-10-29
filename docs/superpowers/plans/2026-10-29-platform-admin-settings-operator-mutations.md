# Platform Admin — Settings Operator Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add Full-gated operator-lifecycle mutations — change role, reset password (one-time secret), disable/enable, revoke sessions — to the operator plane, with self-lockout/last-admin/bootstrap-admin guards, extending the `todl-identity` sibling with the two missing primitives.

**Architecture:** Two phases. Phase 1 adds `ILocalAccountStore.Enable` and `ISessionManager.RevokeAllFor` to the published `todl-identity` sibling and its in-memory/file/fake implementors, then rebuilds the sibling dist. Phase 2 adds the operator-plane methods + guards on `OperatorIdentity`, the host routes, and the portal row-actions UI (inline confirms + a one-time password reveal).

**Tech Stack:** TypeScript (Node), node:test via `tsx`; 4 git repos (`todl-identity`, `todl-identity-local`, `todl-identity-node`, `pragmatic-server`); TS Mural portal.

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-settings-operator-mutations-design.md`

## Global Constraints

- **Cross-repo, merge-local, NEVER push — in every repo.** Branch `pa-s2-operator-mutations` off `master` in each of the 4 repos (all currently clean on master). Merge-local ff at the finish in each; nothing pushed.
- **Build propagation (critical):** the server consumes the siblings as built `dist` via `file:` + node_modules symlinks. After Phase 1, REBUILD in order: `npm --prefix ../todl-identity run build` → `npm --prefix ../todl-identity-local run build` → `npm --prefix ../todl-identity-node run build`. Only then will the server's `typecheck:tools` see the new interface methods. Do NOT run `npm install` anywhere (it breaks the workspace symlinks).
- **Security (load-bearing):** every mutation Full-gated (server 403 for ReadOnly == portal gating); addressed by **email** (never principalId on the wire); password reset returns a server-generated one-time password ONCE with `Cache-Control: no-store`, never stored/logged/echoed, `PresentedSecret` cleared; guards enforced server-side (409): self-lockout (no self-demote/self-disable), last-admin (never demote/disable the last Full operator), bootstrap `admin` protected from demote/disable (reset allowed); email-not-found → 404.
- **House style:** OOP (no module-level free functions/vars); Allman braces; no inline string literals (hoist to `private static readonly` PascalCase); enums over string literals; `Observable` VMs; PascalCase public methods/interfaces. New `.ts` pure ASCII + LF. `control-plane-host.ts` keeps exactly its 6 pre-existing non-ASCII bytes.
- **Gates.** Each sibling: `npm --prefix <repo> run build` + (if present) `typecheck` + `test` against its own `src`. Server (Phase 2, run SEQUENTIALLY): control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`; portal `npm --prefix admin/portal test` + `npm --prefix admin/portal run typecheck`.
- Stage by explicit path, never `git add -A`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Never touch/stage `docs/design/`.
- Default branch is `master` in all four repos (verified).

## Review Focus

- **Role flip leaves a lingering Owner grant** if the old grant is not revoked before saving the new (Save is append-only) → `RoleFor` still returns Full. (T4 test: demote then assert role is ReadOnly AND no Owner grant remains.)
- **Reset password produces a working credential** — authenticate with the returned one-time password succeeds; the old password no longer works. (T4 test.)
- **Guard bypass:** demoting/disabling yourself, the last Full operator, or the bootstrap admin must 409 with no state change. (T4 tests, one per guard.)
- **Revoke-all leaves no live session** for the principal but does not touch other principals' sessions. (T3 + T4 tests.)
- **Enable is a true inverse of Disable** — a disabled→enabled account authenticates again and reappears in the roster. (T2/T3 + T4 tests.)

---

## Phase 1 — identity sibling primitives

### Task 1: `todl-identity` — interface methods + fake

**Repo:** `../todl-identity` (branch `pa-s2-operator-mutations` off master).
**Files:** Modify `src/authn/local-account-store.ts`, `src/authn/session-manager.ts`, `src/testing/fakes.ts`. Test: the existing fakes/session test file (follow what's there).

**Interfaces — Produces:**
- `ILocalAccountStore.Enable(tenant: Tenant, principalId: string): Promise<void>` (counterpart to the existing one-way `Disable`; throws `LocalAccountNotFoundError` for an unknown principal).
- `ISessionManager.RevokeAllFor(principalId: string): Promise<void>`.

- [ ] **Step 1:** add `Enable` to the `ILocalAccountStore` interface and `RevokeAllFor` to the `ISessionManager` interface.
- [ ] **Step 2:** implement `RevokeAllFor` in `FakeSessionManager` (testing/fakes.ts) — delete all sessions whose `principalId` matches. If any OTHER type in this repo implements these interfaces (typecheck will tell), implement there too.
- [ ] **Step 3:** run `npm --prefix ../todl-identity run typecheck` — it must surface every non-implementor; fix each. Add/extend a unit test proving `FakeSessionManager.RevokeAllFor` drops only the matching principal's sessions.
- [ ] **Step 4:** `npm --prefix ../todl-identity test` green; `npm --prefix ../todl-identity run build` succeeds.
- [ ] **Step 5:** byte-scan changed `.ts` (`0 0 N`); commit by explicit path.

### Task 2: `todl-identity-local` — in-memory implementors

**Repo:** `../todl-identity-local` (branch off master).
**Files:** Modify `src/accounts/local-account-store.ts` (add `Enable`), `src/sessions/local-session-manager.ts` (add `RevokeAllFor`). Tests alongside.

**Interfaces — Consumes:** T1's two new interface methods (via the rebuilt `todl-identity` dist — build T1 first).

- [ ] **Step 1:** write failing tests — `LocalAccountStore.Enable` clears `Disabled` (a disabled account becomes findable/authenticatable again); `LocalSessionManager.RevokeAllFor(pid)` drops that principal's sessions only.
- [ ] **Step 2:** run tests, verify fail.
- [ ] **Step 3:** implement `Enable` (mirror `Disable`, set enabled) and `RevokeAllFor` (iterate sessions, drop matching principalId).
- [ ] **Step 4:** tests green; `npm --prefix ../todl-identity-local run typecheck` clean; `run build` succeeds.
- [ ] **Step 5:** byte-scan; commit by explicit path.

### Task 3: `todl-identity-node` — file implementors

**Repo:** `../todl-identity-node` (branch off master).
**Files:** Modify `src/accounts/file-account-store.ts` (add `Enable`), `src/sessions/file-session-store.ts` (add `RevokeAllFor`). Tests alongside.

**Interfaces — Consumes:** T1's interface methods.

- [ ] **Step 1:** write failing tests — `FileAccountStore.Enable(tenant, pid)` sets `disabled=false` and persists (mirror the existing `Disable` test, incl. `LocalAccountNotFoundError` for unknown pid and rollback-on-persist-failure parity); `FileSessionStore.RevokeAllFor(pid)` removes all records with that `principalId`, persists, and leaves other principals' sessions intact.
- [ ] **Step 2:** run tests, verify fail.
- [ ] **Step 3:** implement `Enable` (mirror `Disable`: find record or throw, set `disabled=false`, persist with rollback) and `RevokeAllFor` (delete matching records from the map, persist once).
- [ ] **Step 4:** tests green; `run build` succeeds.
- [ ] **Step 5:** byte-scan; commit by explicit path.

> **After Tasks 1-3:** rebuild dist in order (`todl-identity` → `-local` → `-node`) so the server sees the new methods. Record in the ledger.

---

## Phase 2 — server operator plane + host + portal

### Task 4: `OperatorIdentity` — mutation methods + guards

**Repo:** `pragmatic-server` (branch `pa-s2-operator-mutations` off master).
**Files:** Modify `admin/control-plane/operator-identity.ts`; add new error classes (same file or a sibling). Test: `admin/control-plane/tests/` (new `operator-mutations.test.ts`). Also update every test fake implementing `IOperatorIdentity` (PA-13 added stubs to ~9 fakes — typecheck:tools will enumerate them).

**Interfaces — Produces** (all resolve email→principal via `pack.Accounts.FindByEmail`, throw `OperatorNotFoundError` → 404 if unknown):
- `SetOperatorRole(email: string, role: OperatorRole, actorPrincipalId: string): Promise<void>` — guards: bootstrap admin → `OperatorProtectedError`; target===actor && new role ReadOnly → `OperatorSelfLockoutError`; demoting the last Full → `LastOperatorError`. Apply: if role differs, `Grants.Revoke(currentGrant)` then `Grants.Save(new Grant(pid, Role.Owner|Role.Viewer, tenantRootRef))`.
- `ResetOperatorPassword(email: string): Promise<string>` — generate a strong random password (≥ `MinOperatorPasswordLength`), `Registrar.RotatePasswordIfChanged(tenant, pid, PresentedSecret(pw))`, clear the secret, return the password. Allowed for the bootstrap admin.
- `SetOperatorDisabled(email: string, disabled: boolean, actorPrincipalId: string): Promise<void>` — guards: bootstrap admin → protected; self-disable → self-lockout; disabling the last Full → last-admin. Calls `pack.Accounts.Disable`/`Enable`.
- `RevokeOperatorSessions(email: string): Promise<void>` — `pack.Sessions.RevokeAllFor(pid)`. (Revoking your own is allowed.)
- `OperatorSummary` gains `disabled: boolean`; `ListOperators` now INCLUDES disabled accounts (carries the flag) so the roster can re-enable them. New error classes exported.

- [ ] **Step 1:** write failing unit tests (new `operator-mutations.test.ts`, composing a real `OperatorIdentity` over a temp identity root, as the existing operator tests do): role up/down + idempotent-at-target + no-lingering-Owner-after-demote; reset→authenticate-with-new-password + old-fails; disable→can't-auth + enable→can-auth-again; revoke-sessions→prior token invalid; each guard (self-lockout, last-admin, bootstrap-admin for both role & disable) throws its error; email-not-found throws `OperatorNotFoundError`; `ListOperators` includes a disabled operator with `disabled:true`.
- [ ] **Step 2:** run (control-plane gate), verify fail.
- [ ] **Step 3:** implement the methods + guards + error classes; widen `IOperatorIdentity`; add the method stubs to every `IOperatorIdentity` test fake that `typecheck:tools` flags.
- [ ] **Step 4:** control-plane gate green (`npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`).
- [ ] **Step 5:** byte-scan; commit by explicit path.

### Task 5: host routes

**Files:** Modify `admin/control-plane/control-plane-host.ts`; register new error→status in `ErrorStatuses`. Test: `admin/control-plane/tests/` host test (extend the Settings/operators test; follow `control-plane-host-rbac.test.ts`).

**Interfaces — Consumes:** T4 methods; existing `this.Principal(req)`.

- [ ] **Step 1:** failing host tests: `POST /api/operators/role` `{email, role}` (invalid role → 400; valid → 200, role changed; actor = session); `POST /api/operators/password-reset` `{email}` → 200 `{password}` with `Cache-Control: no-store`; `POST /api/operators/disabled` `{email, disabled}`; `POST /api/operators/revoke-sessions` `{email}`; each 403 for a ReadOnly operator; a guard violation → 409; unknown email → 404.
- [ ] **Step 2:** run, verify fail.
- [ ] **Step 3:** implement the four route arms (exact-path match under `/api/operators/...`, POST only), body validation (hoisted messages), actor from `this.Principal(req)`; register `OperatorSelfLockoutError`/`LastOperatorError`/`OperatorProtectedError` → 409 and `OperatorNotFoundError` → 404 in `ErrorStatuses`. Keep exactly 6 non-ASCII bytes.
- [ ] **Step 4:** control-plane gate green.
- [ ] **Step 5:** byte-scan (host `6 0 N`); commit by explicit path.

### Task 6: portal client + DTO

**Files:** Modify `admin/portal/src/portal-types.ts` (`OperatorSummaryDto` +`disabled`), `admin/portal/src/api-client.ts`. Test: `admin/portal/tests/api-client-platform.test.ts`.

**Interfaces — Produces:** `SetOperatorRole(email, role)`, `ResetOperatorPassword(email): Promise<{ password: string }>`, `SetOperatorDisabled(email, disabled)`, `RevokeOperatorSessions(email)`; `OperatorSummaryDto` gains `disabled?: boolean`.

- [ ] **Step 1:** failing tests — each method hits the right route/method with the right body (role/email/disabled); reset returns `{ password }`.
- [ ] **Step 2:** run, verify fail.
- [ ] **Step 3:** implement (hoist new route/field consts).
- [ ] **Step 4:** portal gate green (`npm --prefix admin/portal test` + typecheck).
- [ ] **Step 5:** byte-scan; commit by explicit path.

### Task 7: portal SettingsView row actions

**Files:** Modify `admin/portal/src/settings-view.ts`, `admin/portal/src/settings-view-model.ts` (`OperatorRow` +`disabled`/status; roster shows disabled). Test: `admin/portal/tests/settings-view*.test.ts`.

**Interfaces — Consumes:** T6 client methods; existing `OnceSecret`, `Act`/`MutatingAct`, `ComboBox`/`ComboOption`, `DataTable`, inline-form idiom.

- [ ] **Step 1:** failing tests — per-row **Change role** (inline role picker + confirm → `SetOperatorRole` → re-fetch), **Reset password** (confirm → `ResetOperatorPassword` → `OnceSecret` reveal showing the returned password, absent from rows/logs, cleared on dismiss), **Disable/Enable** toggle (→ `SetOperatorDisabled`), **Revoke sessions** (confirm → `RevokeOperatorSessions`); all gated on `operator.CanMutate` (Observer sees disabled + hint, zero calls); a disabled operator renders with a status; a 409 surfaces its reason inline.
- [ ] **Step 2:** run, verify fail.
- [ ] **Step 3:** implement row actions as inline confirm panels (no modal primitive — PA-9W ruling); reset uses `OnceSecret`; roster column shows disabled status; copy hoisted to consts.
- [ ] **Step 4:** portal gate green.
- [ ] **Step 5:** byte-scan; commit by explicit path.

---

## Self-Review Notes
- **Spec coverage:** role-change (T4/T5/T6/T7), reset-password one-time (T4/T5/T6/T7), disable/enable (T1-T3 primitive + T4/T5/T6/T7), revoke-sessions (T1/T3 primitive + T4/T5/T6/T7), guards (T4/T5), roster-shows-disabled (T4/T7). Covered.
- **Type consistency:** `Enable`/`RevokeAllFor` identical across interface (T1) and impls (T2/T3); `OperatorRole`/wire `'full'|'readonly'` as in PA-13; `OperatorSummary.disabled` (control-plane) ↔ `OperatorSummaryDto.disabled` (portal).
- **Review Focus:** each of the five has an owning test named above.
- **Proportion:** Phase 1 is three small primitive-addition tasks; Phase 2 is the operator-plane logic + thin routes + portal actions. No fabricated backend — the two gaps are filled with real primitives in the sibling.

> **Implementation note (shipped):** `RevokeAllFor` shipped as **`RevokeAllFor(tenant: Tenant, principalId: string)`** (tenant-scoped), not the single-argument form shown in the recon table above. Session stores are multi-tenant and well-known principal ids (e.g. `admin`) repeat across tenants, so every implementation filters by BOTH tenant and principal — consistent with `Disable`/`Enable(tenant, principalId)`. The server operator plane passes `this.tenant`.
