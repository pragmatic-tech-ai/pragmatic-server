# SP-HIVE-1 — Client, Tenant & Hive Records — Spec

**Status:** Draft 2026-10-22. First sub-project of the SP-HIVE program.
**Design:** `docs/superpowers/specs/2026-10-22-platform-administration-hives-design.md`
**Owner repo:** pragmatic-server (`admin/control-plane` + `admin/portal`).

## Intent

Give the control plane a **system-of-record for the platform hierarchy above environments**: `Client → Tenant → Hive`, and bind each environment to the hive it runs on. Today the only persisted record is `EnvironmentRecord`, which carries a bare `tenantId` string and no client or hive. This sub-project adds the three records, their persistence, operator-gated CRUD API, portal UI, and audit — and nothing else. No orchestration (SP-HIVE-2), no rollout (SP-HIVE-4), no identity realm (SP-HIVE-6).

## In scope

- `ClientRecord`, `TenantRecord`, `HiveRecord` data shapes.
- A `hiveId` field added to `EnvironmentRecord`.
- Three atomic-JSON stores following the existing `EnvironmentRegistry` pattern.
- Control-plane API endpoints for CRUD, each operator-gated and audited.
- Portal list/create/detail views + VMs for clients, tenants, hives.
- Referential + cascade validation.
- Incremental vocabulary relabel only where these files already touch the misnomer.

## Out of scope (named deferrals already filed as Features)

Cluster/registry *provisioning or attachment* behavior (SP-HIVE-2/3 act on the specs this sub-project only *stores*), rollout, tenant identity realm, cloud backends, kind, governance/quota.

## Data model

New module `admin/control-plane/platform-records.ts` (sibling of `environment-record.ts`). All records are plain data shapes (serialized to JSON; properties mirror storage, so they keep their lowerCamel JSON casing — the no-inline-literal and PascalCase rules apply to the TS classes/registries, not these field names).

```ts
export type ClientRecord = {
    id: string            // slug, validated like env names
    displayName: string
    subscriptionRef?: string   // placeholder; billing linkage is later
    createdAt: string
}

export enum HiveBackend { Aks = 'aks', Eks = 'eks', Gke = 'gke', Private = 'private', Local = 'local' }
export enum InfraMode { Provision = 'provision', Attach = 'attach' }

export type ClusterSpec = {
    backend: HiveBackend
    mode: InfraMode
    configRef?: string    // NAME of a server-side secret (kubeconfig / cloud creds); never the value
}

export type RegistrySpec = {
    mode: InfraMode
    endpoint?: string         // e.g. GHCR host or in-hive registry address
    credentialRef?: string    // NAME of a server-side secret; never the value
}

export type TenantRecord = {
    id: string
    clientId: string          // FK → ClientRecord.id
    displayName: string
    createdAt: string
}

export type HiveRecord = {
    id: string
    tenantId: string          // FK → TenantRecord.id
    displayName: string
    cluster: ClusterSpec
    registry: RegistrySpec
    trustRootRef?: string     // NAME of a server-side secret (signature trust root); never the value
    createdAt: string
}
```

`EnvironmentRecord` gains `hiveId?: string` (optional for back-compat with existing records; set at environment creation as a placement choice — the creation flow itself stays where it is, this spec only adds the field and its validation).

**Security:** records store only **reference names** (`configRef`, `credentialRef`, `trustRootRef`) that point at server-side secrets — never secret values. In SP-HIVE-1 the operator supplies these as plain reference-name strings; **writing/resolving the actual secret value is deferred to SP-HIVE-2/3** (which need it to provision/attach). Neither the record nor any DTO ever contains a secret value.

## Persistence

Three stores in `admin/control-plane/`, each a class following `EnvironmentRegistry` exactly (Map-backed, `Load`/`List`/`Get`/`Put`/`Remove`, atomic temp-file + `rename` persist, `ENOENT` → empty):

- `ClientRegistry` (file `clients.json`, root key `clients`).
- `TenantRegistry` (file `tenants.json`, root key `tenants`).
- `HiveRegistry` (file `hives.json`, root key `hives`).

**Naming note:** `src/tenancy/TenantRegistry` already exists but is the *env-scoped runtime* one the design slates for relabel toward "environment"; it lives in a different module. The control-plane `TenantRegistry` here is the platform tenant store. The duplicate name across modules is accepted for now; the runtime one is renamed incrementally as touched (design decision), not in this sub-project.

## API (control-plane host)

Add routes to `ControlPlaneHost.RouteApi` following the existing convention; they are **operator-gated** by the same non-public path gate the environment routes use (`Authenticated`/`Principal`, backed by `OperatorIdentity`). For each of client/tenant/hive: `List`, `Get`, `Create`, `Delete` (update of mutable display fields optional — create+delete is the minimum). **Audit note:** the control plane has no operator-action audit sink today (the hash-chained audit lives in the per-tenant server, not this layer), so SP-HIVE-1 does not add one; a control-plane operator-action audit log is its own follow-up (filed as a Feature) and is out of scope here.

## Portal

New views + VMs under `admin/portal/src/`, following `portal-view-base`, the existing `environment-list-view`/`create-environment-view` structure, and `api-client`:

- `client-list-view` + `client-list-view-model`, `create-client-view` (+ VM).
- `tenant-list-view` + VM (scoped to a selected client), `create-tenant-view` (+ VM; picks the owning client).
- `hive-list-view` + VM (scoped to a selected tenant), `create-hive-view` (+ VM; picks backend + mode for cluster and registry, and accepts secret values that go to the server by reference).

VMs extend `Observable` (not `MuralBase`). All user-facing strings are `private static readonly` class constants. The hive-create form only *collects and stores* the cluster/registry specs — it does not provision or connect anything.

## Validation & cascade guards

- `id` slugs validated like environment names (non-empty, no path separators / `.` / `..`).
- `TenantRecord.clientId` must resolve to an existing client; `HiveRecord.tenantId` to an existing tenant; `EnvironmentRecord.hiveId` (when set) to an existing hive whose `tenantId` matches the environment's tenant.
- Delete guards: refuse to delete a client that still has tenants, a tenant that still has hives, or a hive that still has environments bound to it (distinct typed errors, same style as `EnvironmentExistsError`).

## Tests (in `tests/` subfolders)

- Each registry: round-trip persistence, atomic-write survives, `ENOENT` → empty, `Put`/`Get`/`Remove`.
- Validation: FK resolution, slug rejection, each cascade-delete guard throws its typed error.
- Secret handling: a created hive persists only the *reference names* in `cluster.configRef` / `registry.credentialRef` / `trustRootRef`; no secret value is accepted or stored in SP-HIVE-1 (DTOs carry only the names).
- Portal VM tests following existing `environment-detail-view.test` patterns: create flows call the api-client with the right payloads.

## What is left to the builder

- Exact route paths/verbs (follow the existing control-plane convention).
- Whether `Update` is included beyond display-name edits (create+delete is the floor).
- The portal's master-detail navigation shape (follow existing portal conventions).
