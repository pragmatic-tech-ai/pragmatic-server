# PA-3 - Operator session, role, and visible-but-denied (G7 slice) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD). The THIRD Platform Admin spec - and the first that touches the control plane (a small, honest server slice).
**Area:** `admin/control-plane` (session endpoint) + `admin/portal` (operator context model, shell wiring, role display, observer banner).
**Builds on:** PA-1 kit (`Act` visible-but-denied, `Banner`), PA-2 shell (`app.ts`, `top-bar.ts`). Informed by the tenant portal's `SessionDto`/`roleLabel`/capabilities handling - re-implemented, NOT imported.
**Reconciliation:** `docs/superpowers/notes/2026-10-27-platform-admin-reconciliation.md` section 1.10 (Settings), section 3 G7, section 4 (role handling), section 6 spec 2. **Separation spec** binds: `admin/portal` must never import `admin/tenant-portal`.

## The honesty invariant for this spec (binding)

**Reported == enforced.** The role the UI shows and gates on MUST be exactly the role the server enforces. The server (`OperatorAuthorization.Authorize`) enforces precisely two levels: **Full** may mutate; **ReadOnly** may only use safe methods (GET/HEAD/OPTIONS) plus logout - every other verb returns 403 "Operator role does not permit this action". The UI's can-act MUST derive from that same role and never claim an action is allowed that the server would 403, nor deny one the server would allow.

## Context: what exists, and the exact gap

Recon found: `ValidateToken` already returns an `OperatorPrincipal = { email, principalId, role }` with `role: OperatorRole (Full | ReadOnly)`, and the per-request gate (`control-plane-host.ts:574`, `OperatorAuthorization.Authorize(who.role, method, path)`) already enforces it. **The only gap is that `GET /api/session` returns `{ email }` only (`control-plane-host.ts:617`), dropping the role** - so the portal cannot know what the server enforces and cannot render visible-but-denied. The portal `OperatorDto` is `{ email }`; `ControlPlaneClient.Session()` returns it; PA-2's shell shows the email in the operator menu. The `Act` kit primitive already renders visible-but-denied from `{ can, need?, ask? }`.

## The scope decision (recon finding + rulings)

**Ruling 1 (role vocabulary - resolves recon open decision #1, Operator/Operator lead/Observer vs Full/ReadOnly): map the backend's two enforced roles to a two-term UI vocabulary - Full -> "Operator" (may act), ReadOnly -> "Observer" (observe only). "Operator lead" is DEFERRED (filed as a Feature), not shown as an enforced role.** The backend enforces exactly two levels; there is no lead tier and no lead-gated capability to enforce. Inventing a third UI role would violate reported==enforced (a role the server does not know). The design's "Operator lead" gating of "Invite operator" (a PA-13 Settings concern) maps to Operator (Full) for now, with the lead tier deferred to a backend spec that actually adds the third grant. The denied-action copy may still advise "ask your operator lead" as human guidance - that is advisory text, not a claim that a lead role is enforced.

**Ruling 2 (display name): display name = email.** The identity model has no separate operator display-name field (the principal carries an email claim). PA-3 shows the email and the role label; a distinct display name is deferred (a Feature) until the identity model carries one. `whoami` returns `{ email, principalId, role }`.

**Ruling 3 (gating is action-level, not screen-level; the model is the deliverable): PA-3 delivers the role-aware FOUNDATION - the session role on the wire, a shared capability model, the role shown in the shell, and an honest observer banner - plus the gating builder screens will use. The first visibly-gated ACTIONS ship with the first screen that has a mutation (PA-5+).** An Observer may GET everything (observe), so no whole screen is role-denied; gating applies to mutating action buttons, and PA-2 shipped only placeholders with no mutations yet. So PA-3 is a foundation slice (like PA-1 was for the kit): it builds and tests the `OperatorContext` capability model + the `Act`-gating builder, wires the role through the shell, shows the role in the operator menu, and surfaces an honest read-only banner for Observers. Each later screen spec consumes the model to gate its own actions. This keeps PA-3 honest (no faked gated control on a screen that has no actions) and substantive on the server + model + shell axes.

**Ruling 4 (server slice is minimal): extend `GET /api/session` to return `{ email, principalId, role }`** where `role` is the existing wire vocabulary `'full' | 'readonly'` (the same strings `POST /api/operators` already accepts, via the host's `OperatorRoles` map). The server already has `who` in hand at the session handler; this adds two fields and an enum->wire mapping. No new auth, no new role, no RBAC change.

## Goals

- **Server:** `GET /api/session` returns `{ email, principalId, role }`, `role` in `'full' | 'readonly'`. A control-plane test asserts the payload includes the role for a Full and a ReadOnly principal. Update the existing session-shape test (`control-plane-host.test.ts:640`) to the new payload.
- **Portal DTO/client:** `OperatorDto` gains `principalId: string` and `role: string` (wire); `ControlPlaneClient.Session()` returns the richer DTO (parsing unchanged - it already returns the JSON shape).
- **Operator context model** (`admin/portal/src/operator-context.ts`, PA-owned): an `OperatorRole` enum `{ Operator, Observer }` (UI vocabulary) and an `OperatorContext` class built from the wire role (`'full' -> Operator`, anything else -> Observer, deny-by-default). It exposes `CanMutate: boolean` (Operator true, Observer false - matching the server's enforcement), `RoleLabel`, `NeededRoleLabel` (the role a denied mutation needs - "Operator"), `AskWhom` (advisory), and a builder `MutatingAct(label, onClick, variant?): ActInputs` that returns `Act` inputs gated on `CanMutate` with the needed-role hint filled when denied. Single home for the role vocabulary and the denied-action copy (hoisted constants).
- **Shell wiring** (`app.ts` + `top-bar.ts`): the shell reads `session.role` at boot, builds an `OperatorContext`, exposes it (a seam later screens consume), passes the `RoleLabel` to the top bar's operator menu, and - when the operator is an Observer - shows an honest read-only `Banner` (Info tone) in the shell ("Observer - read-only. You can view everything here; actions need the Operator role.").
- **Tests:** the capability model (both roles -> correct `CanMutate`/labels/`MutatingAct` producing an enabled Act for Operator and a visible-but-disabled Act with the needed-role hint for Observer); the shell showing the role label and the observer banner only for Observers.

## Non-goals

- **Operator-lead tier** - deferred Feature (no backend counterpart).
- **A separate display name** - deferred Feature (identity model has none); email stands in.
- **Per-screen gated actions** - each lands with its screen's spec (PA-5+); PA-3 provides and tests the model/builder only.
- **Operator management** (list operators, invite, change role, disable) - PA-13 Settings (G7 rest).
- **Any RBAC change** on the server - the enforcement is unchanged; PA-3 only reports the already-enforced role.
- **Whole-screen permission-denied** via `ScreenHost.Denied` for role - Observers may view every screen; role gating is action-level. (`ScreenHost.Denied` stays for other uses.)
- Audit of role/session (G9), and gating the nav rows (navigation/observation is always allowed - nav rows are NOT gated).

## Anti-goals (a failure even if it "works")

- The UI reporting a capability the server does not enforce, or vice versa (reported != enforced) - e.g. showing an action enabled for an Observer that the server 403s, or a third role the server does not know.
- A faked gated control on a placeholder screen that has no real action behind it.
- Coupling `admin/portal` to `admin/tenant-portal`.
- The session endpoint leaking anything beyond `{ email, principalId, role }` (no token, no password ref, no internal grant detail).
- Inline user-facing/role/copy string literals (hoist to `private static readonly`).
- A string-literal union where the convention wants an enum (the UI role is an enum; the wire `role` field is the serialized string and stays a string on the DTO).

## Information architecture (the decided shape)

- **Server (`control-plane-host.ts`):** at the session handler, write `{ email: who.email, principalId: who.principalId, role: ControlPlaneHost.RoleWire(who.role) }`. Add `private static RoleWire(role: OperatorRole): string` returning the hoisted `'full'`/`'readonly'` (reuse/define beside the existing `OperatorRoles` input map; keep one home for the two strings). No other handler changes.
- **Portal DTO (`portal-types.ts`):** `OperatorDto = { email: string; principalId: string; role: string }`. (Wire-shape type; `role` is the serialized string.)
- **`operator-context.ts` (PA-owned):** `enum OperatorRole { Operator, Observer }`; `class OperatorContext` with `static FromWire(role: string): OperatorContext` (`'full'` -> Operator else Observer), getters `Role`, `CanMutate`, `RoleLabel`, `NeededRoleLabel`, `AskWhom`, and `MutatingAct(label: string, onClick: () => void, variant?: ActVariant): ActInputs`. Plain class (a per-session value object, not a VM). Hoisted constants for the two labels, the needed-role label, and the ask text.
- **`top-bar.ts`:** `TopBarInputs` gains `roleLabel: string`; the operator-menu region shows it beside the email (text, not colour). No new control type.
- **`app.ts`:** store the `OperatorContext` from boot; expose `get Operator(): OperatorContext | undefined` (the seam screens will read); pass `roleLabel: this.operator.RoleLabel` to the `TopBar`; after mounting the shell, if `!operator.CanMutate`, add an Info `Banner` (the read-only notice) to the top bar's `BannerSlot`.
- Tests under `admin/portal/tests/` (new `operator-context.test.ts`; extend `shell-app.test.ts` / `shell-top-bar.test.ts` as needed) and `admin/control-plane/tests/` (extend the session test).

## What's left to the builder

- Whether `MutatingAct` returns `ActInputs` (recommended - the view does `new Act(ctx.MutatingAct(...))`) or a ready `Act`.
- The exact observer-banner copy and placement (top bar `BannerSlot` recommended; one Info banner, dismissable or not - builder's call, keep it honest and non-blocking).
- How the shell exposes the context to future screens (a getter on `App`, or threading it through a navigator/context seam) - pick the smallest seam that PA-5 can consume; do not over-build a context framework.
- Whether to show the role as plain text next to the email or as a small kit `StatusPill`/`InternalTag`-style chip - keep it icon+text or text, never colour alone; plain text is fine.
- The `RoleWire` home on the server (a reverse map, or a switch) - one home for `'full'`/`'readonly'`.

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline user-facing literals (hoist to `private static readonly`), enums over unions (UI role is an enum; DTO wire `role` stays a string), `IDisposable` not lambdas, tests under `tests/` subfolders.
- New `.ts` files pure ASCII + LF; byte-scan after every write (`0 0 N`). Existing files touched (`control-plane-host.ts`, `control-plane-host.test.ts`, `portal-types.ts`, `api-client.ts`, `app.ts`, `top-bar.ts`): check and MATCH current EOL, never flip. Escape non-ASCII as `\uXXXX`; re-scan after the Write tool.
- **Two gates, both green on the merged result:**
  - Control plane (no package.json; root `npm test` does NOT cover it): from repo root run `npx tsx --test admin/control-plane/tests/*.test.ts` AND `npm run typecheck:tools` (this typechecks tools + both portals).
  - Portal: in `admin/portal` run `npm test` and `npm run typecheck`.
- `admin/portal` must never import `admin/tenant-portal`. The session endpoint leaks nothing beyond `{ email, principalId, role }`.

## Review focus (inputs no happy-path test exercises)

- A ReadOnly principal's `GET /api/session` returns `role: 'readonly'`; a Full principal returns `role: 'full'`; neither leaks token/password/grant internals. (Control-plane test.)
- `OperatorContext.FromWire` is deny-by-default: an unknown/missing role string resolves to Observer (not Operator), so a malformed session never grants mutation. (Model test.)
- `CanMutate` matches the server exactly: Operator true, Observer false; `MutatingAct` yields an enabled Act for Operator and a visible-but-disabled Act (with the needed-role hint, no double-fire) for Observer. (Model + Act test.)
- The observer read-only banner shows for an Observer and NOT for an Operator; the operator menu shows the role label for both. (Shell test.)
- No import from `admin/tenant-portal`; no inline user-facing literal; the DTO/endpoint leak nothing extra. (Diff review.)
