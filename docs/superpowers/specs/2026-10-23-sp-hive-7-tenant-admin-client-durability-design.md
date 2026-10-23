# SP-HIVE-7 #6 — Durable tenant-admin OIDC client + TTL secret rotation

**Status:** design, pending approval. Implements deferral issue #6. Builder-checked.

## Problem

`TenantOidcRelyingParty.Begin` (admin/control-plane/tenant-auth/tenant-oidc-relying-party.ts) mints a **fresh client secret and re-registers the `pragmatic-tenant-admin` OIDC client on every login**, and its secret store is `FileIdentityStores.Open(new FakeStorage(), randomBytes(32))` — in-memory, with a per-instance random master key. Consequences:

1. **Concurrency race.** Two overlapping logins: the second `Begin` overwrites the stored secret (same `secretRef`) while the first login's authorization code is still in flight; the first `Complete` then presents the client with the new secret and the token exchange fails.
2. **Churn / cost.** Every login re-POSTs a new secret to the per-tenant IdP, re-running an argon2 hash in the IdP client store each time.
3. **No durability.** The secret is lost on relying-party restart, so nothing can be reused.

## Decision (confirmed with the user)

Auto-rotate the client secret **on a schedule (TTL)**: register once, reuse the secret across logins until it exceeds a configured age, then rotate. (Chosen over explicit-operator-rotate and rotate-every-restart.)

## Design

The whole durable behaviour is gated behind one optional constructor dependency, `durability`. When it is **absent** the relying-party behaves exactly as today (in-memory `FakeStorage`, random key, fresh secret + re-register every `Begin`) — so the three existing construction sites in `tenant-oidc-relying-party.test.ts` stay unchanged. When it is **present** (production and the new tests) the durable reuse/TTL path runs. This keeps the change additive and the blast radius small.

### 1. Durable secret store

For the durable path, replace the in-memory store with a persistent one, mirroring `OperatorIdentity` (admin/control-plane/operator-identity.ts):

```
FileIdentityStores.Open(new NodeFsStorage(storeRoot), masterKey)   // NodeFsStorage from '@pragmatic-tech-ai/todl-runtime/node'
```

- `storeRoot = join(dataRoot, 'tenant-admin-oidc')`, created with `mkdirSync(storeRoot, { recursive: true, mode: 0o700 })` **lazily inside `stores()`**, immediately before `Open`, only on the durable path.
- `masterKey: Buffer` is the control plane's **existing** 32-byte master key, loaded once in `ControlPlaneServer.Start` (after the operator has composed, so the key file is guaranteed to exist) and passed down. One key for the plane, not a new one.
- `stores.Secrets.Get(ref): Promise<string | null>` — **returns `null` when absent** (never `undefined`, never throws for absence). `Put`/`Get`/`Delete` are all async.

### 2. Durable admin-client record

New `admin/control-plane/tenant-auth/tenant-admin-client-record.ts`, mirroring `gating-record.ts` exactly:

```ts
export type TenantAdminClientRecord =
{
    id: string          // = tenantId (JsonRecordStore key)
    tenantId: string
    clientId: string
    secretRef: string
    rotatedAt: string   // ISO timestamp of the last secret mint
}

export class TenantAdminClientRegistry extends JsonRecordStore<TenantAdminClientRecord>
{
    // RootKey = 'tenant-admin-clients'; constructor(filePath)
}
```

Persisted to `join(dataRoot, 'tenant-admin-clients.json')`. `Get(id)` is synchronous and returns a clone or `undefined`; `Put(record)` is async and **must be awaited**. It holds only the `secretRef` (a name) and a timestamp — **never the secret**. Its `Load()` is async and is called in the server's existing `Promise.all` (server.ts ~line 112), alongside the other registries, before `ComposeTenantPlane`.

### 3. Master key loader

Add a small read-only helper `admin/control-plane/master-key-file.ts`:

```ts
export class MasterKeyFile
{
    // private static readonly ExpectedBytes = 32
    // private static readonly BadSizeMessage = '...'
    public static Load(path: string): Buffer   // readFileSync + assert 32 bytes, else throw MasterKeyError
}
```

`OperatorIdentity` is **not** refactored (it keeps its own private create-or-load). `MasterKeyFile.Load` only reads and validates; the operator composes first and creates the file, so it exists by the time `Start` loads it for the tenant plane. (A future cleanup can unify the two; out of scope here.)

### 4. Constructor shape

Append one optional trailing parameter after the existing ones:

```ts
constructor(
    idp, directory, adminClientFactory, callbackUrl,
    resolverOverride?, flowStates?,
    durability?: TenantAdminDurability)

export type TenantAdminDurability =
{
    storeRoot: string
    masterKey: Buffer
    registry: TenantAdminClientRegistry
    secretTtlMs: number
    now?: () => number          // injectable clock; defaults to Date.now
}
```

Existing positional calls (4 args) are unaffected. `now` makes the TTL unit-testable without waiting.

### 5. `Begin` logic (durable path)

```
conn = await EnsureForTenant(tenantId)
secretRef = SecretRefPrefix + tenantId
secret = await this.SecretForLogin(tenantId, secretRef)      // coalesced per tenant, see §7
adminClientFactory(conn).RegisterClient(tenantId, { clientId: AdminClientId, redirectUris:[callbackUrl], secret })
resolved = resolver.Resolve(tenant, configFor(conn, tenantId, secretRef), stores)
return resolved.Oidc.BeginAuthorization(tenant)
```

`SecretForLogin` (durable):
```
stores = await this.stores()
record = registry.Get(tenantId)
existing = await stores.Secrets.Get(secretRef)       // string | null
const aged = record !== undefined && (now() - Date.parse(record.rotatedAt)) > secretTtlMs
if (record === undefined || existing === null || aged):
    secret = randomBytes(24).base64url
    await stores.Secrets.Put(secretRef, secret)
    await registry.Put({ id: tenantId, tenantId, clientId: AdminClientId, secretRef, rotatedAt: iso(now()) })
    return secret
return existing                                       // reuse (non-null)
```

`RegisterClient` is called **every** `Begin` (both paths) because `IdpClientStore.Register` is an in-memory upsert (src/idp/idp-client-store.ts) and the IdP forgets its clients on restart; re-registering the *same* secret is idempotent and re-establishes the client after an IdP bounce. It still costs one argon2 hash per login — accepted; it is an admin login, low frequency. What the TTL removes is the *new-secret-per-login* race and secret churn.

### 6. `Complete`

Unchanged — it resolves through `secretRef`; the authenticator reads the secret at token-exchange time, and the secret is stable between rotations.

### 7. First-use concurrency

To make even the first login (and the post-TTL window) race-free, `SecretForLogin` is **coalesced per tenant**: a `Map<string, Promise<string>>` keyed by tenantId. The first caller installs the promise; concurrent callers for the same tenant await the same one; the entry is deleted in a `finally`. So two concurrent first-`Begin`s for one tenant mint and register exactly one secret, not two. (Different tenants never contend.)

### 8. TTL configuration

Env `PRAGMATIC_TENANT_ADMIN_SECRET_TTL_HOURS`, parsed in `ComposeTenantPlane`: positive integer → that many hours; absent or invalid → the default. Default **168** (7 days). The env-var name and default live as `private static readonly` members (no inline literals). Passed to the relying-party as `secretTtlMs`.

### 9. Server wiring (server.ts)

- In `Start`: `const masterKey = MasterKeyFile.Load(opts.masterKeyFile)`.
- In the `Promise.all`: construct `new TenantAdminClientRegistry(join(dataRoot, 'tenant-admin-clients.json'))` and `await .Load()` it.
- Pass `masterKey`, the loaded registry, and the parsed TTL into `ComposeTenantPlane` (new params), which builds the `TenantAdminDurability` and passes it to `new TenantOidcRelyingParty(...)`. `ComposeTenantPlane` stays synchronous (the registry arrives pre-loaded).

## Builder rulings (calls made; not the user's to decide)

- **Idempotent always-re-register** rather than making the IdP client store persistent (a separate, larger hardening — filed as its own Feature if wanted). Tolerates an IdP restart with no IdP change.
- **Reuse the plane's existing master key file** (read-only loader) rather than minting a second key or refactoring `OperatorIdentity`.
- **TTL default 168h.**
- **Durable path gated behind an optional `durability` dependency** so existing tests keep the in-memory behaviour and the change stays additive.
- **Rotation is not race-free across its own TTL boundary** (once per TTL vs every login today); first-use and reuse are race-free via the coalescing map. A dual-secret grace window is out of scope.

## Non-goals

Persistent IdP client store; dual-secret rotation grace window; per-tenant master keys; an operator-facing manual rotate endpoint (the TTL is the trigger).

## Security invariants (unchanged, must hold)

The client secret, the IdP admin token, the authorization code, and any inner-error text are never returned, logged, or placed in a thrown message or persisted record. The record persists only the `secretRef` name and a timestamp. `TenantLoginError` stays no-arg / fixed-message / no-cause.

## Review Focus

- **Reuse within TTL:** a second `Begin` within the TTL mints no new secret (stored secret and `rotatedAt` unchanged), still calls `RegisterClient`, and `Complete` succeeds against the first secret.
- **Rotation after TTL:** a `Begin` past the TTL (driven via the injected clock or an aged record) mints a new secret and advances `rotatedAt`.
- **Durability across a fresh relying-party** over the same `storeRoot` + key + registry file: the secret is found and reused (no rotation), proving persistence.
- **Missing-secret recovery:** a record exists but `Secrets.Get` returns `null` → treated as needing a mint, not a crash and not a `null` handed to `RegisterClient`.
- **No leak on a failing `RegisterClient`:** the IdP admin call throwing yields a `TenantLoginError` with no secret in the message, logs, or record.
- **First-use coalescing:** two concurrent `Begin`s for the same new tenant mint and register exactly one secret.
