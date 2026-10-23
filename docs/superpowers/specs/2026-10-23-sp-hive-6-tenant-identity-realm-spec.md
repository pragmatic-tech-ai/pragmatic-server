# SP-HIVE-6: Tenant Identity Realm (Local OIDC Identity Provider) — Design

**Program:** SP-HIVE (platform administration). Hierarchy: Client → Tenant → Hive → Environment → Application.
**Repo:** `pragmatic-server` (control plane in `admin/`, runtime in `src/`).
**Status:** design for approval. Nothing is built until this document is approved.
**Supersedes the placeholder in:** `docs/superpowers/specs/2026-10-22-platform-administration-hives-design.md` decision 4 ("Identity — PER TENANT") and decomposition item 6.

---

## 1. Intent and why

Today a human who uses two environments under the same tenant needs a separate account in each. The running server keys its identity realm by a string it *calls* `tenantId` but which is really the **per-environment scope key** (`src/tenancy/tenant-registry.ts` roots `<baseDir>/<tenantId>/identity` per environment, with its own `IdentityRuntime` and ownership lease). The platform `TenantRecord` — the real Client→Tenant level that owns many environments — carries no identity at all.

The program already decided the target (umbrella design, decision 4): **a client's user authenticates against one tenant-level account shared by every environment under the tenant.** Read literally — "**one** account shared by **every** environment" — that is single sign-on, not merely identical credentials copied into each environment.

SP-HIVE-6 delivers that as a **local identity provider**: a tenant-scoped OIDC issuer (a minimal local analog of Entra) that a tenant's environments federate to. A user logs in once at the tenant provider; every environment under the tenant trusts the token it issues. This is the prerequisite the umbrella design names for SP-HIVE-7 (the tenant-admin app logs into this realm) and for SP-HIVE-4's deferred self-service UI.

The relying-party half already exists and is **not** rebuilt: `environment-identity` is already an OIDC client (Authorization Code + PKCE, discovery, JWKS verification, Redis flow-state, callback→session). SP-HIVE-6 builds the **provider half** we lack and points the existing client at *our* issuer instead of Microsoft's.

## 2. The identity model — three homes, each named for what it is

The word "tenant" was doing three jobs. This design gives each its own name and place. The containment is: **security-identity** (the platform) over **tenant-identity** (a tenant's humans, one realm, SSO) over **environment-identity** (each environment's local principals).

| Home | What it is | Where it lives today | Change in SP-HIVE-6 |
|---|---|---|---|
| **security-identity** | The platform operator plane: operators who run SP-HIVE itself, plus the shared security primitives (auth methods, credentials, RBAC engine, `ResourceKind`) every realm is built from. | `admin/control-plane/operator-identity.ts` (`control-plane`/`admin` principal). | Named and documented as `security-identity`. **No behavior change.** |
| **tenant-identity** | A client's **human users**, one realm rooted on the platform `TenantRecord.id`, shared across every environment under the tenant via SSO. | Does not exist. | **Built: the local OIDC issuer + the tenant realm store.** |
| **environment-identity** | Each environment's **own** principals: service tokens, the rollout agent's machine credential, the workload identity, per-environment RBAC bindings. | `src/tenancy/` + `src/identity/IdentityModule`, where `tenantId` is really the environment-scope key. | The environment stops owning a human-login realm; it becomes an OIDC **relying party** of its tenant's provider. The `tenantId` misnomer is renamed to *environment id* **in the files this sub-project touches** (no big-bang sweep). Environment-local machine/service principals stay here. |

**The identity-package `Tenant` keeps its name.** The external todl-identity `Tenant` (`{Id, Kind, DisplayName}`) is already a pure realm primitive with zero process/storage coupling, and its stores already multiplex many tenants by id. A package-wide `Tenant`→`Realm` rename would be a ~260-site, 6-repo churn that buys nothing semantically. We keep the package untouched and name our scopes (`security-identity` / `tenant-identity` / `environment-identity`) at the **consumer layer** in `pragmatic-server`. This is the finding that makes SP-HIVE-6 a one-repo change, not the "substantial change into todl-identity" the umbrella design feared.

## 3. Goals / Non-goals / Anti-goals

**Goals**
1. A tenant-scoped OIDC identity provider (the "local Entra") that implements, as a real service, the exact contract the existing relying party speaks (§5).
2. A **tenant realm**: the human-account store (local-password accounts + role grants), tenant-keyed, owned by the IdP as its single writer, rooted on the platform `TenantRecord.id` — not nested inside any environment's storage root.
3. **True SSO**: a user logs in once at the tenant provider; a second environment under the same tenant admits them without re-entering credentials (the IdP's own session carries the single sign-on).
4. Environments federate: an environment is provisioned as an OIDC relying party of its tenant's provider, reusing the existing client path end-to-end.
5. The three homes named and bounded as in §2; the `tenantId`→environment-id rename applied to touched files.
6. Everything proven locally, dogfooded as tenant `pragmatic-dev` with one account and two environments.

**Non-goals (this sub-project)**
- Brokering **up** to real Entra/Google (the IdP acting as a federation proxy to an upstream IdP). Deferred.
- A DB-backed realm store for a multi-replica / HA IdP. The single-writer IdP uses the existing file-backed stores; DB-backing is deferred.
- Account **self-management** UI (create/reset/disable accounts). That is SP-HIVE-7's tenant-admin app; SP-HIVE-6 seeds the initial account and exposes no management surface.
- Refresh tokens, single-logout propagation, consent screens, dynamic client registration.
- Machine/mTLS federation through the tenant IdP (machine principals stay in environment-identity).
- A global rename sweep of `tenantId` across the codebase.

**Anti-goals (a failure even if it "works")**
- Any secret value (password, client secret, signing private key) stored in a record, DTO, log, or error message. References by **name** only, resolved server-side — the standing program rule.
- Collapsing the three homes back into one, or routing tenant-human login through the loopback-restricted operator (security-identity) plane.
- Accepting an id_token the issuer did not sign, or signing with an algorithm the relying party rejects (EdDSA): fail-closed on every verification boundary.
- Tearing down the shared tenant realm when one environment's ownership lease drops (the bug that exists if the realm is left inside the per-environment `PragmaticServer`/lease unit).

## 4. Decisions (calls made in this design; a builder follows these)

1. **The IdP is its own service, separate from the control-plane host.** The operator plane (security-identity) is loopback-restricted and operator-only; the tenant IdP is tenant-facing (humans log in) and must be reachable by environment pods. Mixing them violates the three-home boundary. New service, working name **`pragmatic-idp`** (a new `bin` + host in `pragmatic-server`, like `pragmatic-agentd` was a new bin in the existing image).
2. **One multi-tenant issuer, tenant-scoped realms.** A single IdP service serves all tenants; the tenant id appears in the issuer URL (e.g. `…/<tenantId>`), so `iss` is per-tenant and the account store is keyed per-tenant (the package already multiplexes). Per-tenant isolated IdP instances are a later hardening, not day one.
   **The tenant id that scopes the issuer URL, the realm root, and the account-store key is the real platform `TenantRecord.id` — never the runtime per-environment scope key.** An environment resolves its tenant via the control-plane `EnvironmentRecord.tenantId` (which references the real `TenantRecord`); that value feeds the issuer/realm/account key so every environment under the tenant shares one realm. Wiring the issuer to the runtime scope key would give each environment its own realm and silently defeat SSO — explicitly forbidden.
3. **One platform signing key for the walking skeleton.** RS256 (the relying party accepts RS256/ES256; RS256 matches the existing `FakeOidcIdp` reference). The private key is resolved by reference (file path / env), never stored in a record or logged; the public key is published at JWKS with a `kid`. Per-tenant keys and rotation automation are deferred.
4. **Accounts are local-password**, stored in the tenant realm (the package's tenant-keyed account store, file-backed, owned by the IdP). The IdP authenticates a login by checking the password against this store (reusing the package's local-password authenticator), then mints the OIDC code/token. Upstream federation (Entra/Google broker) deferred.
5. **The IdP keeps its own SSO session cookie.** First login renders a minimal login form and sets the IdP session cookie; subsequent `/authorize` hits with a valid IdP cookie skip the form and redirect straight back with a code. This cookie *is* the single sign-on.
6. **Minimal server-rendered login page** served by the IdP at `/authorize` — deliberately plain HTML. It is not the tenant-admin app (SP-HIVE-7); it is the IdP's own login surface.
7. **The realm is detached from the environment lease.** Because the realm now lives in the IdP (not the per-environment `PragmaticServer` DI container), a lost environment lease can no longer dispose it. Environment provisioning stops creating a per-environment human-login realm and instead writes OIDC relying-party config pointing at the tenant provider.
8. **Initial account seeded at tenant provisioning.** When a `TenantRecord` is created (or on first IdP use for that tenant), the realm is seeded with one Owner account; its initial password comes from a secret **reference** (same pattern as the operator password and `agentTokenRef`). Rotation/self-service is SP-HIVE-7.
9. **`tenantId`→environment-id rename is scoped to touched files** (`src/tenancy/*`, the `IdentityModule` wiring, their tests), consistent with the umbrella design's "no big-bang rename." Each renamed symbol gets its new home; call sites in untouched modules are left for when they are next touched.
10. **The IdP terminates HTTPS with a locally-minted certificate.** The relying party hard-fails on any non-`https` discovery/issuer/endpoint URL (`OidcDiscovery.RequireHttps`) and Node's TLS rejects an untrusted cert on the server-to-server token/JWKS/discovery fetches. So the IdP serves TLS with a self-signed dev CA minted at setup; that CA is trusted by the environment processes and the e2e client via `NODE_EXTRA_CA_CERTS`. A real/ACME certificate and a front-door TLS proxy are deferred. This is forced by the pinned contract, not optional.
11. **Clients are confidential (client-secret + PKCE).** The existing environment OIDC config shape (`file-tenant-provisioning.ts`) *requires* `clientSecretRef` (its parser throws on an absent/empty field), and that parser is out of this sub-project's touch set — so public/PKCE-only clients are not available without editing scoped-out code and are deferred. The dogfood uses confidential clients: at client registration a secret is generated once; its **plaintext** lands in the environment's secret store (resolved by `clientSecretRef`), its **hash** lands in the IdP client store (compared with `timingSafeEqual`). PKCE S256 is still enforced on top.
12. **The IdP is the sole writer of its realm and client stores; provisioning calls it, never writes its files.** To keep the single-writer guarantee across the process boundary, the IdP exposes a minimal internal admin surface — `seed tenant Owner account` and `register client` — called by control-plane provisioning (decisions 7 and 8). This admin surface is authenticated by the operator/security-identity plane (an operator credential or a bootstrap token), is loopback/cluster-internal only, and is distinct from the tenant-facing login endpoints. No component other than the IdP process opens its store files for writing.
13. **The IdP owns its own realm master key, distinct from the operator master key.** The reused file identity stores need a 32-byte master key (loaded-or-created by reference, as `operator-identity.ts` does per `identityRoot`). The IdP mints/loads its **own** key by reference; it does not share security-identity's operator key — sharing it would route tenant-human realm encryption through the operator plane, which the anti-goals forbid. Per-tenant realm keys are a later hardening.

## 5. The pinned IdP contract (the relying party already speaks this)

The issuer MUST satisfy, exactly, what `OidcAuthenticator` (in `todl-identity-cloud`) expects:

- **Flow:** Authorization Code + PKCE, `code_challenge_method=S256`, `response_type=code`. No implicit/hybrid.
- **Discovery:** served at `<issuer>/.well-known/openid-configuration`, returning exactly four fields, **all `https`**: `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri`. `userinfo_endpoint` is not read and is not required.
- **Authorization endpoint:** accepts `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`. Authenticates the user (login form or existing IdP SSO cookie), then **302 redirects to the registered `redirect_uri` with `?code=<code>&state=<state>`**. The authorization code is single-use and binds `{sub, nonce, code_challenge, redirect_uri, client_id}`.
- **Token endpoint:** accepts a **form-encoded** POST (`grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id`, and `client_secret` in the body for a confidential client). Validates the PKCE verifier against the stored challenge, the redirect_uri and client_id match, and the client secret if confidential. Returns JSON with an **`id_token`** (and a bare `access_token`; the relying party never calls userinfo and discards the access token).
- **id_token claims:** `iss` = the tenant issuer; `aud` = the client's `clientId`; `exp` valid within a 60s skew; `nonce` = the value from the authorization request; **`sub` present and non-empty** (becomes the principal id). Groups optional. `email`/`name` display claims are **deferred to SP-HIVE-6a is complete → SP-HIVE-6b** (see §9): reliably emitting them on both the login and cookie-SSO paths needs a realm-account read threaded into the token path, which 6b introduces; `name` additionally needs an account name field that does not exist in 6a. The pinned *rejection* criteria the relying party enforces are iss/aud/exp/nonce/sub only, all of which are emitted.
- **Signature:** **RS256** (RS256 or ES256 accepted; **EdDSA rejected**). JOSE header carries a `kid` that resolves in the published JWKS.
- **JWKS:** served at `jwks_uri` as `{ keys: [ { …RS256 public JWK, kid, use: "sig", alg: "RS256" } ] }`. Key rotation works if the new key is published here (the client cache-busts on `ERR_JWKS_NO_MATCHING_KEY` and retries once).

**Reuse:** mirror `todl-identity-cloud/src/testing/fake-oidc-idp.ts` (`DiscoveryDocument()`, `Jwks()`, `MintIdToken()` via `jose` `generateKeyPair`/`exportJWK`/`SignJWT`) as the reference for the discovery/JWKS/token surface; harden it into a real service (persistent realm store, PKCE enforcement, login + SSO cookie, confidential-client secret check, key by reference). Add `jose ^6` as a `pragmatic-server` dependency (it is already the signing library in `todl-identity-cloud`).

**Provider config an environment writes to federate** (the existing shape in `src/config/file-tenant-provisioning.ts`): `issuer`, `discoveryUrl`, `clientId`, `redirectUri`, `clientSecretRef` — all required by that parser (see decision 11; the dogfood uses confidential clients, so `clientSecretRef` always resolves). SP-HIVE-6 wires environment provisioning to emit this pointing at the tenant provider, with `redirectUri` = the environment's `/auth/oidc/callback`.

## 6. Architecture

**Components (all new unless noted):**
- **`pragmatic-idp` host** — the OIDC issuer service: discovery, JWKS, `/authorize` (login form + SSO cookie + code), `/token` (code+PKCE→id_token). Multi-tenant, routes by tenant id in the path. New `bin` in `pragmatic-server`.
- **Tenant realm** — the package's tenant-keyed account + role-grant stores (file-backed), rooted on `TenantRecord.id`, owned by the IdP as single writer. Seeded with one Owner account at tenant provisioning.
- **IdP signing key** — one RS256 keypair, private key by reference, public published at JWKS.
- **IdP SSO session store** — the IdP's own short-lived login session (cookie), the mechanism of single sign-on.
- **Client registration** — per-environment (or per-tenant) OIDC client records the IdP recognizes (`client_id`, allowed `redirect_uri`(s), confidential, `client_secret` **hash**). Minimal store, IdP-owned; registration happens via the IdP admin surface at environment provisioning (decision 12).
- **IdP admin surface (internal)** — two operator-authenticated, cluster-internal operations: seed a tenant's Owner account (decision 8) and register a client (decision 11). The only cross-process path into the IdP's stores; keeps the IdP the single writer.
- **TLS** — the IdP serves HTTPS with a self-signed dev CA minted at setup; the CA is trusted by environment processes and the e2e client via `NODE_EXTRA_CA_CERTS` (decision 10).
- **Environment relying-party wiring (existing, re-pointed)** — environment provisioning emits OIDC config at the tenant provider; the existing `/auth/oidc/begin`→IdP→`/auth/oidc/callback`→`MintSession` path is reused unchanged.
- **Rename** — `src/tenancy/*` + `IdentityModule` wiring: `tenantId`→environment id in touched files; environment-identity keeps machine/service principals.

**SSO sequence (two environments, one tenant):**
1. Browser → Env-A; Env-A 302→ IdP `/authorize?...redirect_uri=EnvA/auth/oidc/callback`.
2. IdP shows login form; user submits credentials; IdP checks the realm account store, sets its **SSO cookie**, 302→ `EnvA/auth/oidc/callback?code=&state=`.
3. Env-A server POSTs IdP `/token`; validates id_token (iss/aud/nonce/sub, RS256 via JWKS); mints Env-A's own opaque session.
4. Later, Browser → Env-B; Env-B 302→ IdP `/authorize...`. IdP sees the **valid SSO cookie**, skips the form, 302→ `EnvB/auth/oidc/callback?code=&state=` immediately.
5. Env-B mints its own session. **The user never re-entered credentials — that is the SSO.**

**Reachability contract (for the plan/e2e, not the identity logic):** the authorization endpoint must be **browser-reachable** and the token/discovery/JWKS endpoints **server-reachable from environment pods**. In the local dogfood these resolve to one base URL both the test browser and the environment containers can hit (host-mapped NodePort / port-forward / `host.docker.internal`); the plan chooses the concrete wiring, as prior SP-HIVE smokes did for in-cluster reachability. Front-channel/back-channel URL split is a deferred concern.

## 7. Security constraints (program-standing, restated)

- Passwords, client secrets, and the signing private key live server-side **by reference name**; never in a record, DTO, response body, log line, or error message.
- Every verification boundary is **fail-closed**: unknown client, bad redirect_uri, failed PKCE, bad/absent code, signature or claim mismatch → reject with no secret-bearing detail.
- Authorization codes and IdP login flow-state are **single-use and TTL-bound** (reuse the Redis flow-state pattern already in `redis-oidc-flow-state-store.ts` for IdP-side state).
- Client secrets stored as **hashes**, compared with `timingSafeEqual` (the `agentTokenHash` pattern).
- The IdP SSO cookie is HttpOnly, `SameSite` appropriate, `Secure` on https, and revocable.
- Login endpoints are rate-limitable and never reveal whether an account exists (uniform failure).

## 8. The proof (gated e2e, runs for real like prior SP-HIVE smokes)

Dogfood tenant `pragmatic-dev`, one seeded Owner account, two environments provisioned as relying parties of the tenant provider. A gated smoke drives the real relying-party endpoints and the real IdP over HTTP (cookie jar following redirects):
1. Env-A login flow completes end-to-end → Env-A session minted; id_token verified against the live JWKS.
2. Env-B login flow, carrying the IdP SSO cookie, completes **without** presenting credentials → Env-B session minted. (Assert: no login form was served the second time.)
3. Negative gates: tampered id_token signature rejected; replayed authorization code rejected; wrong `redirect_uri` rejected; absent/invalid PKCE verifier rejected.
Full in-cluster browser SSO (two environment pods on the live Docker Desktop cluster) is run if the reachability wiring lands cleanly; otherwise it is filed as an integration-smoke follow-up.

## 9. Deferred → filed as GitHub Project Features (Kind=Feature, Status=Todo)

- Broker **up** to real Entra/Google (tenant IdP as federation proxy to an upstream IdP).
- DB-backed realm store for a multi-replica / HA IdP.
- Account self-management (create/reset/disable) — folds into SP-HIVE-7's tenant-admin app.
- Refresh tokens; single-logout (RP-initiated + back-channel); consent screen.
- Per-tenant signing keys + automated rotation.
- Machine / mTLS federation through the tenant provider.
- Completing the `tenantId`→environment-id rename across modules not touched here.
- Front-channel/back-channel issuer URL split for cross-network deployments.
- **`email`/`name` (and other profile) id_token claims**, copied from the realm account — needs the realm plumbed into the token path (an account read by `sub`) and, for `name`, an account name field. Belongs with 6b's realm/provisioning plumbing; no consumer until SP-HIVE-7.
- A real/ACME certificate and front-door TLS proxy (replacing the self-signed dev CA of decision 10).
- Public / PKCE-only clients without a client secret (requires editing the `file-tenant-provisioning.ts` OIDC parser, scoped out here per decision 11).
- Per-tenant realm master keys (decision 13).

## 10. What is left to the builder

- Internal module/type names and file layout within `pragmatic-idp` and the realm wiring (follow repo OOP + Allman + no-inline-literals conventions).
- The concrete reachability wiring for the e2e (NodePort / port-forward / host mapping).
- The minimal login page markup.
- Exact test file placement (in `tests/` subfolders per repo convention) and which model tier each task/review runs on.
- Whether client registration is keyed per-environment or per-tenant+redirect-allowlist (either satisfies the contract; pick the simpler that passes the proof).

---

## 11. Sequencing — delivered in two plans

This design is delivered as two plans, each a working, testable slice, both arguing from this one spec:

- **SP-HIVE-6a — tenant IdP + SSO proof.** The issuer (discovery, JWKS, `/authorize` with login + SSO cookie, `/token`), the tenant realm store (IdP-owned, its own master key), the RS256 signing key, TLS with the self-signed dev CA, and the environment relying-party *wiring* — with the dogfood client and seed account **fixture-wired** by the e2e. Delivers the core value: log in once, both environments under the tenant trust the token. Proven by the §8 gated e2e.
- **SP-HIVE-6b — provisioning integration.** The IdP internal admin surface (seed Owner account, register client — decision 12), client registration driven at environment-create, the Owner-account seed driven at tenant-create (decision 8), confidential-secret two-sided provisioning (decision 11), and the `tenantId`→environment-id rename (decision 9). Turns 6a's fixture-wired proof into a feature driven by the normal provisioning path.

Everything in §§1–10 is in scope across the two; this section only says which plan carries which part. Each plan runs the program rhythm: `superpowers:writing-plans` → subagent-driven SDD → finish menu (the integration decision is the user's).

**Next step:** the SP-HIVE-6a plan.
