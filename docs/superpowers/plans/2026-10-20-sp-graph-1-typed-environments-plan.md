# SP-GRAPH-1: Typed Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin center choose an environment type (Development or Runtime) at creation, record it on the environment, provision the tenant with the matching purpose, and surface it in the portal.

**Architecture:** Extend the existing admin control plane along its established chain — record → template-catalog → service → host → portal — plus the Mural portal. The type is a real enum, orthogonal to the template; the tenant purpose is derived from the type inside `TemplateCatalog.Resolve` (today it is hardcoded per template); records that predate the field read back as Development. Template still drives `kind`, `seedDir`, and `tenantId`; only purpose moves under the explicit type.

**Tech Stack:** TypeScript run via `tsx`; `node:test` + `node:assert/strict` for control-plane unit tests; Mural + Vite for the portal; Playwright for the portal e2e.

**Spec:** `pragmatic-server/docs/superpowers/specs/2026-10-20-sp-graph-1-typed-environments-spec.md` (parent design: `2026-10-20-environments-graphs-admin-design.md`).

## Global Constraints

- OOP (methods on classes, no free functions or module-level state); Allman braces; real enums (never string-literal unions); no inline string literals (hoist to `private static readonly` PascalCase constants); PascalCase for interfaces and public methods.
- pragmatic-server lexical style: single quotes, no semicolons, `.js` import suffixes, Allman.
- LF-only line endings (zero carriage-return bytes) in every file touched.
- Control-plane tests live beside the code under `admin/control-plane/tests/`; portal tests under `admin/portal/tests/`. Fix all review findings including Minors.
- Secrets, tokens, and credentials are never added to any DTO, logged, or echoed.
- Nothing is pushed until the user asks. Work on a branch/worktree.
- Mural ComboBox collapsed-selection text reads only `Label`/`Name`/`Text` (not `DisplayMemberPath`): any ComboBox item class exposes a `Label`.

## Review Focus

- Fail-closed on an unknown or missing type at the API boundary — rejected with 400, never coerced. (Task 4)
- A registry record written before the field reads back as Development, not undefined/throw. (Task 1; re-checked in `DefOf`, Task 3)
- The numeric purpose written into the container's tenants.json matches the chosen type — asserted as the numeric value, not just the record field. (Task 2 at the `Resolve` purpose level; Task 6 end-to-end in the gated smoke.)
- The new DTO field leaks no secret and rides the existing auth gate (unauthenticated create/list stays 401). (Task 4)

---

### Task 1: EnvType enum, record field, legacy-read default

**Files:**
- Modify: `admin/control-plane/environment-record.ts`
- Modify: `admin/control-plane/environment-registry.ts` (the `Load` path, ~line 20)
- Test: `admin/control-plane/tests/environment-registry.test.ts`

**Interfaces:**
- Produces: `export enum EnvType { Development = 'development', Runtime = 'runtime' }`; `EnvironmentRecord.type: EnvType` (required on the in-memory shape).
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```ts
// in environment-registry.test.ts
test('Load normalizes a legacy record with no type to Development', async () =>
{
    // seed the backing store with a record JSON that omits `type`, then Load
    // assert registry.Get(name).type === EnvType.Development
})
test('a record with an explicit type round-trips through persist/Load', async () =>
{
    // Put a record with type = EnvType.Runtime, reload, assert type === Runtime
})
```

- [ ] **Step 2: Run the tests, confirm they fail** — `npx tsx --test admin/control-plane/tests/environment-registry.test.ts` (Expected: FAIL — `EnvType` undefined / type missing).
- [ ] **Step 3: Implement** — add the `EnvType` enum and `type: EnvType` to `EnvironmentRecord` in `environment-record.ts`; in `EnvironmentRegistry.Load`, when a parsed record lacks `type`, set it to `EnvType.Development` (normalize on read so the rest of the code always sees a type). Keep `persist` writing the field.
- [ ] **Step 4: Run the tests, confirm they pass.**
- [ ] **Step 5: Commit** — `feat(admin): add EnvType to the environment record (legacy reads as Development)`.

---

### Task 2: Derive tenant purpose from the type in TemplateCatalog

**Files:**
- Modify: `admin/control-plane/template-catalog.ts` (`Resolve` ~line 194; add `DefaultTypeFor`)
- Test: `admin/control-plane/tests/template-catalog.test.ts`

**Interfaces:**
- Consumes: `EnvType` (Task 1).
- Produces: `Resolve(template: Template, name: string, hostPort: number, type: EnvType): { def: EnvDefinition; seedDir: string }`; `static DefaultTypeFor(template: Template): EnvType`.

- [ ] **Step 1: Write the failing test**

```ts
test('Resolve maps the explicit type to the tenant purpose, overriding the template default', () =>
{
    // Resolve(Template.DevBlank, 'e1', 8080, EnvType.Runtime).def.purpose === TenantPurposeName.Runtime
    // Resolve(Template.DemoContoso, 'e2', 8081, EnvType.Development).def.purpose === TenantPurposeName.Development
})
test('Resolve still takes kind, seedDir and tenantId from the template', () =>
{
    // DevBlank stays EnvKind.Dev + dev-blank seedDir + tenantId === name
    // DemoContoso stays EnvKind.Demo + demo seed dir + tenantId === DemoTenantId
})
test('DefaultTypeFor mirrors the historical template purpose', () =>
{
    // DevBlank -> Development, DemoContoso -> Runtime
})
```

- [ ] **Step 2: Run the tests, confirm they fail.**
- [ ] **Step 3: Implement** — thread `type` through `Resolve`; set `def.purpose` from a `type`→`TenantPurposeName` mapping (Development→`TenantPurposeName.Development`, Runtime→`TenantPurposeName.Runtime`) instead of the hardcoded per-template value; leave `kind`, `seedDir`, `tenantId`, `hostPort` template-driven. Add `DefaultTypeFor(template)` returning the historical default (DevBlank→Development, DemoContoso→Runtime) for legacy fallback. Hoist the two `TenantPurposeName` choices behind the mapping; no new inline literals.
- [ ] **Step 4: Run the tests, confirm they pass.**
- [ ] **Step 5: Commit** — `feat(admin): derive tenant purpose from the chosen EnvType`.

**Ruling:** type is orthogonal to template — an operator may pair any type with any template; purpose follows the type. We do not force `demo-contoso` to Runtime. (Cost if wrong: a `demo-contoso` + Development pairing would still seed the Northwind demo under a Development purpose; harmless for milestone 1, which starts from `dev-blank`.)

---

### Task 3: Thread the type through EnvironmentService.Create and DefOf

**Files:**
- Modify: `admin/control-plane/environment-service.ts` (`Create` ~line 96/114/134; `DefOf` ~line 324)
- Test: `admin/control-plane/tests/environment-service.test.ts`

**Interfaces:**
- Consumes: `EnvType` (Task 1), `Resolve(..., type)` + `DefaultTypeFor` (Task 2).
- Produces: `Create(name: string, template: Template, type: EnvType, hostPort?: number): Promise<EnvironmentRecord>`.

- [ ] **Step 1: Write the failing test**

```ts
test('Create stores the chosen type on the record', async () =>
{
    // h.Service.Create('e1', Template.DevBlank, EnvType.Runtime)
    // assert the Put record.type === EnvType.Runtime
})
test('DefOf re-derives purpose from the stored type, not the template default', async () =>
{
    // a stored DevBlank record with type Runtime -> DefOf(rec).purpose === TenantPurposeName.Runtime
})
test('DefOf falls back to the template default when a legacy record has no type', async () =>
{
    // rec.type undefined + template DemoContoso -> purpose Runtime (via DefaultTypeFor)
})
```

- [ ] **Step 2: Run the tests, confirm they fail.**
- [ ] **Step 3: Implement** — insert `type` into `Create` before the optional `hostPort`; pass it to `Resolve` and set `record.type`; in `DefOf(rec)` pass `rec.type ?? TemplateCatalog.DefaultTypeFor(rec.template)` to `Resolve` so Start/Stop/Delete/Logs re-derive the stored purpose. Update the in-file Create call sites if any.
- [ ] **Step 4: Run the tests, confirm they pass** (also run the full `environment-service.test.ts` to catch the signature change).
- [ ] **Step 5: Commit** — `feat(admin): record the environment type on create and re-derive from it`.

---

### Task 4: Control-plane host — DTO field and fail-closed validation

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (`IEnvironmentService` ~line 22; `EnvironmentDto` ~line 43; `CreateBody` ~line 55; `HandleCreate` ~line 605; `ToDto` ~line 860; `ErrorStatuses` ~line 166)
- Test: `admin/control-plane/tests/control-plane-host.test.ts`

**Interfaces:**
- Consumes: `EnvType` (Task 1), `Create(..., type, ...)` (Task 3).
- Produces: `EnvironmentDto.type: EnvType`; `CreateBody.type?: string`; `IEnvironmentService.Create` signature with `type`.

- [ ] **Step 1: Write the failing test**

```ts
test('POST create with a valid type returns 201 and the DTO carries the type', async () =>
{
    // Send POST /api/environments { name, template: 'dev-blank', type: 'runtime' }
    // assert 201, body.type === 'runtime', FakeService.Create recorded the type
})
test('POST create with an unknown type is rejected 400', async () =>
{
    // type: 'bogus' -> 400, message lists the valid types
})
test('the connect-info DTO carries type and still leaks no secret/internal field', async () =>
{
    // list -> each dto has type; the existing no-leak assertion still holds
})
test('an unauthenticated create still returns 401', async () =>
{
    // no session cookie -> 401 before validation
})
```

- [ ] **Step 2: Run the tests, confirm they fail.**
- [ ] **Step 3: Implement** — add `type` to `IEnvironmentService.Create`, `CreateBody`, and `EnvironmentDto`; in `HandleCreate`, validate `body.type` is one of `Object.values(EnvType)` (hoist a `TypeInvalidMessage` constant mirroring `TemplateInvalidMessage`) → 400 otherwise, then pass it to `service.Create`; add `type` to `ToDto`. Update the `FakeService` in the test (its `Record` fixture ~line 52 and its `Create` `Calls` string ~line 64/250) to include the type.
- [ ] **Step 4: Run the tests, confirm they pass** (run the whole `control-plane-host.test.ts`).
- [ ] **Step 5: Commit** — `feat(admin): carry environment type through the control-plane API (fail-closed on unknown type)`.

---

### Task 5: Portal — type picker, DTO, list and detail

**Files:**
- Modify: `admin/portal/src/portal-types.ts` (`EnvironmentDto`), `admin/portal/src/api-client.ts` (`CreateEnvironment` ~line 93), `admin/portal/src/create-environment-view.ts`, `admin/portal/src/environment-list-view.ts` (`BuildRow` ~line 72), `admin/portal/src/environment-detail-view.ts` (`ShowEnvironment` ~line 79)
- Test: `admin/portal/tests/api-client.test.ts`, `admin/portal/tests/portal.spec.ts`

**Interfaces:**
- Consumes: the host `EnvironmentDto.type` and the `CreateBody.type` field (Task 4).
- Produces: portal `EnvironmentDto.type: string`; `CreateEnvironment(name, template, type, hostPort?)`.

- [ ] **Step 1: Write the failing tests**

```ts
// api-client.test.ts
test('CreateEnvironment posts the type in the body', async () =>
{
    // client.CreateEnvironment('e1', 'dev-blank', 'development', 8080)
    // assert the captured request body.type === 'development'
})
```
For the Playwright `portal.spec.ts`: extend the `FakeControlPlane` env fixture with a `type`, assert the create view shows a type ComboBox that preselects Development, that submitting posts the selected type, and that the list row shows the type.

- [ ] **Step 2: Run the tests, confirm they fail.**
- [ ] **Step 3: Implement** — add `type: string` to the portal `EnvironmentDto`; add a `type` param to `CreateEnvironment` and the request body; add a second `ComboBox` to the create view bound to a small `TypeOption` class exposing `Label` + `Id` (values `development`/`runtime`), preselecting Development; include the type in the list row text (`BuildRow`) and add a type `TextBlock` with a prefix constant to the detail view. Hoist all new labels/prefixes to constants.
- [ ] **Step 4: Run the tests, confirm they pass** — `npm --prefix admin/portal test` and the gated/controller e2e (`npm --prefix admin/portal run test:e2e` against system Chrome).
- [ ] **Step 5: Commit** — `feat(admin-portal): choose and display the environment type`.

---

### Task 6 (operator-run, gated): assert the chosen purpose reaches tenants.json

**Files:**
- Modify: `admin/control-plane/control-plane-smoke.ts`

**Interfaces:**
- Consumes: the whole chain above.

- [ ] **Step 1: Extend the smoke** — after creating a Development environment and a Runtime environment, read the generated `<bundleDir>/tenants.json` for each and assert `tenants[tenantId].purpose` is the numeric value matching the chosen type (0 for Development, 1 for Runtime). Keep it inside the existing gated smoke (needs Docker + `pragmatic-server:dev`), not the `tsx --test` set.
- [ ] **Step 2: Note in `admin/README.md`** that the smoke now checks the purpose, and that it is operator-run.
- [ ] **Step 3: Commit** — `test(admin): smoke asserts the environment type reaches tenants.json`.

**Note:** the controller cannot run this in a sandbox (needs Docker). It is the end-to-end witness for the numeric-purpose Review Focus item; the unit tests (Task 2) cover the derivation up to `def.purpose`, and the existing `BundleBuilder.WriteTenants` tests cover `Number(def.purpose)` reaching the file.

---

## Folded-in backlog (opportunistic — on this slice's code path)

These existing Project #1 backlog items sit directly on files SP-GRAPH-1 already edits, so we clear them here and close their items when done. Each names its Project item id.

### Task 7: Guard EnvironmentService.Create against concurrent same-name creates

Project item: PVTI_lADOE0Zc984Biu4ozhBU2IA

**Files:** Modify `admin/control-plane/environment-service.ts` (`Create`); Test `admin/control-plane/tests/environment-service.test.ts`.

- [ ] **Step 1:** Failing test — two overlapping `Create('e1', ...)` calls resolve to exactly one created environment and one `EnvironmentExistsError` (not two containers / a port race).
- [ ] **Step 2:** Run, confirm fail.
- [ ] **Step 3:** Implement an in-flight name reservation (a `Set<string>`/promise map on the service, released in a `finally`) so a second create for the same safe-name observes the reservation and rejects, mirroring the existing `EnvironmentExistsError` path.
- [ ] **Step 4:** Run, confirm pass.
- [ ] **Step 5:** Commit — `fix(admin): guard Create against concurrent same-name races`.

### Task 8: Provisioning accepts the purpose enum name as well as the numeric value

Project item: PVTI_lADOE0Zc984Biu4ozhA0sSE

**Files:** Modify `src/config/file-tenant-provisioning.ts` (~line 162 purpose parse); Test its existing test file under `src/config/tests/`.

- [ ] **Step 1:** Failing test — a tenants.json `purpose` of `"Development"`/`"Runtime"` (enum name) and of `0`/`1` (numeric) both parse to the correct `TenantPurpose`; an unknown value is rejected.
- [ ] **Step 2:** Run, confirm fail.
- [ ] **Step 3:** Implement a tolerant parse: numeric stays as today; a string is matched against the `TenantPurpose` enum names (hoist the mapping, no inline literals). Keep it fail-closed on an unknown value.
- [ ] **Step 4:** Run, confirm pass.
- [ ] **Step 5:** Commit — `feat(server): accept the tenant purpose enum name in provisioning`.

### Task 9: Harden the environments seed CLI (exit code + shared constants)

Project items: PVTI_lADOE0Zc984Biu4ozhBTTfo (exit non-zero), PVTI_lADOE0Zc984Biu4ozhBU2Ws (reuse admin-cred constants)

**Files:** Modify `environments/seed/seed.ts`; Test `environments/seed/` tests if present (else a small gated note).

- [ ] **Step 1:** Failing test/check — `seed.ts up` returns a non-zero exit code when the server image is missing (today it exits 0); and `seed.ts` references the public `BundleBuilder` admin-cred constants instead of redeclaring its own `AdminEmailPrefix` etc.
- [ ] **Step 2:** Run, confirm fail.
- [ ] **Step 3:** Implement: propagate the image-missing failure to a non-zero `process.exitCode`; replace the duplicated admin-cred literals with the promoted `BundleBuilder` statics.
- [ ] **Step 4:** Run, confirm pass.
- [ ] **Step 5:** Commit — `fix(env): seed up fails loudly on missing image; reuse admin-cred constants`.

### Task 10: Type-check gate for the tsx-run environments/ and admin/ trees

Project item: PVTI_lADOE0Zc984Biu4ozhBTTlg

**Files:** Add a `tsconfig` (noEmit) covering `environments/` + `admin/`; wire an npm script (e.g. `typecheck:tools`).

- [ ] **Step 1:** Add a `tsconfig.tools.json` with `noEmit` including `environments/**` and `admin/**` (these are tsx-run, outside the `src` build, so today a type error there ships silently — exactly the code SP-GRAPH edits).
- [ ] **Step 2:** Run `tsc -p tsconfig.tools.json --noEmit`; fix any pre-existing errors it surfaces (or record them if out of this slice's scope).
- [ ] **Step 3:** Add the npm script and note it in `admin/README.md`.
- [ ] **Step 4:** Commit — `chore(server): type-check gate for the environments and admin trees`.

**Closing:** when a folded task lands and its tests pass, set its Project item to Done and archive it (same mechanism used in the backlog sweep).
