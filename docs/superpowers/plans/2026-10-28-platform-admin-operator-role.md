# Platform Admin Operator Role (G7 slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Platform Admin role-aware: `GET /api/session` reports the operator's enforced role; the portal builds a shared capability model from it, shows the role in the shell, surfaces an honest read-only banner for Observers, and provides the `Act`-gating builder later screens use for visible-but-denied actions.

**Architecture:** Server slice: the session handler already holds the validated `OperatorPrincipal {email, principalId, role}`; extend its JSON to include `principalId` + a wire `role` ('full'|'readonly'). Portal: `OperatorDto` widens to match; a PA-owned `OperatorContext` maps the wire role to a UI `OperatorRole {Operator, Observer}` and a `CanMutate`/needed-role/ask model that feeds the PA-1 `Act`. The shell reads the role at boot, shows it, and renders a read-only `Banner` for Observers. Reported == enforced throughout.

**Tech Stack:** TypeScript (control-plane Node host + imperative Mural portal), `node:test` + `tsx`, `tsc`. PA-1 kit (`Act`, `Banner`), PA-2 shell.

**Spec:** `docs/superpowers/specs/2026-10-28-platform-admin-operator-role-design.md`

## Global Constraints

- Honesty invariant (binding): reported == enforced. The server enforces Full (may mutate) vs ReadOnly (safe methods + logout only). The UI's `CanMutate` must equal that (Operator=true, Observer=false) and must never claim a capability the server would 403.
- Role vocabulary: Full -> "Operator", ReadOnly -> "Observer". No third/"lead" role (deferred). Display name = email (deferred). The session endpoint leaks nothing beyond `{ email, principalId, role }`.
- OOP; Allman braces; PascalCase public methods/interfaces; no inline user-facing/role/copy literals (hoist to `private static readonly`); enums over unions (UI `OperatorRole` is an enum; the DTO wire `role` is the serialized string and stays `string`); `IDisposable` not lambdas; tests under `tests/`.
- New `.ts` files pure ASCII + LF; byte-scan after each write -> `0 0 N`. Existing files touched (`control-plane-host.ts`, `control-plane-host.test.ts`, `portal-types.ts`, `api-client.ts`, `app.ts`, `top-bar.ts`): check + MATCH current EOL, never flip. Escape non-ASCII as `\uXXXX`; re-scan after the Write tool.
- **Two gates, both green on the merged result.** Control plane (root `npm test` does NOT cover `admin/control-plane/tests`): from repo root `npx tsx --test admin/control-plane/tests/*.test.ts` AND `npm run typecheck:tools`. Portal: in `admin/portal`, `npm test` AND `npm run typecheck`.
- `admin/portal` must NEVER import `admin/tenant-portal`.

## Review Focus

- ReadOnly principal -> `GET /api/session` returns `role: 'readonly'`; Full -> `role: 'full'`; no token/password/grant leak. (Task 1.)
- `OperatorContext.FromWire` deny-by-default: unknown/missing role -> Observer (never Operator). (Task 2.)
- `CanMutate` matches the server exactly; `MutatingAct` -> enabled Act for Operator, visible-but-disabled Act with the needed-role hint (no double-fire) for Observer. (Task 2.)
- Observer read-only banner shows for Observer and NOT for Operator; operator menu shows the role label for both. (Task 3.)
- No `admin/tenant-portal` import; no inline user-facing literal; DTO/endpoint leak nothing extra. (All + diff review.)

---

### Task 1: Server - session reports the operator role

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (session handler + a `RoleWire` mapping)
- Test: `admin/control-plane/tests/control-plane-host.test.ts` (update the existing session-shape assertion; add a ReadOnly case)

**Interfaces:**
- Consumes: `who: OperatorPrincipal { email, principalId, role: OperatorRole }` already resolved at the session handler; the existing `'full'`/`'readonly'` strings (the `OperatorRoles` input map).
- Produces: `GET /api/session` JSON `{ email: string, principalId: string, role: 'full' | 'readonly' }`; a `private static RoleWire(role: OperatorRole): string` returning the hoisted wire strings (one home for `'full'`/`'readonly'`, shared with the input map's values).

- [ ] **Step 1: Update the failing test** - change `control-plane-host.test.ts:640` to expect `{ email: FakeOperator.Email, principalId: 'p1', role: 'full' }` (FakeOperator returns role Full), and add a test with a ReadOnly fake principal asserting `role: 'readonly'`. Also assert the body has no `token`/`password` keys.
- [ ] **Step 2: Run to verify it fails** - `npx tsx --test admin/control-plane/tests/control-plane-host.test.ts` from repo root. Expected: FAIL (payload is `{ email }` only).
- [ ] **Step 3: Implement** - in the session handler write `{ email: who.email, principalId: who.principalId, role: ControlPlaneHost.RoleWire(who.role) }`; add the `RoleWire` static. Match the file's EOL.
- [ ] **Step 4: Run both server gates** - `npx tsx --test admin/control-plane/tests/*.test.ts` (whole control-plane suite) and `npm run typecheck:tools`, both from repo root. Expected: all green.
- [ ] **Step 5: Commit** `feat(control-plane): session endpoint reports the operator role`.

---

### Task 2: Portal - OperatorDto + OperatorContext capability model

**Files:**
- Modify: `admin/portal/src/portal-types.ts` (`OperatorDto`)
- Modify: `admin/portal/src/api-client.ts` (only if the `OperatorDto` type usage needs it; `Session()` parsing is unchanged)
- Create: `admin/portal/src/operator-context.ts`
- Test: `admin/portal/tests/operator-context.test.ts` (new)

**Interfaces:**
- Consumes: `ActInputs`, `ActVariant`, `Act` from `./kit/act.js` (and `Act.Enabled`/`Act.DisabledHint` for the test).
- Produces:
  - `OperatorDto = { email: string; principalId: string; role: string }` (wire shape; `role` serialized string).
  - `export enum OperatorRole { Operator, Observer }` (UI vocabulary).
  - `export class OperatorContext`: `static FromWire(role: string): OperatorContext` (`'full'` -> Operator, anything else -> Observer, deny-by-default); getters `Role: OperatorRole`, `CanMutate: boolean` (Operator true / Observer false), `RoleLabel: string` ('Operator'/'Observer'), `NeededRoleLabel: string` ('Operator'), `AskWhom: string` (advisory, e.g. 'your operator lead'); `MutatingAct(label: string, onClick: () => void, variant?: ActVariant): ActInputs` returning `{ can: this.CanMutate, label, onClick, variant, need: this.NeededRoleLabel, ask: this.AskWhom }` (need/ask may be passed always; `Act` shows them only when `!can`). Hoist the wire token `'full'`, the two role labels, needed-role label, and ask text to `private static readonly`.

- [ ] **Step 1: Write the failing tests** - `FromWire('full').CanMutate === true` and `.RoleLabel === 'Operator'`; `FromWire('readonly').CanMutate === false` and `.RoleLabel === 'Observer'`; `FromWire('bogus').Role === OperatorRole.Observer` (deny-by-default); from an Operator context `new Act(ctx.MutatingAct('Delete', () => {...}, ActVariant.Danger))` is `Enabled` and firing calls onClick once; from an Observer context the Act is NOT `Enabled`, its `DisabledHint` names the Operator role, and `Press()` does not call onClick.
- [ ] **Step 2: Run to verify it fails** - `cd admin/portal && npx tsx --test tests/operator-context.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** - widen `OperatorDto`; create `operator-context.ts`. New file ASCII + LF; `portal-types.ts`/`api-client.ts` keep their EOL. Byte-scan.
- [ ] **Step 4: Run the portal gate** - `cd admin/portal && npx tsx --test tests/*.test.ts && npm run typecheck`. Expected: green.
- [ ] **Step 5: Commit** `feat(admin-portal): operator role DTO and capability model`.

---

### Task 3: Shell - role display and observer read-only banner

**Files:**
- Modify: `admin/portal/src/top-bar.ts` (`TopBarInputs.roleLabel` + show it)
- Modify: `admin/portal/src/app.ts` (build + hold `OperatorContext`, pass `roleLabel`, show observer `Banner`, expose `Operator` seam)
- Test: `admin/portal/tests/shell-app.test.ts` (extend), `admin/portal/tests/shell-top-bar.test.ts` (extend for `roleLabel`)

**Interfaces:**
- Consumes: `OperatorContext`/`OperatorRole` (Task 2), `OperatorDto` (now with `role`), `Banner`/`BannerTone` (`./kit/index.js`), `TopBar` (Task 4 of PA-2).
- Produces:
  - `TopBarInputs` gains `roleLabel: string`; the operator-menu region renders it beside the email (text; hoist any static label). Add a `get RoleLabelText(): string` seam.
  - `App`: after a signed-in boot, `this.operator = OperatorContext.FromWire(session.role)`; pass `roleLabel: this.operator.RoleLabel` into the `TopBar`; if `!this.operator.CanMutate`, add an Info `Banner` (hoisted read-only copy, e.g. 'Observer - read-only. You can view everything here; actions need the Operator role.') to the top bar's `BannerSlot`. Add `get Operator(): OperatorContext | undefined` (the seam later screens read). Clear `operator`/banner on logout (`UnmountShell`).

- [ ] **Step 1: Write the failing tests** - extend the signed-in shell test with a Full fake session: `app.Operator?.CanMutate === true`, `app.Top` operator menu shows role label 'Operator', and the top bar `BannerSlot` has NO banner. Add a ReadOnly fake session test: `app.Operator?.CanMutate === false`, role label 'Observer', and the `BannerSlot` contains one `Banner`. (The PA-2 `FakeClient.Session` must now return `{ email, principalId, role }`.) Extend `shell-top-bar.test.ts` fixture with `roleLabel` and assert `RoleLabelText`.
- [ ] **Step 2: Run to verify it fails** - `cd admin/portal && npx tsx --test tests/shell-app.test.ts tests/shell-top-bar.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** - extend `top-bar.ts` and `app.ts`. Match their EOL (existing files). Byte-scan.
- [ ] **Step 4: Run the full portal gate** - `cd admin/portal && npx tsx --test tests/*.test.ts && npm run typecheck`. Expected: all green (whole suite; update any PA-2 test whose fake session now needs the role field - intended change, note it).
- [ ] **Step 5: Commit** `feat(admin-portal): shell shows operator role and an observer read-only banner`.
