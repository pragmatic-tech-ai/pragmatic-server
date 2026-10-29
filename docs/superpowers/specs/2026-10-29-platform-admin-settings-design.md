# PA-13 - Platform Admin Settings v1 (operator profile + operator roster, read-only) - Design

**Status:** approved under the Program 2 autonomous mandate, with EXPLICIT user authorization for the security-sensitive disclosure surface (operator roster, email + role only). Corresponds to reconciliation backlog spec 13 (Settings), scoped to the honest read-only slice. Adds ONE security-sensitive control-plane read + a new authz rule + portal UI.
**Area:** Platform Admin portal (`admin/portal/`) + control-plane (`admin/control-plane/`): one new authenticated GET, one `OperatorIdentity` enumeration method, one `OperatorAuthorization` rule.
**Builds on:** PA-1 kit (`ScreenHost`, `PageHeader`, `Section`, `DataTable`, `PillKinds`, `KeyValueGrid`), the session/`OperatorContext` role model, the PA-8R/PA-9 additive-read pattern.

## Context

`PaSection.Settings` ("Settings", own nav group) mounts the `ComingSoonView` placeholder. The portal already knows the CURRENT operator (email + role) from the authenticated session (`GET /api/session` -> `{ email, principalId, role }`; `OperatorContext.FromWire`). It has NO way to see the roster of all operators.

Backend (control-plane) today:
- Operators live in the operator identity tenant. `OperatorIdentity` (admin/control-plane/operator-identity.ts) wraps a `ServerIdentityPack` whose `Accounts` store (`FileAccountStore`) implements `ListAccounts(tenant): Promise<readonly LocalAccount[]>` - so accounts ARE enumerable. `LocalAccount = { PrincipalId, TenantId, Email, SecretRef, Disabled }`. Role is derived per principal by the existing private `OperatorIdentity.RoleFor(principalId)` (reads grants; returns `OperatorRole.Full | ReadOnly`).
- `IOperatorIdentity` currently exposes only `Authenticate`/`ValidateToken`/`Revoke`/`CreateOperator` - NO enumeration. `/api/operators` is POST-only (create).
- The bootstrap admin is special: `OperatorIdentity.Compose` seeds it via `ServerBootstrap.SeedAsync` (owner grant), and `ValidateToken` resolves its email as `this.operatorEmail` when `principal.Id === AdminPrincipalId` (it does NOT carry a normal email claim). So the admin may be absent from, or mis-emailed in, `ListAccounts`.
- Auth gate: `ControlPlaneHost.Handle` calls `OperatorAuthorization.Authorize(role, method, path)` for every non-public `/api/*`. Today that gate returns `true` for `Full` and, for `ReadOnly`, allows any SAFE method (GET/HEAD/OPTIONS) + logout. So a plain GET is allowed to BOTH roles.
- Role wire encoding: `RoleWire(Full)='full'`, `RoleWire(ReadOnly)='readonly'` (host); the portal maps `'full' -> Operator` else `Observer` (`OperatorContext.FromWire`).

## Recon findings (binding) + rulings

1. **ONE new authenticated read `GET /api/operators`, gated to the Full role only (security-sensitive; user-authorized).** The operator roster is a disclosure surface, so it is NOT a plain safe-method GET: a new explicit rule in `OperatorAuthorization` makes `GET /api/operators` require `Full` (deny `ReadOnly` with 403), even though GET is normally safe. Ruling: add `OperatorAuthorization.FullOnlyReadPaths: ReadonlySet<string> = new Set(['/api/operators'])`; `Authorize` returns `false` for a `ReadOnly` principal whose path is in that set (before the safe-method allowance). `Full` still passes. Unauthenticated -> 401 (existing). This is the ONLY authz change and it only ADDS a denial; no existing route's gating changes.

2. **The roster wire shape exposes ONLY `{ email, role }` - no secrets, no internal refs.** `OperatorSummaryDto = { email: string; role: string }` where `role` is the SAME wire encoding as the session (`'full'`/`'readonly'`). Ruling (binding security invariant): the DTO NEVER carries `SecretRef`, `PrincipalId`, `TenantId`, grant detail, password/hash, or any identity-subsystem internal. `principalId` stays server-side (used only to derive the role and to special-case the admin); it is dropped from the wire. reported==enforced; no fabricated fields.

3. **`OperatorIdentity.ListOperators(): Promise<readonly OperatorSummary[]>` enumerates active operators, with the admin guaranteed present exactly once.** Implementation: `const accounts = await this.pack.Accounts.ListAccounts(this.tenant)`; for each NON-disabled account build `{ email, role: await this.RoleFor(account.PrincipalId) }`, using `this.operatorEmail` for the email when `account.PrincipalId === AdminPrincipalId` (mirroring `ValidateToken`'s exact rule). THEN, if no entry for `AdminPrincipalId` was produced (admin absent from `ListAccounts`), prepend `{ email: this.operatorEmail, role: OperatorRole.Full }` (the admin always holds the Owner/Full grant). Dedupe by email. Ruling: exclude `Disabled` accounts from v1 (an "active operators" roster; showing a disabled account without a status marker would mislead, and status is out of the authorized `{email,role}` surface) - documented; disabled/status surfacing deferred. `OperatorSummary` is the control-plane-internal shape `{ email: string; role: OperatorRole }`; the host maps `role` through `RoleWire` into `OperatorSummaryDto`.

4. **Settings is a SINGLE-screen view (not a self-routing container), role-aware.** `SettingsView` (mirrors `FleetView`/`ReleasePolicyView`; single `ScreenHost`) shows two sections:
   - **"Your session"**: a `KeyValueGrid` with the current operator's Email and Role (from the session/`OperatorContext` already held by the shell - no fetch). Always shown.
   - **"Operators"**: for a `Full` operator, fetch `GET /api/operators` and render a `DataTable<OperatorRow>` (columns Operator=email, Role=Operator/Observer label); for a `ReadOnly` operator, do NOT fetch - render an honest denied note ("Requires the Operator role.") matching the kit's denied/need-role idiom. Ruling: the view decides fetch-or-deny from `OperatorContext.IsOperator` (reported==enforced: the backend also denies ReadOnly, so a ReadOnly operator who somehow fetched would get 403 -> the view shows the same denied state).
5. **Role display:** reuse the portal's role vocabulary. Full -> "Operator", ReadOnly -> "Observer" (matching `OperatorContext` and the shell's existing "Observer - read-only" banner copy). A shared mapping on `OperatorContext` or a small `OperatorRoleLabel` helper; no inline literals.

6. **Reuse.** The kit `ScreenHost`/`PageHeader`/`Section`/`DataTable`/`KeyValueGrid`/`Banner`; the existing session role already in the shell; `OperatorContext`. No new helper beyond the role-label mapping and the DTO. No new backend concept beyond the enumeration + authz rule.

## Goals

- Replace the Settings placeholder with a read-only screen showing the current operator's identity (from session) and, for Operators, the roster of active operators (email + role), on existing data plus one Full-gated additive read.
- Keep the disclosure minimal and the gate tight: roster = {email, role} only, Full-role only, admin always present once.

## Non-goals / deferred (filed as Features)

- Any operator MUTATION from Settings: invite/create (POST /api/operators exists but is a management UI = separate spec), disable/enable, role change, password reset, revoke sessions. Read-only only.
- Operator status (Active/Disabled) column, last-login, created-at, principal id - beyond the authorized {email, role} surface.
- Platform configuration display/edit (no server source; G-config).
- Any change to the existing auth rules beyond adding the one Full-only read denial; any change to POST /api/operators, login, session, logout.

## Anti-goals (a failure even if it "works")

- Exposing ANY secret or identity-subsystem internal in the roster: `SecretRef`, `PrincipalId`, `TenantId`, grants, password/hash, tenant config. {email, role} only.
- Letting a `ReadOnly` operator read the roster (the new rule must deny with 403; a happy-path test is not enough - add the ReadOnly-denied and unauth-401 tests).
- Omitting the bootstrap admin from the roster, or showing it with a wrong/blank email (must be `operatorEmail`, exactly once).
- Fabricating operators, roles, or a status the backend does not report.
- An edit/invite/disable control with no honest backend. Color-only role indication; a control not keyboard-reachable; inline user-facing literals; importing `admin/tenant-portal`.

## Information architecture (decided shape)

Control plane (`admin/control-plane/`):
- `operator-identity.ts` - add `export type OperatorSummary = { email: string; role: OperatorRole }` and `public async ListOperators(): Promise<readonly OperatorSummary[]>` (per finding 3; also add `ListOperators` to the `IOperatorIdentity` interface). Uses `this.pack.Accounts.ListAccounts`, existing `RoleFor`, `AdminPrincipalId`, `operatorEmail`.
- `operator-authorization.ts` - add `FullOnlyReadPaths` set containing `/api/operators`; in `Authorize`, for a `ReadOnly` role return `false` when `path` is in `FullOnlyReadPaths` (keep the existing logout/safe-method allowance otherwise). `Full` unchanged (still `true`).
- `control-plane-host.ts` - add `OperatorsDto`/`OperatorSummaryDto = { email: string; role: string }`; at the existing `OperatorsPath` branch, serve GET inline (`[...].map(o => ({ email: o.email, role: RoleWire(o.role) }))`) before the POST (create) handler. GET passes the central gate (now Full-only via the new rule). No other host change.

Portal (`admin/portal/src/`):
- `portal-types.ts` - add `OperatorSummaryDto = { email: string; role: string }`.
- `api-client.ts` - add `ListOperators(): Promise<OperatorSummaryDto[]>` (GET `/api/operators`), mirroring `ListManifests`.
- `operator-context.ts` - add a role-label mapping (e.g. `public static Label(wireRole: string): string` -> 'Operator'/'Observer', or an instance `RoleLabel`), the single home of the role vocabulary.
- `settings-view-model.ts` - `SettingsViewModel extends Observable`. Holds the current `{ email, roleLabel }` (from the session/OperatorContext) and, when loaded, `OperatorRow[]` (`{ email, roleLabel }`) from `ListOperators`. Stable sort by email. `Update(summaries)` raising a change key. Derives row role labels via the `operator-context` mapping.
- `settings-view.ts` - `SettingsView extends StackPanel implements IPortalView`, `constructor(client, operator: OperatorContext)`. Single `ScreenHost`; populated content = `PageHeader` (breadcrumb ['Settings'] or the nav group + 'Settings'; title 'Settings') + "Your session" `Section`(`KeyValueGrid`: Email, Role) + "Operators" `Section`: if `operator.IsOperator` fetch + fresh `DataTable<OperatorRow>`; else an honest denied note (no fetch). Error path (fetch reject) -> error with `onRetry`. Fresh table slot per render (second-Refresh safe). Seams `Host`, `Table`.
- `app.ts` - `ShowSection(PaSection.Settings)` mounts `new SettingsView(this.client, this.operator)` before the `ComingSoon` fallback; update `shell-app.test.ts` routing (Settings -> SettingsView).

Tests:
- Control-plane (`admin/control-plane/tests/`, `npx tsx --test`): `ListOperators` unit (seed >=2 operators incl. the bootstrap admin -> returns each once with correct email+role; admin present exactly once with `operatorEmail`; a `ReadOnly` operator appears with role readonly; a disabled account is excluded). Host route: `GET /api/operators` as Full -> 200 roster; as ReadOnly -> 403; unauthenticated -> 401. The authz unit: `Authorize(ReadOnly, 'GET', '/api/operators') === false` and `Authorize(Full, 'GET', '/api/operators') === true` and a normal GET still allowed to ReadOnly.
- Portal (`admin/portal/tests/`, `node:test`, `Application.current` harness): `settings-view-model.test.ts` (rows sorted; role labels; empty roster); `settings-view.test.ts` (Full operator -> session KV + operators table populated; ReadOnly operator -> session KV + denied note, NO fetch attempted; fetch-reject -> error with working onRetry; a SECOND `Refresh()` re-renders with no double-parent).

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline user-facing literals, enums over unions, VMs extend `Observable`, `IDisposable` not lambdas, tests under `tests/`.
- New `.ts` pure ASCII + LF; byte-scan after every write (`0 0 N`). Match EOL of touched files.
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools` (root); portal `npm test` + `npm run typecheck` in `admin/portal`. BOTH green on the merged result.
- SECURITY: roster = {email, role} only; Full-role-gated; admin exactly once; no secret/internal-ref ever on the wire; the new authz rule only ADDS a denial.
- No cross-app import; every actionable control keyboard-reachable; role shown as text (not color-only); stateful view survives a second `Refresh()`.

## Review focus (inputs no happy-path test exercises)

- A `ReadOnly` principal hitting `GET /api/operators` -> 403, not 200 (the new rule; unit + host test). A normal GET still works for ReadOnly (rule must not over-broaden).
- The bootstrap admin: present exactly once, email = `operatorEmail`, role Operator - whether or not `ListAccounts` includes it. (ListOperators unit, both cases.)
- A disabled account -> excluded from the roster (not shown as active). (Unit.)
- The roster DTO carries no `principalId`/`SecretRef`/internal ref (assert the serialized shape has exactly `email` + `role`). (Host test.)
- A `ReadOnly` operator in the portal -> Settings shows the session card + a denied note and makes NO `/api/operators` request. (View test asserts the client was not called.)
- A second `Refresh()` re-renders without a double-parent throw. (View test.)
