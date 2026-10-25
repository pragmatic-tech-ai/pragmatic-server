# Tenant-Plane Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish severing operator-side tenant mutations and clean the tenant-admin build: relocate the per-environment identity-admin surface off the operator onto the tenant plane, and move the tenant-admin entrypoint under `admin/` so the `src/bin → admin/` build hack disappears.

**Architecture:** Two independent follow-ups off the tenant-admin container-extraction slice. (1) The tenant-admin entrypoint moves from `src/bin/` into `admin/control-plane/bin/` so it no longer crosses the main build's `rootDir: "src"`; the `tsconfig.build.json` exclusion is deleted and every hardcoded `dist-tenant-admin/src/bin/...` path is repointed. (2) The identity-admin HTTP routes (accounts/grants/security-model/config/snapshot/maker-token/app-reader) move from `ControlPlaneHost` onto `TenantApiEndpoint`, scoped to `session.tenantId` with the same ownership-404 guard the tenant plane already uses; the shared `EnvironmentService.Admin*` service layer is unchanged. The now-orphaned operator-portal identity UI is removed to keep the operator portal coherent.

**Tech Stack:** TypeScript (NodeNext ESM, `verbatimModuleSyntax`), node:test + tsx, the existing `admin/control-plane` HTTP hosts, mural for `admin/portal`.

**Spec:** `docs/superpowers/specs/2026-10-25-platform-and-tenant-admin-app-separation-design.md` (the two-admin-app separation design). This plan implements two of its filed follow-ups: "Relocate per-env identity-admin to the tenant plane" and "Move the tenant-admin bin out of src/bin into admin/".

## Global Constraints

- OOP only: methods/statics on classes; no module-level free functions or mutable module state. `const` compile-time constants and type/enum declarations are fine.
- Allman braces (opening brace on its own line) for every class/interface/enum/method/control-flow block. Hand-maintained; match surrounding code.
- No inline string literals: hoist user-facing text and any reused literal to `private static readonly` PascalCase constants. Structural single-use tokens may stay inline.
- PascalCase for interfaces and all public methods.
- Security discipline (verbatim, non-negotiable): credentials/keys/tokens/secrets/auth-codes and inner-error text are held server-side by name only — NEVER in logs, DTOs, errors, thrown messages, or persisted records. Manifests carry secret REFs, not values.
- Tests live in a `tests/` subfolder (`admin/control-plane/tests/`, `admin/portal/tests/`); files `*.test.ts`.
- LF-only line endings; do not flip files to CRLF. `agent-channel-host.ts` is pre-existing CRLF — do not touch it here.
- NEVER `npm install` at the repo root (breaks workspace symlinks).
- Typecheck gates: `npx tsc -p tsconfig.tools.json --noEmit` AND `npx tsc -p tsconfig.tenant-admin.json --noEmit` must both be clean. Operator portal: `npx tsc -p admin/portal/tsconfig.json --noEmit`.
- Control-plane unit suite (`npx tsx --test "admin/control-plane/tests/*.test.ts"`) must stay green (baseline 621 pass).
- Git commits end with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer. Do not push.

## Review Focus

- **Cross-tenant identity access:** a tenant session must never reach another tenant's environment identity surface. Every relocated route resolves the env record and returns 404 (never 403, never a different body) unless `rec.tenantId === session.tenantId`. Covered by Task 2 cross-tenant tests.
- **Secret leakage through the relocated routes:** `AdminIssueMakerToken` / `AdminGrantAppReader` / config/security-model responses must carry only the protocol DTO shapes, never raw secrets or inner-error text; a failing `service.Admin*` call must map to a fixed generic status+`{error}` body. Covered by Task 2 error-mapping tests.
- **Dead operator UI / dead routes:** after relocation the operator portal must not call a removed route (no runtime 404 buttons) and the operator host must not expose the removed patterns. Covered by Task 2 (operator-no-longer-routes) + Task 3 (portal client surface removed).
- **Build-path drift:** every consumer of the old `dist-tenant-admin/src/bin/pragmatic-tenant-admind.js` path (package bin, k8s manifest command, manifest test, Dockerfile, smoke comment) must be repointed to the new emitted path, or the container boots a missing entrypoint. Covered by Task 1 (manifest test asserts the new command; `build:tenant-admin` emits at the new path).
- **Collapsed-dev + standalone parity:** the entrypoint relocation and the identity routes must leave both the collapsed `Main` and the standalone `TenantAdminServer` wirings working; no behavioral change to `EnvironmentService.Admin*`. Covered by the control-plane unit suite staying green and both tsconfigs typechecking.

---

### Task 1: Move the tenant-admin entrypoint under `admin/`

**Files:**
- Create: `admin/control-plane/bin/pragmatic-tenant-admind.ts` (the relocated entrypoint)
- Delete: `src/bin/pragmatic-tenant-admind.ts`
- Modify: `tsconfig.build.json` (remove the exclusion), `tsconfig.tenant-admin.json` (update `include`), `package.json` (bin path), `admin/control-plane/k8s-manifest-builder.ts:~170` (`TenantAdminEntrypoint`), `docker/Dockerfile` (build/copy/comment lines ~62,66,68,69 — the `cp` SPA target stays `dist-tenant-admin/admin/tenant-portal/dist`), `admin/control-plane/tenant-admin-smoke.ts:~6` (comment)
- Modify test: `admin/control-plane/tests/tenant-admin-manifest.test.ts:~68` (expected `command`)

**Interfaces:**
- Consumes: `TenantAdminServer.Main()` (unchanged).
- Produces: the compiled entrypoint now lands at `dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js` (because `tsconfig.tenant-admin.json` keeps `rootDir: "."` from `tsconfig.tools.json`). This exact string is the new value everywhere the old `dist-tenant-admin/src/bin/pragmatic-tenant-admind.js` appeared.

**Ruling (recorded):** The item says "so the main build owns it." The main build (`tsconfig.build.json`) has `rootDir: "src"` and emits only `src/` → `dist/`; it does not and should not emit `admin/` (broadening `rootDir` to `.` would relocate every `dist/...` artifact and break the package `main`/exports — out of scope, rejected). So the dedicated admin-emitting build (`tsconfig.tenant-admin.json`) stays; what actually goes away is the `tsconfig.build.json` *exclusion hack*, because the entrypoint no longer lives under `src/`. This satisfies the item's real intent (kill the cross-rootDir edge + the exclusion) without the invasive rootDir change.

- [ ] **Step 1: Write/adjust the failing manifest test**

In `admin/control-plane/tests/tenant-admin-manifest.test.ts`, change the expected container command to the new path:
```ts
assert.deepEqual(c.command, ['node', 'dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js'])
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test "admin/control-plane/tests/tenant-admin-manifest.test.ts"`
Expected: FAIL (manifest still emits the old `dist-tenant-admin/src/bin/...` command).

- [ ] **Step 3: Relocate the entrypoint and repoint the path**

- Create `admin/control-plane/bin/pragmatic-tenant-admind.ts` whose body is the two-line entrypoint, with the import fixed to the new relative depth: `import { TenantAdminServer } from '../tenant-admin-server.js'` then `await TenantAdminServer.Main()`. Delete `src/bin/pragmatic-tenant-admind.ts`.
- `tsconfig.build.json`: delete the `"src/bin/pragmatic-tenant-admind.ts"` entry from `exclude`.
- `tsconfig.tenant-admin.json`: replace the `src/bin/pragmatic-tenant-admind.ts` include glob with `admin/control-plane/bin/**/*.ts` (it is already covered by `admin/control-plane/**/*.ts`, so the explicit bin include can simply be dropped). Keep `outDir`, the `todl-runtime` `paths` pin, and the excludes.
- `package.json` `bin.pragmatic-tenant-admind` → `dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js`.
- `k8s-manifest-builder.ts` `TenantAdminEntrypoint` → `['node', 'dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js']`.
- `docker/Dockerfile`: repoint the entrypoint comment + any command referencing the old `.js` path. The SPA copy target (`dist-tenant-admin/admin/tenant-portal/dist`) is unchanged.
- `tenant-admin-smoke.ts` header comment → new entrypoint path.

- [ ] **Step 4: Verify the test passes and both tsconfigs typecheck**

Run: `npx tsx --test "admin/control-plane/tests/tenant-admin-manifest.test.ts"` → PASS.
Run: `npx tsc -p tsconfig.tools.json --noEmit` → clean (the entrypoint now compiles inside the tools graph via `admin/control-plane/**`).
Run: `npx tsc -p tsconfig.build.json --noEmit` → clean (no excluded file; `src/` has no stray admin-reaching import).
Run: `npx tsc -p tsconfig.tenant-admin.json --noEmit` → clean.

- [ ] **Step 5: Verify the emit lands at the new path**

Run: `npm run build:tenant-admin` then confirm `dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js` exists and the old `dist-tenant-admin/src/bin/...` does not. (Clean up the `dist-tenant-admin` dir after — it is git-ignored.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move tenant-admind entrypoint under admin/, drop build-exclusion hack"
```

---

### Task 2: Relocate identity-admin routes to the tenant plane

**Files:**
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts` (add the identity-admin routes)
- Modify: `admin/control-plane/control-plane-host.ts` (remove `RouteAdmin`, `RouteMakerToken`, `RouteAppReaderGrant`, their `*PathPattern`/segment/validation-message constants, and the dispatch arms in `RouteApi`; remove now-unused protocol DTO imports)
- Test: `admin/control-plane/tests/tenant-identity-admin.test.ts` (new); adjust any operator host test that asserted these routes existed

**Interfaces:**
- Consumes (unchanged shared service): `IEnvironmentService.AdminSnapshot/AdminGetConfig/AdminGetSecurityModel/AdminCreateAccount/AdminDisableAccount/AdminGrantRole/AdminRevokeRole/AdminSetSecurityModel/AdminSetConfig/AdminIssueMakerToken/AdminGrantAppReader` (declared `control-plane-host.ts:48-72`). Protocol DTOs `CreateAccountParams`, `GrantMutationDto`, `IdentityConfigDto`, `SecurityModelDto`, `TokenIssuedDto`, `AdminSnapshotDto` from `@pragmatic-tech-ai/pragmatic-protocol`.
- Consumes (tenant endpoint helpers, mirror these): the ownership-404 guard and body reader already in `TenantApiEndpoint` — `ReadBody`/`MaxBodyBytes`, `WriteJson`, `WriteNotFound`, and the `RouteEnvAction` pattern (`tenant-api-endpoint.ts:237-242`) that resolves the env record and 404s unless `rec.tenantId === session.tenantId`.
- Produces: new `/tenant-api` routes consumed by the future tenant-portal identity UI (filed as a follow-up):

| Method + path | Service call |
|---|---|
| `GET  /tenant-api/environments/:name/admin/snapshot` | `AdminSnapshot(name)` |
| `GET  /tenant-api/environments/:name/admin/config` | `AdminGetConfig(name)` |
| `GET  /tenant-api/environments/:name/admin/security-model` | `AdminGetSecurityModel(name)` |
| `POST /tenant-api/environments/:name/admin/accounts` | `AdminCreateAccount(name, params)` |
| `DELETE /tenant-api/environments/:name/admin/accounts/:principalId` | `AdminDisableAccount(name, principalId)` |
| `POST /tenant-api/environments/:name/admin/grants` | `AdminGrantRole(name, mutation)` |
| `DELETE /tenant-api/environments/:name/admin/grants` | `AdminRevokeRole(name, mutation)` |
| `PUT  /tenant-api/environments/:name/admin/security-model` | `AdminSetSecurityModel(name, model)` |
| `PUT  /tenant-api/environments/:name/admin/config` | `AdminSetConfig(name, config)` |
| `POST /tenant-api/environments/:name/maker-token` | `AdminIssueMakerToken(name)` |
| `POST /tenant-api/environments/:name/app-reader-grant` | `AdminGrantAppReader(name)` |

**Interface note:** mirror the operator's existing body validation verbatim (read `control-plane-host.ts:1101-1230` `RouteAdmin`, `947-969` `RouteMakerToken`, `972-988` `RouteAppReaderGrant` for the exact field checks and 400 messages) but adapt to `TenantApiEndpoint`'s own `ReadBody`/`WriteJson` helpers and its `session.tenantId` scoping. Response conventions match the operator's: reads return the DTO; grant/revoke/create/disable/set return `200 {ok:true}` (match whatever the operator returned); maker-token returns the `TokenIssuedDto`; errors from `service.Admin*` map to a fixed generic status + `{error}` body (never echo inner error text).

- [ ] **Step 1: Write the failing tenant identity-admin tests**

Create `admin/control-plane/tests/tenant-identity-admin.test.ts`, mirroring the harness of the existing tenant-api endpoint tests (fake `IEnvironmentService` recording calls; fake `ITenantDirectory`; a `TenantSession` with a known `tenantId`; an env record owned by that tenant and one owned by another). Assert, at minimum:
- `POST .../admin/grants` with a valid `{subject, role, ...}` body → 200 and `service.AdminGrantRole` called with `(name, mutation)`.
- `DELETE .../admin/grants` with a valid body → 200 and `AdminRevokeRole` called (this is the DELETE-with-body path; the test harness must send `Content-Length`).
- `POST .../admin/accounts` valid → `AdminCreateAccount`; `DELETE .../admin/accounts/:principalId` → `AdminDisableAccount(name, principalId)`.
- `GET .../admin/config` → returns `AdminGetConfig` DTO; `PUT .../admin/config` valid → `AdminSetConfig`.
- `GET .../admin/security-model` → `AdminGetSecurityModel`; `PUT` valid → `AdminSetSecurityModel`.
- `GET .../admin/snapshot` → `AdminSnapshot` DTO.
- `POST .../maker-token` → returns `AdminIssueMakerToken` DTO; `POST .../app-reader-grant` → `AdminGrantAppReader`.
- **Cross-tenant:** every route against an env owned by a *different* tenant → 404 (not 403), and the corresponding `service.Admin*` is NOT called.
- **Validation:** a grant body missing `subject`/`role` → 400 `{error}`; a body over the size cap → 400.
- **Error mapping:** when `service.AdminGrantRole` throws, the response is a fixed generic status + `{error}` with no inner-error text.

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test "admin/control-plane/tests/tenant-identity-admin.test.ts"`
Expected: FAIL (routes not implemented on the tenant endpoint).

- [ ] **Step 3: Implement the routes on `TenantApiEndpoint`**

Add the route patterns + handlers to `TenantApiEndpoint.Handle` (new `admin/...`, `maker-token`, `app-reader-grant` branches under the env path), each resolving the env record and applying the ownership-404 guard before any `service.Admin*` call, reusing the operator's field validation and the protocol DTOs. Hoist every new literal (path segments, error messages, the `ok` key) to `private static readonly` constants.

- [ ] **Step 4: Remove the routes from the operator host**

In `control-plane-host.ts`: delete `RouteAdmin`, `RouteMakerToken`, `RouteAppReaderGrant`; the `AdminPathPattern`/`MakerTokenPathPattern`/`AppReaderPathPattern` and the segment/leaf/validation-message constants that become unreferenced; and the three dispatch arms in `RouteApi` (`543-557`). Remove protocol DTO imports that are now unused. Keep `IEnvironmentService` intact (its `Admin*` members are still used by the tenant endpoint). Grep each deleted constant name to confirm zero remaining references before deleting.

- [ ] **Step 5: Run the full control-plane suite + typechecks**

Run: `npx tsx --test "admin/control-plane/tests/*.test.ts"` → all pass (including the new file; update/remove any operator test that asserted the now-removed routes so the suite reflects "operator no longer routes identity-admin").
Run: `npx tsc -p tsconfig.tools.json --noEmit` and `npx tsc -p tsconfig.tenant-admin.json --noEmit` → both clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: relocate per-env identity-admin routes from operator to tenant plane"
```

---

### Task 3: Remove the orphaned operator-side identity-admin consumers (portal UI + smoke steps)

**Files:**
- Delete: `admin/portal/src/maker-token-view.ts`, `admin/portal/src/manage-view.ts`, `admin/portal/src/role-config-view.ts`, `admin/portal/src/role-config-view-model.ts` (verify each is used only for identity-admin before deleting)
- Modify: `admin/portal/src/api-client.ts` (remove the identity-admin client methods + their leaf/segment constants: `Snapshot`, `CreateAccount`, `DisableAccount`, `GrantRole`, `RevokeRole`, `GetConfig`, `SetConfig`, `GetSecurityModel`, `SetSecurityModel`, `IssueMakerToken`, `AdminRoute`, `MakerTokenRoute`, and the `AdminSegment`/`SnapshotLeaf`/`AccountsLeaf`/`GrantsLeaf`/`ConfigLeaf`/`SecurityModelLeaf`/`MakerTokenLeaf` constants)
- Modify: `admin/portal/src/app.ts`, `main.ts`, `environment-detail-view.ts` and any nav/wiring that imports the deleted views
- Modify: `admin/control-plane/control-plane-smoke.ts` — remove the operator-side identity-admin steps that now hit removed routes (the "manage grant"/"manage revoke"/"manage lockout" grant steps, the maker-token step, and any snapshot/config/security-model identity steps), and their helper constants/assertions. The operator no longer owns identity, so these steps are dead; removing the revoke-DELETE step also makes control-plane-smoke's Failure-1 moot. Do NOT touch the env create/start/stop/deploy/promote/graph steps.
- Test: remove/adjust any `admin/portal/tests/*` that covered the deleted views/methods

**Interfaces:**
- Consumes: nothing new.
- Produces: an operator portal with no identity-admin surface (platform admin is read-only oversight; identity management belongs to the tenant plane). The portal retains environments/clients/tenants/hives/graphs/promote. The operator smoke no longer exercises identity-admin.

**Ruling (recorded):** (1) The tenant-portal identity-management mural UI (consuming the Task 2 `/tenant-api` routes) is explicitly out of scope here and is filed as a follow-up Feature — it is a distinct UX surface (the SP-HIVE-7 app was designed via mockups) and does not belong inside a backend-relocation slice. (2) Removing the operator smoke's identity steps (rather than repointing them to the tenant plane) is deliberate: live tenant-side identity coverage belongs on the tenant-admin smoke / the P4 browser-OIDC e2e, not the operator smoke; the relocated routes already have 27 unit cases.

- [ ] **Step 1: Confirm the blast radius**

Grep `admin/portal/src` for every import of the four view files and every call of the identity-admin client methods. List the wiring sites (nav registration, detail-view buttons, app bootstrap). This is the set to prune.

- [ ] **Step 2: Remove the views, client methods, and wiring**

Delete the four view files; remove their imports and nav/detail wiring; delete the identity-admin methods + now-unused constants from `api-client.ts`. Leave the rest of the portal intact.

- [ ] **Step 3: Typecheck + portal tests**

Run: `npx tsc -p admin/portal/tsconfig.json --noEmit` → clean (no dangling imports/refs).
Run the operator-portal test suite (`npx tsx --test "admin/portal/tests/*.test.ts"` if present) → green after removing tests that covered the deleted surface.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove orphaned operator-portal identity-admin UI (moved to tenant plane)"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 = "Move the tenant-admin bin out of src/bin into admin/"; Tasks 2+3 = "Relocate per-env identity-admin to the tenant plane" (backend + orphaned-UI cleanup). The tenant-portal identity UI is deliberately deferred (filed as a follow-up) and noted in Task 3's ruling.
- **Type consistency:** the relocated routes call the identical `IEnvironmentService.Admin*` members; DTO types are the same protocol types, moved from the operator import site to the tenant endpoint import site.
- **Proportion:** the plan carries decisions (which routes, which guard, which paths, the new emit path, the deletion set) and defers the exact validation bodies to the operator handlers the implementer mirrors — no transcription of handler bodies.
