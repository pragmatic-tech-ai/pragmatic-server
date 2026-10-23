# SP-HIVE-6c-rename — environment-id Rename + Environment→Tenant Binding (design)

**Status:** design, decisions resolved with the user (2026-10-23). First of two 6c builds (this, then 6c-proper). Ready for plan → SDD.

**Parent decisions:** `docs/superpowers/specs/2026-10-23-sp-hive-6c-idp-deployment-federation-design.md` (D5 realm = `hive.tenantId`; D7 full rename now). User chose **full rename + migration now** and **bind the environment to its tenant now**.

## 1. Intent & the why

`tenantId` means two different things in the codebase, and SP-HIVE-6 made the collision real:
- **environment-scope** — in the runtime server (`src/tenancy`, `src/cluster`, parts of `src/host`, `src/config`, `environments/seed`) and on `EnvironmentRecord`, `tenantId` is the per-**environment** scope key (one `PragmaticServer` per environment). This is renamed to **`environmentId`**.
- **platform-tenant** — in the control-plane platform records and the SP-HIVE-6 IdP realm, `tenantId`/`TenantRecord.id` is the real tenant (the realm key). This **stays `tenantId`**.

This build (a) renames the environment-scope `tenantId`→`environmentId` everywhere it means "environment," with a data migrator for durable surfaces, and (b) binds an environment to its platform tenant (via its hive), so `EnvironmentRecord` stops conflating the two and placement/realm resolution is correct — the prerequisite for 6c-proper's per-tenant IdP federation. Done pre-production, so there is no live external contract to break.

## 2. The rename — A/B/C strategy (from recon)

The token's meaning is ~90% predictable by directory. Three categories:

- **(A) ENV-SCOPE → RENAME** `tenantId`→`environmentId`, `TenantId`→`EnvironmentId` (and the related wire/env-var/durable surfaces). Whole-file-safe set: `src/tenancy/**`, `src/cluster/**`, `src/host/pragmatic-server-host.ts`, `src/host/cypher/read-filter-source.ts`, `src/identity/identity-runtime.ts` + `redis-oidc-flow-state-store.ts`, `src/config/file-tenant-provisioning.ts` + `tenant-provisioning-factory.ts` + `server-config*.ts`, `environments/seed/**`, and the env-scope control-plane files (`environment-record.ts`, `environment-service.ts`, `environment-workload.ts`, `template-catalog.ts`, `loop-orchestrator.ts`) + their tests.
- **(B) PLATFORM-TENANT → KEEP untouched.** All of `src/idp/**` (the realm key + issuer — confirmed platform), `admin/control-plane/platform-records.ts`, `platform-directory.ts`, the platform `tenant-registry.ts`, `platform-deployment-registry.ts`, `gating-record.ts`, `idp-admin-client.ts`, `operator-identity.ts`, and the platform portal views.
- **(C) UPSTREAM todl symbol → KEEP untouched.** Every `TenantId`/`Tenant`/`ResourceKind.Tenant`/`.Tenant.Id` resolving to `@pragmatic-tech-ai/todl-identity` — all `src/host/*` authz/audit files and `src/identity/{identity-pack-resolver,runtime-principals,server-bootstrap}.ts`. These physically carry the environment value under the upstream name; renaming them breaks the package contract. **Do NOT global-replace `TenantId`→`EnvironmentId`.** The scope-safe mechanical replace is `\btenantId\b`→`environmentId` within the A directories only; `TenantId`→`EnvironmentId` is per-file within A.
- **MIXED (per-line, by hand):** `admin/control-plane/control-plane-host.ts`, `admin/portal/src/portal-types.ts`, `admin/portal/src/api-client.ts`, the env-scope portal view(s), and the five control-plane smokes — each holds both meanings.

## 3. Durable surfaces → the migrator (env-scope only)

A one-shot migrator rewrites the durable env-scope surfaces under the data root:
- Directory layout: `baseDir/<id>/{packages|applications|graphs|identity}` → `baseDir/<environmentId>/…`; bundle `data/<id>/…`.
- JSON keys: `tenants.json` per-entry key, `tenant-config.json` `configs` key, `EnvironmentRecord.tenantId`→`environmentId` in the control-plane `environments.json`. (Keep the `tenants.json` filename + root key and `PRAGMATIC_TENANTS_FILE` to avoid a needless deploy ripple; migrate only the per-entry key.)
- Secret-ref keys in `provisioned-secrets.json`: `<id>-admin-pw` → `<environmentId>-admin-pw`; `<id>/<conn>/password` → `<environmentId>/<conn>/password`.
- Redis prefixes (`pragmatic:route:`, `pragmatic:oidc:flow:`, `pragmatic:own:`) are transient — the migrator need not touch them.

## 4. External contracts — renamed (pre-production)

Since there are no production consumers yet, rename the env-scope external surfaces too (consistency now is cheaper than later):
- Env vars: `PRAGMATIC_TENANT_ID`→`PRAGMATIC_ENVIRONMENT_ID`, `PRAGMATIC_TENANT_DISPLAY_NAME`→`PRAGMATIC_ENVIRONMENT_DISPLAY_NAME`, `PRAGMATIC_RATELIMIT_TENANT_RPS`/`_BURST`→`PRAGMATIC_RATELIMIT_ENVIRONMENT_RPS`/`_BURST`. Update docker/compose/helm/smokes that set them.
- Wire: the `?tenant=` query param → `?environment=`, HTTP header `x-pragmatic-tenant` → `x-pragmatic-environment` (gateway + worker + host + users + the `wsUrl` the control-plane emits — rename together).
- **KEEP (platform):** `PRAGMATIC_IDP_TENANTS`, the IdP issuer path segment, and `PRAGMATIC_TENANTS_FILE` (file name).

## 5. Environment → tenant binding (resolve the crossover)

The rename exposes that `EnvironmentRecord` conflated its env-scope id with the platform tenant it belongs to (`environment-placement.ts:32` fed `record.tenantId` (env-scope) into `ValidateHivePlacement`, compared against `HiveRecord.tenantId` (platform); `hiveId` is never populated today). Fix it here:

1. `EnvironmentRecord` becomes `{ environmentId (required, the renamed data-plane scope), tenantId? (platform, optional — the owning tenant), hiveId? (optional, now actually populated), … }`. The field named `tenantId` now means the platform tenant everywhere (consistent with B); `environmentId` is the runtime scope.
2. `EnvironmentService.Create(name, template, type, hostPort?, hiveId?)` gains an **optional** `hiveId`. When supplied: inject `PlatformDirectory` (a new constructor dependency, already built in `server.ts`), look up `GetHive(hiveId)`, call `ValidateHivePlacement(hive.tenantId, hiveId)`, and record `tenantId = hive.tenantId` (platform) + `hiveId`. When absent: the environment is unbound (today's behavior preserved) — `tenantId` unset, no placement check.
3. `environment-placement.ts` uses the platform `tenantId` for `ValidateHivePlacement`.
4. `CreateBody` + `POST /api/environments` carry an optional `hiveId`; `EnvironmentDto` exposes `hiveId` + the platform `tenantId`.
5. Optional, minimal: the portal create-environment view may offer a hive picker (additive; can be a thin follow-on). Not required for the backend binding.

**Binding is additive and non-breaking** — mandating a hive on every environment is a later tightening, not this build.

## 6. Decisions / rulings (resolved with the user)

- **R-full-rename:** rename code identifiers + durable data (migrator) + env vars + wire strings + Redis-code-identifiers; keep C (upstream), B (platform incl. all `src/idp/**` + the issuer), and the `tenants.json` filename/`PRAGMATIC_TENANTS_FILE`.
- **R-bind-now:** environment→tenant binding via an optional `hiveId` (recorded platform `tenantId` + `hiveId` on the record), additive/non-breaking; placement uses the platform `tenantId`.
- **R-no-global-pascal-replace:** never blind-replace `TenantId`→`EnvironmentId`; the Pascal token is mostly upstream (C).

## 7. Proof

- All existing suites stay green after the rename: `npx tsx --test "src/**/*.test.ts"` (CI glob), `npx tsx --test "admin/**/*.test.ts" "environments/**/*.test.ts"`, `npm run build`, `npm run typecheck:tools`. The rename is behavior-preserving except the additive binding.
- New/updated tests: `EnvironmentService.Create` with a `hiveId` records the hive's platform `tenantId` + `hiveId` and validates placement (reject on tenant/hive mismatch); without a `hiveId` behaves as before; `EnvironmentDto` carries `hiveId` + platform `tenantId`.
- Migrator test: a fixture data root in the old layout (dirs, `tenants.json`/`tenant-config.json` keys, `provisioned-secrets.json` keys, `environments.json` records) is rewritten to the new names and the server/control-plane reads it back correctly; idempotent re-run is a no-op.
- The gated smokes (control-plane, k8s/kind, rollout, idp-sso) type-check and are updated for the renamed env vars/wire; run status unchanged (gated, not in CI).

## 8. Sequencing

This build (6c-rename) lands the renamed, tenant-bound model. **6c-proper** then builds on it: per-tenant IdP launch at tenant-create, the provisioning wiring (seed Owner, register client, inject `generic-oidc` config/secret), container federation, and CA/issuer-host injection — all consuming `EnvironmentRecord.tenantId` (platform) + `environmentId`.
