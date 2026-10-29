# Platform Admin Provisioning Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Full-gated operator action provisions a customer (client + tenant + hive) atomically via a new `POST /api/provision`, rolls back partial failures best-effort with an honest residue report, and reveals both one-time secrets (owner password + agent token) once in a guided portal wizard.

**Architecture:** A new control-plane `ProvisioningOrchestrator` composes the EXISTING services (`PlatformDirectory`, `TenantProvisioningService`, `PlatformDeploymentRegistry`) in order, pre-validating all ids (zero writes on duplicate/invalid) and, on a genuine mid-sequence failure, running reverse-order compensating deletes and returning a truthful rollback report. The `ControlPlaneHost` builds the orchestrator internally from the three services it already holds (no constructor ripple) and exposes `POST /api/provision`, Full-gated by the existing central mutation authorization (no authz change). The portal adds two kit primitives (`Steps`, `OnceSecret`), a `ProvisionWizardView` + VM hosted in the Clients screen's Custom state, reached via a new Full-gated "Provision customer" secondary action.

**Tech Stack:** TypeScript (control-plane via `npx tsx --test`; portal via `npm test` + `tsc`), mural kit Visuals, node:crypto (secrets already minted by existing services).

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-provision-wizard-design.md`

## Global Constraints

- OOP; no global functions or module-level mutable state; Allman braces on every block; PascalCase for public methods/interfaces; enums over string-literal unions; view-models extend `Observable`; `IDisposable` not lambdas; tests under `tests/`.
- No inline reused string literals: hoist route paths, body keys, step/field labels, reveal copy, residue-label prefixes, and error text to `private static readonly` class constants.
- New/edited `.ts` files are pure ASCII and LF only. Byte-scan every written `.ts` with `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> must print `0 0 N`. `control-plane-host.ts` has 6 PRE-EXISTING non-ASCII bytes; do not add or remove any (scanning it will show `6 0 N` -- that is expected, add none).
- SECURITY (binding): both secrets (owner password, agent token) appear BY VALUE in the provision response ONLY; never logged, stored, echoed, re-fetchable, or placed in an error/URL. No GET ever returns them. In the portal they live only inside the `OnceSecret` reveal Visual, never in a VM field. reported == enforced: the rollback report names exactly what was and was not rolled back; no fabricated success; no fabricated IdP teardown.
- Full-gated via the existing central `OperatorAuthorization.Authorize` (any mutating method for a non-Full operator -> 403 before routing). No authz rule is added or changed. In the UI, every provision entry/submit routes through `operator.MutatingAct`.
- admin/portal must NOT import admin/tenant-portal (no cross-app import). The host builds the orchestrator internally (do NOT add a `ControlPlaneHost` constructor parameter -- it already holds `directory`, `provisioning`, `deployments`).
- Gate asymmetry: control-plane runs via `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools` (root `npm test` MISSES control-plane). Portal runs via `npm --prefix admin/portal test` + `npm --prefix admin/portal run typecheck`. Run control-plane and portal gates SEQUENTIALLY (cwd race). BOTH green on the merged result.
- Merge locally (ff-only into master); NEVER push.

## Review Focus

- A duplicate client/tenant/hive id (any of the three already exists) -> 409, ZERO writes, no partial state. (Task 2 orchestrator test asserts all three stores unchanged; Task 3 route test asserts 409.)
- `CreateHive` (or `RegisterHive`) throws AFTER client+tenant succeeded -> reverse-order compensating deletes run, the client+plain records are removed, and the response carries a truthful rollback report. (Task 2 fault-injection test.)
- A compensating delete ALSO fails during rollback -> the report lists the leftover in `residue` (no silent swallow). (Task 2 test.)
- Rolling back a PROVISIONED tenant -> the report always lists `idp-realm:<tenant>` in `residue` (IdP realm + Owner teardown is not available; never claimed clean). (Task 2 test.)
- Both one-time secrets appear ONLY in the 201 provision response; no GET re-returns them; the portal keeps them out of every VM field. (Task 3 CP test + Task 7 VM test + code review.)
- An Observer (ReadOnly) -> cannot open/submit the wizard (UI gated) AND the server 403s `/api/provision`; unauth -> 401. (Task 3 rbac test + Task 8 view test.)
- "Finish" is blocked until the operator confirms they saved the secrets. (Task 5 OnceSecret test + Task 8 wizard test.)

---

### Task 1: `DeregisterHive` compensating-delete seam

**Files:**
- Modify: `admin/control-plane/platform-deployment-registry.ts`
- Test: `admin/control-plane/tests/platform-deployment-registry.test.ts`

**Interfaces:**
- Consumes: `RolloutRegistrationRegistry.Remove(id)` (inherited from `JsonRecordStore`).
- Produces: `public async DeregisterHive(hiveId: string): Promise<void>` on `PlatformDeploymentRegistry` -- removes the hive's rollout-registration record so a rolled-back provision leaves no orphaned registration. Idempotent (removing an absent id is a no-op, matching `JsonRecordStore.Remove`).

- [ ] **Step 1: Write the failing test** `DeregisterHive removes a prior registration so VerifyAgentToken then fails`

```ts
// register, verify the token works, DeregisterHive, then VerifyAgentToken rejects with HiveNotRegisteredError
const token = await registry.RegisterHive('hive-1')
await registry.VerifyAgentToken('hive-1', token) // resolves
await registry.DeregisterHive('hive-1')
await assert.rejects(() => registry.VerifyAgentToken('hive-1', token), HiveNotRegisteredError)
```
Add a second assertion: `DeregisterHive` on an unregistered hive resolves without throwing (idempotent).

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test admin/control-plane/tests/platform-deployment-registry.test.ts`
Expected: FAIL (`DeregisterHive is not a function`).

- [ ] **Step 3: Implement `DeregisterHive`**

Add `public async DeregisterHive(hiveId: string): Promise<void> { await this.registrations.Remove(hiveId) }` next to `RegisterHive`. Allman braces.

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test admin/control-plane/tests/platform-deployment-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(control-plane): add DeregisterHive compensating-delete seam`

---

### Task 2: `ProvisioningOrchestrator`

**Files:**
- Create: `admin/control-plane/provisioning-orchestrator.ts`
- Test: `admin/control-plane/tests/provisioning-orchestrator.test.ts`

**Interfaces:**
- Consumes: `PlatformDirectory` (`GetClient`/`GetTenant`/`GetHive`, `CreateClient`, `CreateHive`, `DeleteClient`/`DeleteTenant`/`DeleteHive`), `TenantProvisioningService.Provision({id,clientId,displayName,ownerEmail}) -> {record,ownerPassword}`, `PlatformDeploymentRegistry.RegisterHive(id) -> token` and `DeregisterHive(id)` (Task 1), `RecordId.Validate`, `RecordExistsError`, record types from `platform-records.js`, `ClusterSpec`/`RegistrySpec`.
- Produces (exact, consumed by Task 3 and mirrored by the portal DTOs in Task 6):

```ts
export type ProvisionInput = {
    client: { id: string; displayName: string; subscriptionRef?: string }
    tenant: { id: string; displayName: string; ownerEmail: string }
    hive: { id: string; displayName: string; cluster: ClusterSpec; registry: RegistrySpec; trustRootRef?: string }
}
export type ProvisionSecrets = { ownerEmail: string; ownerPassword: string; agentToken: string }
export type ProvisionResult = { client: ClientRecord; tenant: TenantRecord; hive: HiveRecord; secrets: ProvisionSecrets }
export type ProvisionRollback = { rolledBack: readonly string[]; residue: readonly string[] }
export class ProvisionFailedError extends Error { public readonly rollback: ProvisionRollback /* message is a fixed safe label; carries no secrets */ }
export class ProvisioningOrchestrator { public async Provision(input: ProvisionInput): Promise<ProvisionResult> }
```

`Provision` algorithm (the implementer writes the bodies; this fixes the behavior):
1. Pre-validate with NO writes: `RecordId.Validate` each of `client.id`, `tenant.id`, `hive.id`; then if `directory.GetClient(client.id)`/`GetTenant(tenant.id)`/`GetHive(hive.id)` is defined throw `RecordExistsError(thatId)`. (Reserved-id and shape/cluster/registry validation happen in the route, Task 3, before the orchestrator is called.)
2. Create in order, tracking which steps completed: `CreateClient(input.client)` -> `provisioning.Provision({id:tenant.id, clientId:client.id, displayName:tenant.displayName, ownerEmail:tenant.ownerEmail})` -> `CreateHive({id:hive.id, tenantId:tenant.id, displayName, cluster, registry, trustRootRef})` -> `RegisterHive(hive.id)`.
3. On success return `{ client, tenant: tenantRecord, hive, secrets: { ownerEmail: tenantRecord.ownerEmail, ownerPassword, agentToken } }`.
4. On any throw during step 2 (after at least the client create started): run `Rollback` over the completed steps in REVERSE order, build a `ProvisionRollback`, and throw `ProvisionFailedError(rollback, <safe cause label = caught error's name>)`. The original error's message is NOT propagated (may be unsafe); only its class name is used as a safe label.

`Rollback(completed)` reverse order, each compensating action wrapped so its own failure is captured not thrown:
- registration completed -> try `deployments.DeregisterHive(hive.id)`; success -> push `registration:<id>` to `rolledBack`, failure -> push to `residue`.
- hive completed -> try `directory.DeleteHive(hive.id)`; success -> `rolledBack`, failure -> `residue` (`hive:<id>`).
- tenant completed -> try `directory.DeleteTenant(tenant.id)`; success -> push `tenant:<id>` to `rolledBack`; FAILURE -> push `tenant:<id>` to `residue`. In BOTH cases ALSO push `idp-realm:<tenant.id>` to `residue` -- the IdP realm + Owner are never torn down (no teardown path exists), so a rolled-back provisioned tenant always reports IdP residue.
- client completed -> try `directory.DeleteClient(client.id)`; success -> `rolledBack` (`client:<id>`), failure -> `residue`.
Order matters: hive before tenant before client (FK guards: `TenantHasHivesError`, `ClientHasTenantsError`). Label prefixes (`client:`,`tenant:`,`hive:`,`registration:`,`idp-realm:`) are hoisted constants.

- [ ] **Step 1: Write the failing tests** `admin/control-plane/tests/provisioning-orchestrator.test.ts`

Use the existing control-plane test fakes (`tests/fake-provisioning.ts`, in-memory registries / a real `PlatformDirectory` over in-memory stores as other tests do). Tests:
- `happy path provisions client + tenant + hive and returns both secrets`: result has the three records and `secrets.ownerPassword` + `secrets.agentToken` non-empty; all three directory stores now contain the records; the agent token verifies via `deployments.VerifyAgentToken(hive.id, secrets.agentToken)`.
- `duplicate client id -> RecordExistsError and ZERO writes`: pre-seed the client id; `assert.rejects(..., RecordExistsError)`; assert tenant + hive stores are empty and the client store is unchanged (no tenant/hive created, no IdP seeded via the fake). Repeat for a pre-seeded tenant id and a pre-seeded hive id.
- `CreateHive failure rolls back tenant + client and reports residue`: inject a directory whose `CreateHive` throws; `assert.rejects(..., ProvisionFailedError)`; catch and assert `err.rollback.rolledBack` contains `client:<id>` and `tenant:<id>`, and `err.rollback.residue` contains `idp-realm:<tenant>`; assert the client + tenant records are gone from the stores.
- `RegisterHive failure rolls back registration-less + hive + tenant + client`: inject a deployments whose `RegisterHive` throws; assert `rolledBack` contains `hive:<id>`, `tenant:<id>`, `client:<id>`; `residue` contains `idp-realm:<tenant>`; stores clean.
- `a failing compensating delete is reported in residue`: inject a directory whose `DeleteClient` throws during rollback (and some earlier step throws to trigger rollback); assert `err.rollback.residue` contains `client:<id>`.
- `ProvisionFailedError carries no secret`: assert `err.message` and `JSON.stringify(err.rollback)` contain neither the owner password nor any token substring.

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test admin/control-plane/tests/provisioning-orchestrator.test.ts`
Expected: FAIL (module/class not found).

- [ ] **Step 3: Implement `ProvisioningOrchestrator`** in `admin/control-plane/provisioning-orchestrator.ts`

Per the algorithm above. Constructor `public constructor(private readonly directory: PlatformDirectory, private readonly provisioning: TenantProvisioningService, private readonly deployments: PlatformDeploymentRegistry)`. All helper logic as private methods (no free functions). Rollback captures each compensating failure with try/catch and never rethrows from within rollback.

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsx --test admin/control-plane/tests/provisioning-orchestrator.test.ts`
Expected: PASS. Byte-scan the new file -> `0 0 N`.

- [ ] **Step 5: Commit** `feat(control-plane): ProvisioningOrchestrator with pre-validation and best-effort rollback`

---

### Task 3: `POST /api/provision` route

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts`
- Test: `admin/control-plane/tests/control-plane-host-platform.test.ts` (happy path + error mapping) and `admin/control-plane/tests/control-plane-host-rbac.test.ts` (403/401 gating)

**Interfaces:**
- Consumes: `ProvisioningOrchestrator` (Task 2) built internally from `this.directory`, `this.provisioning`, `this.deployments`; existing host helpers `ReadJsonObject`, `NonEmpty`, `OptionalString`, `ParseCluster`, `ParseRegistry`, `ToTenantDto`, `WriteJson`, status constants, `CacheControlHeader`/`NoStore`, `ReservedIdPrefix`.
- Produces: route `ProvisionPath = '/api/provision'` dispatched in the same POST path as the other platform mutations, so the central `OperatorAuthorization.Authorize` gates it unchanged.

Route behavior:
- Build the orchestrator once (a private readonly field assigned in the constructor: `this.orchestrator = new ProvisioningOrchestrator(this.directory, this.provisioning, this.deployments)`) OR lazily in the handler. Do NOT add a constructor parameter.
- Parse the body object. Validate shape (400, no writes) with hoisted messages: `client` object with `NonEmpty(client.id)` + string `client.displayName` + `OptionalString(client.subscriptionRef)`; `tenant` object with `NonEmpty(tenant.id)` + string `tenant.displayName` + `NonEmpty(tenant.ownerEmail)` + `!tenant.id.startsWith(ReservedIdPrefix)`; `hive` object with `NonEmpty(hive.id)` + string `hive.displayName` + `ParseCluster(hive.cluster)` defined + `ParseRegistry(hive.registry)` defined + `OptionalString(hive.trustRootRef)`.
- Call `await this.orchestrator.Provision(input)`.
- Success -> set `Cache-Control: no-store`, `WriteJson(res, StatusCreated, { client, tenant: ToTenantDto(tenant), hive, secrets })`.
- Catch `RecordExistsError` -> `StatusConflict (409)` `{ error: e.message }`. Catch the `RecordId` validation error type -> `StatusBadRequest` `{ error }`. Catch `ProvisionFailedError` -> `StatusInternalServerError (500)` `{ error: e.message, rollback: e.rollback }`. (If the host lacks a 409/500 constant, add hoisted `StatusConflict = 409` / `StatusInternalServerError = 500`.)

- [ ] **Step 1: Write the failing tests**

In `control-plane-host-platform.test.ts`:
- `POST /api/provision as Full operator -> 201 with records and both secrets`: assert status 201, `Cache-Control: no-store`, body has `client`,`tenant`,`hive`, `secrets.ownerPassword` and `secrets.agentToken` non-empty; a follow-up `GET /api/tenants/<id>` does NOT contain the password (no secret re-fetch).
- `POST /api/provision with a duplicate client id -> 409 and no partial tenant/hive`: pre-create the client, then provision with the same client id; assert 409 and that no new tenant/hive exist.
- `POST /api/provision with invalid cluster -> 400 and zero writes`.
In `control-plane-host-rbac.test.ts`:
- `POST /api/provision as ReadOnly -> 403` (central gate) and `as unauthenticated -> 401`, asserting zero writes in both.

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test admin/control-plane/tests/control-plane-host-platform.test.ts admin/control-plane/tests/control-plane-host-rbac.test.ts`
Expected: FAIL (404/route missing).

- [ ] **Step 3: Implement the route** in `control-plane-host.ts`

Add the field, path constant, validation, dispatch arm, and error mapping as above. Do not touch the 6 pre-existing non-ASCII bytes.

- [ ] **Step 4: Run to verify they pass**

Run the two suites above, then the full control-plane gate: `npx tsx --test admin/control-plane/tests/*.test.ts` and `npm run typecheck:tools` (from repo root). Expected: all green. Byte-scan `control-plane-host.ts` -> `6 0 N`.

- [ ] **Step 5: Commit** `feat(control-plane): POST /api/provision atomic provision route (Full-gated)`

---

### Task 4: kit `Steps` primitive

**Files:**
- Create: `admin/portal/src/kit/steps.ts`
- Modify: `admin/portal/src/kit/index.ts` (export `Steps` and its input type)
- Test: `admin/portal/tests/kit-steps.test.ts`

**Interfaces:**
- Produces: `export class Steps extends StackPanel` built from an input bag `{ steps: readonly string[]; current: number; content: Visual }` -- renders a horizontal step indicator (each label, the one at `current` marked active) above the supplied `content`. A `public get ActiveIndex(): number` test seam. No behavior beyond display; advancing is driven by the owner rebuilding with a new `current`.

- [ ] **Step 1: Write the failing test** `Steps renders its labels and marks the current step active, with the content below`

Assert the Visual contains each step label and that `ActiveIndex` equals the passed `current`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix admin/portal test`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `Steps`** and export it from `kit/index.ts`. Allman braces; hoist any repeated literal. Follow the existing kit view conventions (e.g. `Section`, `PageHeader`).

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix admin/portal test`. Byte-scan the new file -> `0 0 N`.

- [ ] **Step 5: Commit** `feat(portal/kit): Steps linear step indicator`

---

### Task 5: kit `OnceSecret` primitive

**Files:**
- Create: `admin/portal/src/kit/once-secret.ts`
- Modify: `admin/portal/src/kit/index.ts`
- Test: `admin/portal/tests/kit-once-secret.test.ts`

**Interfaces:**
- Consumes: `KeyActivatedButton` (with its public `Press()`), `TextBlock`/`TextBox`, `Act`.
- Produces: `export class OnceSecret extends StackPanel` from an input bag `{ label: string; value: string; confirmLabel: string; onConfirm: () => void }` -- shows the `label`, the `value` once (in a read-only display element, selectable), a best-effort "Copy" affordance, and a confirm control the operator must activate. Confirming calls `onConfirm` exactly once and flips `Confirmed`. Test seams: `public get Confirmed(): boolean`, `public get ConfirmButton(): KeyActivatedButton` (or an `Act`) for the test to `Press()`, and `public get Value(): string` returning the displayed value (sourced from the Visual, demonstrating the value lives in the Visual). The value is held ONLY in this Visual -- never persisted elsewhere by this class.

- [ ] **Step 1: Write the failing tests**
- `OnceSecret shows its value and is unconfirmed initially`: `Confirmed` is false; `Value` equals the passed value.
- `activating the confirm control calls onConfirm once and sets Confirmed`: press the confirm seam; assert a counter incremented to 1 and `Confirmed` is true; pressing again does not call `onConfirm` a second time.

- [ ] **Step 2: Run to verify they fail**

Run: `npm --prefix admin/portal test`
Expected: FAIL.

- [ ] **Step 3: Implement `OnceSecret`** and export from `kit/index.ts`. The copy affordance, if it touches `navigator.clipboard`, must be guarded (`typeof navigator !== 'undefined' && navigator.clipboard`) so it is a no-op under test rather than throwing. Allman; hoist literals.

- [ ] **Step 4: Run to verify they pass** and byte-scan -> `0 0 N`.

- [ ] **Step 5: Commit** `feat(portal/kit): OnceSecret one-time reveal with required confirm`

---

### Task 6: portal DTOs + `ControlPlaneClient.Provision`

**Files:**
- Modify: `admin/portal/src/portal-types.ts` (DTOs)
- Modify: `admin/portal/src/api-client.ts` (client call)
- Test: `admin/portal/tests/api-client.test.ts`

**Interfaces:**
- Consumes: existing `ClientDto`, `TenantDto`, `HiveDto`, cluster/registry DTO shapes already used by the create-hive path; `ControlPlaneClient.Send<T>(route, { method, body })`.
- Produces (mirror Task 2 exactly):

```ts
export interface ProvisionInputDto { client: { id: string; displayName: string; subscriptionRef?: string }; tenant: { id: string; displayName: string; ownerEmail: string }; hive: { id: string; displayName: string; cluster: <ClusterDto>; registry: <RegistryDto>; trustRootRef?: string } }
export interface ProvisionSecretsDto { ownerEmail: string; ownerPassword: string; agentToken: string }
export interface ProvisionResultDto { client: ClientDto; tenant: TenantDto; hive: HiveDto; secrets: ProvisionSecretsDto }
```
(Use the SAME cluster/registry DTO types the existing create-hive request body uses -- find them in `portal-types.ts`/`create-hive-view`; do not invent new ones.)
- `public Provision(input: ProvisionInputDto): Promise<ProvisionResultDto>` on `ControlPlaneClient` -> `this.Send(ControlPlaneClient.ProvisionRoute, { method: PostMethod, body: input })` with `ProvisionRoute = '/api/provision'` hoisted.

- [ ] **Step 1: Write the failing test** `Provision POSTs the composed input to /api/provision and returns the result with secrets`

Use the existing api-client test harness (fetch stub) pattern: assert the request method is POST, the URL ends `/api/provision`, the JSON body equals the input, and the parsed result surfaces `secrets.ownerPassword` + `secrets.agentToken`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix admin/portal test`
Expected: FAIL.

- [ ] **Step 3: Implement** the DTOs and the `Provision` method.

- [ ] **Step 4: Run to verify it passes** and byte-scan both edited files.

- [ ] **Step 5: Commit** `feat(portal): Provision DTOs and ControlPlaneClient.Provision`

---

### Task 7: `ProvisionWizardViewModel`

**Files:**
- Create: `admin/portal/src/provision-wizard-view-model.ts`
- Test: `admin/portal/tests/provision-wizard-view-model.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneClient.Provision` (Task 6), `ProvisionInputDto`/`ProvisionResultDto`, cluster/registry enums used by create-hive.
- Produces: `export class ProvisionWizardViewModel extends Observable` with per-step field setters/getters (client: id/displayName/subscriptionRef; tenant: id/displayName/ownerEmail; hive: id/displayName/cluster/registry/trustRootRef), `public StepValid(step: WizardStep): boolean` (required fields non-empty; ownerEmail non-empty -- NOT trimmed-away), `public CanProvision(): boolean` (all steps valid), and `public async Provision(): Promise<ProvisionResultDto>` which composes the `ProvisionInputDto` (wiring `tenant.clientId = client.id`, `hive.tenantId = tenant.id` server-side -- the DTO itself carries only the fields above; the ORCHESTRATOR wires FKs) and calls the client ONCE. Define `export enum WizardStep { Client, Tenant, Hive }`.
- CRITICAL: `Provision` RETURNS the `ProvisionResultDto` to the caller (the view). The VM does NOT store `secrets` (or the password/token) in any field -- the view hands them straight to the `OnceSecret` Visual.

- [ ] **Step 1: Write the failing tests**
- `each step is invalid until its required fields are filled; CanProvision is false until all three are valid`.
- `Provision composes the input and calls the client once and returns the result`: inject a fake client whose `Provision` records the input and returns a canned result with secrets; assert called exactly once with the composed fields and that the returned result carries the secrets.
- `the view-model does not retain the secrets`: after `Provision`, assert the VM exposes NO property returning the owner password or agent token (reflect over own enumerable fields / assert there is no getter that returns them). The secrets exist only in the returned result.

- [ ] **Step 2: Run to verify they fail** -> `npm --prefix admin/portal test`.

- [ ] **Step 3: Implement** the VM. Extends `Observable`. No secret field.

- [ ] **Step 4: Run to verify they pass** and byte-scan.

- [ ] **Step 5: Commit** `feat(portal): ProvisionWizardViewModel (no secret retention)`

---

### Task 8: `ProvisionWizardView`

**Files:**
- Create: `admin/portal/src/provision-wizard-view.ts`
- Test: `admin/portal/tests/provision-wizard-view.test.ts`

**Interfaces:**
- Consumes: `ProvisionWizardViewModel` (Task 7), `Steps` (Task 4), `OnceSecret` (Task 5), `operator.MutatingAct` + `Act`, `OperatorContext`, `ComboBox` + `ComboOption` for cluster/registry pickers, `TextBox`/`TextBlock`, `KeyActivatedButton`.
- Produces: `export class ProvisionWizardView extends StackPanel` constructed `(client: ControlPlaneClient, operator: OperatorContext, onDone: () => void)`. Renders the current step inside `Steps`; Next/Back advance within validated steps; the final provision submit routes through `operator.MutatingAct` (Full-gated) and calls `vm.Provision()`; on success it swaps to an `OnceSecret` reveal for the owner password AND the agent token (two reveals, or one combined) whose confirm unlocks a "Finish" action that calls `onDone`. On error, an error line shows the server message (never a secret). Test seams: `public get Mode()` (Form | Reveal), the submit `Act`, the reveal(s), and the Finish `Act`.
- Secrets handed from `vm.Provision()`'s result directly into the `OnceSecret` Visual(s); never stored on the view beyond the live reveal Visual.

- [ ] **Step 1: Write the failing tests**
- `a Full operator can fill the steps, submit, and sees the reveal with both secrets; Finish is blocked until confirmed`: drive the VM fields, press submit (fake client returns a result), assert Mode is Reveal and the reveal(s) show the owner password + agent token; assert the Finish action is disabled/no-op until the OnceSecret confirm is pressed, then Finish calls `onDone`.
- `an Observer cannot submit`: build with a ReadOnly `OperatorContext`; assert the submit `Act` is gated (its `Press()` is a no-op / `inputs.can` is false) so `vm.Provision` is never called.
- `a server error surfaces without leaking into a stored field`: fake client `Provision` rejects; assert the error line is shown and Mode stays Form.

- [ ] **Step 2: Run to verify they fail** -> `npm --prefix admin/portal test`.

- [ ] **Step 3: Implement** the view. Allman; hoist all step/field labels and reveal copy. Fresh form slots per render (a Visual holds one parent). Full-gate via `operator.MutatingAct` for submit and finish.

- [ ] **Step 4: Run to verify they pass** and byte-scan.

- [ ] **Step 5: Commit** `feat(portal): ProvisionWizardView with one-time secret reveal`

---

### Task 9: "Provision customer" entry on the Clients screen

**Files:**
- Modify: `admin/portal/src/kit/page-header.ts` (optional `secondaryAction`)
- Modify: `admin/portal/src/section-container-view.ts` (`ListSecondaryAction()` seam, default undefined; pass to the list header)
- Modify: `admin/portal/src/clients-view.ts` (override `ListSecondaryAction` with a Full-gated "Provision customer" Act that enters Custom state hosting `ProvisionWizardView`)
- Test: `admin/portal/tests/clients-view.test.ts` (+ a kit header test if one exists for `page-header`)

**Interfaces:**
- Consumes: `ProvisionWizardView` (Task 8), existing `SectionContainerView` Custom-state machinery (`EnterCustom`/`SwapScreen`, return-to-list), `operator.MutatingAct`.
- Produces: `PageHeader` input gains optional `secondaryAction?: Act` rendered beside `primaryAction` in the title row. `SectionContainerView` gains `protected ListSecondaryAction(): Act | undefined { return undefined }` and passes it to the list `PageHeader` (and, so a zero-client tenant can still provision, also exposes the provision action in the empty state -- extend the empty-state panel input to accept an optional secondary action, default none). Only `ClientsView` overrides `ListSecondaryAction`.
- `ClientsView` override: a Full-gated "Provision customer" `Act` (via `operator.MutatingAct`) that calls a private `ShowProvision()` which `SwapScreen(new ProvisionWizardView(this.client, this.operator, () => <return to list + Refresh>))`. No new sidebar nav entry.

- [ ] **Step 1: Write the failing tests**
- `the Clients list shows a Full-gated "Provision customer" action for a Full operator and omits it for an Observer`.
- `activating "Provision customer" swaps to the provision wizard, and the wizard's onDone returns to the Clients list`.
(Keep the existing "Create client" primary-action tests green.)

- [ ] **Step 2: Run to verify they fail** -> `npm --prefix admin/portal test`.

- [ ] **Step 3: Implement** the `PageHeader` secondary action, the base seam (default undefined; the other 3 section views inherit the no-op and are unaffected), and the `ClientsView` override hosting the wizard in Custom state.

- [ ] **Step 4: Run to verify they pass**, then the FULL portal gate (`npm --prefix admin/portal test` + `npm --prefix admin/portal run typecheck`) and root `npm run typecheck:tools`. Byte-scan every edited file.

- [ ] **Step 5: Commit** `feat(portal): Full-gated "Provision customer" entry on the Clients screen`

---

## Notes for the executor

- The IdP realm + Owner teardown does not exist and must NOT be fabricated; `DeleteTenant` only removes the directory record. This is why rollback of a provisioned tenant always reports `idp-realm:<tenant>` residue (Task 2). A follow-up "Tenant de-provision" capability is deferred as a GitHub Feature.
- Run the control-plane gate and the portal gate SEQUENTIALLY (cwd race). node:test summary lines use the `` prefix; when grepping a captured log for pass/fail use `"(tests|pass|fail)"` or `"tests [0-9]+$"`, not `^#`.
- Stage only by explicit path; never `git add -A`. The design doc and this plan are committed only when the branch merges (established pattern). EOL stays LF; new `.ts` pure ASCII.
