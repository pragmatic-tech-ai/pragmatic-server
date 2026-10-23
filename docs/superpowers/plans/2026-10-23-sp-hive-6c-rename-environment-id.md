# SP-HIVE-6c-rename — environment-id Rename + Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rename the environment-scope `tenantId`→`environmentId` everywhere it means "environment" (code, external contracts, persisted field), keep the platform-tenant `tenantId` and the upstream todl `TenantId` untouched, and bind each environment to its platform tenant via its hive.

**Architecture:** A disciplined, category-scoped rename (A=env-scope→rename, B=platform-tenant→keep, C=upstream-todl→keep) landed in compile-closure-safe tasks, plus an additive environment→tenant binding and a one-shot field migrator.

**Tech Stack:** TypeScript (ESM, Node ≥22.5), `node:test`+`tsx`.

**Spec:** `docs/superpowers/specs/2026-10-23-sp-hive-6c-rename-environment-id-spec.md`

## Global Constraints

- **The A/B/C boundary is law.** Rename `tenantId`→`environmentId` / `TenantId`→`EnvironmentId` ONLY in the A set. NEVER touch: `src/idp/**`, `admin/control-plane/platform-records.ts` / `platform-directory.ts` / the platform `tenant-registry.ts` / `platform-deployment-registry.ts` / `gating-record.ts` / `idp-admin-client.ts` / `operator-identity.ts` / the platform portal views (B); and NEVER touch any `TenantId`/`Tenant`/`ResourceKind.Tenant`/`.Tenant.Id` resolving to `@pragmatic-tech-ai/todl-identity` — all `src/host/*` authz/audit files + `src/identity/{identity-pack-resolver,runtime-principals,server-bootstrap}.ts` (C). **Never global-replace `TenantId`→`EnvironmentId`** — the Pascal token is mostly upstream.
- A set (whole-file rename): `src/tenancy/**`, `src/cluster/**`, `src/host/pragmatic-server-host.ts`, `src/host/cypher/read-filter-source.ts`, `src/identity/identity-runtime.ts` + `redis-oidc-flow-state-store.ts`, `src/config/file-tenant-provisioning.ts` + `tenant-provisioning-factory.ts` + `server-config*.ts`, `environments/seed/**`, `admin/control-plane/{environment-record,environment-service,environment-workload,template-catalog,loop-orchestrator}.ts`, + their tests. MIXED (per-line, A-portion only): `admin/control-plane/control-plane-host.ts`, `admin/portal/src/portal-types.ts`, `admin/portal/src/api-client.ts`, the env-scope portal view(s), the five control-plane smokes.
- OOP, Allman braces, PascalCase, no new inline reused literals.
- Each task ends GREEN on the FULL suites — a rename that leaves the tree red between tasks is a failed task.
- Test/build commands: `npx tsx --test "src/**/*.test.ts"` (CI glob); `npx tsx --test "admin/**/*.test.ts" "environments/**/*.test.ts"` (admin+env); `npm run build`; `npm run typecheck:tools`. Do NOT run `npm install`. Gated smokes are type-checked, not run.
- Commit after each task.

## Review Focus

- **No B/C/idp touched:** after each task, `git diff --stat` must show zero changes under `src/idp/`, `platform-*.ts`, `operator-identity.ts`, or the C-layer host authz/audit files; `grep -rn '\.TenantId' src/host` is unchanged. Task 1 review verifies this explicitly.
- **Behavior-preserving rename:** Tasks 1–2 change names/wire-strings only; no logic change. The full suites prove it (updated for the new names). Task 1 review diffs for any accidental semantic edit.
- **Placement uses the PLATFORM tenant:** after binding, `ValidateHivePlacement` receives `EnvironmentRecord.tenantId` (platform), NOT `environmentId`. Task 3 tests a tenant/hive mismatch rejects and a match passes.
- **Unbound environments still work:** `Create` without a `hiveId` behaves exactly as before (no platform tenant, no placement check). Task 3 tests it.
- **Migrator idempotent + readers clean:** readers know only `environmentId`; the migrator rewrites a legacy `tenantId` field→`environmentId` and a re-run is a no-op. Task 4 tests both.

---

### Task 1: Env-scope code-identifier rename (A + MIXED A-portions), wire/env-var VALUES unchanged

**Files:** every A file + the A-portions of the MIXED files + their tests (see Global Constraints).

- [ ] **Step 1:** In the A directories, rename the identifiers `tenantId`→`environmentId` and `TenantId`→`EnvironmentId` (fields, params, locals, method-name fragments like `ServerFor`/`FlowStateFor` args, type members). Keep the VALUES of any wire/env-var strings as-is (e.g. a `TenantQuery` const may be renamed to `EnvironmentQuery` but its value stays `'tenant'` this task; `env.PRAGMATIC_TENANT_ID` keeps that literal). Rename `EnvironmentRecord.tenantId`→`environmentId` (the data-plane field).
- [ ] **Step 2:** Hand-edit the MIXED files' A-portions only: `control-plane-host.ts` (`EnvironmentDto.tenantId`→`environmentId`, `ToDto`, the env wsUrl construction, the `TenantQuery` const name), `portal-types.ts` (`EnvironmentDto.tenantId`→`environmentId`), `api-client.ts` (`EnvironmentDto` plumbing), the env-scope portal view, the smokes' env-scope `EnvironmentRecord`/boot usage. Leave every B token in those files (`HiveDto.tenantId`, `TenantDto`, `ListHives(tenantId)`, `CreateHive` body, nav `ShowHives(…, tenantId)`) untouched.
- [ ] **Step 3:** Update all A/MIXED tests for the renamed identifiers.
- [ ] **Step 4:** Verify green: `npm run build`, `npm run typecheck:tools`, `npx tsx --test "src/**/*.test.ts"`, `npx tsx --test "admin/**/*.test.ts" "environments/**/*.test.ts"`. Then confirm scope: `git diff --stat` shows NO changes under `src/idp/`, `platform-*.ts`, `operator-identity.ts`, or the C host-authz files; and `grep -rn '\btenantId\b' <A dirs>` returns nothing (all renamed).
- [ ] **Step 5:** Commit `refactor(env): rename environment-scope tenantId->environmentId (code identifiers)`.

### Task 2: External-contract value flips (env vars, query param, header)

**Files:** `src/config/server-config-loader.ts` (env-var name constants), `src/cluster/gateway.ts` + `src/cluster/worker-host.ts` (header + `?tenant=`), `src/host/pragmatic-server-host.ts` (`?tenant=`), `environments/seed/users.ts` + `admin/control-plane/control-plane-host.ts` (the emitted `wsUrl` + `TenantQuery` value), `environments/seed/docker.ts` + any compose/helm + the smokes that set the env vars; + tests asserting these strings.

**Interfaces:** Consumes the renamed consts from Task 1 (whose VALUES this task changes).

- [ ] **Step 1:** Flip the env-scope external VALUES: `PRAGMATIC_TENANT_ID`→`PRAGMATIC_ENVIRONMENT_ID`, `PRAGMATIC_TENANT_DISPLAY_NAME`→`PRAGMATIC_ENVIRONMENT_DISPLAY_NAME`, `PRAGMATIC_RATELIMIT_TENANT_RPS`/`_BURST`→`…_ENVIRONMENT_…`; the query param `'tenant'`→`'environment'`; the header `'x-pragmatic-tenant'`→`'x-pragmatic-environment'`. Change every producer AND consumer in the same commit (gateway emits header → worker reads it; control-plane emits `wsUrl` → host parses `?environment=`). Update docker/compose/helm + the smokes that set these vars. **KEEP** `PRAGMATIC_IDP_TENANTS`, the IdP issuer path, and `PRAGMATIC_TENANTS_FILE`.
- [ ] **Step 2:** Update tests asserting these strings.
- [ ] **Step 3:** Verify green (same four commands as Task 1 Step 4) + the gated smokes type-check.
- [ ] **Step 4:** Commit `refactor(env): flip environment-scope env vars, query param, and routing header values`.

### Task 3: Environment → tenant binding

**Files:** `admin/control-plane/environment-record.ts` (+ add platform `tenantId?`), `environment-service.ts` (ctor dep + `Create` param + record population), `environment-placement.ts` (placement uses platform `tenantId`), `control-plane-host.ts` (`CreateBody.hiveId`, `ToDto` adds `hiveId`+`tenantId`, `EnvironmentDto`), `admin/control-plane/server.ts` (inject `PlatformDirectory` into `EnvironmentService`); tests under `admin/control-plane/tests/`.

**Interfaces:**
- Consumes: `PlatformDirectory.GetHive(hiveId): HiveRecord | undefined`, `PlatformDirectory.ValidateHivePlacement(tenantId, hiveId)`, `HiveRecord.tenantId` (platform).
- Produces: `EnvironmentRecord` gains `tenantId?: string` (platform tenant) alongside `environmentId` (from Task 1) and the now-populated `hiveId?`. `EnvironmentService.Create(name, template, type, hostPort?, hiveId?)`; `EnvironmentService` ctor gains a trailing `directory: PlatformDirectory`. `EnvironmentDto` gains `hiveId?` + platform `tenantId?`.

- [ ] **Step 1: Write failing tests** (`admin/control-plane/tests/environment-service.test.ts` + a placement/DTO test): `Create` WITH a valid `hiveId` records `tenantId === hive.tenantId` and `hiveId`, and `ValidateHivePlacement` passes; `Create` with a `hiveId` whose hive is missing/owned-by-another-tenant throws `HivePlacementError`; `Create` WITHOUT a `hiveId` leaves `tenantId`/`hiveId` unset and skips placement (today's behavior); `EnvironmentDto` carries `hiveId` + platform `tenantId`.
- [ ] **Step 2:** Run the control-plane suite — expect the new tests to FAIL.
- [ ] **Step 3:** Implement: add the optional `hiveId` param + `PlatformDirectory` dep; when `hiveId` is given, `GetHive`→`ValidateHivePlacement(hive.tenantId, hiveId)`→set `tenantId = hive.tenantId` + `hiveId` on the record; `environment-placement.ts` passes the platform `tenantId`; `CreateBody`/route/`ToDto`/`EnvironmentDto` carry the fields; wire `server.ts`.
- [ ] **Step 4:** Run green (all four commands).
- [ ] **Step 5:** Commit `feat(env): bind an environment to its platform tenant via its hive`.

### Task 4: One-shot environment-id field migrator

**Files:** Create `admin/control-plane/migrate-environment-id.ts` (+ a tests file). (Scope confirmed small: on-disk dir names, JSON map keys, and secret-ref strings are keyed by the id VALUE and do NOT change; only the persisted literal FIELD `tenantId` renames.)

**Interfaces:** Produces `class EnvironmentIdMigrator` with `Migrate(dataRoot: string): Promise<{ changed: number }>` — rewrites the literal `tenantId` field→`environmentId` in the control-plane `environments.json` records and in any bundle `tenant-config.json`/env-definition JSON that carries a literal `tenantId` field; leaves everything else (dir names, map keys, secret refs, the new platform `tenantId`) untouched; idempotent.

- [ ] **Step 1: Write failing tests:** a fixture data root whose `environments.json` has records with a legacy `tenantId` field → after `Migrate`, those records have `environmentId` (same value) and no `tenantId` field; a second `Migrate` run reports `changed: 0` (idempotent); records already using `environmentId` are untouched.
- [ ] **Step 2:** Run the test — FAIL.
- [ ] **Step 3:** Implement the migrator (read-modify-write the JSON files; header comment: run once on an existing data root before starting the renamed control-plane; it is a standalone script, not in `npm test`).
- [ ] **Step 4:** Run green.
- [ ] **Step 5:** Commit `feat(env): one-shot tenantId->environmentId persisted-field migrator`.

---

## Final verification (before whole-branch review)
- All four commands green; gated smokes type-check.
- `git diff --stat master..HEAD` shows zero changes under `src/idp/`, the platform records/registries, `operator-identity.ts`, and the C host-authz/audit files.
- Whole-branch review on the most capable model, Review-Focus items re-checked (no B/C leak, behavior-preserving rename, placement uses platform tenant, unbound still works, migrator idempotent).
