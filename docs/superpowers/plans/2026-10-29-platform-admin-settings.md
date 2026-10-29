# Platform Admin Settings v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only Settings section showing the current operator's identity (from session) and, for Operator-role users only, the roster of active operators (email + role), backed by one new Full-gated control-plane read.

**Architecture:** Control-plane gains `OperatorIdentity.ListOperators()` (enumerates active accounts via the existing `Accounts.ListAccounts`, guarantees the bootstrap admin exactly once), a new `OperatorAuthorization` rule making `GET /api/operators` Full-role-only, and a GET arm on the existing `OperatorsPath`. The portal gains a client method + a single-screen role-aware `SettingsView`.

**Tech Stack:** TypeScript (ESM, `.js` specifiers); control-plane `node:http` host + `node:test`; portal `@pragmatic-tech-ai/mural` + the portal `kit` + `node:test` with the `Application.current` harness.

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-settings-design.md`

## Global Constraints

- OOP; Allman braces; PascalCase public methods/interfaces; enums over string-literal unions; view-models extend `Observable`; `IDisposable` not lambdas; tests under `tests/`.
- No inline user-facing / reused string literals - hoist to `private static readonly` constants (route path, labels, column keys/headers, empty/error/denied text, role labels).
- New `.ts`: pure ASCII, LF. Byte-scan every written `.ts`: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`. Match EOL of edited files (all LF).
- SECURITY (binding): the operator roster exposes ONLY `{ email, role }` - NEVER `SecretRef`, `PrincipalId`, `TenantId`, grants, password/hash, or any identity-subsystem internal. `GET /api/operators` is Full-role-only (ReadOnly -> 403, unauthenticated -> 401). The bootstrap admin appears exactly once with `operatorEmail`. The new authz rule only ADDS a denial; it must not broaden or change any existing route's gating. reported==enforced; no fabricated fields.
- No cross-app import (`admin/tenant-portal`); every actionable control keyboard-reachable; role shown as text; stateful view survives a second `Refresh()` (fresh table slot per render).
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; portal `npm test` + `npm run typecheck` in `admin/portal`. BOTH green on the merged result.

## Review Focus

- A `ReadOnly` principal hitting `GET /api/operators` -> 403 (not 200); a normal GET still allowed to ReadOnly (rule not over-broad). -> Task 1 (authz unit) + Task 3 (host).
- The bootstrap admin present exactly once, email = `operatorEmail`, role Full, whether or not `ListAccounts` returns it. -> Task 2.
- A disabled account excluded from the roster. -> Task 2.
- The wire DTO carries exactly `email` + `role` (no `principalId`/`SecretRef`/internal). -> Task 3 (assert serialized shape).
- A `ReadOnly` operator in the portal sees the session card + a denied note and makes NO `/api/operators` request. -> Task 5 (assert client not called).
- A second `Refresh()` re-renders with no double-parent. -> Task 5.

---

### Task 1: `OperatorAuthorization` Full-only read rule

**Files:**
- Modify: `admin/control-plane/operator-authorization.ts`
- Test: `admin/control-plane/tests/operator-authorization.test.ts` (add cases; create the file if absent)

**Interfaces:**
- Produces: unchanged public `Authorize(role, method, path): boolean` signature; new `public static readonly FullOnlyReadPaths: ReadonlySet<string>` containing `'/api/operators'`.

- [ ] **Step 1: Write failing tests** — `Authorize(OperatorRole.ReadOnly, 'GET', '/api/operators')` is `false`; `Authorize(OperatorRole.Full, 'GET', '/api/operators')` is `true`; a normal safe GET (e.g. `/api/fleet`) is still `true` for `ReadOnly`; logout still allowed for `ReadOnly`; a mutating method still denied for `ReadOnly`.
- [ ] **Step 2: Run tests, verify they fail** (`npx tsx --test admin/control-plane/tests/operator-authorization.test.ts`).
- [ ] **Step 3: Implement** — add `FullOnlyReadPaths = new Set(['/api/operators'])` (hoist the path literal to a `private static readonly OperatorsPath` on the class or share the host's; keep ONE home). In `Authorize`, for `role !== OperatorRole.Full`: return `false` if `FullOnlyReadPaths.has(path)`, else the existing `(path === LogoutPath || !this.IsMutating(method))`. `Full` branch unchanged.
- [ ] **Step 4: Byte-scan both files -> `0 0 N`. Run the test file -> PASS.**
- [ ] **Step 5: Run `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; commit** (`feat(control-plane): gate GET /api/operators to the Full role`).

---

### Task 2: `OperatorIdentity.ListOperators()`

**Files:**
- Modify: `admin/control-plane/operator-identity.ts`
- Test: `admin/control-plane/tests/operator-identity.test.ts` (add cases; create if absent - study an existing control-plane test that composes an `OperatorIdentity` for the harness)

**Interfaces:**
- Produces: `export type OperatorSummary = { email: string; role: OperatorRole }`; `ListOperators(): Promise<readonly OperatorSummary[]>` added to BOTH the `IOperatorIdentity` interface and the `OperatorIdentity` class.

- [ ] **Step 1: Write failing tests** — compose an `OperatorIdentity` (reuse the existing test setup pattern), create a second operator via `CreateOperator(email, pw, ReadOnly)`, then assert `ListOperators()`: returns the bootstrap admin exactly once with email === the composed `operatorEmail` and role `Full`; returns the second operator with role `ReadOnly`; after `Disable`-ing (or creating then disabling, if a disable path is reachable in the harness) an account, it is excluded. If disabling is not reachable from the test harness, assert exclusion via a unit on the mapping with a stubbed account list (document the choice).
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement `ListOperators`** — `const accounts = await this.pack.Accounts.ListAccounts(this.tenant)`; map each `account` with `account.Disabled === false` to `{ email: account.PrincipalId === OperatorIdentity.AdminPrincipalId ? this.operatorEmail : account.Email, role: await this.RoleFor(account.PrincipalId) }`; if none had `PrincipalId === AdminPrincipalId`, prepend `{ email: this.operatorEmail, role: OperatorRole.Full }`; dedupe by email (keep first). Add `ListOperators` to the `IOperatorIdentity` interface. NO secret/ref in the result.
- [ ] **Step 4: Byte-scan -> `0 0 N`. Run the test file -> PASS.**
- [ ] **Step 5: `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; commit** (`feat(control-plane): OperatorIdentity.ListOperators (active roster, admin once)`).

---

### Task 3: `GET /api/operators` route + DTO

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts`
- Test: the control-plane host test file that already exercises operator routes / manifests (add cases there; otherwise `admin/control-plane/tests/control-plane-host-operators.test.ts`)

**Interfaces:**
- Consumes: `OperatorIdentity.ListOperators` (Task 2), the Full-only gate (Task 1).
- Produces: `OperatorSummaryDto = { email: string; role: string }` served at `GET /api/operators`.

- [ ] **Step 1: Write failing host tests** — authenticated as `Full` -> `GET /api/operators` returns 200 and a JSON array where every element has exactly the keys `email` and `role` (assert `Object.keys` set === {email, role} - NO `principalId`/`secretRef`), with `role` in {`'full'`,`'readonly'`}, and the admin present once; authenticated as `ReadOnly` -> 403; unauthenticated -> 401.
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** — add `private static readonly OperatorSummaryDto` mapping is inline; at the existing `OperatorsPath` branch in `RouteApi`, handle GET BEFORE the POST(create): `if (method === PlaneHttp.MethodGet) { const roster = await this.operator.ListOperators(); PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, roster.map(o => ({ email: o.email, role: ControlPlaneHost.RoleWire(o.role) }))); return true }`. The central gate already enforces Full-only (Task 1) + 401 (existing); no gating code here. Do NOT expose principalId or any other field.
- [ ] **Step 4: Byte-scan -> `0 0 N`. Run the test file -> PASS.**
- [ ] **Step 5: `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; commit** (`feat(control-plane): GET /api/operators roster (email+role, Full-gated)`).

---

### Task 4: Portal plumbing - DTO, client, role label

**Files:**
- Modify: `admin/portal/src/portal-types.ts`, `admin/portal/src/api-client.ts`, `admin/portal/src/operator-context.ts`
- Test: `admin/portal/tests/api-client-platform.test.ts` (add a `ListOperators` case, mirroring `ListManifests`) + `admin/portal/tests/operator-context.test.ts` (role-label cases)

**Interfaces:**
- Consumes: `GET /api/operators` returning `{ email, role }[]` (Task 3).
- Produces: `OperatorSummaryDto = { email: string; role: string }` (portal-types); `ControlPlaneClient.ListOperators(): Promise<OperatorSummaryDto[]>`; a role-label mapping on `OperatorContext` (e.g. `public static RoleLabel(wireRole: string): string` -> 'Operator'/'Observer', the single home of the role vocabulary; hoist 'Operator'/'Observer'/'full' literals to constants).

- [ ] **Step 1: Write failing tests** — `ListOperators` issues `GET /api/operators` and returns the parsed array (mirror the existing `ListManifests` test); `OperatorContext.RoleLabel('full') === 'Operator'`, `RoleLabel('readonly') === 'Observer'`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the DTO, the client method (mirror `ListManifests` - no-arg GET, hoisted route constant), and the role-label mapping.
- [ ] **Step 4: Byte-scan each touched file -> `0 0 N`. Tests PASS.**
- [ ] **Step 5: `npm test` + `npm run typecheck` in `admin/portal`; root `npm run typecheck:tools`; commit** (`feat(portal): ListOperators client + OperatorSummaryDto + role label`).

---

### Task 5: `SettingsView` + view-model + routing

**Files:**
- Create: `admin/portal/src/settings-view-model.ts`, `admin/portal/src/settings-view.ts`
- Modify: `admin/portal/src/app.ts`
- Test: `admin/portal/tests/settings-view-model.test.ts`, `admin/portal/tests/settings-view.test.ts`, and `admin/portal/tests/shell-app.test.ts` (routing: Settings -> SettingsView)

**Interfaces:**
- Consumes: `ControlPlaneClient.ListOperators`, `OperatorSummaryDto`, `OperatorContext` (+ `RoleLabel`, `IsOperator`), the kit (`ScreenHost`, `PageHeader`, `Section`, `DataTable`, `KeyValueGrid`), the single-screen view pattern from `FleetView`/`ReleasePolicyView`.

- [ ] **Step 1: Write failing VM tests** — `SettingsViewModel` from the current `{email, roleLabel}` + `Update(summaries)` derives `OperatorRow[]` (`{ email, roleLabel }`) sorted by email; empty roster -> empty rows; role labels via the Task 4 mapping.
- [ ] **Step 2: Implement `settings-view-model.ts`** (`extends Observable`; getters + change key).
- [ ] **Step 3: Write failing view tests** — Full operator: `ScreenHost` populated; "Your session" `KeyValueGrid` shows the email + role; "Operators" `Section` has a `DataTable` with the roster rows. ReadOnly operator: session card shown; "Operators" shows a denied note; assert the client's `ListOperators` was NOT called (spy/fake records calls). Fetch-reject (Full): error state with a working `onRetry` (activate it, recover). Second `Refresh()` re-renders with no double-parent. (Use the existing view-test harness; drive retry the way `releases-view.test.ts` does.)
- [ ] **Step 4: Implement `settings-view.ts`** — `extends StackPanel implements IPortalView`, `constructor(client, operator)`. Single `ScreenHost`; `Refresh()` builds a fresh content tree each render (fresh table slot). `PageHeader` (breadcrumb/title from hoisted constants). "Your session" `Section` -> `KeyValueGrid` (Email, Role from `operator`). "Operators" `Section`: if `operator.IsOperator` -> fetch `ListOperators`, build/`Update` the VM, render a fresh `DataTable<OperatorRow>` (columns Operator=email [sort], Role=roleLabel); else render an honest denied note (hoisted text), no fetch. Fetch-reject -> `ScreenHost` error with `onRetry: () => void this.Refresh()`. Seams `Host`, `Table`.
- [ ] **Step 5: Wire `app.ts`** — mirror the EXISTING guarded `ClientsView` idiom (`this.operator` is `OperatorContext | undefined`): in `ShowSection`, before the `ComingSoon` fallback, add `if (section === PaSection.Settings) { const operator = this.operator; if (operator !== undefined) { this.Mount(new SettingsView(this.client, operator)); return } }` (fall through to ComingSoon only if operator is somehow undefined, exactly as ClientsView does). Update `shell-app.test.ts` to assert Settings -> SettingsView (the harness signs in an operator, as the existing Clients routing test does).
- [ ] **Step 6: Byte-scan the two new files -> `0 0 N`. Run `npm test` + `npm run typecheck` in `admin/portal`; root `npm run typecheck:tools`. All green. Commit** (`feat(portal): Settings v1 - operator profile + roster (read-only)`).
