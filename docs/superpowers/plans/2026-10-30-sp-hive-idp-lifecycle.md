# SP-HIVE IdP Lifecycle + Env-Id Rename (SH-E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rename the tenant-plane session profile key `tenant`→`environment`, and tear down a tenant's per-tenant IdP on tenant-delete.

**Spec:** `docs/superpowers/specs/2026-10-30-sp-hive-idp-lifecycle-design.md` (acceptance + rulings — read it).

## Global Constraints

- ASCII + LF for pragmatic-server files (control-plane-host.ts keeps 6 non-ASCII). **Byte-scan BASE of each tenant-portal file before editing — match base EOL, do NOT flip** (some tenant-portal files are CRLF at base). Byte-scan each touched file on the way out.
- OOP + Allman braces; no inline string literals (hoist to `private static readonly`); VMs extend `Observable`; PascalCase public members; `admin/portal`↔`admin/tenant-portal` separate.
- Gates: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`; tenant-portal `npm --prefix admin/tenant-portal test` + `npm --prefix admin/tenant-portal run typecheck`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path; never `git add -A`; never docs.

## Review Focus

- No remaining reader of the old `tenant` profile key (missed consumer = runtime break); served key is exactly `environment`.
- Fail-closed tenant-delete (teardown failure must not strand a deleted-record-with-live-IdP; `TenantHasHivesError` guard precedes; `platform-directory` stays IdP-free).
- Tenant-delete for a tenant with no IdP is a safe no-op.

---

### Task 1: Rename tenant-plane session profile key `tenant` → `environment`

**Files:** `admin/control-plane/tenant-api/tenant-profile-dto.ts` (DTO + mapper), tenant-portal consumers `admin/tenant-portal/src/{tenant-types.ts,identity-plate.ts,settings-view.ts,tenant-app.ts}`, their tests under `admin/control-plane/tests/` and `admin/tenant-portal/tests/`.

- [ ] Failing test(s): the served `TenantProfileDto` exposes `environment` (not `tenant`); a tenant-portal test reads `profile.environment`.
- [ ] Rename `TenantProfileDto.tenant` → `environment` + `ToDto`/mapper; update every tenant-portal reader + type; leave `session.tenantId` and internal ids untouched. Grep the whole tenant-portal + tenant-api for the old key to confirm none remain.
- [ ] Verify control-plane gate + typecheck:tools + tenant-portal test + tenant-portal typecheck; byte-scan each touched file (match base EOL). Commit (explicit paths).

### Task 2: Tear down a tenant's per-tenant IdP on tenant-delete

**Files:** `admin/control-plane/idp-service.ts` (+ its interface), `admin/control-plane/control-plane-host.ts` (tenant-delete wiring), possibly `admin/control-plane/idp-registry.ts` (record lookup); tests.

- [ ] Failing test: deleting a tenant that HAS an IdP record calls `driver.Discard` (via `IdpService.TeardownForTenant`); a tenant with NO IdP record is a no-op (no throw); `platform-directory` is not changed to import the IdP service; the `TenantHasHivesError` guard still precedes.
- [ ] Add `IdpService.TeardownForTenant(tenantId)` → lookup `IdpRegistry` record → `driver.Discard(record)` (no-op if absent). Wire it into the host's tenant-delete path (fail-closed per the DeleteHive→DestroyCluster pattern). Keep `platform-directory` IdP-free.
- [ ] Verify control-plane gate + typecheck:tools; byte-scan (control-plane-host.ts stays `6 0 N`). Commit (explicit paths).

## Final verification (whole branch)

- `npx tsx --test admin/control-plane/tests/*.test.ts` — all pass.
- `npm --prefix admin/tenant-portal test` + `npm --prefix admin/tenant-portal run typecheck` — pass / exit 0.
- `npm run typecheck:tools` — exit 0.
- Byte-scan every touched file (base EOL preserved; control-plane-host.ts `6 0 N`).
