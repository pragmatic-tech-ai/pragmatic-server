# Platform Admin — Settings Operator Mutations Design

**Status:** PROPOSED — surfaced for owner review before SDD (operator-lifecycle mutations are security-sensitive).
**Date:** 2026-10-29
**Spec id:** PA-S2 (Program 2, Platform Admin)
**Builds on:** PA-13 Settings (read-only operator roster + Full-gated invite) — `docs/superpowers/specs/2026-10-29-platform-admin-settings-design.md`.

---

## 1. Intent and why

PA-13 shipped the Settings area read-only: the signed-in operator's session plus a Full-gated operator roster and an **invite** (create operator). The operator **lifecycle** is still missing — an operator cannot be demoted, have a forgotten password reset, be disabled, or have its sessions revoked. This spec adds those mutations to the operator plane (`IOperatorIdentity` / `OperatorIdentity`), Full-gated, with the safety guards the tenant plane already has.

## 2. Security / honesty spine (load-bearing)

- **Full-gated == enforced.** Every mutation is a mutating route denied to a ReadOnly operator by the central `OperatorAuthorization.Authorize` (server 403); the portal mirrors (reported == enforced). No optimistic UI; re-fetch after.
- **Addressed by email, never principalId.** The roster surface never exposes `principalId` (PA-13 ruling). Every mutation takes the operator's **email**; the server resolves email→principal via `pack.Accounts.FindByEmail`. A `principalId` never crosses the wire.
- **Password reset reveals a one-time secret, once.** A reset generates a new random password, applies it server-side, and returns it in the response body **once** — revealed via the existing `OnceSecret` kit primitive (from PA-W1), never stored, logged, echoed, or re-fetchable. The operator copies it and hands it to the user out of band. We never display or accept an admin-typed password for someone else.
- **Lockout guards (new on the operator plane, mirroring the tenant plane's `AdminService`):**
  - **Self-lockout** — an operator may not demote (Full→ReadOnly) or disable **themselves** → 409.
  - **Last-administrator** — the last Full operator may not be demoted or disabled → 409 (there must always be at least one operator who can mutate).
  - **Bootstrap admin** — the seeded `admin` principal may not be demoted or disabled (its Owner grant is re-seeded on every `Compose`, so a demote wouldn't stick, and disabling the root operator could brick the control plane) → 409. Its password *may* be reset.
  - Revoking **your own** sessions is allowed (it only logs you out; recoverable by re-login).

## 3. What exists vs. what is a gap (recon result)

| Capability | Exists on the pack? | Primitive / gap |
|---|---|---|
| Change role Owner↔Viewer | ✅ (with care) | `Grants.Revoke(oldGrant)` **then** `Grants.Save(newGrant)` — `Save` is append-only, so the old role must be revoked first (else `RoleFor` still sees Owner). No new primitive. |
| Reset password | ✅ (usable) | `Registrar.RotatePasswordIfChanged(tenant, principalId, PresentedSecret)` — a freshly generated password always differs, so it rotates; fail-safe no-op if the account has no stored hash (operators always have one). Precedent: `ServerBootstrap.RotateAdminPasswordAsync`. No new primitive. |
| Disable operator | ✅ | `ILocalAccountStore.Disable(tenant, principalId)` (one-way). |
| **Enable operator** | ❌ **GAP** | `Disable` is one-way; no `Enable`/`SetDisabled`. The on-disk `disabled` field exists but nothing clears it. Needs a **NEW primitive** in the published `todl-identity` + `todl-identity-node` sibling. |
| **Revoke all sessions for a principal** | ❌ **GAP** | Only `Sessions.Revoke(token)`; `FileSessionStore` stores `principalId` per record but exposes no index/enumeration. Needs a **NEW primitive** (`RevokeAllFor(principalId)`) in the sibling. |

**Implication:** role-change and password-reset are fully buildable on the operator plane with **no sibling-package change**. Disable (as a usable pair with Enable) and revoke-sessions both require **new primitives in the published `todl-identity` sibling** — a real build, cross-repo, with the workspace build-propagation (rebuild the sibling `dist` before the server consumes it), also merge-local / never-push.

## 4. Scope decision surfaced (Section 7) — two honest options

- **(A) Operator-plane-only slice (recommended):** ship **change-role** + **reset-password** + the self-lockout/last-admin/bootstrap-admin guards. No change to the published identity package. Disable/Enable and Revoke-sessions are filed as Features (they need the two new sibling primitives). Smaller, lower-risk, ships real security value (demote a compromised/over-privileged operator; reset a forgotten password), and touches only this repo.
- **(B) Full lifecycle:** also extend `todl-identity`/`-node` with `Enable`/`SetDisabled` on `ILocalAccountStore` and `RevokeAllFor(principalId)` on `ISessionManager` + `FileSessionStore`, then build disable/enable and revoke-sessions too. Covers the whole lifecycle but edits the published sibling identity package (rebuild + propagate; merge-local there as well), a materially larger, cross-repo change.

Everything below the fork is written for the **(A)** core; the two extra mutations slot in identically once the sibling primitives exist.

## 5. Backend design (operator plane)

New methods on `IOperatorIdentity` / `OperatorIdentity` (all resolve email→principal via `FindByEmail`, throwing a not-found → 404 if unknown):

- `SetOperatorRole(email: string, role: OperatorRole, actorPrincipalId: string): Promise<void>`
  - Resolve target principal. Guard: target is bootstrap admin → `OperatorProtectedError` (409); target===actor and new role is ReadOnly → `OperatorSelfLockoutError` (409); demoting the last Full operator → `LastOperatorError` (409).
  - Apply: read current grants (`GrantsFor`); if target role differs, `Grants.Revoke(currentRoleGrant)` then `Grants.Save(new Grant(principalId, targetRole, tenantRootRef))`. Idempotent when already at the target role (no-op).
- `ResetOperatorPassword(email: string): Promise<string>` (returns the one-time password)
  - Resolve target principal. Generate a strong random password (reuse the existing password-policy length floor, `MinOperatorPasswordLength`). `Registrar.RotatePasswordIfChanged(tenant, principalId, PresentedSecret(generated))`; clear the `PresentedSecret`. Return the generated password (the ONLY place it is ever returned). Allowed for the bootstrap admin.

New error classes (`OperatorSelfLockoutError`, `LastOperatorError`, `OperatorProtectedError`, `OperatorNotFoundError`) registered in `ControlPlaneHost.ErrorStatuses` → 409 (404 for not-found), matching the `OperatorExistsError → 409` precedent. Messages are fixed safe labels (no email/secret in the 500/409 body beyond a generic reason).

`ListOperators` is extended to carry role as today; **it continues to exclude disabled accounts** for the (A) slice (no enable path yet, so showing disabled rows would be a dead end). Under (B), `OperatorSummary` gains a `disabled` flag and the roster shows disabled operators with a status so they can be re-enabled.

### Host routes
Keyed by email in the body (never a path id, to avoid leaking/encoding principalId):
- `POST /api/operators/role` body `{ email, role: 'full' | 'readonly' }` → `SetOperatorRole`. Validate role against the wire enum (400). Actor from `this.Principal(req)`.
- `POST /api/operators/password-reset` body `{ email }` → `ResetOperatorPassword`; 200 `{ password }` with `Cache-Control: no-store`. (Under (B): `POST /api/operators/disabled` `{ email, disabled }` and `POST /api/operators/revoke-sessions` `{ email }`.)
All are mutating POSTs → Full-gated automatically by `OperatorAuthorization`. A non-Full operator is 403 before the handler runs.

## 6. Portal design
- `SettingsView` roster `DataTable` gains a per-row **actions** affordance (reusing the `Act`/`MutatingAct` gating): **Change role** and **Reset password** (under (B): **Disable/Enable**, **Revoke sessions**). All gated on `operator.CanMutate` (visible-but-disabled for an Observer, with the same "need Operator" hint PA-13 uses).
- **Change role** uses an inline confirm (this portal has no modal primitive — same ruling as PA-9W; TA-4's "true modal overlay" stays a deferred Feature): a small inline panel with a role picker (ComboBox Full/ReadOnly) + confirm; on success re-fetch the roster.
- **Reset password** confirm → calls the route → reveals the returned one-time password via `OnceSecret` (confirm-once, best-effort copy), then returns to the roster. The password lives only in the live reveal Visual + the POST response body — never a VM field, URL, or log.
- Client: `ControlPlaneClient.SetOperatorRole(email, role)` and `ResetOperatorPassword(email): Promise<{ password: string }>` (+ the (B) methods). New `ApiError` handling reuses the existing generic path; 409s surface the server's generic reason inline.
- Self-lockout/last-admin/bootstrap-admin: the portal does NOT pre-gate these (it cannot always know the last-admin state without racing); it surfaces the server's 409 reason inline. (Reported-permissive, server-enforcing — same pattern as TA-3.)

## 7. Decisions surfaced for owner sign-off

1. **Scope — (A) operator-plane-only (recommended) vs (B) full lifecycle incl. the sibling identity-package changes?** (Section 4.) This is the main fork: (B) edits the published `todl-identity` sibling.
2. **Password reset = server-generated one-time password revealed once (recommended)** vs admin-typed password. I recommend generated+once (secret-by-reference discipline; no typing someone else's password).
3. Confirm the bootstrap `admin` operator is **protected** from demote/disable (password reset still allowed).

## 8. Deferred Features (file as Project #1 Kind=Feature)
- (If scope A) Operator **disable/enable** — needs `Enable`/`SetDisabled` on `ILocalAccountStore` (`todl-identity`/`-node`).
- (If scope A) Operator **revoke-all-sessions** — needs `RevokeAllFor(principalId)` on `ISessionManager` + `FileSessionStore`.
- Operator **last-login / created-at / status** columns (no source today) — carried from PA-13.

## 9. Security invariants (review checklist)
- Every mutation Full-gated (server 403 == portal gating); no principalId on the wire; email→principal server-side.
- Reset password returned once, `no-store`, never stored/logged/echoed/re-fetchable; `PresentedSecret` cleared.
- Self-lockout + last-admin + bootstrap-admin guards enforced server-side (409), not merely in the UI.
- Role flip revokes the old grant before saving the new (no lingering Owner grant).
- New `.ts` pure ASCII + LF; `control-plane-host.ts` keeps its 6 pre-existing non-ASCII bytes.

## 10. Testing / gates
- Control-plane: new unit tests — role flip up/down + idempotent-at-target; revoke-old-before-save (no lingering Owner); reset returns a working new password (authenticate with it) + fail-safe; each guard (self-lockout, last-admin, bootstrap-admin) → its error; email→principal not-found → 404; route 403 for ReadOnly; `no-store` on reset. Gate: `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`.
- Portal: row actions gated by role; change-role inline confirm → client call + re-fetch; reset → OnceSecret reveal (secret absent from roster/rows/logs, cleared on dismiss); 409 reason surfaced inline. Gate: `npm --prefix admin/portal test` + `npm --prefix admin/portal run typecheck`.
- (B only) sibling `todl-identity`/`-node` unit tests for the new `Enable`/`RevokeAllFor` primitives, plus rebuild the sibling `dist` before the server gate.

> **Implementation note (shipped):** `RevokeAllFor` shipped as **`RevokeAllFor(tenant: Tenant, principalId: string)`** (tenant-scoped), not the single-argument form shown in the recon table above. Session stores are multi-tenant and well-known principal ids (e.g. `admin`) repeat across tenants, so every implementation filters by BOTH tenant and principal — consistent with `Disable`/`Enable(tenant, principalId)`. The server operator plane passes `this.tenant`.
