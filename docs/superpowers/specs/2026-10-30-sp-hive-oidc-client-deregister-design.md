# SP-HIVE deregister env OIDC client on env-delete (SH-F)

**Status:** design — FORK RESOLVED 2026-10-30: deregister failure posture =
**best-effort (fail-open)**. Env-delete always completes; a failed deregister
is swallowed.
**Program:** SP-HIVE 100% burn-down, batch SH-F. Closes the SP-HIVE-6c
follow-up that SH-E deferred ("deregister a bound environment's OIDC client on
env-delete").

## Why this is now buildable in-repo

SH-E deferred this item on the belief that the IdP admin API is PUT/POST-only
and a DELETE-client endpoint would need a sibling IdP product. That is wrong:
the tenant IdP realm lives **in this repo** at `src/idp` (run from the server
image via `idp-main.ts`). So the DELETE-client route is added to the in-repo
realm admin endpoint, the control-plane admin client gets a matching
`DeregisterClient`, and env-delete calls it. No sibling repo involved.

## Context (verified)

- A per-environment confidential OIDC client is registered during
  `EnvironmentService.Federate` (environment-service.ts): `clientId =
  def.environmentId`, registered at the platform tenant
  (`platformTenantId = rec.tenantId`) via
  `adminClientFactory(conn).RegisterClient(platformTenantId, { clientId,
  redirectUris, secret })`. The connection comes from
  `IIdpService.EnsureForTenant`.
- The realm client registry is `src/idp/idp-client-store.ts`
  (`IdpClientStore`, in-memory `Map` keyed by `(tenantId, clientId)`), with
  `Register` / `Find` / `VerifySecret` / `RedirectAllowed` — **no remove**.
- The realm admin endpoint `src/idp/idp-admin-endpoint.ts`
  (`IdpAdminEndpoint.Handle(method, segments, authorization, body)`) routes
  `PUT realms/<t>` (realm), `POST realms/<t>/accounts`,
  `POST realms/<t>/clients`, `POST realms/<t>/accounts/<p>/password`. It has
  **no DELETE route**. Bearer token is verified before any routing
  (constant-work across a set; empty set rejects).
- `src/idp/idp-host.ts` `RouteAdmin` already forwards the raw method and
  reads an empty body as `parsed=undefined`, so a bodyless `DELETE` reaches
  `admin.Handle` unchanged — **no host change needed**.
- Control-plane `admin/control-plane/idp-admin-client.ts` (`IdpAdminClient`)
  has `EnsureRealm` (PUT), `SeedAccount` / `RegisterClient` (POST). Its
  private `Request(method, urlPath, body)` always writes a JSON body +
  Content-Length — it must learn to send a bodyless request for DELETE.
- `EnvironmentService.Delete(name)` today: `Require` → runtime `Teardown` →
  `RemoveVolume` → `registry.Remove` → `NotifyChanged`. The record carries
  `tenantId?` (the realm / platform tenant) and `environmentId` (the
  clientId). It does **not** deregister the OIDC client.
- `IIdpService` has `EnsureForTenant` (connect-or-create) and
  `TeardownForTenant`. There is **no non-creating connect**. Implementors:
  `IdpService` (real), `InjectedIdpService` (tenant-admin pod, connection
  only), plus env-gated smoke doubles (e.g. `UncontactedIdpService`).

## Scope

- **IN:** add realm-side `DELETE realms/<tenant>/clients/<clientId>` (idempotent);
  `IdpClientStore.Remove`; control-plane `IdpAdminClient.DeregisterClient` +
  bodyless request support; `IIdpService.ConnectForTenant` (non-creating
  lookup → connection or `undefined`); wire best-effort deregister into
  `EnvironmentService.Delete`.
- **OUT:** retry/persistence of un-revoked clients (the fail-open ruling
  makes a stale registration benign; the realm is Discarded wholesale on
  tenant-delete per SH-E). A runtime admin add/revoke UI. Any sibling-repo
  change.

## Items + acceptance + rulings

1. **Realm: remove a registered client** (`idp-client-store.ts`, **CRLF**).
   Add `Remove(tenantId, clientId): boolean` — deletes the `(tenantId,
   clientId)` entry, returns whether it existed. No secret is read or
   returned (there is none to leak — the store holds only a hash).
   Acceptance: `Remove` of a registered client returns `true` and a later
   `Find` returns `undefined`; `Remove` of an unknown client returns `false`
   and mutates nothing; removing one client leaves a sibling client of the
   same tenant intact.

2. **Realm admin endpoint: DELETE client route** (`idp-admin-endpoint.ts`,
   **CRLF**). Add a `DELETE` route at segments `realms/<tenant>/clients/
   <clientId>` (path length 4). **Ruling — idempotent teardown:** the route
   returns `200 { clientId }` whether the client existed, did not exist, OR
   the realm itself is unknown — a DELETE for teardown must never fail on an
   already-absent target (an env may be deleted after its tenant's realm was
   already Discarded). *Why:* correct idempotent-DELETE semantics and robust
   teardown ordering. *Cost if wrong:* a caller cannot distinguish
   "deleted" from "was already absent" — acceptable for teardown. The
   bearer-token check still precedes routing; no secret in any response.
   Acceptance: an authenticated DELETE of a registered client returns 200 and
   the client no longer authenticates/authorizes; DELETE of an unknown client
   returns 200; DELETE of a client in an unknown realm returns 200; a DELETE
   with a missing/blank/wrong token returns 401 and removes nothing.

3. **Control-plane admin client: `DeregisterClient`** (`idp-admin-client.ts`,
   **CRLF**). Add `DeregisterClient(tenantId, clientId): Promise<void>` →
   `DELETE RealmPath(tenantId) + '/clients/' + encodeURIComponent(clientId)`.
   Teach the private `Request` to send a **bodyless** request when `body`
   is `undefined` (omit Content-Type / Content-Length, `req.end()` with no
   payload); existing PUT/POST callers pass a body and are unchanged. A
   non-2xx still throws `IdpAdminError`; transport failures still throw
   `IdpAdminTransportError`; neither carries request data. Acceptance: a 200
   resolves; a 401/404 rejects with `IdpAdminError(status)`; a transport
   error rejects with `IdpAdminTransportError`; the request carries no
   Content-Length/body.

4. **`IIdpService.ConnectForTenant`** (`idp-service.ts` LF; `injected-idp-
   service.ts` LF, 3 non-ASCII; smoke doubles). Add
   `ConnectForTenant(tenantId): Promise<IdpConnection | undefined>` — a
   **non-creating** lookup. **Ruling:** `IdpService.ConnectForTenant` loads
   the registry; if there is no record for the tenant it returns `undefined`
   (never creates one); otherwise it returns a connection via the existing
   ensure/reuse path (a record that exists is typically Running and is
   reused). *Why:* reuse the proven connect path without expanding the
   driver interface with a pure "connect"; deregister is best-effort so a
   brief relaunch of a stopped IdP, or a skip, are both acceptable. *Cost if
   wrong:* a stopped IdP may be briefly relaunched to deregister one client —
   wasteful, harmless. `InjectedIdpService.ConnectForTenant` returns its
   injected connection (the tenant-admin pod never creates). Smoke doubles
   return `undefined` (or their stub connection) to compile. Acceptance:
   `ConnectForTenant` for a tenant with no IdP record returns `undefined` and
   creates nothing; for a tenant with a running IdP returns a connection.

5. **Wire best-effort deregister into `EnvironmentService.Delete`**
   (`environment-service.ts`, LF). After `Require(name)`, if `rec.tenantId`
   is set, attempt: `conn = await this.idp.ConnectForTenant(rec.tenantId)`;
   if `conn !== undefined`, `await this.adminClientFactory(conn)
   .DeregisterClient(rec.tenantId, rec.environmentId)`. **Ruling (fork):**
   **best-effort / fail-open** — the whole attempt is wrapped so any
   failure (connect, transport, non-2xx) is swallowed and env-delete
   proceeds through Teardown → RemoveVolume → registry.Remove →
   NotifyChanged unchanged. *Why (operator chose it):* the env is being
   destroyed regardless; a DELETE is idempotent and the leftover is benign
   (secret gone; realm Discarded on tenant-delete); blocking delete on an
   unreachable IdP would strand the environment. *Cost if wrong:* a stale
   client registration lingers until tenant-delete. **No secret, token, or
   client-id-bound credential is ever logged** (nothing is logged here).
   Acceptance: deleting a federated env (record has `tenantId`) calls
   `DeregisterClient(tenantId, environmentId)`; deleting an unbound env
   (`tenantId` undefined) never touches the IdP; a deregister that throws
   does not prevent the env record from being removed.

## Constraints (Global)

- **EOL (critical, mixed base — byte-scan each BASE before editing, match it
  on the way out, do NOT flip):**
  - `src/idp/idp-client-store.ts` → **CRLF**
  - `src/idp/idp-admin-endpoint.ts` → **CRLF**
  - `admin/control-plane/idp-admin-client.ts` → **CRLF**
  - `admin/control-plane/idp-service.ts` → LF
  - `admin/control-plane/injected-idp-service.ts` → LF (**keep its 3
    non-ASCII bytes**)
  - `admin/control-plane/environment-service.ts` → LF
  - `src/idp/idp-host.ts` is LF and is **not** touched.
  - Git Bash `sed -i` strips CR from CRLF files — never use it on the CRLF
    targets. All other `src/idp` + control-plane files 0 non-ASCII — keep
    ASCII (except injected-idp-service.ts's 3).
- **Never fabricate** a client, a response, or a result. DELETE is
  idempotent; it does not invent success for a request it did not route.
- Secrets / tokens / client secrets NEVER logged, echoed, or returned (the
  admin endpoint and admin client already guarantee this — preserve it).
- OOP + Allman braces; no inline string literals (hoist to
  `private static readonly`); enums over string unions; PascalCase public
  members; no module-level free functions/state;
  `admin/portal` ↔ `admin/tenant-portal` stay separate (neither touched).
- Gates: realm `npm test` (`tsx --test src/**/*.test.ts`); control-plane
  `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run
  typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit
  path; never `git add -A`; never docs.

## Review focus

- **Idempotent DELETE:** unknown client, unknown realm, and
  already-deleted all yield 200 and mutate nothing beyond the one target;
  the bearer check still precedes everything; 401 removes nothing.
- **Fail-open delete:** a throwing deregister (connect undefined, transport,
  non-2xx) never prevents the env record from being removed; an unbound env
  never reaches the IdP; the existing Teardown/RemoveVolume/Remove/Notify
  order is unchanged.
- **Non-creating connect:** `ConnectForTenant` for an absent tenant returns
  `undefined` and creates no record / allocates no port.
- **Bodyless request:** DELETE carries no Content-Length/body; PUT/POST
  callers unchanged; error types and redaction unchanged.
- **No credential leak:** no secret/token/client secret in any log, error,
  or response anywhere on the new paths.
- **EOL:** the three CRLF-at-base files stay CRLF; no LF file flipped;
  injected-idp-service.ts keeps its 3 non-ASCII bytes.
