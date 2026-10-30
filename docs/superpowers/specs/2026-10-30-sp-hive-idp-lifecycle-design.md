# SP-HIVE IdP lifecycle + env-id rename (SH-E)

**Status:** design — 2026-10-30.
**Program:** SP-HIVE 100% burn-down, batch SH-E. Two honestly-buildable
SP-HIVE-6c/7 lifecycle follow-ups (pragmatic-server + tenant-portal).

## Scope note (what's in, what's deferred)

- **IN:** (1) rename the tenant-plane session/profile response key
  `tenant` → `environment`; (2) tear down a tenant's per-tenant IdP on
  tenant-delete.
- **DEFERRED (not here):** "deregister a bound environment's OIDC client on
  env-delete" — `IdpAdminClient` is PUT/POST-only; the IdP admin API exposes no
  DELETE-client endpoint, so honestly closing it needs the IdP product (a
  sibling repo) to add one. Grouped with the identity-sibling wave, not
  fabricated here.

## Items + acceptance + rulings

1. **Rename `/auth/session` (tenant profile) response key `tenant` →
   `environment`** (SP-HIVE-6c/7). At the env plane the server's "tenant" IS an
   environment (see the platform-admin tenant-semantics: Client→Tenant→
   Environment→Application; the env-plane `tenantId` is really an environment
   id). The tenant-plane profile DTO (`tenant-api/tenant-profile-dto.ts`,
   `TenantProfileDto.tenant`) must expose the block under the key `environment`
   instead of `tenant`; update the mapper and EVERY tenant-portal consumer
   (`identity-plate.ts`, `settings-view.ts`, `tenant-app.ts`, `tenant-types.ts`)
   and their tests. **Ruling:** rename only the `tenant` PROFILE key to
   `environment`; leave `session.tenantId` and other internal identifiers
   untouched (the internal field name is out of scope — this is the wire-key
   rename only). No behaviour change beyond the key name + the display label it
   feeds. Acceptance: the served profile has `environment` (not `tenant`); the
   portal reads `environment`; control-plane AND tenant-portal gates green.

2. **Tear down a tenant's per-tenant IdP on tenant-delete** (SP-HIVE-6c). Today
   `platform-directory.DeleteTenant` only guards `TenantHasHivesError` and
   removes the record; the tenant's IdP container/realm (created by
   `IdpService.EnsureForTenant`) is left running. The driver can already destroy
   it: `IIdpWorkloadDriver.Discard(record)` exists (DockerIdpDriver +
   in-cluster). **Ruling:** add `IdpService.TeardownForTenant(tenantId)` that
   looks up the tenant's IdP record (`IdpRegistry`) and calls `driver.Discard`
   (a no-op when the tenant has no IdP record). Wire it at the orchestrator/
   service-owning layer — the host's tenant-delete path
   (`control-plane-host.ts` `DeletePlatform`) — NOT in `platform-directory`
   (which stays IdP-free). **Fail-closed order:** keep the existing
   `TenantHasHivesError` guard, then remove the record, then tear down the IdP
   best-effort — OR teardown-then-remove; choose so a teardown failure does not
   strand a deleted-record-with-live-IdP. Match the DeleteHive→DestroyCluster
   pattern already established (guard → act → remove, record kept on failure).
   Acceptance: deleting a tenant with an IdP calls `Discard`; a tenant with no
   IdP record is a no-op; `platform-directory` never imports the IdP service.

## Constraints (Global)

- ASCII + LF. Every pragmatic-server target file is LF at base; preserve.
  `control-plane-host.ts` keeps its 6 non-ASCII bytes. **Byte-scan BASE of each
  tenant-portal file before editing** — some tenant-portal files are CRLF at
  base; match base EOL, do NOT flip. Byte-scan each touched file on the way out.
- OOP + Allman braces; no inline string literals (hoist to
  `private static readonly`); enums over string unions; VMs extend `Observable`;
  PascalCase public members; `admin/portal`↔`admin/tenant-portal` stay separate.
- Gates: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` +
  `npm run typecheck:tools`; tenant-portal `npm --prefix admin/tenant-portal test`
  + `npm --prefix admin/tenant-portal run typecheck`.
- Merge locally (ff-only); **NEVER push.**

## Review focus

- **Rename completeness:** no remaining reader of the old `tenant` profile key
  (a missed consumer is a runtime break); the served key is exactly
  `environment`.
- **Fail-closed tenant-delete:** a teardown failure must not leave a
  deleted-record-with-live-IdP (or, if remove-then-teardown, must surface the
  error); the `TenantHasHivesError` guard still precedes everything;
  `platform-directory` stays IdP-free.
- **No-op safety:** tenant-delete for a tenant that never had an IdP must not
  error.
