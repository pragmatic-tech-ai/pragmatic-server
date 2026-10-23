# SP-HIVE-6a: Tenant IdP + SSO Proof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tenant-scoped local OIDC identity provider (a minimal local Entra) and prove that two environments under one tenant achieve single sign-on against it.

**Architecture:** A new `pragmatic-server` service, `pragmatic-idp` (its own `bin`, HTTPS host mirroring `ControlPlaneHost`), serves a standards OIDC issuer per tenant: discovery, JWKS, `/authorize` (login form + IdP SSO cookie + single-use PKCE-bound authorization code), `/token` (code→RS256 id_token). It owns a tenant realm (the reused `FileIdentityStores` account/secret stores, keyed by the real `TenantRecord.id`, under its **own** master key) and verifies logins with the reused `LocalPasswordAuthenticator`. The relying-party half already exists in `AuthHttpEndpoint`→`OidcAuthenticator` and is **not modified** — the proof drives it against the new issuer. The dogfood client and seed account are fixture-wired by the e2e (provisioning integration is SP-HIVE-6b).

**Tech Stack:** TypeScript (ESM, `.js` import extensions), `node:http`/`node:https`, `jose ^6` (RS256 sign — already the signing lib in `todl-identity-cloud`), reused `@pragmatic-tech-ai/todl-identity*` store/authenticator primitives, `node:test` + `tsx`, `selfsigned` (new dependency, pure-JS dev-CA minting). OOP + Allman braces + PascalCase public members + no inline string literals (hoist to `private static readonly`).

**Spec:** `docs/superpowers/specs/2026-10-23-sp-hive-6-tenant-identity-realm-spec.md` (SP-HIVE-6a is §11's first slice; §§1–10 are the authority).

## Global Constraints

- **Three homes stay separate.** This is `tenant-identity`. It does not import or route through `admin/control-plane/operator-identity.ts` (`security-identity`), and it uses its **own** realm master key, never the operator key (spec decision 13, anti-goals).
- **Realm scope key = the real platform `TenantRecord.id`.** The issuer URL, realm store root, and account-store tenant key are all that id — never the runtime per-environment scope key (spec decision 2).
- **Secrets by reference only.** Passwords, client secrets, and the signing private key live server-side by reference/file; never in a record, DTO, response body, log line, or error message (spec §7, anti-goals).
- **Fail-closed at every verification boundary.** Unknown/absent client, disallowed `redirect_uri`, missing/mismatched PKCE, bad/absent/replayed code, signature or claim mismatch → reject with no secret-bearing detail (spec §7).
- **Pinned issuer contract (spec §5):** Authorization Code + PKCE `S256`; `response_type=code`; discovery returns exactly `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri`, all `https`, at `<issuer>/.well-known/openid-configuration`; id_token signed **RS256** with a `kid` resolvable in JWKS; claims `iss`=tenant issuer, `aud`=`clientId`, `exp` within 60s skew, `nonce` echoed, `sub` present and non-empty; token endpoint is form-encoded. Confidential clients (client secret in token POST body) + PKCE.
- **Tests live in `tests/` subfolders** next to the code (`src/idp/tests/<name>.test.ts`); unit tests run under `npx tsx --test "src/idp/tests/*.test.ts"`; the gated e2e lives in `admin/control-plane/` (outside the `src/**` glob) and runs via `npx tsx admin/control-plane/idp-sso-smoke.ts`.
- **Issuer URL shape:** `<baseUrl>/<tenantId>` where `<baseUrl>` is an `https` origin; endpoints are `<issuer>/authorize`, `<issuer>/token`, `<issuer>/jwks`, `<issuer>/.well-known/openid-configuration`.

## Review Focus

Inputs the spec implies but that are the most likely to bite, each pinned to the task that owns it:

1. **Open redirect** — `/authorize` accepting a `redirect_uri` not on the client's allowlist (Task 4 client store exact-match; Task 7 authorize rejects before issuing a code).
2. **PKCE downgrade** — `/authorize` accepting a missing/empty `code_challenge` or a non-`S256` method; `/token` accepting a verifier whose `sha256`/base64url ≠ stored challenge (Task 7 requires `S256` + non-empty challenge; Task 8 recomputes and compares).
3. **Authorization-code replay** — a code usable twice, or across a different client/redirect than it was issued to (Task 5 single-use atomic `Take`; Task 8 re-checks `clientId`+`redirectUri` against the binding).
4. **Token the real RP would reject** — wrong `iss`/`aud`, missing `nonce`, missing/empty `sub`, or an alg other than RS256/ES256 (Task 8 claim set + Task 1 RS256+kid; the Task 11 e2e verifies with the real `OidcAuthenticator`).
5. **Account enumeration** — login revealing whether an email exists (unknown email vs wrong password giving distinguishable results/timing) (Task 3 delegates to `LocalPasswordAuthenticator`, which dummy-verifies on miss and returns a uniform `"invalid email or password"`).

---

### Task 1: IdP signing key + JWKS

**Files:**
- Create: `src/idp/idp-signing-key.ts`
- Test: `src/idp/tests/idp-signing-key.test.ts`

**Interfaces:**
- Consumes: `jose` (`generateKeyPair`, `exportJWK`, `importPKCS8`/`exportPKCS8`, `SignJWT`).
- Produces: `class IdpSigningKey` with `public static async LoadOrCreate(privateKeyFile: string): Promise<IdpSigningKey>` (PEM PKCS8 at the ref; generate + persist mode `0o600` if absent), `public PublicJwks(): { keys: JWK[] }` (one RS256 JWK with `kid`, `alg:'RS256'`, `use:'sig'`), `public Kid(): string`, `public async Sign(claims: Record<string, unknown>): Promise<string>` (RS256, header `{alg:'RS256',kid}`, caller sets `iss`/`aud`/`sub`/`nonce`/`exp`/`iat`). `kid` derived deterministically from the public JWK thumbprint.

- [ ] **Step 1: Write the failing test** — `src/idp/tests/idp-signing-key.test.ts`:
  - `test('signs a token verifiable against its own JWKS')`: `LoadOrCreate` in a temp dir → `Sign({iss:'x',aud:'c',sub:'u'})` → verify with `jose.jwtVerify(token, createLocalJWKSet(key.PublicJwks()), {algorithms:['RS256']})` succeeds and payload round-trips.
  - `test('JWKS entry carries kid, alg RS256, use sig')`: `PublicJwks().keys[0]` has `kid === key.Kid()`, `alg==='RS256'`, `use==='sig'`.
  - `test('reload from the same file yields the same kid and public key')`: second `LoadOrCreate` on the same file → equal `Kid()` and equal JWKS.
- [ ] **Step 2: Run to verify it fails** — `npx tsx --test "src/idp/tests/idp-signing-key.test.ts"` → FAIL (module missing).
- [ ] **Step 3: Implement `IdpSigningKey`** in `src/idp/idp-signing-key.ts` — mirror `FakeOidcIdp`'s key handling (RS256, JWK `kid`/`alg`/`use=sig`), but persist the private key as PEM PKCS8 by reference; `kid` = `jose.calculateJwkThumbprint` of the public JWK.
- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit** — `feat(idp): RS256 signing key + JWKS`.

### Task 2: Authorization-code store

**Files:**
- Create: `src/idp/authorization-code-store.ts`
- Test: `src/idp/tests/authorization-code-store.test.ts`

**Interfaces:**
- Produces: `class AuthorizationCodeBinding` (ctor: `public readonly Sub`, `TenantId`, `ClientId`, `RedirectUri`, `Nonce`, `CodeChallenge: string`, `ExpiresAt: Date` — all `public readonly`). `interface IAuthorizationCodeStore { Issue(binding: AuthorizationCodeBinding): Promise<string>; Take(code: string): Promise<AuthorizationCodeBinding | null>; }`. `class InMemoryAuthorizationCodeStore implements IAuthorizationCodeStore` (ctor `(now: () => Date = () => new Date(), codeBytes = 32)`): `Issue` returns a `randomBytes(32).toString('base64url')` code, stores the binding; `Take` is single-use (delete-on-read) and returns `null` if absent or `ExpiresAt <= now`.

- [ ] **Step 1: Write the failing test**:
  - `test('a code can be taken exactly once')`: `Issue` → `Take` returns the binding; second `Take` → `null`.
  - `test('an expired code is not returned')`: binding with `ExpiresAt` in the past → `Take` → `null`.
  - `test('an unknown code returns null')`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the store (single-use via `Map.delete` after read, inside the same async turn so two concurrent `Take`s cannot both win).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(idp): single-use PKCE-bound authorization-code store`.

### Task 3: Tenant realm (accounts + login)

**Files:**
- Create: `src/idp/idp-realm.ts`
- Test: `src/idp/tests/idp-realm.test.ts`

**Interfaces:**
- Consumes: `FileIdentityStores.Open(storage, masterKey)` → `IdentityStoreSet`; `NodeFsStorage`; `Argon2PasswordHasher`; `LocalPasswordAuthenticator`; `Tenant`/`TenantKind`; `Credential`/`PresentedSecret`/`AuthMethod.Local`; `AuthenticatedResult`; `MasterKeyResolver` / the `LoadOrCreateKey` pattern from `operator-identity.ts`.
- Produces: `class IdpRealm` — `public static async OpenFor(realmRoot: string, tenantId: string, displayName: string, masterKey: Buffer): Promise<IdpRealm>` (opens `FileIdentityStores` at `join(realmRoot, tenantId)`, builds `new Tenant(tenantId, TenantKind.SelfHosted, displayName)`); `public async SeedAccount(email: string, principalId: string, password: string): Promise<void>` (hash via `Argon2PasswordHasher`, `Secrets.Put(ref, hash)`, `Accounts.CreateAccount(tenant, email, principalId, ref)` — secret ref name derived from `principalId`, never the password); `public async Authenticate(email: string, password: string): Promise<AuthenticatedResult | null>` (delegates to `LocalPasswordAuthenticator`; returns the `AuthenticatedResult` or `null`); `public TenantId(): string`. The realm's master key is the **IdP's own** (Global Constraints), distinct from the operator key.
- Decision carried from spec: realm root is keyed by the real `TenantRecord.id` passed as `tenantId`.

- [ ] **Step 1: Write the failing test** (temp realm dir, a freshly generated 32-byte master key):
  - `test('a seeded account authenticates with its password')`: `SeedAccount('a@t','p-1','pw')` → `Authenticate('a@t','pw')` returns an `AuthenticatedResult` whose `Principal.Id === 'p-1'` and `Principal.TenantId === tenantId`.
  - `test('a wrong password is rejected')`: `Authenticate('a@t','nope')` → `null`.
  - `test('an unknown email is rejected the same way (no enumeration)')`: `Authenticate('ghost@t','pw')` → `null` (and asserts the rejection path ran, i.e. not throwing/distinguishable).
  - `test('the stored secret is a hash, never the password')`: the on-disk secret store value for the ref does not contain the plaintext and begins with the argon2 prefix.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `IdpRealm`** composing the reused stores + authenticator; derive the secret ref from `principalId`; the password never appears in any field name, log, or error.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(idp): tenant realm over reused identity stores`.

### Task 4: Client registry + secret verification

**Files:**
- Create: `src/idp/idp-client-store.ts`
- Test: `src/idp/tests/idp-client-store.test.ts`

**Interfaces:**
- Consumes: `Argon2PasswordHasher` (hash the client secret); `node:crypto.timingSafeEqual` is not needed directly — argon2 `Verify` is already constant-time-ish and uniform; use it for the secret check to match the password path. (If a non-argon2 scheme is chosen, it MUST compare with `timingSafeEqual` over fixed-length digests.)
- Produces: `class OidcClient` (ctor `public readonly ClientId`, `TenantId`, `RedirectUris: readonly string[]`, `SecretHash: string`); `class IdpClientStore` — `public async Register(tenantId: string, clientId: string, redirectUris: readonly string[], secret: string): Promise<void>`, `public Find(tenantId: string, clientId: string): OidcClient | undefined`, `public async VerifySecret(tenantId: string, clientId: string, presented: string): Promise<boolean>` (uniform false on unknown client — dummy-verify to avoid client enumeration), `public RedirectAllowed(tenantId: string, clientId: string, redirectUri: string): boolean` (exact-match against the allowlist). In-memory for 6a (fixture-seeded); interface shape allows a persistent impl in 6b.

- [ ] **Step 1: Write the failing test**:
  - `test('a registered client verifies its secret')`.
  - `test('a wrong client secret is rejected')`.
  - `test('an unknown client verifies false without throwing')`.
  - `test('redirect_uri must match the allowlist exactly')`: registered `https://e/cb` → `RedirectAllowed(...,'https://e/cb')` true; `'https://e/cb/../evil'`, `'https://e/cb?x=1'`, `'https://evil/cb'` all false.
  - `test('the stored client secret is a hash, not the secret')`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** `IdpClientStore` (argon2 hash at register; uniform verify; exact-string redirect match — no prefix/substring matching).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(idp): confidential client registry with allowlisted redirects`.

### Task 5: IdP SSO session (the single-sign-on cookie)

**Files:**
- Create: `src/idp/idp-sso-session.ts`
- Test: `src/idp/tests/idp-sso-session.test.ts`

**Interfaces:**
- Produces: `class IdpSsoSession` (ctor `public readonly PrincipalId`, `TenantId`, `ExpiresAt: Date`); `class IdpSsoSessionStore` — `public Issue(principalId: string, tenantId: string): { Id: string; session: IdpSsoSession }` (opaque `randomBytes(32).base64url` id, server-side record, TTL), `public Validate(id: string, tenantId: string): IdpSsoSession | null` (null if absent/expired/mismatched tenant), `public Revoke(id: string): void`. Plus `class IdpSsoCookie` — `public static Build(id: string, expiresAt: Date, secure: boolean): string` (`idp_sso=<id>; HttpOnly; SameSite=Lax; Path=/; Secure?; Expires=…`) and `public static Read(cookieHeader: string | undefined): string | undefined`. `SameSite=Lax` (not Strict) so a cross-site top-level redirect from an environment carries the cookie. Store keeps only the id→record map; the id is the secret.

- [ ] **Step 1: Write the failing test**:
  - `test('an issued session validates for its tenant')` and `test('it does not validate for a different tenant')`.
  - `test('an expired session is invalid')`; `test('a revoked session is invalid')`.
  - `test('the cookie is HttpOnly, Path=/, SameSite=Lax, Secure when asked')` and round-trips through `Read`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the session store + cookie builder/reader.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(idp): IdP SSO session + cookie`.

### Task 6: Dev-CA TLS material

**Files:**
- Create: `src/idp/dev-ca.ts`
- Modify: `package.json` (add `selfsigned` dependency)
- Test: `src/idp/tests/dev-ca.test.ts`

**Interfaces:**
- Consumes: `selfsigned` (pure-JS X.509 self-signing, Windows-safe — no openssl/native dep).
- Produces: `class DevCa` — `public static EnsureAt(dir: string, host: string): { certFile: string; keyFile: string; caFile: string }` (mint a CA + a server cert with `subjectAltName` DNS=`host` and `IP=127.0.0.1` into `dir` if absent, mode `0o600`; idempotent reuse if present); `class IdpTlsMaterial` — `public static Load(ref: { certFile: string; keyFile: string }): { key: Buffer; cert: Buffer }` (mirrors `MachineTls` file-ref loading, **server cert only — no `requestCert`**, since the IdP does not do client-cert auth). The `caFile` path is what environments/tests add to `NODE_EXTRA_CA_CERTS`.

- [ ] **Step 1: Write the failing test**:
  - `test('mints a CA and server cert, idempotently')`: `EnsureAt` in a temp dir creates the three files; a second call returns the same paths without regenerating (same bytes).
  - `test('the server cert validates against the minted CA')`: load cert + CA, assert `tls.checkServerIdentity`/a `TLSSocket` handshake using the CA as trust root accepts the host (or assert the cert chain verifies via `crypto.X509Certificate.verify(caPublicKey)`).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `DevCa`/`IdpTlsMaterial`** with `selfsigned`; SAN includes the IdP host and `127.0.0.1`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(idp): dev CA + TLS material loader`.

### Task 7: IdP host — discovery + JWKS over HTTPS

**Files:**
- Create: `src/idp/idp-host.ts`
- Test: `src/idp/tests/idp-host-discovery.test.ts`

**Interfaces:**
- Consumes: `node:https` `createServer`, Task 1 (`IdpSigningKey`), Task 6 (`IdpTlsMaterial`), the `ControlPlaneHost` dispatch/`WriteJson` shape to mirror.
- Produces: `class IdpHost` — ctor `(baseUrl: string, signingKey: IdpSigningKey, realms: IdpRealmSet, clients: IdpClientStore, codes: IAuthorizationCodeStore, sso: IdpSsoSessionStore, flowStates: IOidcFlowStateStore, tls: { key: Buffer; cert: Buffer }, secureCookie: boolean)`; `public Listen(port: number, host: string): Promise<void>` (HTTPS); `public async Close(): Promise<void>`; `public Address(): { address: string; port: number }`; `private async Handle(req, res)` dispatch; `private WriteJson(res, status, body)`. Routing parses `/<tenantId>/<rest>`; this task serves `GET /<tenant>/.well-known/openid-configuration` → `{ issuer, authorization_endpoint, token_endpoint, jwks_uri }` (all `<baseUrl>/<tenant>…`, all `https`) and `GET /<tenant>/jwks` → `signingKey.PublicJwks()`. `IdpRealmSet` = `{ For(tenantId): IdpRealm | undefined }` (a small tenant→realm map; opened lazily or injected). Unknown tenant/path → 404 JSON (no detail leak). `baseUrl` MUST be `https`.
- Produces for later tasks: the `Handle` router with slots for `/authorize` (Task 8) and `/token` (Task 9).

- [ ] **Step 1: Write the failing test** (construct `IdpHost` with a fixture signing key + a one-tenant realm set; invoke the discovery/jwks handlers — either via a real HTTPS `Listen` + a CA-trusting client, or by calling a testable `RouteApi(path)` seam):
  - `test('discovery returns exactly the four https fields for the tenant')`: keys are precisely `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri`; each starts with `https://` and contains `/<tenantId>`.
  - `test('jwks serves the signing public key')`: `keys[0].kid === signingKey.Kid()`.
  - `test('an unknown tenant discovery path is 404')`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `IdpHost`** mirroring `ControlPlaneHost` (plain-looking `Handle`, `WriteJson`), on `https.createServer({key,cert})`. Factor a `RouteApi(req,res,path)` so handlers are unit-testable without a socket.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(idp): HTTPS host serving OIDC discovery + JWKS`.

### Task 8: `/authorize` — login, SSO cookie, PKCE-bound code

**Files:**
- Modify: `src/idp/idp-host.ts` (add the `/authorize` route + a minimal login page)
- Create: `src/idp/authorize-endpoint.ts` (the request logic, so it is unit-testable)
- Test: `src/idp/tests/authorize-endpoint.test.ts`

**Interfaces:**
- Consumes: Tasks 2 (codes), 3 (realm), 4 (clients), 5 (sso).
- Produces: `class AuthorizeEndpoint` — `public async HandleGet(tenantId, query: URLSearchParams, cookieHeader): Promise<AuthorizeResult>` and `public async HandlePost(tenantId, query, cookieHeader, form: URLSearchParams): Promise<AuthorizeResult>`. `AuthorizeResult` is one of: `{ kind:'redirect'; location; setCookie? }` (back to `redirect_uri?code=&state=`), `{ kind:'loginPage'; html }`, `{ kind:'error'; status; body }`. Validation order (all fail-closed, before any code is issued): `response_type==='code'`; client exists for tenant; `redirect_uri` on the client allowlist (exact); `code_challenge` non-empty **and** `code_challenge_method==='S256'`; `state` and `nonce` present. On a valid GET with a valid `idp_sso` cookie → issue code bound to `{sub,tenantId,clientId,redirectUri,nonce,codeChallenge,exp}`, redirect. On a valid GET without a cookie → `loginPage`. On POST with credentials → `IdpRealm.Authenticate`; success → `sso.Issue` + set cookie + issue code + redirect; failure → `loginPage` with a uniform error (no enumeration). Error responses never echo back an unvalidated `redirect_uri`.
- Hoist the login-page HTML to a `private static readonly` template constant.

- [ ] **Step 1: Write the failing test**:
  - `test('unknown client is rejected without issuing a code')` and `test('a redirect_uri off the allowlist is rejected')`.
  - `test('a missing or non-S256 code_challenge is rejected')`.
  - `test('valid authorize with no SSO cookie returns the login page')`.
  - `test('valid credentials set the SSO cookie and redirect with code and state')`: result is `redirect`, `location` is `redirectUri?code=<c>&state=<s>`, `setCookie` present; the issued code is takeable from the code store and binds the authenticated `sub` + the request's `nonce`/`codeChallenge`.
  - `test('a valid SSO cookie skips the login page and redirects with a code')`: `HandleGet` with a cookie from a prior `sso.Issue` → `redirect`, no login page served.
  - `test('bad credentials return the login page with a uniform error, no code issued')`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `AuthorizeEndpoint`** and wire `GET`/`POST /<tenant>/authorize` in `IdpHost` (parse form bodies; set cookie via `IdpSsoCookie.Build`).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(idp): authorize endpoint with login, SSO cookie, PKCE-bound code`.

### Task 9: `/token` — authorization-code → RS256 id_token

**Files:**
- Modify: `src/idp/idp-host.ts` (add the `/token` route)
- Create: `src/idp/token-endpoint.ts`
- Test: `src/idp/tests/token-endpoint.test.ts`

**Interfaces:**
- Consumes: Tasks 1 (sign), 2 (codes), 4 (client secret verify). PKCE check: `createHash('sha256').update(code_verifier).digest('base64url') === binding.CodeChallenge`.
- Produces: `class TokenEndpoint` — `public async Handle(tenantId, form: URLSearchParams): Promise<{ status: number; body: object }>`. Requires form fields `grant_type==='authorization_code'`, `code`, `code_verifier`, `redirect_uri`, `client_id`, `client_secret`. Steps (all fail-closed): verify client secret (Task 4); `codes.Take(code)` → reject if null (covers replay + expiry); binding `clientId`/`redirectUri` MUST equal the posted `client_id`/`redirect_uri`; PKCE verifier recompute matches `CodeChallenge`; then mint id_token via `signingKey.Sign({ iss:'<baseUrl>/<tenant>', aud:clientId, sub:binding.Sub, nonce:binding.Nonce, email, name, iat, exp })` (claims copied from the realm account; `exp` = now + 300s). Response body `{ id_token, access_token: <opaque random>, token_type:'Bearer', expires_in:300 }`. Any failure → `{ status:400, body:{ error:'invalid_grant' } }` (or `invalid_client` for the secret), no secret-bearing detail.

- [ ] **Step 1: Write the failing test** (seed a realm account, register a confidential client, issue a code via the code store with a known challenge):
  - `test('valid code + verifier + secret mints an id_token that verifies against JWKS with the required claims')`: `jose.jwtVerify` with `issuer`/`audience`/`algorithms:['RS256']` succeeds; `sub` non-empty, `nonce` echoed.
  - `test('a replayed code is rejected')`: second `Handle` with the same code → 400.
  - `test('a wrong PKCE verifier is rejected')`.
  - `test('a client_id or redirect_uri not matching the code binding is rejected')`.
  - `test('a wrong client secret is rejected')`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `TokenEndpoint`** + wire `POST /<tenant>/token` (form-encoded parse) in `IdpHost`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `feat(idp): token endpoint minting RS256 id_tokens`.

### Task 10: Service assembly — `pragmatic-idp` bin + Main

**Files:**
- Create: `src/idp/idp-main.ts`, `src/bin/pragmatic-idpd.ts`
- Modify: `package.json` (`bin` += `"pragmatic-idp": "dist/bin/pragmatic-idpd.js"`)
- Test: `src/idp/tests/idp-main.test.ts`

**Interfaces:**
- Consumes: all prior tasks; the `server.ts` env-driven `Main()`/`IsEntryPoint()` pattern.
- Produces: `class IdpMain` — `public static async Run(): Promise<void>` reading env: `PRAGMATIC_IDP_PORT` (default e.g. 7100), `PRAGMATIC_IDP_BASE_URL` (the `https` origin, required), `PRAGMATIC_IDP_HOST` (default `127.0.0.1`), `PRAGMATIC_IDP_DATA` (default `<dir>/data`; holds `signing-key.pem`, `tls/`, `realms/`), `PRAGMATIC_IDP_SECURE_COOKIE`. It `DevCa.EnsureAt` (local), `IdpSigningKey.LoadOrCreate`, builds the realm set + in-memory client/code/sso/flow stores, constructs `IdpHost`, and listens over HTTPS. `public static IsEntryPoint(): boolean`. `src/bin/pragmatic-idpd.ts` = `import '../identity/../idp/idp-main.js'` (one-line re-export matching the other bins; file tail runs `IdpMain.Run().catch(...)`).
- Note: the in-memory client/code/sso stores mean 6a runs a single instance (spec: HA/Redis-backed deferred). Account + client seeding is the e2e's job in 6a (6b drives it from provisioning).

- [ ] **Step 1: Write the failing test**:
  - `test('IsEntryPoint is false when imported')`.
  - `test('Run binds HTTPS and serves discovery for a configured tenant')`: set env to a temp data dir + a test base URL + port 0-style ephemeral; start `Run` (or a testable `Compose`→`Listen` seam), fetch `<base>/<tenant>/.well-known/openid-configuration` with the dev CA trusted, assert the four fields. Tear down.
  - (If `Run` is awkward to test directly, extract `IdpMain.Compose(env): Promise<IdpHost>` and test that.)
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `IdpMain`** + the bin + the `package.json` bin entry.
- [ ] **Step 4: Run to verify it passes**, and `npm run typecheck:tools` + `tsc -p tsconfig.build.json --noEmit` clean.
- [ ] **Step 5: Commit** — `feat(idp): pragmatic-idp service assembly + bin`.

### Task 11: SSO end-to-end proof (gated smoke)

**Files:**
- Create: `admin/control-plane/idp-sso-smoke.ts`

**Interfaces:**
- Consumes: the running `IdpHost` (HTTPS, dev CA), and the **real** relying-party verifier `OidcAuthenticator` (constructed per the recon signatures: `OidcAuthenticatorOptions` with a real HTTPS `IHttpClient`, `OidcDiscovery`, `JwksCache`, an `IOidcFlowStateStore`, `ClaimsMapper`, an `IdentityConfig`, and an `OidcResolvedConfig` whose `Issuer`/`DiscoveryUrl`/`ClientId`/`RedirectUri` point at the IdP). Set `process.env.NODE_EXTRA_CA_CERTS` to the dev CA before constructing HTTPS clients.
- Produces: `class IdpSsoSmoke` with `public static async Main()` and the `IsEntryPoint()` entry guard + `PassTag`/`FailTag` console reporting (mirror `rollout-push-smoke.ts`). Not part of `tsx --test`; run via `npx tsx admin/control-plane/idp-sso-smoke.ts`.

**Scenario (one tenant `pragmatic-dev`, one seeded account, two registered clients `env-a`/`env-b` with distinct redirect URIs):**
- [ ] **Step 1: Stand up** the IdP over HTTPS with the dev CA; seed the realm account; register both confidential clients.
- [ ] **Step 2: Environment A login** — drive the full flow with one HTTPS cookie jar (the simulated browser): GET the client-A authorize URL (built like `AuthorizationRequest.Build`) → receive the login page → POST credentials → follow the 302 to `redirect_uri?code=&state=` → hand `code`+`state` to the **real** `OidcAuthenticator.Authenticate` for client A → assert an `AuthenticatedResult` whose `Principal.Id` is the seeded `sub`. Assert the IdP set an `idp_sso` cookie.
- [ ] **Step 3: Environment B SSO** — reusing the **same** cookie jar, GET the client-B authorize URL → assert **no login page is served** (the response is a 302 straight to client-B's `redirect_uri?code=&state=`) → hand to the real `OidcAuthenticator` for client B → assert an `AuthenticatedResult` with the **same** `Principal.Id`. This is the single-sign-on proof.
- [ ] **Step 4: Negative gates** — assert each is rejected: a tampered id_token (flip a byte → `OidcAuthenticator` rejects on signature), a replayed authorization code (second `/token` → `invalid_grant`), a `redirect_uri` off client A's allowlist (authorize rejects, no code), and a bad PKCE verifier (token rejects). Report each with `PassTag`.
- [ ] **Step 5: Report + exit** — print a one-line pass summary; non-zero exit on any failure. Tear down the IdP and temp dirs in a `finally`.
- [ ] **Step 6: Run it for real** — `npx tsx admin/control-plane/idp-sso-smoke.ts` → all gates pass. Commit — `test(idp): gated two-environment SSO smoke`.

---

## Self-Review

**1. Spec coverage.** Issuer contract §5 → Tasks 1,7,8,9. Tenant realm keyed by `TenantRecord.id` §2/decision 2 → Task 3 (+ Global Constraints). IdP own master key decision 13 → Task 3. Confidential clients decision 11 → Task 4,9. Single-writer / fixture seeding for 6a §11 → Tasks 3,4 seeded by Task 11 (admin API is 6b). SSO cookie decision 5 → Task 5,8. TLS decision 10 → Task 6,7,10. Own service decision 1 → Task 10. SSO proof §8 → Task 11. The `tenantId` rename (decision 9) and provisioning integration are **SP-HIVE-6b**, correctly absent here.

**2. Step scan.** Each code step names a signature and a file; bodies are left to the implementer except where a formula is load-bearing (PKCE `sha256`/base64url, id_token claim set), which are stated as one-liners, not transcribed functions. No "handle edge cases" placeholders.

**3. Type consistency.** `AuthorizationCodeBinding` fields (Task 2) are consumed identically in Tasks 8 (issue) and 9 (take/compare). `IdpRealm.Authenticate → AuthenticatedResult` (Task 3) is what Task 8 consumes. `IdpSigningKey.Sign`/`PublicJwks`/`Kid` (Task 1) are consumed in Tasks 7,9. `IOidcFlowStateStore` is the RP-side store used only in the Task 11 harness, not by the IdP itself (the IdP uses its own code + SSO stores) — intentional, noted so no task tries to share them.

**4. Review Focus.** Open redirect → Task 4/7 tests; PKCE downgrade → Task 7/8 tests; code replay → Task 2/9 tests; RP-rejectable token → Task 9 tests + Task 11 real-verifier gate; enumeration → Task 3/4 tests. All five pinned.

**5. Proportion.** 11 tasks for a full OIDC issuer + realm + TLS + the live SSO proof; plan is signatures/test-names, not code bodies. In line with the spec's size and the SP-HIVE cadence.

---

**Execution handoff:** Plan complete. The program's established method is subagent-driven SDD (fresh implementer + task review per task, whole-branch review on the most capable model at the end), then the finish menu with the integration decision left to the user.
