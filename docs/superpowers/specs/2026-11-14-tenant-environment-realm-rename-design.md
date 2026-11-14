# Tenant / Environment / Realm rename: design

Status: draft for owner approval (2026-11-14).

## Why

"Tenant" means three different things across the product, and that is confusing to read and to operate:

- the **customer** organisation (Client → Tenant → Environment → Application): tenant `e2e`, its tenant plane, tenant admin, its IdP;
- an **environment** (`loop-rt`): older environment-server code calls each environment a "tenant" (`tenants.json`, `PRAGMATIC_TENANTS_FILE`, `TenantRegistry`, the `tenant` in `/auth/session`, "Publish to tenant" in Plexus);
- the **identity boundary** in the identity packages (`Tenant` class): what accounts, sessions and grants belong to. In an environment server it is the environment; in the IdP it is the customer tenant.

## Owner decisions

1. **Customer stays "tenant".** Everything that means the customer keeps its name.
2. **Environment-meaning "tenant" becomes "environment".**
3. **The identity `Tenant` becomes `Realm`** in all identity packages (`Realm`, `RealmKind`, `realmId`, `IRealmConfigStore`, ...). An environment server has one realm per environment; the IdP has one realm per customer tenant.
4. **Stored and wire names are renamed too.** Readers accept the old names for one release and write the new names, so existing environments, the e2e stack, the IdP volumes and the owner's dev data keep working.

## Vocabulary after the change

| Concept | Name | Examples |
|---|---|---|
| Customer organisation | tenant | tenant plane, tenant admin, `TenantRecord`, `PLEXUS_E2E_TENANT`, desktop discovery `tenants[]`, `stack.json` `tenant`, IdP per tenant |
| Deployment environment | environment | `EnvironmentRegistry`, `EnvironmentProvisioning`, `EnvironmentPurpose`, `environmentId`, `environments.json`, "Publish to environment" |
| Identity boundary | realm | `Realm`, `RealmKind`, `realmId`, `ResourceKind.Realm`, `IRealmConfigStore`, `RealmSecurityModel` |

In the environment server, the realm id equals the environment id. Code that needs the environment id says so (`EnvironmentId`); code that works with accounts, sessions, grants says realm (`server.Realm()`, `session.RealmId`).

## Scope per repository

### Identity packages (todl-identity, -local, -host, -cloud, -engine, -node)
All `Tenant*` identity names become `Realm*`; folder `todl-identity-host/src/tenancy/` becomes `realm/`. Not renamed: `aadTenantId`, `MissingTenantError` and the `login.microsoftonline.com/<tenant>` path segment, which are Microsoft Entra's own tenant.

Stored-name migration (todl-identity-node; read old or new, write new):
- `tenantId` → `realmId` in `accounts.json` (accounts and groups), `sessions.json`, `service-tokens.json`, `audit.json`, `audit-anchors.json`;
- `resourceTenantId` → `resourceRealmId` in `grants.json`;
- root key `tenants` → `realms` in `idp-directory.json`;
- file `tenant-config.json` → `realm-config.json` (read the old file when the new one is missing; the first save writes the new file and removes the old one).

`ResourceKind.Tenant` → `ResourceKind.Realm` keeps its numeric value (0), so stored grants are unchanged. Its **name** travels as a string on the admin wire (`GrantDto.resourceKind`) and in audit records: readers accept `"Tenant"` as an alias of `"Realm"`, writers send `"Realm"`.

Audit hash chains and HMAC checkpoints cover the id **value**, never the field name, so renaming the field does not break verification. Field order stays as it is.

Value-keyed formats need no change: `<id>/svctok/<hash>`, `<id>/pwhash/<pid>`, `local-source-token-key/<id>`, `upstream-token/<id>/<pid>`, `system:<id>`.

### todl-platform-cloud
SQL stores rename `tenant_id` columns to `realm_id` and `identity_tenant_config` to `identity_realm_config`, through an idempotent startup migration (rename when the old name exists).

### pragmatic-protocol
No field names contain "tenant". Doc comments that say tenant but mean environment are reworded.

### pragmatic-server: environment server (`src/`)
- `src/tenancy/` → `src/environments/` (or similar): `TenantRegistry`, `TenantProvisioning`, `TenantPurpose`, `TenantOwnedElsewhereError`, ... → `Environment*`; `tenantId` parameters → `environmentId`. This also ends the clash with the control plane's customer `TenantRegistry`.
- Identity uses follow the Realm rename; mixed sites (`server.Tenant()`, `context.Tenant.Id`, `session.TenantId`, `credential.Tenant`) are decided per site: realm when it is about accounts, sessions or grants, environment when it is about the environment.
- `src/idp/` keeps "tenant" for the customer (its realm per tenant, `clients.json` `tenantId`, `PRAGMATIC_IDP_TENANTS`); its identity types follow Realm.

Configuration (old names still read for one release):
- env var `PRAGMATIC_TENANTS_FILE` → `PRAGMATIC_ENVIRONMENTS_FILE`;
- file `tenants.json` → `environments.json`, root key `tenants` → `environments`;
- helm value `tenants:` → `environments:`; docker compose and seed bundle follow.

Wire and telemetry (no compatibility: no reader of the old name exists, or it is an operator surface):
- `/auth/session` and `/auth/browser-login` JSON `tenant` → `environment`;
- OTel label `tenant` → `environment`; `rate_limited_total{scope="tenant"}` → `scope="environment"`;
- audit JSONL field `tenant` → `environment`;
- log text (`tenants=<n>`, `... tenant <id>`) → environment.

### pragmatic-server: control plane and portals (`admin/`)
Customer meaning stays. Renamed are only the places that configure an environment server:
- `env-server-seed.ts`, `k8s-manifest-builder.ts` (`TenantsFileVar`), `control-plane-smoke.ts` (`TenantsFile`), `environment-seed-port.ts`, `template-catalog.ts` (`TenantPurposeName`);
- ConfigMap `<env>-tenants` → `<env>-environment` (data key `environments.json`);
- the `'Tenant'` resource-kind constants become `'Realm'`.
- The live-loop orchestrator's descriptor field `tenant` (an environment id) → `environment`.
- `tenant-api/tenant-profile-dto.ts` has the inverse problem: a field named `environment` that carries the customer tenant. It becomes `tenant`.

Stays as is: the control plane's own `<dataRoot>/tenants.json` (customers), `registry.json` `environments.*.tenantId` (the owning customer), every `PRAGMATIC_TENANT_ADMIN_*` variable, tenant-admin images and k8s names, desktop discovery fields.

Docs: README, ARCHITECTURE.md, admin/README, dev README, docker and helm READMEs, environments README, runbooks.

### TODL (published)
Environment-meaning exports are renamed; the old names stay exported as deprecated aliases for one release:
`RemoteTenantConnector` → `RemoteEnvironmentConnector`, `ITenantReadClient`/`ITenantWriteClient` → `IEnvironmentReadClient`/`IEnvironmentWriteClient`, `TenantDocumentAssembler`/`TenantNodeCell`/`TenantFieldCell` → `Environment*`, `RemoteBuildTarget.Tenant` → `Environment` (old option still accepted). Files follow. The generated app code uses the new names (`CypherEnvironmentClient`).

The dev-only socket override sends `?environment=` instead of `?tenant=`. The server stopped reading `?tenant=` long ago, so this fixes a broken override.

Release: todl 0.65.0.

### Plexus
The publish feature is about environments: `PublishTenantContributor` → `PublishToEnvironmentContributor`, command `tenant.publish` → `environment.publish`, "Publish to tenant" → "Publish to environment" (menu, dialog title, failure text), `TenantDeployService`, `TenantPublishIpc`, `ITenantPublisher`, IPC channel `tenant-publish:deploy`, `window.api.tenantPublish`, module folders `tenant-publish` → `environment-publish`. The e2e specs that find the contributor by class name change in the same commit. `RuntimeDescriptor.tenant` → `environment` (reads both for one release).

Account and sign-in code keeps "tenant" (customer).

## Order

Bottom-up, one branch per repository, each merged locally (fast-forward) once its own suite is green:

1. todl-identity → 2. todl-identity-local, -host, -cloud, -engine → 3. todl-identity-node (stored-name migration) → 4. todl-platform-cloud (SQL migration) → 5. pragmatic-protocol → 6. pragmatic-server (environment server, IdP, control-plane islands, config, docs) → 7. TODL (release 0.65.0) → 8. Plexus.

Identity packages and protocol are file-linked siblings (no publishing). Pushing and publishing wait for the owner.

## Verification

- Every repository: full test suite and typecheck green; new tests for each old-name reader (old file in, new name read, new name written).
- pragmatic-server: server suite, control-plane suite, both portal builds.
- Migration on real data: a new control plane and a new IdP image over the existing e2e stack data (`~/.pragmatic/e2e-stack`, the IdP volume, `loop-*` environments), and a new image rolled onto an environment that still has the old ConfigMap. The owner's `admin/control-plane/data` is not used for testing; it migrates on its first start with the new code.
- The Plexus live-loop e2e passes end to end.

## Calls made by Claude (owner to check)

- The new folder name for `src/tenancy/`: `src/environments/`.
- `tenant-config.json` is replaced on first save (old file removed), rather than kept beside the new one.
- Telemetry, audit JSONL and `/auth/session` fields change without an alias (no known reader; dashboards need updating).
- The tenant-profile DTO's misnamed `environment` field is fixed to `tenant` in the same change.
- The compatibility readers are removed in a later release; that removal is filed as a GitHub Project item.

## Out of scope

Customer-tenant naming; Microsoft Entra's `aadTenantId`; value-keyed paths and Redis keys; historical plans and specs under `docs/superpowers`.
