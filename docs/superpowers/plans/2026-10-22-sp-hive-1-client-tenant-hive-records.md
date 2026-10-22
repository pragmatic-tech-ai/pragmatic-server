# SP-HIVE-1 — Client, Tenant & Hive Records — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the control plane a persisted system-of-record for `Client → Tenant → Hive`, plus a `hiveId` binding on environments, with operator-gated CRUD API and portal UI — no orchestration.

**Architecture:** Three atomic-JSON stores cloned from the existing `EnvironmentRegistry` pattern, coordinated by a `PlatformDirectory` that enforces foreign-key and cascade-delete rules; `ControlPlaneHost` gains gated CRUD routes; the mural-free operator portal gains list/create/delete views mirroring the environment views.

**Tech Stack:** TypeScript (Node), `node:test` via `tsx`, the existing `admin/control-plane` + `admin/portal` (Vite) code.

**Spec:** `docs/superpowers/specs/2026-10-22-sp-hive-1-client-tenant-hive-records-spec.md` (design: `docs/superpowers/specs/2026-10-22-platform-administration-hives-design.md`)

## Global Constraints

- OOP: no module-level free functions or state; validation lives as `static` methods on a class. Allman braces.
- No inline string literals in TS — hoist to `private static readonly` class constants. Record *field names* keep their lowerCamel JSON casing (they mirror storage).
- Public methods/interfaces PascalCase. Portal VMs extend `Observable` (not `MuralBase`).
- Records store only secret **reference names** (`configRef`/`credentialRef`/`trustRootRef`); no secret value is accepted or stored in SP-HIVE-1. No value ever appears in a record or DTO.
- No orchestration, rollout, identity-realm, or audit-sink work (all out of scope / later sub-projects).
- LF-only. Tests live in `tests/` subfolders. Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Control-plane tests run: `npx tsx --test admin/control-plane/tests/<name>.test.ts` (from the pragmatic-server root). Portal tests run: `npx tsx --test tests/<name>.test.ts` (from `admin/portal`).

## Review Focus

- **Duplicate id on create** — creating a client/tenant/hive whose id already exists must reject with a typed error, never silently overwrite. → Task 4.
- **Dangling foreign key** — creating a tenant for a missing client, or a hive for a missing tenant, must reject. → Task 4.
- **Cascade delete** — deleting a client with tenants, a tenant with hives, or a hive with bound environments must reject with a typed error. → Task 4.
- **Malformed store file** — a `*.json` store whose contents are not valid JSON must fail loudly on `Load`, not silently reset to empty (only `ENOENT` means empty). → Task 2.
- **Cross-tenant placement** — an environment `hiveId` naming a hive under a different tenant must be rejected by placement validation. → Task 4.

---

### Task 1: Record shapes + id validation

**Files:**
- Create: `admin/control-plane/platform-records.ts`
- Test: `admin/control-plane/tests/platform-records.test.ts`

**Interfaces:**
- Produces: `ClientRecord`, `TenantRecord`, `HiveRecord`, `ClusterSpec`, `RegistrySpec` (shapes exactly as in the spec's Data model block); `enum HiveBackend { Aks='aks', Eks='eks', Gke='gke', Private='private', Local='local' }`; `enum InfraMode { Provision='provision', Attach='attach' }`; `class RecordId { public static Validate(id: string): void }` throwing `InvalidRecordIdError extends Error`.

- [ ] **Step 1: Write the failing test** `platform-records.test.ts`

```ts
test('RecordId.Validate accepts a plain slug and rejects empty/dot/separator ids', () => {
  assert.doesNotThrow(() => RecordId.Validate('acme-eu'))
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b']) {
    assert.throws(() => RecordId.Validate(bad), /invalid record id/)
  }
})
```

- [ ] **Step 2: Run it to verify it fails** — `npx tsx --test admin/control-plane/tests/platform-records.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** the types/enums and `RecordId.Validate` in `platform-records.ts`. Reject when `id === '' || id === '.' || id === '..'` or it matches `/[\\/:]/` (mirror `src/tenancy/tenant-registry.ts`'s check). Message via a `private static readonly` constant containing `invalid record id`.
- [ ] **Step 4: Run it to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit** — `git add admin/control-plane/platform-records.ts admin/control-plane/tests/platform-records.test.ts && git commit -m "feat(admin): platform record shapes + id validation"`

---

### Task 2: ClientRegistry (store pattern)

**Files:**
- Create: `admin/control-plane/client-registry.ts`
- Test: `admin/control-plane/tests/client-registry.test.ts`

**Interfaces:**
- Consumes: `ClientRecord` (Task 1).
- Produces: `class ClientRegistry { constructor(filePath: string); async Load(): Promise<void>; List(): readonly ClientRecord[]; Get(id: string): ClientRecord | undefined; async Put(record: ClientRecord): Promise<void>; async Remove(id: string): Promise<void> }` — keyed by `record.id`, root JSON key `clients`.

- [ ] **Step 1: Write the failing tests** `client-registry.test.ts` (use `mkdtemp` for a temp file path, as `environment-registry.test.ts` does):

```ts
test('Load on a missing file yields an empty list', async () => { /* Load(); assert List().length === 0 */ })
test('Put then Load round-trips the record', async () => { /* Put(rec); new ClientRegistry(path); Load(); assert deepEqual Get(rec.id), rec */ })
test('Remove deletes and persists', async () => { /* Put; Remove(id); reload; assert Get(id) === undefined */ })
test('Load on malformed JSON throws (not silent-empty)', async () => { /* writeFile(path,'{ not json'); await assert.rejects(reg.Load()) */ })
```

- [ ] **Step 2: Run to verify fail** — `npx tsx --test admin/control-plane/tests/client-registry.test.ts` → FAIL.
- [ ] **Step 3: Implement** `ClientRegistry` by cloning `EnvironmentRegistry` (Map-backed; atomic temp-file + `rename` persist; `ENOENT` → empty; **malformed JSON propagates** — do not catch `SyntaxError`), dropping the env-only `probe`/`Reconcile`/`type`-migration members and keying on `record.id`.
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): ClientRegistry store"`

---

### Task 3: TenantRegistry + HiveRegistry (same pattern)

**Files:**
- Create: `admin/control-plane/tenant-registry.ts`, `admin/control-plane/hive-registry.ts`
- Test: `admin/control-plane/tests/tenant-registry.test.ts`, `admin/control-plane/tests/hive-registry.test.ts`

**Interfaces:**
- Consumes: `TenantRecord`, `HiveRecord` (Task 1).
- Produces: `class TenantRegistry` (root key `tenants`) and `class HiveRegistry` (root key `hives`), each with the identical `Load/List/Get/Put/Remove` surface from Task 2, keyed by `record.id`.

*Naming:* this control-plane `TenantRegistry` is a different module from `src/tenancy/tenant-registry.ts` (the env-scoped runtime one, slated for incremental relabel — not touched here).

- [ ] **Step 1: Write the failing tests** — the same four round-trip/malformed tests as Task 2, once per registry (store a `TenantRecord` / `HiveRecord` fixture).
- [ ] **Step 2: Run to verify fail** — FAIL.
- [ ] **Step 3: Implement** both as clones of `ClientRegistry` with their own root key.
- [ ] **Step 4: Run to verify pass** — PASS (run both test files).
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): TenantRegistry + HiveRegistry stores"`

---

### Task 4: PlatformDirectory coordinator + environment hiveId binding

**Files:**
- Create: `admin/control-plane/platform-directory.ts`
- Modify: `admin/control-plane/environment-record.ts` (add `hiveId?: string` to `EnvironmentRecord`)
- Test: `admin/control-plane/tests/platform-directory.test.ts`

**Interfaces:**
- Consumes: `ClientRegistry`, `TenantRegistry`, `HiveRegistry` (Tasks 2–3); an environment lookup `interface IEnvironmentLookup { List(): readonly EnvironmentRecord[] }` (satisfied by the existing `EnvironmentRegistry`).
- Produces:
  ```ts
  class PlatformDirectory {
    constructor(clients: ClientRegistry, tenants: TenantRegistry, hives: HiveRegistry, environments: IEnvironmentLookup, now?: () => Date)
    async Load(): Promise<void>                                   // loads all three registries
    ListClients(): readonly ClientRecord[]; GetClient(id: string): ClientRecord | undefined
    async CreateClient(input: { id: string; displayName: string; subscriptionRef?: string }): Promise<ClientRecord>
    async DeleteClient(id: string): Promise<void>                 // guard: no tenants
    ListTenants(clientId?: string): readonly TenantRecord[]; GetTenant(id: string): TenantRecord | undefined
    async CreateTenant(input: { id: string; clientId: string; displayName: string }): Promise<TenantRecord>
    async DeleteTenant(id: string): Promise<void>                 // guard: no hives
    ListHives(tenantId?: string): readonly HiveRecord[]; GetHive(id: string): HiveRecord | undefined
    async CreateHive(input: { id: string; tenantId: string; displayName: string; cluster: ClusterSpec; registry: RegistrySpec; trustRootRef?: string }): Promise<HiveRecord>
    async DeleteHive(id: string): Promise<void>                   // guard: no environment has this hiveId
    ValidateHivePlacement(tenantId: string, hiveId: string): void // hive exists AND its tenantId === tenantId
  }
  ```
  Typed errors (each `extends Error`, name set, message via `private static readonly`): `RecordExistsError`, `UnknownClientError`, `UnknownTenantError`, `ClientHasTenantsError`, `TenantHasHivesError`, `HiveHasEnvironmentsError`, `HivePlacementError`.

- [ ] **Step 1: Write the failing tests** `platform-directory.test.ts`:

```ts
test('CreateClient then CreateTenant then CreateHive persists the chain', async () => { /* happy path; Get* returns them; ListTenants(clientId) filters; ListHives(tenantId) filters */ })
test('CreateClient with an existing id throws RecordExistsError', async () => {})
test('CreateTenant for a missing client throws UnknownClientError', async () => {})
test('CreateHive for a missing tenant throws UnknownTenantError', async () => {})
test('DeleteClient with a tenant throws ClientHasTenantsError', async () => {})
test('DeleteTenant with a hive throws TenantHasHivesError', async () => {})
test('DeleteHive bound by an environment throws HiveHasEnvironmentsError', async () => { /* env lookup returns a record with hiveId === hive.id */ })
test('ValidateHivePlacement rejects a hive under a different tenant with HivePlacementError', async () => {})
test('CreateHive validates id and stores only ref names (no secret values)', async () => { /* cluster.configRef is the string given; record JSON has no value field */ })
```

- [ ] **Step 2: Run to verify fail** — `npx tsx --test admin/control-plane/tests/platform-directory.test.ts` → FAIL.
- [ ] **Step 3: Implement** `PlatformDirectory`. `Create*` call `RecordId.Validate(input.id)`, reject duplicates via `Get*`, resolve the parent FK (`UnknownClientError`/`UnknownTenantError`), stamp `createdAt` from `now()` (default `() => new Date()`, ISO string), then `Put`. `Delete*` enforce the cascade guards by scanning the child registry (and `environments.List()` for hives). `ValidateHivePlacement` throws `HivePlacementError` unless the hive exists and its `tenantId` matches. Add `hiveId?: string` to `EnvironmentRecord`.
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): PlatformDirectory coordinator + env hive binding"`

---

### Task 5: Control-plane CRUD routes (operator-gated)

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (add routes + DTO mappers; add `PlatformDirectory` to the constructor)
- Modify: the control-plane composition/bootstrap that constructs `ControlPlaneHost` (wire a `PlatformDirectory` built over the three registries + the existing `EnvironmentRegistry`)
- Test: `admin/control-plane/tests/control-plane-host-platform.test.ts`

**Interfaces:**
- Consumes: `PlatformDirectory` (Task 4), the existing `Authenticated`/`Principal` gate.
- Produces: gated routes for collections + items of client/tenant/hive, following the existing `/api/environments` route convention in `RouteApi` (List `GET`, Create `POST`, Delete `DELETE`; `GET` item optional). DTOs mirror the records 1:1 (`ClientDto = ClientRecord`, etc.).

- [ ] **Step 1: Write the failing test** — drive `ControlPlaneHost` with a fake `IOperatorIdentity` (copy the setup in `control-plane-host.test.ts`): an unauthenticated request to the clients collection returns 401; an authenticated `POST` creates and `GET` lists it; a `DELETE` under a cascade violation returns the mapped error status.
- [ ] **Step 2: Run to verify fail** — `npx tsx --test admin/control-plane/tests/control-plane-host-platform.test.ts` → FAIL.
- [ ] **Step 3: Implement** the routes in `RouteApi` (non-public, so the existing gate challenges them), delegating to `PlatformDirectory`, mapping records→DTOs and the typed errors→status codes the way `WriteError`/existing routes do. Wire the `PlatformDirectory` through the constructor and its composition site.
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): control-plane CRUD routes for clients/tenants/hives"`

---

### Task 6: Portal api-client + DTO types

**Files:**
- Modify: `admin/portal/src/api-client.ts`, `admin/portal/src/portal-types.ts`
- Test: `admin/portal/tests/api-client-platform.test.ts`

**Interfaces:**
- Produces on `ControlPlaneClient`: `ListClients()`, `CreateClient(id, displayName, subscriptionRef?)`, `DeleteClient(id)`, `ListTenants(clientId?)`, `CreateTenant(id, clientId, displayName)`, `DeleteTenant(id)`, `ListHives(tenantId?)`, `CreateHive(input)`, `DeleteHive(id)`; `ClientDto`/`TenantDto`/`HiveDto` in `portal-types.ts` mirroring the records.

- [ ] **Step 1: Write the failing test** — following `admin/portal/tests/api-client.test.ts`, stub fetch and assert each new method calls the right route/verb/body and parses the DTO.
- [ ] **Step 2: Run to verify fail** — `npx tsx --test tests/api-client-platform.test.ts` (from `admin/portal`) → FAIL.
- [ ] **Step 3: Implement** the methods via the existing private `Send<T>` helper and add the DTO types.
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(portal): api-client methods for clients/tenants/hives"`

---

### Task 7: Portal client + tenant views/VMs

**Files:**
- Create: `admin/portal/src/client-list-view.ts`, `client-list-view-model.ts`, `create-client-view.ts`, `tenant-list-view.ts`, `tenant-list-view-model.ts`, `create-tenant-view.ts`
- Modify: `admin/portal/src/main.ts` / `app.ts` (register the new views in nav)
- Test: `admin/portal/tests/client-tenant-views.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient` (Task 6). VMs extend `Observable`; follow `environment-list-view` / `create-environment-view` + `portal-view-base` structure.

- [ ] **Step 1: Write the failing test** — following `environment-detail-view.test.ts`: the client-create VM calls `CreateClient` with its field values; the tenant-create VM lists clients and submits `CreateTenant` with the chosen `clientId`.
- [ ] **Step 2: Run to verify fail** — `npx tsx --test tests/client-tenant-views.test.ts` (from `admin/portal`) → FAIL.
- [ ] **Step 3: Implement** the views/VMs mirroring the environment views; all user-facing strings as `private static readonly` constants; register them in the portal nav.
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(portal): client + tenant management views"`

---

### Task 8: Portal hive view/VM (cluster + registry form)

**Files:**
- Create: `admin/portal/src/hive-list-view.ts`, `hive-list-view-model.ts`, `create-hive-view.ts`
- Modify: `admin/portal/src/main.ts` / `app.ts` (register)
- Test: `admin/portal/tests/hive-views.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient.CreateHive`, `ListHives` (Task 6); `HiveBackend`, `InfraMode` (Task 1).

- [ ] **Step 1: Write the failing test** — the hive-create VM, scoped to a tenant, submits `CreateHive` with `cluster { backend, mode, configRef? }`, `registry { mode, endpoint?, credentialRef? }`, and optional `trustRootRef`; selecting backend `Local`/mode `Attach` is the default path; assert no secret *value* field is sent (only ref names).
- [ ] **Step 2: Run to verify fail** — `npx tsx --test tests/hive-views.test.ts` (from `admin/portal`) → FAIL.
- [ ] **Step 3: Implement** the hive views/VM: backend + mode pickers for cluster and registry, optional reference-name inputs, list scoped to the selected tenant. Strings as constants; VM extends `Observable`.
- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(portal): hive management view"`

---

## Notes for the executor

- Tasks 1–4 are the load-bearing core and are independent of the portal; 5 bridges; 6–8 are the UI and share one shape. Tasks 2 and 3 are near-identical clones — a single implementer can batch 3's two files.
- Do not modify `EnvironmentService.Create`'s behavior; Task 4 only adds the `hiveId` field and the placement validator. Wiring placement into environment creation is SP-HIVE-2's concern.
