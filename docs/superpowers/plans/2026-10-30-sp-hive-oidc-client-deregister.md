# SP-HIVE Deregister Env OIDC Client on Env-Delete (SH-F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Deregister a bound environment's per-env OIDC client from the in-repo tenant IdP realm when the environment is deleted (best-effort / fail-open).

**Architecture:** Realm side (`src/idp`) grows an idempotent `DELETE realms/<tenant>/clients/<clientId>` route backed by a new `IdpClientStore.Remove`. The control-plane `IdpAdminClient` grows `DeregisterClient` (bodyless DELETE). `IIdpService` grows a non-creating `ConnectForTenant`. `EnvironmentService.Delete` calls deregister best-effort before its existing teardown.

**Spec:** `docs/superpowers/specs/2026-10-30-sp-hive-oidc-client-deregister-design.md` (fork decision + rulings — read it).

## Global Constraints

- **EOL (critical, mixed base — byte-scan BASE of each file before editing, match it, do NOT flip; `sed -i` strips CR so never use it on CRLF files):**
  - `src/idp/idp-client-store.ts` → **CRLF**
  - `src/idp/idp-admin-endpoint.ts` → **CRLF**
  - `admin/control-plane/idp-admin-client.ts` → **CRLF**
  - `admin/control-plane/idp-service.ts` → LF
  - `admin/control-plane/injected-idp-service.ts` → LF (**keep its 3 non-ASCII bytes**)
  - `admin/control-plane/environment-service.ts` → LF
  - All files 0 non-ASCII except injected-idp-service.ts (3) — keep ASCII.
  - Byte-scan BASE: `git show master:PATH | python -c "import sys;b=sys.stdin.buffer.read();print(b.count(13),b.count(10),sum(c>127 for c in b))"`; byte-scan each touched file on the way out.
- Never fabricate a client/response. Secrets/tokens/client secrets NEVER logged, echoed, or returned.
- OOP + Allman braces; no inline string literals (hoist to `private static readonly`); enums over string unions; PascalCase public members; no module-level free functions/state.
- Gates: realm `npm test` (`tsx --test src/**/*.test.ts`); control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path; never `git add -A`; never docs.

## Review Focus

- Idempotent DELETE: unknown client / unknown realm / already-deleted all return 200 and mutate only the one target; 401 (missing/blank/wrong token) removes nothing and still precedes routing.
- Fail-open env-delete: a throwing deregister never blocks record removal; an unbound env (`tenantId` undefined) never contacts the IdP; existing Teardown→RemoveVolume→Remove→Notify order preserved.
- Non-creating connect: `ConnectForTenant` for an absent tenant returns `undefined`, creates no record, allocates no port.
- Bodyless request: DELETE carries no Content-Length/body; PUT/POST callers unchanged; error types + redaction unchanged.
- No credential leak anywhere on the new paths.
- EOL: three CRLF-at-base files stay CRLF; no LF file flipped; injected-idp-service.ts keeps 3 non-ASCII.

---

### Task 1: Realm — `IdpClientStore.Remove` (item 1)

**Files:** `src/idp/idp-client-store.ts` (**CRLF**), `src/idp/tests/idp-client-store.test.ts` (match that test file's base EOL).

**Interfaces:**
- Produces: `IdpClientStore.Remove(tenantId: string, clientId: string): boolean` — removes the `(tenantId, clientId)` entry, returns whether it existed.

- [ ] Failing tests: `Remove` of a registered client returns `true` then `Find` returns `undefined`; `Remove` of an unknown client returns `false` and leaves the store unchanged; after registering two clients for the same tenant, removing one leaves the other `Find`-able.
- [ ] Implement `Remove` using the existing private `KeyFor`; `Map.delete` returns the existence boolean. No secret read/returned.
- [ ] Verify realm `npm test`; byte-scan (idp-client-store.ts stays CRLF, 0 non-ASCII). Commit (explicit paths).

### Task 2: Realm admin endpoint — DELETE client route (item 2)

**Files:** `src/idp/idp-admin-endpoint.ts` (**CRLF**), tests `src/idp/tests/idp-admin-endpoint.test.ts` and/or `src/idp/tests/idp-host-admin.test.ts` (match base EOL).

**Interfaces:**
- Consumes: `IdpClientStore.Remove` (Task 1); existing `Handle(method, segments, authorization, body)` dispatch.
- Produces: a `DELETE` route at segments `['realms', <tenant>, 'clients', <clientId>]` (length 4) returning `AdminResult(200, { clientId })`.

- [ ] Failing tests: authenticated `DELETE realms/<t>/clients/<id>` of a registered client → 200 `{ clientId }` and the client is gone (a later authorize/verify fails / `Find` undefined); DELETE of an unknown client → 200; DELETE of a client in an unknown realm → 200; DELETE with missing/blank/wrong bearer → 401 and nothing removed.
- [ ] Implement: add `DeleteMethod='DELETE'`, `ClientPathLength=4`, `ClientIdIndex=3` constants; in `Handle`, after the token check and the `realms`/tenant guard, route length-4 `DELETE` with `segments[SubResourceIndex]==='clients'` to a new `private async DeleteClient(tenantId, clientId): Promise<AdminResult>` that calls `this.clients.Remove(tenantId, clientId)` and returns `200 { clientId }` **regardless of the boolean and regardless of realm existence** (idempotent teardown — see spec ruling). Do not add an UnknownRealm guard to this route. No secret in the response.
- [ ] Verify realm `npm test`; byte-scan (idp-admin-endpoint.ts stays CRLF, 0 non-ASCII). Commit (explicit paths).

### Task 3: Control-plane admin client — `DeregisterClient` + bodyless request (item 3)

**Files:** `admin/control-plane/idp-admin-client.ts` (**CRLF**), tests `admin/control-plane/tests/idp-admin-client.test.ts` (match base EOL).

**Interfaces:**
- Produces: `IdpAdminClient.DeregisterClient(tenantId: string, clientId: string): Promise<void>` → `DELETE RealmPath(tenantId) + '/clients/' + encodeURIComponent(clientId)`.

- [ ] Failing tests (reuse the test's existing fake HTTPS server / transport harness): a 200 from the server resolves `DeregisterClient`; a 404 rejects with `IdpAdminError` carrying status 404; a transport error rejects with `IdpAdminTransportError`; the DELETE request carries no Content-Length header and no body (assert via the fake server capturing the request).
- [ ] Implement: add `DeleteMethod='DELETE'` and a `ClientSegment='/clients/'` (or reuse `ClientsSuffix` + separator) constant; add `DeregisterClient`. Change `private Request(method, urlPath, body?: unknown)` so that when `body === undefined` it omits the Content-Type + Content-Length headers and calls `req.end()` with no payload; when `body` is provided, behaviour is byte-identical to today. Error handling (IdpAdminError / IdpAdminTransportError / timeout) and redaction unchanged.
- [ ] Verify control-plane gate + `npm run typecheck:tools`; byte-scan (idp-admin-client.ts stays CRLF, 0 non-ASCII). Commit (explicit paths).

### Task 4: `IIdpService.ConnectForTenant` — non-creating lookup (item 4)

**Files:** `admin/control-plane/idp-service.ts` (LF, interface + `IdpService`), `admin/control-plane/injected-idp-service.ts` (LF, keep 3 non-ASCII), the env-gated smoke doubles that `implements IIdpService` (`in-cluster-env-create-smoke.ts`, `in-cluster-federation-smoke.ts`, `in-cluster-ui-serving-smoke.ts`), tests `admin/control-plane/tests/idp-service.test.ts` + `injected-idp-service.test.ts` (match base EOL).

**Interfaces:**
- Produces: `IIdpService.ConnectForTenant(tenantId: string): Promise<IdpConnection | undefined>`.

- [ ] Failing tests: `IdpService.ConnectForTenant` for a tenant with **no** registry record returns `undefined` and the driver's create/EnsureRunning is **not** invoked (assert on a fake driver/registry); for a tenant with an existing running record returns a connection (driver reuse path). `InjectedIdpService.ConnectForTenant` returns its injected connection.
- [ ] Implement: add `ConnectForTenant` to the `IIdpService` interface. `IdpService.ConnectForTenant` → `Serialized(tenantId, ...)` → `registry.Load()` → `registry.Get(tenantId)`; if `undefined` return `undefined` (create nothing, allocate no port); otherwise obtain a connection via the existing ensure/reuse path (reuse `EnsureLocked`-style reuse — a present record is typically Running; pass the record's own identity, never allocate for a missing one). `InjectedIdpService.ConnectForTenant(tenantId)` returns the same connection as `EnsureForTenant` (connection-only pod). Each smoke double gets a `ConnectForTenant` returning `undefined` (they never delete-federate) so they compile. Keep EOL per file; keep injected-idp-service.ts's 3 non-ASCII.
- [ ] Verify control-plane gate + `npm run typecheck:tools`; byte-scan every touched file (EOL matched; injected `3` non-ASCII preserved). Commit (explicit paths).

### Task 5: Wire best-effort deregister into `EnvironmentService.Delete` (item 5)

**Files:** `admin/control-plane/environment-service.ts` (LF), tests `admin/control-plane/tests/environment-service.test.ts` (match base EOL).

**Interfaces:**
- Consumes: `IIdpService.ConnectForTenant` (Task 4); `IdpAdminClient.DeregisterClient` (Task 3) via the existing `this.adminClientFactory`; `EnvironmentRecord.tenantId` / `.environmentId`.

- [ ] Failing tests (using the suite's existing fakes for `idp` + `adminClientFactory`): deleting a federated env (record has `tenantId`) calls `ConnectForTenant(tenantId)` then `DeregisterClient(tenantId, environmentId)`; deleting an env with `tenantId` undefined never calls `ConnectForTenant`/`DeregisterClient`; a `DeregisterClient` that rejects (or `ConnectForTenant` that rejects/returns undefined) still results in the record being removed (`registry.Remove` called, `Deleted` notified) — fail-open.
- [ ] Implement: add a `private async DeregisterFederation(rec): Promise<void>` that, when `rec.tenantId !== undefined`, does `const conn = await this.idp.ConnectForTenant(rec.tenantId); if (conn !== undefined) { await this.adminClientFactory(conn).DeregisterClient(rec.tenantId, rec.environmentId); }`, the whole body wrapped in `try { ... } catch { /* best-effort: env-delete proceeds */ }` (swallow; log nothing — no secret/token to leak, and no logging surface here). Call it in `Delete` right after `const rec = this.Require(name)` and before the runtime teardown. Do not change the Teardown→RemoveVolume→registry.Remove→NotifyChanged sequence.
- [ ] Verify control-plane gate + `npm run typecheck:tools`; byte-scan (environment-service.ts stays LF, 0 non-ASCII). Commit (explicit paths).

## Final verification (whole branch)

- Realm `npm test` (`tsx --test src/**/*.test.ts`) — all pass.
- Control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` — all pass.
- `npm run typecheck:tools` — exit 0.
- Byte-scan every touched file: CRLF-at-base trio (idp-client-store.ts, idp-admin-endpoint.ts, idp-admin-client.ts) stays CRLF; LF files stay LF; injected-idp-service.ts keeps 3 non-ASCII; all others 0 non-ASCII.
