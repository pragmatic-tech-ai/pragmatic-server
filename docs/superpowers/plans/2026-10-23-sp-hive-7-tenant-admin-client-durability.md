# Durable tenant-admin OIDC client + TTL secret rotation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the tenant relying-party minting a fresh OIDC client secret and re-registering on every login; register once, persist durably, reuse until a TTL elapses, then rotate — removing the concurrency race and churn.

**Architecture:** A durable secret store (`FileIdentityStores` over a `NodeFsStorage` root, keyed by the plane's existing master key) plus a durable per-tenant admin-client record registry, both gated behind one optional `durability` dependency on `TenantOidcRelyingParty`. `Begin` reuses the stored secret unless it is missing or older than the TTL, coalescing per-tenant mints so first-use is race-free; `RegisterClient` is still called every login (idempotent upsert) so a login survives an IdP restart.

**Tech Stack:** TypeScript (tsx, node:test), `@pragmatic-tech-ai/todl-identity-node` (`FileIdentityStores`), `@pragmatic-tech-ai/todl-runtime/node` (`NodeFsStorage`), existing `JsonRecordStore`.

**Spec:** `docs/superpowers/specs/2026-10-23-sp-hive-7-tenant-admin-client-durability-design.md` — read it with this plan; it carries the exact decisions and the Review Focus.

## Global Constraints

- OOP only: methods/static methods on classes, no module-level free functions or mutable state. Allman braces. No inline string literals — hoist to `private static readonly` PascalCase constants. PascalCase interfaces and public methods. Enums over string-literal sets.
- Secret material stays server-side: the client secret, IdP admin token, auth code, and inner-error text are NEVER returned, logged, or placed in a thrown message or persisted record. `TenantLoginError` stays no-arg / fixed-message / no-cause.
- Tests live in a `tests/` subfolder. Control-plane tests run with `npx tsx --test "admin/control-plane/tests/*.test.ts"`. Do not run `npm install` at the repo root (breaks workspace symlinks).
- The durable path is additive and gated behind the optional `durability` param: with it absent, `TenantOidcRelyingParty` behaves exactly as today. Existing construction sites that pass 4 args must stay green unchanged.

## Review Focus

- **Reuse within TTL:** a second `Begin` within the TTL mints no new secret (stored secret + `rotatedAt` unchanged), still calls `RegisterClient`, and `Complete` succeeds against the first secret. — Task 2.
- **Rotation after TTL:** a `Begin` past the TTL (via injected clock or an aged record) mints a new secret and advances `rotatedAt`. — Task 2.
- **Durability across a fresh relying-party** over the same store root + key + registry file: the secret is reused, no rotation. — Task 2.
- **Missing-secret recovery:** record present but `Secrets.Get` returns `null` → mint, never a crash and never `null` to `RegisterClient`. — Task 2.
- **No leak on a failing `RegisterClient`:** the IdP admin call throwing yields a `TenantLoginError` with no secret in message/logs/record. — Task 2.
- **First-use coalescing:** two concurrent `Begin`s for the same new tenant mint and register exactly one secret. — Task 2.

---

### Task 1: Master-key loader + durable admin-client record store

**Files:**
- Create: `admin/control-plane/master-key-file.ts`
- Create: `admin/control-plane/tenant-auth/tenant-admin-client-record.ts`
- Test: `admin/control-plane/tests/master-key-file.test.ts`
- Test: `admin/control-plane/tests/tenant-admin-client-record.test.ts`

**Interfaces:**
- Produces: `MasterKeyFile.Load(path: string): Buffer` — reads the file, asserts exactly 32 bytes (else throws `MasterKeyError` from `./operator-identity.js`, reused), returns the Buffer. Read-only (no create).
- Produces: `type TenantAdminClientRecord = { id: string; tenantId: string; clientId: string; secretRef: string; rotatedAt: string }` and `class TenantAdminClientRegistry extends JsonRecordStore<TenantAdminClientRecord>` with `RootKey = 'tenant-admin-clients'` and `constructor(filePath: string)`. Inherits async `Load()`, sync `Get(id)`, async `Put(record)`.

- [ ] **Step 1: Failing tests.** `master-key-file.test.ts`: writing 32 bytes then `MasterKeyFile.Load` returns a 32-byte Buffer equal to the bytes; a wrong-size file throws `MasterKeyError`. `tenant-admin-client-record.test.ts`: after `Load`, `Put` a record then `Get(tenantId)` returns it; `Get` of an unknown id is `undefined`; a second `Put` with the same id overwrites.
- [ ] **Step 2: Run, verify they fail** (`npx tsx --test admin/control-plane/tests/master-key-file.test.ts admin/control-plane/tests/tenant-admin-client-record.test.ts`).
- [ ] **Step 3: Implement both files.** `MasterKeyFile` mirrors the size check in `operator-identity.ts` (constants `ExpectedBytes = 32`, a `BadSizeMessage`); `readFileSync` the path. `TenantAdminClientRecord`/`Registry` mirror `gating-record.ts` exactly.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** (`feat(tenant): master-key loader + durable admin-client record store`).

### Task 2: `TenantOidcRelyingParty` durable secret path

**Files:**
- Modify: `admin/control-plane/tenant-auth/tenant-oidc-relying-party.ts`
- Test: `admin/control-plane/tests/tenant-oidc-relying-party.test.ts` (add cases; keep existing ones passing unchanged)

**Interfaces:**
- Consumes: `TenantAdminClientRegistry` + `TenantAdminClientRecord` (Task 1).
- Produces: `export type TenantAdminDurability = { storeRoot: string; masterKey: Buffer; registry: TenantAdminClientRegistry; secretTtlMs: number; now?: () => number }` and a new **trailing optional** constructor param `durability?: TenantAdminDurability` (after the existing `resolverOverride?`, `flowStates?`).

- [ ] **Step 1: Write failing tests** covering every Review-Focus bullet. Use a fake `IdpAdminClient` factory recording `RegisterClient` calls (clientId + secret), a real `TenantAdminClientRegistry` over a temp file, a `FileIdentityStores` over a temp `storeRoot` + fixed 32-byte key, and an injected `now`. Assert: reuse-within-TTL (one mint, `RegisterClient` still called on the 2nd Begin, same secret, `rotatedAt` unchanged); rotation-after-TTL (advance `now` past TTL → new secret, `rotatedAt` advanced); durability (a *second* `TenantOidcRelyingParty` over the same root/key/registry reuses, no new mint); missing-secret (delete the stored secret, keep the record → next Begin mints, no `null` to RegisterClient); no-leak (RegisterClient throws → `TenantLoginError`, and the secret string appears in neither the error message nor the record); first-use coalescing (two concurrent `Begin`s for a fresh tenant → exactly one minted/registered secret). Keep a test that with **no** `durability` the current behaviour holds (fresh secret each Begin).
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Implement.** Add the `durability` field. `stores()` returns the durable `FileIdentityStores.Open(new NodeFsStorage(storeRoot), masterKey)` (with `mkdirSync(storeRoot, { recursive: true, mode: 0o700 })` just before `Open`) when `durability` is set, else the current `FakeStorage` + random key. Add `private SecretForLogin(tenantId, secretRef): Promise<string>` implementing the reuse/mint/TTL logic from spec §5 against `durability.registry` and the store (`Secrets.Get` returns `string | null` — test `=== null`; await `Put` and `registry.Put`), using `durability.now?.() ?? Date.now()`. Coalesce via a `private readonly inFlight = new Map<string, Promise<string>>()` keyed by tenantId, cleared in `finally` (spec §7). The non-durable branch keeps minting fresh. `Begin` calls `SecretForLogin` (durable) or the existing mint (non-durable), then the shared `RegisterClient` + `Resolve` + `BeginAuthorization`. `Complete` unchanged. All new literals (`storeRoot` segment is passed in, not built here) hoisted.
- [ ] **Step 4: Run, verify pass**, and run the whole relying-party + auth-endpoint suites to confirm no regression.
- [ ] **Step 5: Commit** (`feat(tenant): durable OIDC client secret with TTL rotation`).

### Task 3: Server wiring + TTL config

**Files:**
- Modify: `admin/control-plane/server.ts`
- Test: `admin/control-plane/tests/server-compose.test.ts` if one exists for `ComposeTenantPlane`/TTL parsing; otherwise add a focused `tests/tenant-plane-compose.test.ts` for the TTL parse only (pure).

**Interfaces:**
- Consumes: `MasterKeyFile.Load` (Task 1), `TenantAdminClientRegistry` (Task 1), `TenantAdminDurability` + the new RP param (Task 2).

- [ ] **Step 1: Failing test** for the TTL parse: a static helper `ControlPlaneServer.ParseSecretTtlHours(raw: string | undefined): number` returns `168` for undefined/empty/`'0'`/`'-3'`/`'abc'` and the integer hours for a valid positive integer. Env var name + default are `private static readonly` members.
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement wiring.** In `Start`: `const masterKey = MasterKeyFile.Load(opts.masterKeyFile)`. In the existing `Promise.all`, construct `new TenantAdminClientRegistry(join(dataRoot, TenantAdminClientsFile))` and `await` its `Load()`. Add params to `ComposeTenantPlane(... , masterKey: Buffer, adminClientRegistry: TenantAdminClientRegistry, secretTtlHours: number)`; inside, build `TenantAdminDurability { storeRoot: join(dataRoot, 'tenant-admin-oidc'), masterKey, registry: adminClientRegistry, secretTtlMs: secretTtlHours * 3600_000 }` and pass it as the trailing arg to `new TenantOidcRelyingParty(...)`. Parse the TTL via `ParseSecretTtlHours(env[...])`. New filename/segment literals hoisted to `private static readonly`.
- [ ] **Step 4: Verify.** `npm run typecheck:tools` clean; `npx tsx --test "admin/control-plane/tests/*.test.ts"` all green; the TTL-parse test passes.
- [ ] **Step 5: Commit** (`feat(tenant): wire durable admin-client store + secret TTL into the control plane`).

---

## Notes for the executor

- Security-core: Task 2 gets an adversarial review (secret-leak + concurrency focus) on the most capable model. Tasks 1 and 3 are mechanical/integration.
- Dependency order is strict: 1 → 2 → 3.
- After Task 3, whole-branch review on the most capable model, then the finish menu (merge locally per the standing preference; never push without explicit instruction).
