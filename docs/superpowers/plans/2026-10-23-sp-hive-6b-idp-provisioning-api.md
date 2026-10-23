# SP-HIVE-6b — IdP Provisioning API & Identity Claims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the local IdP an authenticated admin API (ensure-realm / seed-account / register-client), a typed control-plane client for it, and `email`/`name` id_token claims — the self-contained mechanism SP-HIVE-7 will drive.

**Architecture:** New `IdpAdminEndpoint` served under a reserved `/_admin/` namespace (matched before the realm guard, fail-closed, bearer-token authed). `IdpRealm` gains a display-name profile side-store and `LookupProfile`; the authorize→code→token path carries `email`/`name` so the token emits them. A new `IdpAdminClient` speaks the admin API over HTTPS with dev-CA trust. No control-plane wiring, no Docker, no deployment — those are SP-HIVE-6c.

**Tech Stack:** TypeScript (ESM, Node ≥22.5, explicit `.js` imports), `node:test`+`tsx`, `node:https`/`node:http`, `node:crypto` (`timingSafeEqual`, `randomBytes`, `createHash`), `jose` ^6 (existing), `@pragmatic-tech-ai/todl-identity` (`ILocalAccountStore.FindByPrincipalId`, `LocalAccount.Email`), `Argon2PasswordHasher` (`todl-identity-local`).

**Spec:** `docs/superpowers/specs/2026-10-23-sp-hive-6b-idp-provisioning-spec.md`

## Global Constraints

- OOP only: behavior on classes; no module-level free functions or mutable module state; module-level `const` for true constants/types only. Allman braces. PascalCase for interfaces and public methods.
- No inline string literals for reused/user-facing strings or registration/serialization keys — hoist to `private static readonly` constants (route segments, claim names, header names, error codes, env-var names, file names).
- **No secret or password in any log line, error message, persisted record, or response body.** The admin API never echoes a client secret or a password. The `IdpAdminClient` never logs request bodies.
- Admin API is HTTPS only, under `/_admin/`; JSON bodies; every admin response carries `Cache-Control: no-store`.
- Admin authn fail-closed: no configured admin token ⇒ the `_admin` namespace is absent ⇒ 404. Token compare via `timingSafeEqual` over fixed-length SHA-256 digests (never compare raw strings; never let a length mismatch throw).
- Realm keys may not begin with `_` (reserves the admin/system namespace); reject at realm creation.
- No change to upstream `todl-identity` types. The display name lives only in the IdP side-store; email is read from `LocalAccount`, never duplicated.
- Tests live in `tests/` subfolders. IdP unit tests: `npx tsx --test "src/idp/tests/*.test.ts"`. Gated smoke (needs `openssl`): `npx tsx admin/control-plane/idp-sso-smoke.ts`. Build: `npm run build` (`tsc -p tsconfig.build.json`). Tools/admin typecheck: `npm run typecheck:tools`. Do not run `npm install` (breaks workspace symlinks).
- Commit after each task. Each task ends green on its own tests.

## Review Focus

- **Admin-token compare robustness:** a presented token of a different length than the configured one must yield 401, not a thrown `RangeError` from `timingSafeEqual` — Task 6 hashes both sides to equal length first and tests the length-mismatch case.
- **Malformed / oversized admin body:** invalid JSON → 400; a body over the 16 KB POST cap → 413 (reuse 6a's cap) — Task 7 tests both on an admin route.
- **Reserved / traversal realm keys:** a realm key `_admin`, any `_`-prefixed key, or one containing `/`/`..` must be rejected (400) before any filesystem realm is created — Task 5 tests the rejection; Task 6 maps it to 400.
- **SSO path with no profile row:** an SSO-cookie login for a principal with no display-name row still issues a token with `email` present and `name` as `""` — Task 3 tests the SSO path, Task 1 tests the missing-row lookup.
- **Secret/password leakage:** neither the admin endpoint's success/error bodies nor the `IdpAdminClient`'s thrown errors contain the client secret or the password — Task 6 and Task 9 assert absence explicitly.

---

### Task 1: Realm display-name profile side-store + idempotent SeedAccount + LookupProfile

**Files:**
- Modify: `src/idp/idp-realm.ts`
- Test: `src/idp/tests/idp-realm.test.ts`

**Interfaces:**
- Consumes (from `@pragmatic-tech-ai/todl-identity`): `ILocalAccountStore.FindByPrincipalId(tenant, principalId): Promise<LocalAccount | null>` (confirmed to exist), `LocalAccount.Email`, `ILocalAccountStore.CreateAccount`, `ISecretStore.Put`, `Argon2PasswordHasher.Hash`.
- Produces: `IdpRealm.SeedAccount(email: string, principalId: string, password: string, displayName?: string): Promise<void>` (idempotent on principalId; `displayName` appended as optional trailing param so no existing 3-arg call site breaks — a deliberate deviation from the spec's prose ordering, chosen to keep this task self-contained); `IdpRealm.LookupProfile(principalId: string): Promise<{ email: string; name: string } | null>`. The profile side-store persists `principalId → displayName` as JSON under the realm's own directory (follow the realm's existing storage pattern; email is NOT stored here).

- [ ] **Step 1: Write failing tests** in `idp-realm.test.ts`:
  - `test('SeedAccount is idempotent on principalId and does not rotate the password')` — seed; authenticate OK; re-seed same principalId with a different password; original password still authenticates, new one does not.
  - `test('SeedAccount stores the display name; LookupProfile returns account email and side-store name')` — seed with displayName; `LookupProfile(principalId)` deep-equals `{ email, name: displayName }`.
  - `test('LookupProfile returns an empty name when the account has no profile row')` — create an account whose profile row is absent (seed without displayName); `name === ''`, `email` present.
  - `test('LookupProfile returns null for an unknown principal')`.
- [ ] **Step 2:** Run `npx tsx --test "src/idp/tests/idp-realm.test.ts"` — expect FAIL (new behavior/signature absent).
- [ ] **Step 3:** Implement. `SeedAccount`: if `FindByPrincipalId` returns an account, update only the side-store display name (when `displayName` given) and return; else hash→`Secrets.Put(SecretRefFor(principalId))`→`CreateAccount`, then side-store `Put(principalId, displayName ?? '')`. `LookupProfile`: `FindByPrincipalId`; null→null; else `{ email: account.Email, name: sideStore.Get(principalId) ?? '' }`. Add a private side-store class persisting a `{ [principalId]: displayName }` JSON doc under the realm dir.
- [ ] **Step 4:** Run the test — expect PASS.
- [ ] **Step 5:** Commit `feat(idp): realm display-name profile side-store, idempotent SeedAccount, LookupProfile`.

### Task 2: AuthorizationCodeBinding carries Email and Name

**Files:**
- Modify: `src/idp/authorization-code-store.ts`
- Test: `src/idp/tests/authorization-code-store.test.ts`

**Interfaces:**
- Produces: `AuthorizationCodeBinding` ctor gains trailing `public readonly Email: string` and `public readonly Name: string`. `Issue`/`Take` are unchanged (they round-trip the whole binding).

- [ ] **Step 1:** Add `test('a binding round-trips Email and Name through Issue/Take')` asserting `Take` returns a binding whose `Email`/`Name` equal what `Issue` stored.
- [ ] **Step 2:** Run `npx tsx --test "src/idp/tests/authorization-code-store.test.ts"` — expect FAIL.
- [ ] **Step 3:** Append `Email`, `Name` to the ctor/fields.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5:** Commit `feat(idp): carry email/name on the authorization-code binding`.

### Task 3: Authorize endpoint threads email/name into the binding (both paths)

**Files:**
- Modify: `src/idp/authorize-endpoint.ts`
- Test: `src/idp/tests/authorize-endpoint.test.ts`

**Interfaces:**
- Consumes: `IdpRealm.LookupProfile` (Task 1), `AuthorizationCodeBinding.Email/Name` (Task 2).
- Produces: on the fresh-login path and the SSO-cookie path, the endpoint calls `await realm.LookupProfile(principalId)` and populates the binding's `Email`/`Name` (defaulting to `''` when the lookup is null). No signature change to the public `HandleGet`/`HandlePost`.

- [ ] **Step 1:** Add tests: `test('a fresh login issues a code whose binding carries email and name')` and `test('an SSO-cookie authorize issues a code whose binding carries email and name')` — drive the endpoint, `Take` the code from the redirect, assert `binding.Email`/`binding.Name`.
- [ ] **Step 2:** Run `npx tsx --test "src/idp/tests/authorize-endpoint.test.ts"` — expect FAIL.
- [ ] **Step 3:** Thread `LookupProfile` into both paths; pass email/name into the binding construction (`RedirectWithCode`). Seed the test account with a displayName via the Task 1 signature.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5:** Commit `feat(idp): authorize endpoint carries email/name on both login and SSO paths`.

### Task 4: Token endpoint emits email and name claims

**Files:**
- Modify: `src/idp/token-endpoint.ts`
- Test: `src/idp/tests/token-endpoint.test.ts`

**Interfaces:**
- Consumes: `AuthorizationCodeBinding.Email/Name`.
- Produces: the signed id_token claims gain `email` and `name` from the binding (claim-name constants `EmailClaim='email'`, `NameClaim='name'`).

- [ ] **Step 1:** Extend the existing success test (or add `test('the id_token carries email and name claims')`) to decode the id_token and assert `email`/`name` equal the binding's values.
- [ ] **Step 2:** Run `npx tsx --test "src/idp/tests/token-endpoint.test.ts"` — expect FAIL.
- [ ] **Step 3:** Add `email`/`name` to the claims object passed to `signingKey.Sign`.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5:** Commit `feat(idp): emit email and name id_token claims`.

### Task 5: IdpRealmSet.EnsureRealm + realm factory + reserved-key rejection

**Files:**
- Modify: `src/idp/idp-host.ts` (the `IdpRealmSet` class)
- Test: `src/idp/tests/idp-realm-set.test.ts` (new)

**Interfaces:**
- Produces: `type RealmFactory = (tenantId: string, displayName: string) => Promise<IdpRealm>`. `IdpRealmSet` ctor gains optional trailing `factory?: RealmFactory` (6a's `new IdpRealmSet(entries)` still compiles). `EnsureRealm(tenantId: string, displayName: string): Promise<IdpRealm>` — rejects a `tenantId` that is empty, begins with `_`, or contains `/`, `\`, or `..` by throwing `ReservedRealmError` (new, exported); returns the existing realm if present; else requires a factory (throws if none), creates, caches, returns. `For(tenantId)` unchanged.

- [ ] **Step 1:** Write `idp-realm-set.test.ts`: `test('EnsureRealm creates once then returns the same realm')`; `test('EnsureRealm returns a pre-registered realm without the factory')`; `test('EnsureRealm rejects an underscore-prefixed, empty, or traversal key with ReservedRealmError')` (cases `'_admin'`, `'_x'`, `''`, `'../x'`, `'a/b'`); `test('EnsureRealm without a factory for a new key throws')`.
- [ ] **Step 2:** Run `npx tsx --test "src/idp/tests/idp-realm-set.test.ts"` — expect FAIL.
- [ ] **Step 3:** Implement on `IdpRealmSet`. Keep the validation in one private `static ValidKey(key): boolean` reused by the error path.
- [ ] **Step 4:** Run — expect PASS. Also run the existing `idp-host-discovery.test.ts` to confirm the ctor change is backward-compatible.
- [ ] **Step 5:** Commit `feat(idp): IdpRealmSet.EnsureRealm with realm factory and reserved-key rejection`.

### Task 6: IdpAdminEndpoint (SECURITY-CORE — adversarial review)

**Files:**
- Create: `src/idp/idp-admin-endpoint.ts`
- Test: `src/idp/tests/idp-admin-endpoint.test.ts`

**Interfaces:**
- Consumes: `IdpRealmSet.EnsureRealm` (Task 5), `IdpRealm.SeedAccount` (Task 1), `IdpClientStore.Register` (6a), `ReservedRealmError` (Task 5).
- Produces:
  - `class AdminResult { constructor(public readonly Status: number, public readonly Body: unknown) }`
  - `class IdpAdminEndpoint { constructor(adminToken: string, realms: IdpRealmSet, clients: IdpClientStore); Handle(method: string, segments: readonly string[], authorization: string | undefined, body: unknown): Promise<AdminResult> }` where `segments` are the path parts **after** `_admin`.
  - Behavior (contracts from spec §4.3): verify bearer token first — extract from `authorization` (`Bearer <t>`), compare `timingSafeEqual(sha256(presented), sha256(adminToken))`; any failure (absent header, wrong scheme, wrong token, length mismatch) → `AdminResult(401, { error: 'unauthorized' })`. Then route: `PUT realms/<t>` `{displayName}`→`EnsureRealm`→`200 {tenantId}`; `POST realms/<t>/accounts` `{email,principalId,displayName,password}`→`SeedAccount`→`200 {principalId}`; `POST realms/<t>/clients` `{clientId,redirectUris,secret}`→`Register`→`200 {clientId}`. Missing/empty required field, non-array/empty redirectUris, or `ReservedRealmError` → `400 {error}`. Unknown admin path/method → `404`. Success/error bodies NEVER include `password` or `secret`.

- [ ] **Step 1:** Write `idp-admin-endpoint.test.ts`:
  - authz: `test('a valid bearer token is accepted')`; `test('a missing Authorization header is 401')`; `test('a wrong token is 401')`; `test('a token of a different length is 401, not a thrown error')`; `test('a non-Bearer scheme is 401')`.
  - routes: `test('PUT realm is 200 and idempotent')`; `test('POST account is 200 and seeds a realm-authenticatable login')`; `test('POST client is 200 and the secret is verifiable but never echoed')`.
  - validation: `test('a malformed body is 400')`; `test('an underscore-prefixed realm is 400')`; `test('empty redirectUris is 400')`.
  - leakage: `test('no 200 or 400 body contains the password or the client secret')` (stringify the result body, assert it excludes the raw values).
- [ ] **Step 2:** Run `npx tsx --test "src/idp/tests/idp-admin-endpoint.test.ts"` — expect FAIL.
- [ ] **Step 3:** Implement. Hoist all route segments (`_admin`, `realms`, `accounts`, `clients`), the header name/scheme, claim/error strings, and the `Bearer ` prefix to constants. One private `VerifyToken(authorization): boolean`. Validate bodies with explicit type guards; on `ReservedRealmError` return 400.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5:** Commit `feat(idp): authenticated admin endpoint (ensure-realm, seed-account, register-client)`.

### Task 7: Host routing wires the reserved _admin namespace

**Files:**
- Modify: `src/idp/idp-host.ts`
- Test: `src/idp/tests/idp-host-admin.test.ts` (new)

**Interfaces:**
- Consumes: `IdpAdminEndpoint.Handle` (Task 6).
- Produces: `IdpHost` ctor gains an optional trailing `admin?: IdpAdminEndpoint` (6a construction still compiles). In `RouteApi`, when `segments[0]` equals the reserved `_admin` segment: if `admin` is undefined, fall through to 404; else read the request body honoring the existing 16 KB cap (→413 over cap; →400 on invalid JSON), call `admin.Handle(method, segments.slice(1), authHeader, parsedBody)`, and `WriteJson` the `AdminResult` with `Cache-Control: no-store`. This branch runs BEFORE the realm-existence guard.

- [ ] **Step 1:** Write `idp-host-admin.test.ts` (reuse the discovery test's HTTPS fixture): with an admin endpoint + token — `test('admin routes are reachable over https with no-store')`; without — `test('the _admin namespace is 404 when no admin endpoint is configured')`; `test('an oversized admin body is 413')`; `test('an invalid-json admin body is 400')`.
- [ ] **Step 2:** Run `npx tsx --test "src/idp/tests/idp-host-admin.test.ts"` — expect FAIL.
- [ ] **Step 3:** Implement the branch + ctor param. Reuse the existing POST-cap/body-read helper from 6a.
- [ ] **Step 4:** Run the new test and the existing `idp-host-discovery.test.ts` — expect PASS.
- [ ] **Step 5:** Commit `feat(idp): route the reserved _admin namespace, fail-closed to 404`.

### Task 8: idp-main loads the admin token and composes the admin endpoint (security-sensitive)

**Files:**
- Modify: `src/idp/idp-main.ts`
- Test: `src/idp/tests/idp-main.test.ts`

**Interfaces:**
- Produces: `IdpMain.Compose` reads `PRAGMATIC_IDP_ADMIN_TOKEN_REF`; when set, loads the token from `join(dataDir, 'secrets', ref)` (utf8, trimmed), builds a `RealmFactory` `(tenantId, displayName) => IdpRealm.OpenFor(realmsDir, tenantId, displayName, masterKey)`, constructs `IdpRealmSet(preOpened, factory)` and `IdpAdminEndpoint(token, realms, clients)`, and passes the endpoint to `IdpHost`. When the ref is unset or the file is absent, admin stays disabled (no endpoint). Env-var name hoisted to a constant; the `secrets` dirname hoisted.

- [ ] **Step 1:** Add tests: `test('Compose with an admin-token ref file present enables the _admin namespace')` (write the token file under the data dir, compose, assert an admin PUT over https is not 404); `test('Compose without the ref keeps _admin at 404')`.
- [ ] **Step 2:** Run `npx tsx --test "src/idp/tests/idp-main.test.ts"` — expect FAIL.
- [ ] **Step 3:** Implement. Do NOT log the token. Trim trailing newline. Treat a missing file as "disabled", not an error.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5:** Commit `feat(idp): compose the admin endpoint from PRAGMATIC_IDP_ADMIN_TOKEN_REF, fail-closed`.

### Task 9: IdpAdminClient (control-plane HTTPS client)

**Files:**
- Create: `admin/control-plane/idp-admin-client.ts`
- Test: `admin/control-plane/tests/idp-admin-client.test.ts` (new)

**Interfaces:**
- Consumes: the admin API (Tasks 6–7), `DevCa`/`IdpTlsMaterial` + `IdpHost`/`IdpAdminEndpoint` for the test fixture.
- Produces: `class IdpAdminClient { constructor(opts: { baseUrl: string; adminToken: string; ca: string | Buffer }); EnsureRealm(tenantId: string, displayName: string): Promise<void>; SeedAccount(tenantId: string, account: { email: string; principalId: string; displayName: string; password: string }): Promise<void>; RegisterClient(tenantId: string, client: { clientId: string; redirectUris: readonly string[]; secret: string }): Promise<void> }`. Uses `node:https` with an `https.Agent({ ca })` (no `rejectUnauthorized:false`), sends `Authorization: Bearer <adminToken>`, `Content-Type: application/json`. Non-2xx → a typed `IdpAdminError` carrying status + the server `error` code only (never the request body / secret / password). Never logs request bodies.

- [ ] **Step 1:** Write the test against an in-process `IdpHost` with an `IdpAdminEndpoint` (test token) + dev CA: `test('EnsureRealm, SeedAccount, RegisterClient round-trip over https')` then authenticate the seeded login through the realm to confirm the seed took; `test('a wrong admin token surfaces IdpAdminError(401) with no secret in the message')` (assert the thrown error's string excludes the password/secret).
- [ ] **Step 2:** Run `npx tsx --test "admin/control-plane/tests/idp-admin-client.test.ts"` — expect FAIL.
- [ ] **Step 3:** Implement. Hoist header names, the `Bearer ` prefix, content-type, and path templates to constants.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5:** Commit `feat(control-plane): IdpAdminClient over https with dev-CA trust`.

### Task 10: Upgrade the gated SSO smoke to provision via the admin API + assert claims

**Files:**
- Modify: `admin/control-plane/idp-sso-smoke.ts`

**Interfaces:**
- Consumes: `IdpAdminEndpoint`, `IdpAdminClient`, the claim additions (Tasks 1–9).

- [ ] **Step 1:** Construct the smoke's `IdpHost` with an `IdpAdminEndpoint` (test admin token) and an `IdpRealmSet` that has a factory. Replace the direct `IdpRealm.SeedAccount` / `IdpClientStore.Register` calls with `IdpAdminClient.EnsureRealm` + `SeedAccount` (with a displayName) + `RegisterClient` for both environment clients.
- [ ] **Step 2:** Add assertions: the id_token from the env-A fresh login carries `email` (equal to the seeded email) and `name` (equal to the seeded displayName); the env-B SSO-cookie login's id_token carries the same `email`/`name`.
- [ ] **Step 3:** Add a negative gate: a second `IdpHost` constructed with NO admin endpoint returns 404 for an `_admin` PUT (drive via a raw https GET/PUT or a client pointed at it, asserting 404).
- [ ] **Step 4:** Run `npx tsx admin/control-plane/idp-sso-smoke.ts` — expect exit 0, all gates PASS.
- [ ] **Step 5:** Commit `test(idp): SSO smoke provisions via the admin API and asserts email/name claims`.

---

## Final verification (before the whole-branch review)

- `npx tsx --test "src/idp/tests/*.test.ts"` green.
- `npx tsx --test "admin/control-plane/tests/*.test.ts"` green.
- `npx tsx admin/control-plane/idp-sso-smoke.ts` exit 0.
- `npm run build` and `npm run typecheck:tools` clean.
- Whole-branch review on the most capable model; Tasks 6 and 8 flagged for adversarial security review (token compare, fail-closed, no secret/password leakage).
