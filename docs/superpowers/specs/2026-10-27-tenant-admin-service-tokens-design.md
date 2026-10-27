# Tenant-Admin "Service Tokens" — list / issue / revoke (SP-ADMIN B1-2) — Design

**Status:** design
**Date:** 2026-10-27
**Repo:** `pragmatic-server` (server control-plane + `admin/tenant-portal`). Branch off `master`.
**Program:** Backlog Program 2 → SP-ADMIN → Spec B → B1 (tenant-admin identity UI). Second B1 slice after B1-1 (Users & Access), merged-local @add9890.
**Builds on:** the B1-1 house pattern (imperative Mural view + `Observable` VM, accounts `DataGrid`) and the existing identity-admin REST surface in `admin/control-plane/tenant-api/tenant-api-endpoint.ts`.

## Intent

Let a tenant operator manage an environment's **service tokens** from the tenant portal: see the live tokens (reference, principal, scopes, expiry, revoked) in a table, **issue** a new token (shown exactly once), and **revoke** one. The JSON-RPC `AdminProtocol` already has `ListTokens`/`IssueToken`/`RevokeToken`; this slice exposes them over the per-environment `/tenant-api/.../admin/tokens` REST surface the portal speaks, wires the identity-engine path through `AdminProxy`/`EnvironmentService`, and adds the UI — with the hard rule that the secret token value appears exactly once, at issuance, and nowhere else.

## Goals

- **Server:** a `tokens` leaf on the per-environment admin REST surface —
  - `GET  /tenant-api/environments/:name/admin/tokens` → `ServiceTokenSummaryDto[]` (secret-free).
  - `POST /tenant-api/environments/:name/admin/tokens` body `IssueTokenParams` → `201` `TokenIssuedDto` (the one and only place the secret `token` is returned), with `Cache-Control: no-store`.
  - `DELETE /tenant-api/environments/:name/admin/tokens` body `{ tokenRef }` → `200 { ok: true }`.
- **Plumbing:** add `ListTokens`/`RevokeToken` to `IAdminConnection`/`IAdminProxy`/`AdminProxy`/`WsAdminConnection` (the wire contracts and `IssueToken` proxy method already exist), and `AdminListTokens`/`AdminIssueToken`/`AdminRevokeToken` to `IEnvironmentService`/`EnvironmentService` and the fakes (`loop-orchestrator`, tests).
- **Error mapping:** map the engine's `AdminTokenNotFoundError` ("service token not found") in `AdminProxy.Classify` to a not-found kind so a stale/already-revoked `tokenRef` returns **404**, not the generic 500.
- **UI:** a `TokensView` + `TokensViewModel` reached from a new top-bar entry, environment-scoped (matching B1-1): a tokens `DataGrid`; an **issue** form (principal, scopes, a preset-duration picker); a **one-time secret reveal** panel after issue (copyable, dismissable, never re-rendered); a **revoke** action with inline confirm; loading/empty/error states.
- **Security:** the secret is returned once (201 only), never logged / persisted raw / placed in an error body (server already complies); `Cache-Control: no-store` on the issue response; the UI holds the secret only in transient view state, shows it once, clears it on dismiss, and never writes it into a persisted or re-rendered node. The list and the grid show summary fields only.

## Non-goals / anti-goals (this spec)

- **Scope catalog** — there is no server list of valid scopes; the issue form takes free-text scopes (space/comma-separated → `string[]`, at least one required). → a scope catalog is a deferred Project **Feature** (sibling of the B1-3 concept/field-catalog gap).
- **The `LocalAccountNotFoundError` → 404 mapping gap** (same `Classify` gap as tokens, surfaced in recon) — out of scope here; → deferred Project **Feature**.
- **Token rotation / editing** — the model is issue-new + revoke-old; no in-place edit.
- **Cross-environment token aggregation** — env-scoped, consistent with B1-1's R1 (the committed full-tenant view comes after the env-scoped slices).
- **Showing the secret after issuance** — impossible by construction (the server never returns it again); the UI must not cache it.

## Rulings

- **R1 — revoke by body, not path tail.** `DELETE .../admin/tokens` carries `{ tokenRef }` in the body, mirroring the existing grants-DELETE-with-body. *Why:* a `tokenRef` is `tenantId/svctok/<hash>` and contains `/`; a path tail would require `%2F` encoding and risks host/`decodeURIComponent` double-decoding. *Cost if wrong:* switch to an encoded path tail (`.../tokens/:encodedRef`) — a localized change if a body-on-DELETE proves awkward.
- **R2 — reuse the existing secret-free list DTO.** `ServiceTokenSummaryDto { tokenRef; principalId; scopes; expiresAt; revoked }` already exists and has no `token` field; list returns it verbatim. *Cost if wrong:* n/a — it is exactly the needed shape.
- **R3 — map token-not-found → 404.** Add a `Classify` text match for "service token not found" (+ a not-found kind handled in `WriteIdentityError`). *Why:* revoking a token another operator already revoked should read as 404, not a scary 500. *Cost if wrong:* a stale revoke shows the generic 500 message instead; functionally harmless.
- **R4 — issue form: free-text scopes + preset-duration strip.** Scopes are a text field (≥1 required); expiry is a button strip of presets → `expiresInSeconds` (1 hour `3600`, 24 hours `86400`, 30 days `2592000`, Never `null`), matching the portal's no-ComboBox house pattern. *Cost if wrong:* a scope catalog / custom duration is an additive later change.
- **R5 — one-time secret reveal.** After a successful issue, the view shows the returned `token` once in a transient reveal panel (with a copy affordance and a Dismiss that clears it); the token lives only in VM transient state, is never put in the tokens grid, never re-rendered after dismiss, and never persisted. *Cost if wrong:* if the panel leaked the secret into a durable node that would be a security defect — pinned by a test.
- **R6 — env-scoped, top-bar entry.** A **Service Tokens** top-bar nav entry + the same environment picker as B1-1; `ITenantNavigator` gains `ShowServiceTokens()`. *Cost if wrong:* consistent with B1-1; a tenant-wide view is the later aggregation slice.

## Architecture

**Server (control-plane + protocol-proxy):**

| Layer | Change |
|---|---|
| `admin/control-plane/admin-proxy.ts` | Add `ListTokens`/`RevokeToken` to `IAdminConnection` + `IAdminProxy` + `AdminProxy` (`With(info, conn => conn.X(...))`) + `WsAdminConnection` (`sendRequest(AdminProtocol.ListTokens/RevokeToken, ...)`). Add `Classify` match for "service token not found" → not-found kind. |
| `admin/control-plane/control-plane-host.ts` + `environment-service.ts` | Add `AdminListTokens(name)`, `AdminIssueToken(name, params)`, `AdminRevokeToken(name, tokenRef)` to `IEnvironmentService` + `EnvironmentService` (each `AdminInfoFor(name)` → `proxy.X(info, …)`), and to the fakes in `loop-orchestrator.ts` + tests. |
| `admin/control-plane/tenant-api/tenant-api-endpoint.ts` | Add `TokensLeaf = 'tokens'` to `AdminPathPattern`; in `DispatchAdmin` route GET(no tail)→list, POST(no tail)→issue (201 + `Cache-Control: no-store`), DELETE(no tail, body `{tokenRef}`)→revoke. Reuse `ReadObject`/`NonEmpty`/`WriteJson`/`WriteIdentityError`. |
| `WriteIdentityError` | Handle the new not-found kind → 404. |

Ownership/auth is unchanged: `OwnedEnv` + `TenantAuthGate` already gate every admin leaf (cross-tenant/unknown → 404, never 403); RBAC = `administer` (Owner/Admin) at the engine.

**UI (`admin/tenant-portal/src/`):** mirrors B1-1 exactly.

| File | Role |
|---|---|
| `service-token-row.ts` | `ServiceTokenRow` (plain class) — `TokenRef`, `PrincipalId`, `ScopesText`, `ExpiresText`, `StatusText` (Active/Revoked/Expired), from `ServiceTokenSummaryDto`. |
| `service-tokens-view-model.ts` | `ServiceTokensViewModel extends Observable` — env list+selection, token rows, busy/error/state, issue-draft (principal, scopes text, selected duration preset), transient issued-secret, revoke pending/confirm; `LoadEnvironments`/`SelectEnvironment`/`LoadTokens`/`IssueToken`/`DismissSecret`/`RequestRevoke`/`ConfirmPending`/`CancelPending`. Consumes `ITokensSource`. Reuses B1-1's busy-counter + load-token + self-safe patterns. |
| `service-tokens-view.ts` | `ServiceTokensView extends TenantViewBase` — env picker strip, tokens `DataGrid` (text columns TokenRef/Principal/Scopes/Expires/Status + a below-grid Revoke on the selected row with confirm), issue form (principal `TextBox`, scopes `TextBox`, duration preset button strip, Issue button), and the one-time secret reveal panel. `get Grid()` test seam; `Dispose()` releases grid + listener. |
| `tenant-api-client.ts` | `ListTokens(env)`, `IssueToken(env, params)`, `RevokeToken(env, tokenRef)` via `Send<T>` + a `/admin/tokens` leaf; declare `implements ITokensSource`. |
| `tenant-types.ts` | `ServiceTokenSummaryDto`, `IssueTokenParams`, `TokenIssuedDto`, `RevokeTokenParams`, `ITokensSource`; `ITenantNavigator.ShowServiceTokens()`. |
| `tenant-app.ts` | **Service Tokens** top-bar entry + `ShowServiceTokens()` (constructs `ServiceTokensView(this.client, …)`). |
| `tests/fake-tenant-control-plane.ts` | `/admin/tokens` GET/POST/DELETE routes for e2e. |

## Trust-boundary / security UX

- The secret `token` is in the `POST` 201 response only; the server adds `Cache-Control: no-store`, never logs it, never puts it in an error body (verified: generic error bodies, audit excludes token, store keys by `sha256`). The `tokenRef` embeds the token's hash — not the secret, it is the revoke handle — and may be displayed.
- UI: the issued secret is held only in VM transient state, rendered once in the reveal panel, cleared on Dismiss, never written to the grid or any persisted node, never re-shown. A test asserts the secret appears in no node after Dismiss and is absent from the tokens grid.
- Errors are the backend's fixed generic strings surfaced verbatim; `401` → `ShowError` → `ShowLogin` (base); `409` RBAC; `404` unknown token / cross-tenant; `503` engine unavailable.

## Testing

- **Server:** `admin/control-plane/tests/` — table-driven route tests mirroring `tenant-identity-admin.test.ts` (each new route calls the right `EnvironmentService` method for the owning tenant; cross-tenant → 404 with no service call; bad/oversized bodies → 400; a service throw → fixed generic status/body with no inner text); `admin-proxy.test.ts` cases for `ListTokens`/`RevokeToken` (opens once/disposes once; `Classify` token-not-found → 404). The `GET tokens` list returns the summary DTOs and NO `token` field; the `POST` issue returns the token once and sets `Cache-Control: no-store`.
- **UI:** `tsx --test` VM tests against a fake `ITokensSource` (load/issue/revoke/dismiss/self states) and view tests at the B1-1 altitude (grid configured/fed via the `Grid` seam; chrome/states/flows via the `Fixtures` walker; the secret-never-rendered-after-dismiss assertion; revoke confirm). Extend the e2e fake with the routes.
- Gates: `npm --prefix admin/tenant-portal test` + `typecheck`; the control-plane test command (confirm how the ~769-test suite is invoked — likely `npx tsx --test admin/control-plane/tests/*.test.ts`); `npm run typecheck:tools`. LF for new files; match pre-existing CRLF (the tenant-portal EOL map from B1-1 applies). Secret-handling conventions above.

## Left to the plan

Exact new method signatures on `IAdminConnection`/`IAdminProxy`/`IEnvironmentService`/`TenantApiClient`/`ITokensSource`; the `Classify` not-found kind name + `WriteIdentityError` wiring; the preset-duration constants home; the reveal-panel control shape (copy affordance); the DataGrid column widths; and task decomposition (likely: proxy methods+Classify → env-service methods+fakes → REST routes+tests → client+DTOs+fake → VM+row → view+DataGrid+reveal → nav wiring).
