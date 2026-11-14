# Tenant / Environment / Realm rename: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every "tenant" that means an environment says "environment", the identity packages' `Tenant` says `Realm`, and customer "tenant" stays; stored and wire names follow with old-name readers for one release.

**Architecture:** Bottom-up across sibling repositories under `D:\architecture-agent`. The identity packages and pragmatic-protocol are consumed as file-linked built `dist`, so each must be rebuilt (`npm run build`) before its dependents compile. Each repository gets branch `feat/realm-environment-rename`, merged locally (fast-forward) into its default branch when its suite is green.

**Tech Stack:** TypeScript (ESM, strict), node:test via tsx, Playwright e2e (Plexus), kind + kubectl (live check).

**Spec:** `D:\architecture-agent\pragmatic-server\docs\superpowers\specs\2026-11-14-tenant-environment-realm-rename-design.md`

## Global Constraints

- Customer meaning keeps "tenant" (control plane customers, tenant plane/admin/api/auth, IdP per tenant, Plexus account/sign-in, desktop discovery wire `tenants`/`tenantPlaneUrl`/`tenantId`/`tenantName`, `PLEXUS_E2E_TENANT`, `stack.json` `tenant`, `PRAGMATIC_TENANT_ADMIN_*`, control plane `<dataRoot>/tenants.json`, `registry.json` `environments.*.tenantId`).
- Never rename: `aadTenantId`, `MissingTenantError`, `login.microsoftonline.com/<tenant>`, value-keyed formats (`<id>/svctok/<hash>`, `<id>/pwhash/<pid>`, `local-source-token-key/<id>`, `upstream-token/<id>/<pid>`, `system:<id>`), Redis keys, `<baseDir>/<envId>/...` layout, cookie names `ps_session`/`idp_sso`, test fixtures about Microsoft tenants (`ms.tenant`, `concept Tenant`).
- `ResourceKind.Realm` keeps numeric value 0 (was `Tenant`).
- Old stored/config names: read old OR new (new wins when both present), always write new.
- Code style (all repos): OOP, Allman braces, PascalCase public members, literals hoisted to `private static readonly`, tests in `tests/` folders, CRLF files keep CRLF.
- Commits: `git -c user.name="Eugene Napryaglo" -c user.email="evgen.napryaglo@gmail.com" commit`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; stage explicit paths only; no `sed -i`/scripted edits of repo files (use the editor). Never push or publish (owner decides).
- Never touch: `admin/control-plane/data/`, Plexus `apps/plexus/electron.vite.config.ts`, `framework-typings.generated.ts`, `packages/plexus-core/src/vite/mural-renderer.ts` (+ test), Plexus `e2e/fixtures/*` local edits, server untracked `docs/design/`.

## Review Focus

1. A stored identity file holding both the old and the new field (half-migrated) → the new field wins; the next write drops the old one. (Task 4 test.)
2. An admin request or stored audit record using the kind name `"Tenant"` → treated as `Realm`. (Task 7 test on `admin-enums`.)
3. An environment pod started by the new image with the OLD ConfigMap (`PRAGMATIC_TENANTS_FILE`, `tenants.json`, root key `tenants`) → starts and serves. (Task 8 test, Task 12 live.)
4. `realm-config.json` and a stale `tenant-config.json` both present → `realm-config.json` wins and the stale file is not read. (Task 4 test.)
5. A customer-meaning wire name accidentally renamed (desktop discovery, `/desktop/console`, `stack.json`) → Plexus sign-in breaks. (Task 9 pins the discovery and console JSON keys in a test; Task 12 live-loop sign-in proves it.)

---

### Task 1: todl-identity core types → Realm

**Files:** `D:\architecture-agent\todl-identity\src\**` (production + tests). Rename `src/core/tenant.ts` → `src/core/realm.ts`, `src/provider/tenant-config-store.ts` → `realm-config-store.ts`, `src/provider/tenant-resolver.ts` → `realm-resolver.ts`.

**Interfaces — Produces (exact names later tasks use):**
- `Realm` (was `Tenant`: `Id`, `Kind`, `DisplayName`, `IsSelfHosted()`), `RealmKind { Saas, SelfHosted }`.
- `ResourceKind.Realm = 0` (member order unchanged).
- `IRealmConfigStore` (`Get(realmId)`, `Save(realmId, …)`), `RealmConfigStoreKey` (description `"IdentityRealmConfigStore"`), `IRealmResolver`, testing `FakeRealm`.
- Member renames `TenantId` → `RealmId` on `Principal`, `Session`, `ResourceRef`, `LocalAccount`, `LocalGroup`, `ServiceTokenGrant`, `SourceTokenRequest`, `AuditEvent`, `UnreadableIdpDirectoryRecordError`; `AccessContext.Tenant` → `.Realm`; every parameter `tenant: Tenant` → `realm: Realm`, `tenantId` → `realmId` (IAuthenticator, ILocalAccountStore, ILocalGroupStore, IPrincipalDirectory, IRoleGrantStore, IServiceTokenStore, ISessionManager.RevokeAllFor, IIdpDirectorySource, IIdpDirectoryStore, IIdentityProviderRegistry.PackFor, IdpDirectorySync.Run, PerUserSourceTokenCache.Forget).
- Error text: `"stored IdP directory record is unreadable for realm "`.

- [ ] Step 1: `git switch -c feat/realm-environment-rename`.
- [ ] Step 2: Rename files/symbols/members/parameters as listed; update `src/index.ts` and `./testing` barrels (old names are NOT kept — consumers are file-linked and change in Tasks 2-9).
- [ ] Step 3: Add test `ResourceKind.Realm keeps the stored value 0` in the enum's tests folder: `assert.equal(ResourceKind.Realm, 0)`.
- [ ] Step 4: `npx tsc --noEmit -p .` and the repo test script pass; `grep -rn -i tenant src` shows no identity-boundary uses left (report any remaining hit with its reason).
- [ ] Step 5: `npm run build`; commit "refactor: the identity boundary is a Realm (was Tenant)".

### Task 2: todl-identity-local and todl-identity-host → Realm

**Files:** `todl-identity-local\src\**`, `todl-identity-host\src\**`; host folder `src/tenancy/` → `src/realm/`.

**Interfaces — Consumes:** Task 1. **Produces:** host `InMemoryRealmConfigStore`, `MappingRealmResolver`, `SingleRealmResolver`, `ConfigurableIdentityProviderRegistry.SingleRealm(…)`, `AuditCheckpoint.RealmId`, `AuditTamperDetected.RealmId`, `IAuditCheckpointStore.Realms()` / `Latest(realmId)`, `IAuditCheckpointSigner.Sign/Verify(realmId, …)`, `AuditAnchoring.VerifyAll(chain, chainRealms)`; local `LocalSourceTokenProvider.Verify(realmId, …)`. Error texts: `"audit chain tamper detected for realm "`, `"No identity configuration for realm: "`, `"realm id and principal id must not contain the key separator"`.

- [ ] Step 1: Branch in both repos. Step 2: rename per the list (keep the value-keyed key formats exactly). Step 3: typecheck + tests green in local, then host. Step 4: build both; commit each repo.

### Task 3: todl-identity-cloud and todl-identity-engine → Realm

**Files:** `todl-identity-cloud\src\**`, `todl-identity-engine\src\**` (`security/tenant-security-model.ts` → `realm-security-model.ts`).

**Produces:** engine `RealmSecurityModel` (was `TenantSecurityModel`); cloud public params `realmId`/`realm` on `OnBehalfOfTokenProvider.Forget`, `IRevocableSourceTokenProvider.Forget`, `UpstreamTokenVault.Put/Get/Delete`, `BeginAuthorization`, `ClaimsMapper.Map`, `GroupRoleMapper.ApplyGroups`. Cloud keeps `aadTenantId`, `MissingTenantError`, Entra URL, `google-identity-profile.ts` comment, `fake-oidc-idp.ts` issuer `https://idp.test/tenant`.

- [ ] Step 1: Branch both. Step 2: rename. Step 3: typecheck + tests green. Step 4: build; commit each.

### Task 4: todl-identity-node → Realm, with stored-name migration

**Files:** `todl-identity-node\src\**`: `accounts/file-account-store.ts`, `sessions/file-session-store.ts`, `tokens/file-service-token-store.ts`, `grants/file-role-grant-store.ts`, `audit/file-audit-sink.ts`, `audit/file-audit-checkpoint-store.ts`, `directory/file-idp-directory-store.ts`, `config/file-tenant-config-store.ts` → `file-realm-config-store.ts`, `config/invalid-tenant-config-error.ts` → `invalid-realm-config-error.ts`.

**Produces:** `FileRealmConfigStore`, `InvalidRealmConfigError` (`.RealmId`, text `"stored realm config record is malformed"`), `FileAuditCheckpointStore.Realms()`.

Stored names (read old or new, new wins, write new):
| File | Old | New |
|---|---|---|
| accounts.json (accounts[], groups[]) | `tenantId` | `realmId` |
| sessions.json | `tenantId` | `realmId` |
| service-tokens.json | `tenantId` | `realmId` |
| grants.json | `resourceTenantId` | `resourceRealmId` |
| audit.json events[] | `tenantId` | `realmId` |
| audit-anchors.json checkpoints[] | `tenantId` | `realmId` |
| idp-directory.json root | `tenants` | `realms` |
| file name | `tenant-config.json` | `realm-config.json` (read old only when new is absent; first save writes new and deletes old) |

Follow the existing precedent (`LegacyAccountRecord`, `SecurityModelMigration`): one small static reader per record shape that maps a legacy record to the current one. Audit: field order of written records unchanged except the name; hash/HMAC inputs untouched.

- [ ] Step 1: Branch. Step 2: For each row write a failing test in that store's `tests/` folder named `reads a legacy <file> written with <old> and writes <new>`: write a JSON file with the old name, open the store, assert the record's `RealmId`, trigger a save, assert the file now has the new name and not the old. Add `prefers the new name when a record carries both` (accounts.json) and `ignores a stale tenant-config.json when realm-config.json exists`. Add `an audit chain written before the rename still verifies` (old `tenantId` audit.json + anchors → `VerifyAll` passes).
- [ ] Step 3: Run them: FAIL. Step 4: Implement the renames and readers. Step 5: full suite + typecheck green. Step 6: build; commit.

### Task 5: todl-platform-cloud SQL stores

**Files:** `D:\architecture-agent\todl-platform-cloud\src\identity\sql-*.ts` (+ tests).

**Produces:** stores implement the Realm interfaces; SQL column `tenant_id` → `realm_id` in all 8 tables; table `identity_tenant_config` → `identity_realm_config`.

- [ ] Step 1: Branch. Step 2: Failing test `migrates a database created with tenant_id columns`: create the old schema (as today's code creates it), run the store's schema setup, assert `realm_id` columns and `identity_realm_config` exist and existing rows are readable. Step 3: Implement an idempotent startup migration (rename only when the old name exists) using the dialect(s) the stores already support; rename code identifiers. Step 4: suite + typecheck green; build; commit.

### Task 6: pragmatic-protocol doc comments

**Files:** `pragmatic-protocol\src\contracts\admin-protocol.ts:4`, `cypher-protocol.ts:13`, `pragmatic-app-deploy-protocol.ts:4`, `pragmatic-app-protocol.ts:4`, `transport/tests/browser-socket-dialer.test.ts:94` (`TenantUrl` → `EnvironmentUrl`).

- [ ] Step 1: Branch. Step 2: Reword "tenant" → "environment" (development/runtime environment). Step 3: tests + build; commit.

### Task 7: pragmatic-server — identity adoption across `src/` (+ IdP)

**Files:** every `src/**` file importing the renamed identity symbols (≈20 production: e.g. `src/identity/identity-module.ts`, `identity-pack-resolver.ts`, `runtime-principals.ts`, `server-bootstrap.ts`, `src/platform/node-platform.ts`, `cloud-platform.ts`, `src/host/admin-service.ts`, `src/host/environment/*`, `src/pragmatic-server.ts`; plus `src/idp/*`) and tests.

**Produces:** `PragmaticServer.Realm(): Realm` (was `Tenant()`); `src/host/admin-enums.ts` parses kind names `"Realm"` and `"Tenant"` (alias) to `ResourceKind.Realm`, names it `"Realm"`; `server-connection-handler.ts` `DefaultResourceKind` = `Realm`; audit sinks (`file-access-audit-sink.ts`, `sql-access-audit-sink.ts`) write the kind name `"Realm"`. In `src/idp/`: identity types become Realm; customer-meaning names stay (`clients.json` `tenantId`, `PRAGMATIC_IDP_TENANTS`, realm-per-tenant wording, admin API `{tenantId}`).

- [ ] Step 1: Branch. Step 2: Failing test in `src/host/tests/`: `admin kind name "Tenant" is accepted as Realm and named Realm` (parse `"Tenant"` → `ResourceKind.Realm`; name of `ResourceKind.Realm` → `"Realm"`). Step 3: Adopt the Realm names; mixed sites per the spec rule (accounts/sessions/grants → realm). Step 4: `npx tsc -p tsconfig.build.json --noEmit` + `npm test` green; commit.

### Task 8: pragmatic-server — environment server says "environment"

**Files:** `src/tenancy/` → `src/environments/` (all files: `tenant-registry.ts` → `environment-registry.ts`, `tenant-provisioning.ts`, `tenant-purpose.ts`, …), `src/config/` (`file-tenant-provisioning.ts` → `file-environment-provisioning.ts`, `server-config-loader.ts`), `src/cluster/*` (`redis-tenant-ownership.ts` → `redis-environment-ownership.ts`, `gateway.ts`, `worker-host.ts`), `src/host/*` env-meaning sites (`pragmatic-server-host.ts` `TenantHint` → `EnvironmentHint`, `rate-limiter.ts`, `rate-limit-guard.ts`, `auth-http-endpoint.ts`, `browser-session-auth.ts` `CookieTenant` → `CookieEnvironment`, `apps/app-session-check.ts`), `src/observability/request-instrumentation.ts`, `src/bin/*`, `src/packaging/*`, `environments/seed/*`, `docker/`, `docker-compose*.yml`, `helm/pragmatic-server/**`, tests.

**Produces:** `EnvironmentRegistry`, `EnvironmentProvisioning`, `EnvironmentPurpose`, `EnvironmentOwnedElsewhereError`, `InMemoryEnvironmentProvisioning`, `FileEnvironmentProvisioning`; env var constant `PRAGMATIC_ENVIRONMENTS_FILE`; file `environments.json` root key `environments`.

Compatibility (one release): `server-config-loader` reads `PRAGMATIC_ENVIRONMENTS_FILE`, else `PRAGMATIC_TENANTS_FILE` (logs one deprecation line); `FileEnvironmentProvisioning` accepts root key `environments` or `tenants` (new wins). Helm template reads `.Values.environments` falling back to `.Values.tenants`; writes the new var and file.

No alias: `/auth/session` + `/auth/browser-login` JSON `tenant` → `environment`; OTel label `tenant` → `environment`; `rate_limited_total` scope value `"tenant"` → `"environment"` (`RateLimitScope.Environment`); audit JSONL field `tenant` → `environment` (keep field order); logs `tenants=<n>` → `environments=<n>`, `… tenant <id>` → `… environment <id>`.

- [ ] Step 1: Failing tests: `reads the legacy PRAGMATIC_TENANTS_FILE when the new variable is unset`, `prefers PRAGMATIC_ENVIRONMENTS_FILE when both are set`, `reads a legacy tenants.json with root key "tenants"`, `/auth/session answers {environment, principalId, expiresAt}`. Step 2: FAIL. Step 3: Rename + compat. Step 4: build typecheck, `npm test`, `npm run typecheck:tools` green; commit.

### Task 9: pragmatic-server — control plane islands, docs

**Files:** `admin/control-plane/env-server-seed.ts` (ConfigMap `<env>-tenants` → `<env>-environment`, data key `environments.json`, writes `PRAGMATIC_ENVIRONMENTS_FILE`), `k8s-manifest-builder.ts` (`TenantsFileVar` → `EnvironmentsFileVar`; nothing else), `control-plane-smoke.ts` (`TenantsFile` only), `environment-seed-port.ts`, `template-catalog.ts` (`TenantPurposeName` → `EnvironmentPurposeName`), `environment-service.ts:171` + `live-loop/loop-orchestrator.ts:179/435` + `environments/seed/users.ts` + `control-plane-smoke.ts:460` (kind `'Tenant'` → `'Realm'`), `live-loop/loop-orchestrator.ts:288` descriptor field `tenant` → `environment`, `tenant-api/tenant-profile-dto.ts` field `environment` → `tenant` (+ `admin/tenant-portal/src/tenant-types.ts:15` and its users), `desktop-sign-in-smoke.ts:64,336-338`, `migrate-environment-id.ts` (comments only; never touch `registry.json` `tenantId`), docs (README.md, ARCHITECTURE.md, admin/README.md, dev README + dev-info, docker/README.md, docker/compose-README.md, environments/README.md, helm README + NOTES.txt + values comments, idp-login/README.md, runbooks under docs/superpowers/runbooks).

Existing environments: when re-applying an environment whose ConfigMap is `<env>-tenants`, the seeder deletes the old ConfigMap after writing the new one.

- [ ] Step 1: Failing tests: `the env seed writes ConfigMap <env>-environment with environments.json and PRAGMATIC_ENVIRONMENTS_FILE`, `re-applying an environment removes the legacy <env>-tenants ConfigMap`, `desktop discovery and /desktop/console keep their tenant field names` (pins `tenants`, `tenantPlaneUrl`, `tenantId`, `tenantName`). Step 2: FAIL. Step 3: implement. Step 4: control-plane suite (`npx tsx --test "admin/control-plane/**/*.test.ts"`), `npm test`, `npm run typecheck:tools`, both portal builds green; commit.

### Task 10: TODL → environment names, release 0.65.0

**Files:** `TODL\src\graph-api\browser\remote-tenant-connector.ts` → `remote-environment-connector.ts`, `tenant-write-client.ts` → `environment-write-client.ts`, `tenant-document-assembler.ts` → `environment-document-assembler.ts` (+ tests; `graph-api/wire/tests/cypher-wire.test.ts:23` path), `src/index.ts`, `build-system-core/build-options.ts`, `html-bundle/emit-remote-data-action.ts` (+ comments in emit-remote-host-action, html-artifacts, html-bundle-build-system, servable-manifest, todl-app-bootstrap), `package.json` version.

**Produces:** `RemoteEnvironmentConnector`, `IEnvironmentReadClient`, `IEnvironmentWriteClient`, `EnvironmentDocumentAssembler`, `EnvironmentNodeCell`, `EnvironmentFieldCell`, `RemoteBuildTarget.Environment?: string`; deprecated aliases exported from `src/index.ts` for the old names (`/** @deprecated use … */ export { RemoteEnvironmentConnector as RemoteTenantConnector }`, type aliases for interfaces); `RemoteBuildTarget.Tenant?` kept, marked deprecated, used when `Environment` is unset. Generated code: `CypherEnvironmentClient`, query param `environment` (`EnvironmentParam = "environment"`). Message: `"Remote environment connector is read-only; writes arrive in SP1"`.

- [ ] Step 1: Failing tests: `the dev URL override sends ?environment=` (`wss://srv.example.com/ws?environment=acme`), `a build target with the deprecated Tenant option still sets the environment`, `the old export names still resolve to the new classes`. Step 2: FAIL. Step 3: implement. Step 4: full suite + typecheck; `npm run build`; bump `package.json` to `0.65.0`; commit "Release todl 0.65.0 (environment names)".

### Task 11: Plexus → "Publish to environment"

**Files:** `packages/plexus-core/src/renderer/modules/solution-explorer/services/publish-tenant-contributor.ts` → `publish-to-environment-contributor.ts` (+ test), `publish-target-dialog.ts` (+ test), `solution-explorer-service.ts`, `packages/plexus-core/src/renderer/modules/tenant-publish/` → `environment-publish/`, `packages/plexus-core/src/shared/tenant-publish-api.ts` → `environment-publish-api.ts`, `apps/plexus/src/main/tenant-publish/` → `environment-publish/` (`tenant-deploy-service.ts`, `tenant-publish-ipc.ts`, tests), `apps/plexus/src/shared/tenant-publish-api.ts`, `apps/plexus/src/renderer/src/services/tenant-publish/` → `environment-publish/`, `apps/plexus/src/preload/index.ts`, `apps/plexus/src/main/index.ts`, `apps/plexus/src/renderer/src/app.mu`, `packages/plexus-core/src/shared/account-api.ts:297` (comment only), e2e `runtime-live-loop.spec.ts`, `sp1-plexus-smoke.spec.ts`, `support/orchestrator-client.ts`; TODL renames where Plexus uses them.

**Produces:** `PublishToEnvironmentContributor` (ServiceKey `'PublishToEnvironmentContributor'`), command `environment.publish`, labels `'Publish to environment'`, failure `'Publish to environment failed ('`, `IEnvironmentPublisher`/`EnvironmentPublisherKey` (`'EnvironmentPublisher'`), `EnvironmentPublishStatus`/`EnvironmentPublishResult`, `EnvironmentDeployService`, `EnvironmentPublishIpc`, `IEnvironmentPublishApi`/`IEnvironmentPublishBridge`, channel `'environment-publish:deploy'`, `window.api.environmentPublish`, `IpcEnvironmentPublisher`. e2e: class-name lookups use `'PublishToEnvironmentContributor'`; `RuntimeDescriptor.environment` (reads `environment ?? tenant`). Customer names stay (account, sign-in, "tenant console" texts, `PLEXUS_E2E_TENANT`).

- [ ] Step 1: Branch. Step 2: Rename; update tests' expected labels/command ids. Step 3: Plexus unit suites for plexus-core and apps/plexus + typecheck green (pre-existing typecheck noise from the owner's untracked `e2e/fixtures/contoso/build-remote/` is not ours — report, don't fix). Step 4: `npm run build` in apps/plexus; commit.

### Task 12: Integration and live migration check

- [ ] Step 1: Rebuild the server image (`DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=$HOME/.pragmatic/ghrc-read.npmrc -t pragmatic-server:dev .` from `D:\architecture-agent`), kind-load into `pragmatic-e2e`.
- [ ] Step 2: Migration on real data: restart the e2e control plane on the new code (same data root); confirm operator login, tenant owner sign-in through the IdP; restart the IdP container on the new image (same volume) and sign in again; roll `loop-rt`'s server onto the new image while its ConfigMap is still `<env>-tenants` → it starts and serves Contoso.
- [ ] Step 3: `loop-orchestrator.ts teardown`, then the Plexus live-loop (`SP_RUNTIME_LOOP_E2E=1 SP_RUNTIME_LOOP_KEEP=1 PLEXUS_E2E_STACK=~/.pragmatic/e2e-stack/stack.json npx playwright test e2e/runtime-live-loop.spec.ts`) passes; the new environments carry `<env>-environment` ConfigMaps.
- [ ] Step 4: Fast-forward merge every repository's branch into its default branch; file the GitHub Project item "Remove tenant→realm/environment compatibility readers" (Kind=Feature, Status=Todo) listing every old-name reader added.
