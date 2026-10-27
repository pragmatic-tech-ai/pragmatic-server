# Tenant-Admin "Service Tokens" (B1-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Expose the existing `AdminProtocol` token ops (list/issue/revoke) over the per-environment `/tenant-api/.../admin/tokens` REST surface and add a tenant-portal Service Tokens screen — with the secret token value returned exactly once at issuance and shown once in the UI.

**Architecture:** Server: add `ListTokens`/`RevokeToken` through `AdminProxy`→`WsAdminConnection` (wire contracts + `IssueToken` proxy already exist) and `AdminListTokens`/`AdminIssueToken`/`AdminRevokeToken` through `EnvironmentService`; add a `tokens` leaf to the tenant-api REST dispatcher; map token-not-found → 404. UI: a `ServiceTokensView` + `ServiceTokensViewModel` mirroring the B1-1 Users & Access pattern (imperative Mural view + `Observable` VM + accounts-style `DataGrid`), with a one-time secret-reveal panel.

**Tech Stack:** TypeScript; server control-plane (`admin/control-plane`), protocol (`pragmatic-protocol`), Mural UI; `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-27-tenant-admin-service-tokens-design.md`

## Global Constraints

- Branch off `master`; merge locally when done; **never push**.
- **Secrets:** the secret `token` is returned ONLY in the issue `201` body; add `Cache-Control: no-store` to that response; NEVER log it, put it in an error body, or persist it raw (server store keys by `sha256` already). The list route and `ServiceTokenSummaryDto` MUST NOT contain a `token` field. The UI holds the issued secret only in transient VM state, shows it once, clears it on Dismiss, and never writes it into the grid or any persisted/re-rendered node.
- **Error handling (REST):** generic backend strings surfaced verbatim; `401`→login (`TenantViewBase.ShowError`), `409` RBAC, `404` unknown-token / cross-tenant / unknown-env, `503` engine-unavailable, `400` invalid body. Cross-tenant/unknown env → 404 with NO service call (existing `OwnedEnv` gate).
- Style: OOP; Allman braces; PascalCase public members & interfaces; NO inline string literals (hoist to `private static readonly`; fixture/seed data in fakes excepted); enums over string unions; VMs extend `Observable`; `dispose()`/`Dispose()` teardown.
- **Line endings** (tenant-portal EOL map from B1-1, verified against `master`): NEW files are **LF**; pre-existing **CRLF** files are `tenant-api-client.ts`, `tenant-app.ts`, `tenant-app.test.ts`, `tenant-tree-view.test.ts`; pre-existing **LF** files are `tenant-types.ts`, `fake-tenant-control-plane.ts`. Match each file's existing EOL; after editing verify with `tr -cd '\r' < f | wc -c` vs `wc -l` (the subagent editor silently flips EOL). Server control-plane files: match each file's existing EOL (check per file).
- Tests: tenant-portal tests under `admin/tenant-portal/tests/` run by `npm --prefix admin/tenant-portal test`; control-plane tests under `admin/control-plane/tests/` — confirm the invocation (likely `npx tsx --test "admin/control-plane/tests/*.test.ts"`) in Task 1 and use it for Tasks 1–3. Gate `npm run typecheck:tools` covers the server tools + both portals.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

### Plan rulings (from the design; reviewers may challenge)

- **R1** revoke is `DELETE .../admin/tokens` with body `{tokenRef}` (not a path tail — tokenRef contains `/`).
- **R2** list reuses the existing secret-free `ServiceTokenSummaryDto`.
- **R3** add a `Classify` match "service token not found" → a not-found kind → REST 404.
- **R4** issue form: free-text scopes (≥1) + a preset-duration button strip (1h `3600` / 24h `86400` / 30d `2592000` / Never `null`).
- **R5** one-time secret reveal in transient VM state, cleared on Dismiss, never in the grid or re-rendered.
- **R6** env-scoped, **Service Tokens** top-bar entry; `ITenantNavigator.ShowServiceTokens()`.

## Review Focus

- **Issue response carries the secret once + `Cache-Control: no-store`, list never includes `token`.** → Task 3 (REST) tests + Task 4 (client/fake) tests.
- **Revoke of an unknown/already-revoked `tokenRef` → 404, not 500** (Classify not-found mapping). → Task 1 + Task 3 tests.
- **The issued secret appears in NO node after Dismiss and never in the tokens grid.** → Task 6 view test.
- **Issue with empty scopes or missing principal is rejected before any engine call** (400 server-side; guarded client-side). → Task 3 (server validation) + Task 5/6 (VM/view guard) tests.
- **Cross-tenant / unknown env on any token route → 404 with no service call.** → Task 3 table-driven tests.

---

### Task 1: `AdminProxy` — ListTokens / RevokeToken + token-not-found Classify

**Files:**
- Modify: `admin/control-plane/admin-proxy.ts`
- Test: `admin/control-plane/tests/admin-proxy.test.ts`

**Interfaces:**
- Consumes: `AdminProtocol.ListTokens` (`RequestType0<ServiceTokenSummaryDto[], void>`, method `'admin/tokens/list'`), `AdminProtocol.RevokeToken` (`RequestType<RevokeTokenParams, AdminAckDto, void>`, `'admin/tokens/revoke'`) from `pragmatic-protocol`; existing `AdminProxyErrorKind`, `Classify`, `With`, `AdminConnectInfo`, and the existing `IssueToken` proxy method as the template.
- Produces:
  - `IAdminConnection`: `ListTokens(): Promise<ServiceTokenSummaryDto[]>`; `RevokeToken(params: RevokeTokenParams): Promise<AdminAckDto>`.
  - `IAdminProxy` + `AdminProxy`: `ListTokens(info: AdminConnectInfo): Promise<ServiceTokenSummaryDto[]>`; `RevokeToken(info: AdminConnectInfo, params: RevokeTokenParams): Promise<AdminAckDto>` (each `return this.With(info, conn => conn.X(...))`).
  - `WsAdminConnection`: both via `this.conn.sendRequest(AdminProtocol.ListTokens, undefined)` / `sendRequest(AdminProtocol.RevokeToken, params)`.
  - `AdminProxyErrorKind.NotFound` (new enum member) + `Classify` returns it when the message (lowercased) contains `'service token not found'`.

- [ ] **Step 1: Confirm the control-plane test command.** Run the suite once (try `npx tsx --test "admin/control-plane/tests/*.test.ts"`); record the working command in the task report — Tasks 2–3 reuse it.
- [ ] **Step 2: Write failing tests** in `admin-proxy.test.ts` mirroring the existing `IssueToken` cases (`:116`/`:180`/`:231`): `ListTokens` opens once / disposes once and returns the summary array; `RevokeToken` opens once / disposes once and returns the ack; a thrown error whose message contains `service token not found` is classified `NotFound` (and non-matching errors keep their current kinds).
- [ ] **Step 3: Run tests, verify they fail.** `npx tsx --test admin/control-plane/tests/admin-proxy.test.ts`.
- [ ] **Step 4: Implement** the two methods across `IAdminConnection`/`IAdminProxy`/`AdminProxy`/`WsAdminConnection`, and the `NotFound` kind + `Classify` match. Add the match string as a `private static readonly`.
- [ ] **Step 5: Run tests, verify pass.** Same command + `npm run typecheck:tools`.
- [ ] **Step 6: Commit** (match each file's existing EOL).

---

### Task 2: `EnvironmentService` — AdminListTokens / AdminIssueToken / AdminRevokeToken

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (`IEnvironmentService`), `admin/control-plane/environment-service.ts`, `admin/control-plane/loop-orchestrator.ts` (fake)
- Test: `admin/control-plane/tests/environment-service.test.ts`

**Interfaces:**
- Consumes: Task 1's `AdminProxy.ListTokens/IssueToken/RevokeToken`; `AdminInfoFor(name)`; the `AdminIssueMakerToken`/`AdminDisableAccount` methods as templates (`environment-service.ts:510`/`:522`).
- Produces on `IEnvironmentService` + `EnvironmentService`:
  - `AdminListTokens(name: string): Promise<ServiceTokenSummaryDto[]>`
  - `AdminIssueToken(name: string, params: IssueTokenParams): Promise<TokenIssuedDto>`
  - `AdminRevokeToken(name: string, tokenRef: string): Promise<void>` (wraps `proxy.RevokeToken(info, { tokenRef })`, discards the ack)
  Each is `const info = await this.AdminInfoFor(name); return this.proxy.X(info, …)`. **No env-type restriction** (unlike `AdminIssueMakerToken`'s dev-only guard) — generic service tokens are not dev-scoped.

- [ ] **Step 1: Write failing tests** in `environment-service.test.ts` following the file's style: each method calls `AdminInfoFor(name)` then the matching `proxy` method with the right args, and returns/forwards the proxy result (use the existing fake proxy).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the three methods on the interface + class, and add stubs to the `loop-orchestrator.ts` fake `IEnvironmentService` implementation (and any other `IEnvironmentService` fake the typecheck surfaces).
- [ ] **Step 4: Run tests + `typecheck:tools`, verify pass.**
- [ ] **Step 5: Commit** (match EOL).

---

### Task 3: tenant-api REST `tokens` leaf

**Files:**
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts`
- Test: `admin/control-plane/tests/tenant-identity-admin.test.ts`

**Interfaces:**
- Consumes: Task 2's `service.AdminListTokens/AdminIssueToken/AdminRevokeToken`; existing `AdminPathPattern`, `DispatchAdmin`, `AdminRead`, `ReadObject`, `NonEmpty`, `WriteJson`, `WriteIdentityError`, `OwnedEnv`, status constants; `IssueTokenParams`/`RevokeTokenParams`/`ServiceTokenSummaryDto`/`TokenIssuedDto`.
- Produces: `TokensLeaf = 'tokens'` added to `AdminPathPattern`; `DispatchAdmin` branches — `GET tokens` (no tail) → `service.AdminListTokens(name)` → `200` `ServiceTokenSummaryDto[]`; `POST tokens` (no tail) → validate body (`principalId` non-empty, `scopes` a non-empty string array, `expiresInSeconds` null or positive int) → `service.AdminIssueToken(name, params)` → `201` `TokenIssuedDto` + header `Cache-Control: no-store`; `DELETE tokens` (no tail) → body `{tokenRef}` (non-empty) → `service.AdminRevokeToken(name, tokenRef)` → `200 {ok:true}`. `WriteIdentityError` gains a branch: `AdminProxyError` kind `NotFound` → `404` (generic message).

- [ ] **Step 1: Write failing tests** in `tenant-identity-admin.test.ts`:
  - Add table rows: `GET tokens` → `AdminListTokens`, `POST tokens` → `AdminIssueToken`, `DELETE tokens` (body `{tokenRef:'r'}`) → `AdminRevokeToken` — each "calls the service for the owning tenant" and "404s a cross-tenant env and never calls the service".
  - `GET tokens` returns the fake's summary array and the JSON has NO `token` field on any element.
  - `POST tokens` returns `201` with the issued DTO and the response carries `Cache-Control: no-store`.
  - `POST tokens` with empty `scopes` (and with missing `principalId`) → `400` with the generic field message and NO service call.
  - `DELETE tokens` with a missing/empty `tokenRef` → `400`.
  - A `service.Throw` of an `AdminProxyError` NotFound → `404` generic body (no inner text).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the leaf + routes + `no-store` header + validation + the `WriteIdentityError` NotFound branch. Hoist new literals (`'tokens'`, `'no-store'`, `'Cache-Control'`, field messages) to `private static readonly`.
- [ ] **Step 4: Run control-plane suite + `typecheck:tools`, verify pass.**
- [ ] **Step 5: Commit** (match EOL).

---

### Task 4: tenant-portal client + DTOs + fake routes

**Files:**
- Modify: `admin/tenant-portal/src/tenant-types.ts` (LF), `admin/tenant-portal/src/tenant-api-client.ts` (**CRLF**), `admin/tenant-portal/tests/fake-tenant-control-plane.ts` (LF)
- Test: `admin/tenant-portal/tests/tenant-api-client.test.ts` (**CRLF**)

**Interfaces:**
- Consumes: the private `Send<T>(route, init)` helper; `EnvRoute(name)`; existing `/admin/*` leaf constants + `MethodPost`/`MethodDelete`; `TenantApiError`.
- Produces in `tenant-types.ts`:
  - `ServiceTokenSummaryDto = { tokenRef: string; principalId: string; scopes: string[]; expiresAt: string | null; revoked: boolean }`
  - `IssueTokenParams = { principalId: string; scopes: string[]; expiresInSeconds: number | null }`
  - `TokenIssuedDto = { tokenRef: string; token: string; principalId: string; scopes: string[]; expiresAt: string | null }`
  - `RevokeTokenParams = { tokenRef: string }`
  - `ITokensSource { ListEnvironments(): Promise<EnvironmentDto[]>; ListTokens(env: string): Promise<ServiceTokenSummaryDto[]>; IssueToken(env: string, params: IssueTokenParams): Promise<TokenIssuedDto>; RevokeToken(env: string, tokenRef: string): Promise<void> }`
  - add `ShowServiceTokens(): void` to `ITenantNavigator`.
  - `TenantApiClient` gains `ListTokens`/`IssueToken`/`RevokeToken` and now also `implements ITokensSource` (keep `implements IUsersAccessSource`): a `/admin/tokens` leaf constant; `ListTokens` = GET `EnvRoute+leaf`; `IssueToken` = POST with `JSON.stringify(params)`; `RevokeToken` = DELETE with body `JSON.stringify({ tokenRef })`.
- fake: `/tenant-api/environments/:name/admin/tokens` GET (in-memory summaries, NO `token`), POST (record, return a `TokenIssuedDto` with a `token` once, 201), DELETE (body `{tokenRef}`, mark revoked, `{ok:true}`). Seed one token.

- [ ] **Step 1: Write failing client tests** (`tenant-api-client.test.ts`): `ListTokens('e')` → GET `/tenant-api/environments/e/admin/tokens` → parsed summaries; `IssueToken('e', params)` → POST that route with the params body → the issued DTO; `RevokeToken('e','r')` → DELETE that route with body `{tokenRef:'r'}`; a `409` rejects with `TenantApiError.Status===409`.
- [ ] **Step 2: Run, verify fail.** `npm --prefix admin/tenant-portal test`.
- [ ] **Step 3: Implement** the DTOs/interface/nav member, the three client methods, and the fake routes.
- [ ] **Step 4: Run tests + `typecheck`, verify pass.**
- [ ] **Step 5: Commit** (tenant-types/fake LF; client/test CRLF — verify each).

---

### Task 5: `ServiceTokenRow` + `ServiceTokensViewModel`

**Files:**
- Create: `admin/tenant-portal/src/service-token-row.ts` (LF), `admin/tenant-portal/src/service-tokens-view-model.ts` (LF)
- Test: `admin/tenant-portal/tests/service-tokens-view-model.test.ts` (LF)

**Interfaces:**
- Consumes: `ITokensSource`, the token DTOs, `EnvironmentDto`, `TenantApiError` (Task 4); `Observable`; the B1-1 `users-access-view-model.ts` as the authoritative pattern (busy-counter, load-token, state enum, property keys, self-safe confirm, error routing — **read it**).
- Produces:
  - `ServiceTokenRow` (plain class): ctor `(dto: ServiceTokenSummaryDto)`; readonly `TokenRef`, `PrincipalId`, `ScopesText` (`scopes.join(', ')`), `ExpiresText` (`'Never'` when null, else the ISO string; keep formatting simple), `StatusText` (`'Revoked'` if revoked; else `'Expired'` if `expiresAt` non-null and in the past; else `'Active'`), `Revoked: boolean`. Static `FromDtos(dtos): ServiceTokenRow[]`.
  - `TokenDuration` enum (`OneHour`/`OneDay`/`ThirtyDays`/`Never`) + a `static` map to `expiresInSeconds` (`3600`/`86400`/`2592000`/`null`).
  - `ServiceTokensViewModel extends Observable` — ctor `(source: ITokensSource)` (no principal needed; issuing another principal's token is not self-lockout-sensitive). Property keys (`static readonly *Property`): Environments, SelectedEnvironment, Rows, Busy, Error, State, IssuedSecret, Pending. Getters: `Environments`, `SelectedEnvironment`, `Rows`, `Busy`, `Error`, `State` (`TokensState { Loading, Empty, Ready, Error, NoEnvironment }`), `IssuedSecret: TokenIssuedDto | undefined` (transient), `Pending: string | undefined` (tokenRef pending revoke-confirm). Draft fields: `DraftPrincipalId: string`, `DraftScopes: string`, `DraftDuration: TokenDuration`. Methods: `LoadEnvironments`, `SelectEnvironment(name)`, `LoadTokens`, `IssueToken` (parse `DraftScopes` → non-empty `string[]` by splitting on whitespace/commas; guard empty → set `Error`, no call; on success set `IssuedSecret`, clear draft scopes/principal, reload), `DismissSecret` (clears `IssuedSecret`), `RequestRevoke(tokenRef)` (sets `Pending`), `ConfirmPending`/`CancelPending` (revoke then reload / clear). Reuse B1-1's busy-counter + load-token + 401-rethrow error handling (`FailWith` rethrows only 401; all else → `Error`+`State=Error`).

- [ ] **Step 1: Write failing tests** against a fake `ITokensSource`: row mapping (scopes join; Never/Expired/Revoked/Active status); load populates rows; empty env list → `NoEnvironment`, no `ListTokens` call; `IssueToken` with blank scopes sets `Error` and does NOT call the source; successful issue sets `IssuedSecret`, clears the draft, reloads; `DismissSecret` clears it; `RequestRevoke`→`Pending`, `ConfirmPending` calls `RevokeToken` + reloads, `CancelPending` clears; a `TenantApiError(409)` on revoke sets `Error`, rows unchanged; a 401 rethrows; a non-API load error → `State=Error` (not stuck Loading).
- [ ] **Step 2: Run, verify fail.** **Step 3: Implement.** **Step 4: Run + typecheck, verify pass.** **Step 5: Commit** (LF).

---

### Task 6: `ServiceTokensView` (DataGrid + issue form + one-time reveal)

**Files:**
- Create: `admin/tenant-portal/src/service-tokens-view.ts` (LF)
- Test: `admin/tenant-portal/tests/service-tokens-view.test.ts` (LF)

**Interfaces:**
- Consumes: Task 5's VM (exact member names — **read the VM file**); `TenantViewBase`; `TextBox` (`@pragmatic-tech-ai/mural/basic`); `DataGrid`/`DataGridTextColumn`/`SelectionMode`/`GridLength`/`GridUnitType` (same subpath imports as B1-1); the B1-1 `users-access-view.ts` as the authoritative pattern (**read it** — grid-as-field built once, `Render()` teardown+re-add, `Act()` helper not `Run()`, `suppressSelection` guard, `get Grid()` seam, inline-confirm, no secret echo).
- Produces: `ServiceTokensView extends TenantViewBase` — ctor `(source: ITokensSource)`; `Refresh()` → `vm.LoadEnvironments()`; `get Grid(): DataGrid`; `Dispose()` → grid dispose + listener removal.
  - DataGrid columns (text): TokenRef `new GridLength(3, GridUnitType.Star)` `'TokenRef'`; Principal `new GridLength(2, Star)` `'PrincipalId'`; Scopes `new GridLength(3, Star)` `'ScopesText'`; Expires `GridLength.Auto` `'ExpiresText'`; Status `GridLength.Auto` `'StatusText'`.
  - Below-grid: a Revoke action on the selected row (inline confirm via `vm.Pending`/`RequestRevoke`/`ConfirmPending`/`CancelPending`).
  - Issue form: a principal `TextBox`, a scopes `TextBox` (placeholder e.g. "space-separated scopes"), a **duration preset button strip** over `TokenDuration` (click sets `vm.DraftDuration`, selected marked), and an Issue button that copies the box `.Text` into `vm.DraftPrincipalId`/`vm.DraftScopes` then `Act(() => vm.IssueToken())`. Build the form once as a field (reused TextBoxes can't re-parent), re-added each `Render()`, like B1-1.
  - **One-time reveal panel:** when `vm.IssuedSecret` is set, render a panel showing the `token` value once (in a read-only field or selectable `TextBlock`) plus the tokenRef/principal/expiry and a **Dismiss** button → `vm.DismissSecret()`. The secret is NOT put in the grid and NOT retained after Dismiss.
- Tests (B1-1 altitude; do NOT walk realized grid rows): grid configured/fed via `Grid` seam (5 columns + BindingPaths, `SelectionMode.Single`, `ItemsSource` mirrors rows); env picker + reload; issue form present, duration strip selects, Issue calls `source.IssueToken` with parsed scopes; the reveal panel shows the secret after issue; **after Dismiss the secret string appears in NO node, and it never appears in any grid `ItemsSource` row**; selecting a row + Revoke shows confirm and calls `RevokeToken`; loading/empty/error/NoEnvironment states render distinctly.

- [ ] **Step 1: Write failing view tests** (above). **Step 2: Run, verify fail.** **Step 3: Implement.** **Step 4: Run + typecheck, verify pass.** **Step 5: Commit** (LF).

---

### Task 7: Nav wiring

**Files:**
- Modify: `admin/tenant-portal/src/tenant-app.ts` (**CRLF**)
- Test: `admin/tenant-portal/tests/tenant-app.test.ts` (**CRLF**)

**Interfaces:**
- Consumes: Task 6's `ServiceTokensView`; `ITenantNavigator.ShowServiceTokens()` (Task 4); the existing top-bar/`Show` machinery and the B1-1 `UsersAccessLabel`/`ShowUsersAccess` wiring as the template.
- Produces: a `public static readonly ServiceTokensLabel`; a top-bar `MakeButton(ServiceTokensLabel, () => this.ShowServiceTokens())`; `ShowServiceTokens()` = `this.Show(new ServiceTokensView(this.client))`.

- [ ] **Step 1: Write failing tests** (extend `tenant-app.test.ts`): after `Boot()`, a `ServiceTokensLabel` top-bar button exists; clicking it makes `current` a `ServiceTokensView`. (If `FakeClient` lacks `ListTokens`, add a stub, as B1-1 did for `ListEnvironments`.)
- [ ] **Step 2: Run, verify fail.** **Step 3: Implement.** **Step 4: Run + typecheck + `typecheck:tools`, verify pass.** **Step 5: Commit** (CRLF — verify).

---

## Notes for the executor

- Wire contracts (`AdminProtocol.ListTokens/IssueToken/RevokeToken`) + the `IssueToken` proxy method already exist; Tasks 1–3 add the list/revoke proxy methods, the env-service methods, and the REST leaf. Server validation of issue params already exists at the JSON-RPC layer (`ParseIssueToken`); the REST layer re-validates body shape per Task 3.
- The `maker-token` route (`RouteEnvCredential`) is the closest existing precedent for issuing a token over REST (201 body); the grants-DELETE-with-body is the precedent for revoke-by-body.
- UI Tasks 4–7 mirror B1-1 (Users & Access) almost exactly; read those files rather than re-deriving the pattern. The tenant-portal EOL map is in Global Constraints — honor it per file.
- Final gates: control-plane suite, `npm --prefix admin/tenant-portal test`, `npm --prefix admin/tenant-portal run typecheck`, `npm run typecheck:tools`.
