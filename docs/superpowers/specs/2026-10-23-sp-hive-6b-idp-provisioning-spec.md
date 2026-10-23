# SP-HIVE-6b — IdP Provisioning Integration (design)

**Status:** design, approved for autonomous execution (AFK run 2026-10-23). Rulings made in the user's absence are flagged in §10 for review.

**Consumes:** SP-HIVE-6a (the local OIDC Identity Provider under `src/idp/`). Continues the tenant identity realm.

## 1. Intent & the why

6a built a local OIDC **provider** (`pragmatic-idp`): realms, discovery/jwks/authorize/token, local-password login, confidential clients. But a live `pragmatic-idp` process today has **realms with zero accounts and zero clients** — `IdpRealm.SeedAccount` and `IdpClientStore.Register` are reachable only from tests and the gated smoke, never wired into provisioning. So no human can actually log in and no environment can actually federate.

6b closes that gap: it wires the platform's existing provisioning flows (tenant-create, environment-create in `admin/control-plane/`) to the IdP so that creating a tenant seeds its Owner login and creating an environment registers that environment as an OIDC client of the tenant's realm. After 6b, the author→deploy→serve loop has a real, SSO-capable human login backed by the tenant realm.

The control-plane and the IdP are **separate processes** (control-plane host vs. the `pragmatic-idp` bin), so provisioning crosses a process boundary: 6b adds an authenticated **admin API** on the IdP that the control-plane calls.

## 2. The three homes (unchanged from 6a)

`security-identity` (operator plane), `tenant-identity` (the IdP realm = human users, shared across a tenant's environments), `environment-identity` (per-environment machine/service scope, today's `src/tenancy`). 6b provisions into `tenant-identity` and wires `environment-identity` to federate to it.

## 3. Goals / non-goals / anti-goals

**Goals**
- An authenticated IdP **admin API** (HTTPS) to ensure a realm, seed an account, and register a client.
- **Tenant-create** seeds the tenant realm's **Owner** login account (one-time password reveal).
- **Environment-create** registers the environment as an OIDC **client** of the tenant realm and injects the relying-party config + secret into the environment bundle, so the served app federates to the realm for SSO.
- **Two-sided confidential-secret provisioning**: one generated secret, argon2 hash on the IdP, raw secret by ref in the environment — never logged, never in a DTO or error.
- **id_token `email` and `name` claims** emitted (the 6a deferral), consumable by the existing relying-party `ClaimsMapper`.

**Non-goals**
- The `tenantId`→environment-id rename (deferred — §10, ruling R1; filed as future SP-HIVE-6c).
- Federation up to an upstream Entra/Google IdP (6a deferral, still out).
- HA / persistent-backed IdP stores, graceful shutdown (6a deferrals, still out).
- A tenant-admin UI to manage users/clients (that is SP-HIVE-7's surface; 6b exposes the API it will call).

**Anti-goals**
- No raw secret or password ever written to a log line, an error message, a persisted record, or a response body except the single intended one-time reveal (with `Cache-Control: no-store`).
- No change to upstream `todl-identity` (`LocalAccount`, `ILocalAccountStore`) — the display-name is held in an IdP-owned side-store, not by widening the upstream account (per the 6a one-repo principle).
- No new unauthenticated surface on the IdP.

## 4. Decisions

1. **Admin API, not shared files.** Control-plane → IdP provisioning goes over an HTTPS admin API, not by both processes writing the same `realms/` files. One writer (the IdP) owns realm state.
2. **Reserved admin namespace.** Admin routes live under a reserved first path segment `_admin`, matched **before** the realm-existence guard in `RouteApi`. Realm keys (tenantIds) may not equal the reserved segment; the IdP rejects a realm named `_admin`.
3. **Admin endpoints.** `PUT /_admin/realms/<tenantId>` (ensure realm exists; idempotent); `POST /_admin/realms/<tenantId>/accounts` (seed/ensure an account: email, principalId, displayName, password — idempotent on principalId); `POST /_admin/realms/<tenantId>/clients` (register a confidential client: clientId, redirectUris, secret — idempotent on clientId). Mutating, JSON bodies, `Cache-Control: no-store`.
4. **Admin authn.** A single platform **admin bearer token**, held by the IdP server-side by ref (loaded from its data dir / `ISecretStore`, never an env-var plaintext), compared with `timingSafeEqual`. Missing/wrong token → `401` with a uniform body, no detail. Fail-closed: if the IdP has no admin token configured, the admin API is disabled (404), never open. Security-core — adversarial review.
5. **Two-sided client secret.** The **control-plane generates** the client secret once (`randomBytes`), POSTs it raw to `POST /_admin/.../clients` (the IdP stores only the argon2 `SecretHash` via `IdpClientStore.Register`), and writes the raw secret into the environment bundle's provisioned secrets keyed `oidc-secret/<environmentName>`, surfaced as `OidcSettingKeys.SecretRef` in the environment's `IdentityConfig.ProviderSettings`. The secret is held in memory only across that one call and never logged.
6. **Owner password.** The control-plane generates the Owner password once, POSTs it to `POST /_admin/.../accounts`, and returns it **once** in the `CreateTenant` HTTP response (`{ owner: { email, principalId, password } }`, `Cache-Control: no-store`), mirroring the existing hive one-time-token reveal. The IdP stores only the argon2 hash; the control-plane persists only non-secret owner metadata (email, principalId) on the `TenantRecord`.
7. **Owner identity vs. grant.** 6b seeds the Owner **login** in the tenant realm (`tenant-identity`). The environment-side authorization grant (`Role.Owner` on `ResourceKind.Tenant`) already exists via `ServerBootstrap.SeedAsync`/`EnsureOwnerGrantAsync` and is unchanged; 6b aligns the bootstrap admin principalId/email with the realm Owner so the same human maps across.
8. **email claim.** Sourced from `LocalAccount.Email` (already stored). Threaded from login through a new `AuthorizationCodeBinding.Email` into `TokenEndpoint` as the `email` claim.
9. **name claim.** `LocalAccount` has no display-name. The IdP realm owns a small **profile side-store** (principalId → displayName) under the realm's storage; `SeedAccount` gains a `displayName`; a realm lookup returns `{ email, name }` by principalId. Threaded through `AuthorizationCodeBinding.Name` into the `name` claim. No upstream package change.
10. **Claims recovery on the SSO path.** The authorize GET/SSO path has only `session.PrincipalId`; it recovers `{ email, name }` via `IdpRealm.LookupProfile(principalId)` to populate the binding, so SSO-issued tokens carry the same claims as fresh-login tokens.
11. **IdP topology.** The IdP is a platform-level process multiplexing tenants via realms. The control-plane learns the IdP admin base URL and admin-token ref from config (new control-plane settings), defaulting to the local dev IdP. The issuer injected into each environment is `<idpBaseUrl>/<tenantId>`.
12. **Idempotency everywhere.** Re-running tenant-create or env-create (or a retried admin call) must not error or duplicate: ensure-realm, seed-account (by principalId), register-client (by clientId) are all idempotent; re-seeding an existing account does not rotate its password unless explicitly asked.

## 5. Architecture

- **`src/idp/idp-admin-endpoint.ts`** (new): `IdpAdminEndpoint` — parses/authorizes admin requests, dispatches to realm/client provisioning. Holds the admin-token verifier.
- **`src/idp/idp-host.ts`** (modify): `RouteApi` branches the reserved `_admin` segment before the realm guard; wires `IdpAdminEndpoint`. Admin routing only present when an admin token is configured.
- **`src/idp/idp-realm.ts`** (modify): add `displayName` to `SeedAccount`; add the profile side-store + `LookupProfile(principalId): Promise<{ email, name } | null>`; `IdpRealmSet` gains the ability to create a realm on demand for ensure-realm.
- **`src/idp/idp-main.ts`** (modify): load the admin token by ref from the IdP data dir; construct `IdpAdminEndpoint`; new env `PRAGMATIC_IDP_ADMIN_TOKEN_REF` (admin API disabled when absent).
- **`src/idp/authorize-endpoint.ts` / `token-endpoint.ts` / `authorization-code-store.ts`** (modify): carry `Email`/`Name` on the binding; emit `email`/`name` claims.
- **`admin/control-plane/idp-admin-client.ts`** (new): `IdpAdminClient` — the control-plane's HTTPS client for the admin API (carries the dev CA like the smoke's client; bearer admin token; never logs secrets).
- **`admin/control-plane/platform-directory.ts`** (modify): `CreateTenant` ensures the realm + seeds the Owner; returns the one-time Owner password.
- **`admin/control-plane/environment-service.ts`** (modify): `Create` registers the environment's OIDC client and injects RP config/secret into the bundle.
- **`environments/seed/bundle.ts`** (modify): `WriteTenantConfig` emits `generic-oidc` providerSettings; `WriteSecrets` emits the client secret by ref.
- **Control-plane config** (modify): IdP admin base URL + admin-token ref settings.

## 6. The pinned contract (additions to 6a)

- Admin API is HTTPS only, under `/_admin/`. Bodies are JSON; responses `Cache-Control: no-store`.
- `register-client` redirectUris must be the exact environment callback URL(s); the IdP keeps the 6a exact-allowlist match.
- Injected RP config keys (unchanged names from `OidcSettingKeys`): `issuer`, `discoveryUrl`, `clientId`, `redirectUri`, `secretRef`. Pack id `generic-oidc`.
- id_token now carries `email` (string) and `name` (string) in addition to the 6a claims. Scopes `openid email profile` are already requested by the relying party.

## 7. Security

- Admin bearer token: by-ref load, `timingSafeEqual`, fail-closed (no token ⇒ API disabled, never open), uniform `401`.
- Two-sided secret & owner password: generated once, argon2 hash on the IdP, raw by-ref on the environment / single one-time reveal; never logged, never in a DTO/record/error. The only raw-secret response body is the one-time Owner reveal; register-client never echoes the secret.
- TLS: reuse 6a's dev-CA HTTPS; the control-plane admin client trusts the CA via an injected `node:https` agent (as the smoke does), not `NODE_EXTRA_CA_CERTS`.
- No secret or password in any log line at any level.
- Admin API mutations are idempotent and authenticated; an unauthenticated caller learns nothing (uniform 401; realm existence not disclosed).

## 8. Proof

- Unit tests per new/changed unit (admin endpoint authz incl. missing/wrong token and disabled-when-unconfigured; realm profile side-store + LookupProfile; binding/claims threading; idempotent provisioning; IdpAdminClient).
- The gated two-environment **SSO smoke** (`admin/control-plane/idp-sso-smoke.ts`) is upgraded to provision **through the admin API** (ensure realm, seed Owner, register both environment clients) instead of calling the test-only stores directly, and asserts the issued id_token now carries the `email` claim (and `name`). Negative gates: bad/missing admin token → 401; admin API disabled when no token configured → 404; the existing 6a negative gates remain.
- Control-plane integration test: `CreateTenant` returns a one-time Owner password and the IdP realm then authenticates it; `EnvironmentService.Create` yields a bundle whose `tenant-config.json` carries `generic-oidc` providerSettings and whose provisioned secrets carry the client secret by ref.

## 9. Deferred (file as GitHub Features on the user's go)

- **SP-HIVE-6c: `tenantId`→environment-id rename & data migration** (ruling R1) — the environment-scope key rename across ~465 sites/91 files; touches on-disk layout, JSON keys, secret refs, env vars, the id_token issuer URL, and Redis flow-state prefixes. A data-migration + external-contract change; needs its own spec, a migration path, and the user present. Not shipped in the AFK run.
- Upstream `LocalAccount.DisplayName` (vs. the IdP side-store) — revisit if the name is needed beyond the token.
- Admin-token rotation; multiple admin tokens / per-caller credentials.
- Owner password rotation API.
- Upstream Entra/Google federation (6a deferral).
- IdP HA / persistent stores / graceful shutdown (6a deferrals).

## 10. Rulings made in the user's absence (review on return)

- **R1 — defer the rename.** The summary listed the `tenantId`→environment-id rename inside 6b. Recon showed it is a data-migration + external-contract change (on-disk layout, env vars, issuer URLs, Redis keys; 465 sites). Shipping that unattended risks breaking existing environments and the 6a relying-party issuer contract. Ruling: **defer** to its own sub-project (SP-HIVE-6c) with the user present. Cost if wrong: the code keeps the known `tenantId`-means-environment ambiguity a while longer — cosmetic, fully reversible.
- **R2 — control-plane generates the secrets.** Both the client secret and the Owner password are generated control-plane-side and pushed to the IdP (which stores only hashes), mirroring the existing hive one-time-token reveal, rather than the IdP generating and returning them. Simpler orchestration; symmetric two-sided write. Cost if wrong: a reshuffle of which process calls `randomBytes` — contained.
- **R3 — display-name in an IdP side-store, not upstream.** Keeps 6b a one-repo change per the 6a principle. Cost if wrong: a later migration to a first-class upstream field.
- **R4 — platform-level IdP multiplexing tenants.** One IdP process serves all tenants via realms; the control-plane holds its admin URL/token by config. Cost if wrong: a topology change (per-tenant IdP) later — the admin API shape is unaffected.

## 11. Relationship to the program

6b consumes 6a and unblocks **SP-HIVE-7** (the Tenant Admin mural app logs into this realm and will call this admin API to manage users/clients). The rename becomes **SP-HIVE-6c**. **SP-HIVE-5** (kind driver) is independent.
