# SP-HIVE-6b — IdP Provisioning API & Identity Claims (design)

**Status:** design, approved for autonomous execution (AFK run 2026-10-23). Re-scoped after a builder-check (ruling R5, §10). Rulings made in the user's absence are flagged in §10 for review.

**Consumes:** SP-HIVE-6a (the local OIDC Identity Provider under `src/idp/`). Continues the tenant identity realm.

## 1. Intent & the why

6a built a local OIDC **provider** (`pragmatic-idp`): realms, discovery/jwks/authorize/token, local-password login, confidential clients. But a live `pragmatic-idp` process today has **realms with zero accounts and zero clients** — `IdpRealm.SeedAccount` and `IdpClientStore.Register` are reachable only from tests and the gated smoke, never over any API. And 6a's id_token omits the `email`/`name` claims (an explicit 6a deferral).

6b delivers the **mechanism** that later provisioning will drive, plus the deferred claims:

1. The IdP emits `email` and `name` id_token claims.
2. The IdP gains an authenticated **admin API** (HTTPS) to ensure a realm, seed an account, and register a client — the surface SP-HIVE-7 (tenant-admin app) will call.
3. The control-plane gains a typed **`IdpAdminClient`** for that API.

6b stops at the mechanism. Actually wiring tenant-create/env-create to a *running, reachable* IdP — and the deployment topology, container networking, CA trust, environment→tenant binding, and admin-token sharing that requires — is **SP-HIVE-6c**, because those are architecture decisions that are the user's to make and are unsafe to ship unattended (see §9, §10 R5).

## 2. The three homes (unchanged from 6a)

`security-identity` (operator plane), `tenant-identity` (the IdP realm = human users, shared across a tenant's environments), `environment-identity` (per-environment machine/service scope, today's `src/tenancy`). 6b builds provisioning *into* `tenant-identity`; the federation of `environment-identity` up to it is 6c.

## 3. Goals / non-goals / anti-goals

**Goals**
- id_token `email` and `name` claims, on both the fresh-login and the SSO (cookie) authorize paths, consumable by the existing relying-party `ClaimsMapper`.
- An authenticated IdP **admin API** (HTTPS): ensure-realm, seed-account (with displayName), register-client — idempotent, fail-closed, secrets never echoed or logged.
- A typed control-plane **`IdpAdminClient`** that speaks that API over HTTPS with dev-CA trust and a bearer admin token.

**Non-goals (moved to SP-HIVE-6c — see §9)**
- Composing/launching a reachable platform IdP; control-plane config for its URL; sharing the admin token across the two processes.
- Wiring `CreateTenant` → seed Owner and `EnvironmentService.Create` → register client (incl. binding an environment to its platform tenant, which does not exist in code today).
- Container→IdP networking, served-app CA trust, in-container issuer/discovery host, the exact environment callback `redirectUri`.
- The `tenantId`→environment-id rename & data migration.
- Federation up to an upstream Entra/Google IdP; IdP HA / persistent stores / graceful shutdown (all 6a deferrals).

**Anti-goals**
- No raw secret or password ever in a log line, an error, a persisted record, or any response body. The admin API never echoes a client secret or a password.
- No change to upstream `todl-identity` (`LocalAccount`, `ILocalAccountStore`) — the display-name lives in an IdP-owned side-store (per the 6a one-repo principle).
- No unauthenticated surface on the IdP, and no admin surface that is open when unconfigured.

## 4. Decisions

1. **Admin API, not shared files.** Provisioning into the IdP goes over an HTTPS admin API; one writer (the IdP) owns realm state. (6c decides how the control-plane reaches it.)
2. **Reserved admin namespace.** Admin routes live under a reserved first path segment `_admin`, matched **before** the realm-existence guard in `RouteApi`. The IdP reserves the entire `_`-prefixed first-segment namespace: it rejects any realm key / tenantId beginning with `_` (ensure-realm → 400), so a realm can never shadow or be shadowed by the admin namespace.
3. **Admin endpoints & contracts (resolved).** All under `/_admin/`, HTTPS, JSON, `Cache-Control: no-store`:
   - `PUT /_admin/realms/<tenantId>` body `{ displayName }` → `200 { tenantId }` whether created or already present (idempotent).
   - `POST /_admin/realms/<tenantId>/accounts` body `{ email, principalId, displayName, password }` → `200 { principalId }`. Idempotent on principalId: a re-seed updates the side-store displayName, leaves email and secret unchanged, and does **not** rotate the password (no rotate flag in 6b). Never echoes the password.
   - `POST /_admin/realms/<tenantId>/clients` body `{ clientId, redirectUris, secret }` → `200 { clientId }`. Idempotent on clientId (re-register replaces redirectUris + secret hash). **Never echoes the secret.**
   - Validation failure (malformed body, empty field, bad redirectUri, `_`-prefixed realm) → `400 { error }` uniform.
   - Missing/invalid admin token → `401 { error: "unauthorized" }` uniform, no detail, realm existence not disclosed.
   - Admin API not configured (no admin token) → the `_admin` namespace is absent → `404` (same shape as any unknown path).
4. **Admin authn.** A single platform **admin bearer token**, loaded by the IdP from its own data dir by ref (new env `PRAGMATIC_IDP_ADMIN_TOKEN_REF`, resolved against the IdP's secret store), compared with `timingSafeEqual` over fixed-length digests. Fail-closed: no configured token ⇒ admin API disabled (404), never open. Security-core — adversarial review.
5. **On-demand realm creation.** `IdpAdminEndpoint` holds a realm **factory** `(tenantId, displayName) => Promise<IdpRealm>` closing over the same `realmRoot` + IdP `masterKey` that `idp-main` uses; `IdpRealmSet` gains `EnsureRealm(tenantId, factory)` (idempotent, returns the existing realm if present). This is how PUT-realm and the account/client routes obtain a realm without pre-registration.
6. **Two-sided client secret — the IdP half only.** 6b builds the half the API owns: `register-client` accepts a raw secret, stores only the argon2 `SecretHash` (via `IdpClientStore.Register`), and never returns it. The control-plane `IdpAdminClient` passes a caller-supplied secret through. *Generating* the secret, writing the raw half into an environment bundle by ref, and the Owner one-time-password reveal are 6c (they depend on the control-plane wiring).
7. **email claim.** Sourced from `LocalAccount.Email` (already stored) via `ILocalAccountStore.FindByPrincipalId`. Threaded from login through a new `AuthorizationCodeBinding.Email` into `TokenEndpoint` as the `email` claim.
8. **name claim.** `LocalAccount` has no display-name. The IdP realm owns a small **profile side-store** holding **only** `principalId → displayName` (email is never duplicated there), persisted under the realm's storage via `NodeFsStorage`. `SeedAccount` gains a `displayName` parameter; `IdpRealm.LookupProfile(principalId): Promise<{ email: string; name: string } | null>` reads email from the account store and name from the side-store. Threaded through `AuthorizationCodeBinding.Name` into the `name` claim.
9. **Claims on both authorize paths.** Fresh-login: the authenticated principal's id → `LookupProfile` → binding. SSO/cookie path (only `session.PrincipalId` available): same `LookupProfile(principalId)` so SSO-issued tokens carry identical claims. A principal with no profile row yields an empty `name` (claim still emitted as `""`), email always present.
10. **Idempotency.** ensure-realm, seed-account (by principalId), register-client (by clientId) are all idempotent and safe to retry; no duplicate, no error on re-run.

## 5. Architecture (files in 6b scope)

- **`src/idp/idp-admin-endpoint.ts`** (new): `IdpAdminEndpoint` — token verify, body parse/validate, dispatch to realm-ensure / seed-account / register-client; holds the realm factory and the `IdpClientStore`.
- **`src/idp/idp-host.ts`** (modify): `RouteApi` branches the reserved `_admin` segment before the realm guard; wires `IdpAdminEndpoint` only when present (constructor gains an optional admin endpoint).
- **`src/idp/idp-realm.ts`** (modify): `SeedAccount(email, principalId, displayName, password)`; profile side-store + `LookupProfile`; keep `SecretRefFor`.
- **`src/idp/idp-realm-set` / `IdpRealmSet` in `idp-host.ts`** (modify): `EnsureRealm(tenantId, factory)`.
- **`src/idp/authorization-code-store.ts`** (modify): `AuthorizationCodeBinding` gains `Email`, `Name`.
- **`src/idp/authorize-endpoint.ts`** (modify): populate `Email`/`Name` on the binding via `LookupProfile`, both paths.
- **`src/idp/token-endpoint.ts`** (modify): emit `email`, `name` claims from the binding.
- **`src/idp/idp-main.ts`** (modify): load the admin token by ref from the IdP data dir; build the realm factory; construct `IdpAdminEndpoint` when a token is configured; new env `PRAGMATIC_IDP_ADMIN_TOKEN_REF`.
- **`admin/control-plane/idp-admin-client.ts`** (new): `IdpAdminClient` — HTTPS client (injected `node:https` agent carrying the dev CA, bearer admin token), methods `EnsureRealm`, `SeedAccount`, `RegisterClient`; never logs secrets; surfaces typed errors without secret material.

## 6. The pinned contract (additions to 6a)

- Admin API HTTPS only, under `/_admin/`, JSON, `Cache-Control: no-store`; contracts exactly as §4.3.
- id_token now carries `email` (string, from `LocalAccount.Email`) and `name` (string, display name or `""`). The relying party already requests `openid email profile` and maps `email`.
- `register-client` keeps 6a's exact-string redirect allowlist.
- Realm keys may not begin with `_`.

## 7. Security

- Admin bearer token: by-ref load, fixed-length `timingSafeEqual`, fail-closed (unconfigured ⇒ 404), uniform 401, no existence disclosure.
- Client secret & password: the admin API stores only the argon2 hash and **never** echoes the raw value; no secret/password in any log line at any level, nor in any error or DTO.
- TLS: reuse 6a's dev-CA HTTPS; the `IdpAdminClient` trusts the CA via an injected `https.Agent`, not `NODE_EXTRA_CA_CERTS`.
- Reserved `_`-namespace prevents a realm from shadowing the admin routes.

## 8. Proof

- Unit tests: admin-endpoint authz (valid / missing / wrong token / disabled-when-unconfigured→404); each route's success + idempotent-hit + validation-400; `_`-prefixed realm rejected; realm factory / `EnsureRealm` idempotent; profile side-store + `LookupProfile` (present, missing-row→`""`, email-from-account); binding→claims threading in `TokenEndpoint`; `IdpAdminClient` round-trips against an in-process host and never logs/returns a secret.
- The gated two-environment **SSO smoke** (`admin/control-plane/idp-sso-smoke.ts`) is upgraded to construct an `IdpAdminEndpoint` with a test admin token and provision **through the `IdpAdminClient`/admin API** (ensure realm, seed Owner with displayName, register both clients) instead of the test-only direct store calls, and asserts the issued id_token now carries `email` (and `name`) on both a fresh login and an SSO-cookie login. A second host with no admin token proves the disabled→404 gate. The existing 6a negative gates remain.
- No Docker and no control-plane `CreateTenant`/`EnvironmentService` change is in 6b; those tests belong to 6c.

## 9. Deferred (file as GitHub Features on the user's go)

- **SP-HIVE-6c: IdP deployment, federation & tenant binding** (ruling R5) — compose/launch a reachable platform IdP; control-plane config for its admin URL; provision+share the admin token across the two processes; wire `CreateTenant` → ensure realm + seed Owner (one-time password reveal, `TenantRecord` owner metadata) and `EnvironmentService.Create` → generate the client secret, register the client, inject `generic-oidc` providerSettings + the raw secret by ref into the environment bundle; **bind an environment to its platform tenant** (no such plumbing exists today — `EnvironmentService.Create` does not know its platform tenant id); container→IdP networking, served-app CA trust, in-container issuer/discovery host, the exact callback `redirectUri`; enforce the `_`-reservation at `CreateTenant`. This slice rests on topology/architecture decisions that are the user's to make.
- **SP-HIVE-6c also carries the `tenantId`→environment-id rename & data migration** — ~465 sites/91 files touching on-disk layout, JSON keys, secret refs, env vars, the id_token issuer URL, and Redis flow-state prefixes; a data-migration + external-contract change needing its own migration path and the user present. (This is also what forces the realm-key-identity question the builder-check raised: today `tenantId` is the environment id, so "a realm shared across a tenant's environments" cannot be realized until an environment is bound to a distinct platform-tenant id.)
- Upstream `LocalAccount.DisplayName` (vs. the IdP side-store); admin-token rotation / multiple admin credentials; Owner password rotation API; upstream Entra/Google federation; IdP HA / persistent stores / graceful shutdown.

## 10. Rulings made in the user's absence (review on return)

- **R5 — re-split 6b after the builder-check.** The original 6b bundled the claims + admin-API mechanism (self-contained, fully testable) with live control-plane wiring + deployment topology + container federation + environment→tenant binding + the rename. The builder-check showed the second group has no implementable answer without architecture decisions that are the user's (where the IdP runs, how containers reach it over TLS, how an environment is bound to a platform tenant, how the admin token is shared) and is unsafe to ship unattended. Ruling: 6b ships the mechanism + claims; everything topology/wiring moves to **SP-HIVE-6c** with the user present. Cost if wrong: 6b delivers a provisioning API nothing in production calls yet — but SP-HIVE-7 needs exactly that API, and nothing is lost or broken (default behavior unchanged).
- **R1 — defer the rename** (now folded into 6c, unchanged reasoning): data-migration + external-contract change, 465 sites; unsafe unattended; cosmetic/reversible if left.
- **R2 — control-plane generates the secrets** (applies in 6c): generated control-plane-side, pushed to the IdP which stores only hashes; mirrors the hive one-time-token reveal.
- **R3 — display-name in an IdP side-store, not upstream** (in 6b): keeps 6b one-repo; email is never duplicated into the side-store (read from `LocalAccount`).
- **R4 — platform-level IdP multiplexing tenants** (settled in 6c): one IdP process, realms per tenant; the admin API shape built in 6b is topology-agnostic.

## 11. Relationship to the program

6b builds the API + claims. **SP-HIVE-6c** does deployment/federation/binding + the rename (needs the user). **SP-HIVE-7** (tenant-admin mural app) logs into the realm and drives this admin API. **SP-HIVE-5** (kind driver) is independent.
