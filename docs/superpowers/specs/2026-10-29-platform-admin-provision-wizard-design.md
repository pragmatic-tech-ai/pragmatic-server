# PA-W1 - Provisioning Wizard (atomic client+tenant+hive provision) - Design

**Status:** DRAFT for your review (the FIRST backend build; surfaced before SDD per the standing agreement). Approved-in-principle under the mandate: user authorized backend work and chose the provisioning wizard, then chose the ATOMIC provision-endpoint shape. This doc is the checkpoint - read it, then I proceed to plan + SDD.
**Area:** control-plane (`admin/control-plane/`): one new `POST /api/provision` route + an orchestration that composes existing services with rollback. Portal (`admin/portal/`): a guided multi-step wizard + a one-time-secret reveal + two new UI primitives.
**Builds on:** existing `PlatformDirectory` (CreateClient/Tenant/Hive + DeleteClient/Tenant/Hive), `TenantProvisioningService.Provision` (seeds the Owner with a one-time password), `PlatformDeploymentRegistry.RegisterHive` (one-time agent token); the portal create views (`create-client/tenant/hive`), `ComboOption`, the Full-gated `Act` / `operator.MutatingAct`.

## Context

The operator provisions a new customer by creating, in order, a **client -> tenant -> hive**. Each piece already has a create path, and two of them mint a ONE-TIME secret the operator must capture:
- `TenantProvisioningService.Provision` seeds the tenant's single Owner account with a randomly generated password, returned exactly once (`control-plane-host.ts:1086` "revealed exactly once here; never logged or stored").
- `PlatformDeploymentRegistry.RegisterHive(hiveId)` returns the hive's raw agent token exactly once (`:963` "appears in this response body only; the registry stores just its hash").

Today these are three separate operator actions across three screens, the portal DROPS both secrets (`ControlPlaneClient.CreateTenant` returns only `TenantDto`; there is no `RegisterHive` client call), and a mid-sequence failure leaves orphaned half-provisioned state (a client with no tenant, a tenant with no hive). Environment creation is NOT operator-plane (the host's `/api/environments` is GET-only; environments are tenant/dev-side) - so the chain is client -> tenant -> hive only.

The user chose an **atomic** server-side provision: one transaction, rollback on partial failure, both secrets returned once, consumed by a guided wizard.

## Recon findings (binding) + rulings

1. **ONE new control-plane route `POST /api/provision`, Full-gated, orchestration-only (no new store).** Ruling: a new `ProvisioningOrchestrator` (or a host method) composes the EXISTING services in order - `directory.CreateClient` -> `provisioning.Provision` (which creates the tenant record + Owner) -> `directory.CreateHive` -> `deployments.RegisterHive`. It persists NO new record type; it only sequences existing creates. The route is a mutation, so the central `OperatorAuthorization.Authorize` already makes it Full-only (no authz rule change). It is the only backend addition.

2. **Rollback = compensating deletes in reverse order, best-effort, reported honestly.** The stores are independent JSON-record stores with no cross-store transaction. Ruling: on a step failure, run the compensating deletes for the steps that DID succeed, in reverse order (`DeleteHive` -> `DeleteTenant` -> `DeleteClient`), then return the original error. If a compensating delete itself fails, do NOT swallow it silently - the response reports which pieces could not be rolled back (an operator must know a client/tenant was left behind). reported == enforced: the response never claims a clean rollback it did not achieve. (Open design question O1 below: whether to pre-validate all three inputs before any create, to make most failures fail BEFORE any write.)

3. **Idempotency / pre-validation.** Ruling: validate ALL inputs (client id/displayName, tenant id/displayName/ownerEmail, hive id/displayName/cluster/registry) up front and reject (400, no writes) before creating anything - so the common failure (a bad field, a duplicate id) never creates partial state and never needs rollback. Rollback then only covers genuine mid-sequence runtime failures (a store write throwing after an earlier success). Duplicate-id on any of the three -> 409, no writes.

4. **Both one-time secrets returned once, by value, in the provision response ONLY; never logged/stored/echoed again.** Ruling: the `201` response body carries `{ client, tenant, hive, secrets: { ownerEmail, ownerPassword, agentToken } }`. The secrets appear in THIS response and nowhere else (same contract the existing single routes already honor). The portal shows them on a one-time reveal screen the operator must acknowledge; they are never put in a portal field beyond the reveal Visual, never logged, never re-fetchable. No GET ever returns them.

5. **Portal: a guided multi-step wizard + a one-time-secret reveal, with two new kit primitives.** Ruling: add the deferred primitives, now justified: `Steps` (a step indicator / container for a linear multi-step form) and `OnceSecret` (a reveal control for a value shown once, with a copy affordance and a "I have saved this" confirm that is required before the wizard can finish). The wizard collects client+tenant+hive fields across steps, POSTs once to `/api/provision`, then shows the `OnceSecret` reveal for the owner password + agent token. Full-gated (an Observer cannot open/submit it). A new `ControlPlaneClient.Provision(input): Promise<ProvisionResult>` (the one call). The wizard is reached from a Full-gated "Provision..." action (home TBD in O2).

6. **Honesty / security (binding).** reported == enforced: the wizard shows exactly what the server provisioned and the exact secrets it returned; a rollback is reported truthfully; the secrets live only in the reveal Visual (not a VM field, not a log, not a URL). No fabricated success. No secret re-fetch path.

## Goals

- One Full-gated operator action provisions client+tenant+hive atomically (rollback on partial failure) and reveals both one-time secrets once, captured by the operator.
- Eliminate orphaned half-provisioned state from a mid-sequence failure.
- Surface the owner password + agent token the backend already generates (today dropped by the portal).

## Non-goals / deferred (filed as Features)

- Environment provisioning (not operator-plane; tenant/dev-side).
- Provisioning MORE than one hive, or editing/re-provisioning an existing customer.
- A durable provision audit/history record (that is the separate G9 audit store).
- Re-revealing a lost secret (impossible by design - the operator must capture it at reveal time; a lost owner password is recovered via a future password-reset Feature, a lost agent token via re-registration).
- A true cross-store DB transaction (the stores are file-backed; compensating deletes are the rollback mechanism).

## Anti-goals (a failure even if it "works")

- Leaving orphaned state after a failure without reporting it (a swallowed compensating-delete failure).
- Logging / storing / re-returning either secret, or keeping it in a VM field or URL.
- Claiming success when a later step failed, or claiming a clean rollback that did not happen.
- Writing anything when an input is invalid/duplicate (must pre-validate -> 400/409 with no writes).
- An Observer reaching the provision call (must be Full-gated end to end; server 403s regardless).
- Partial atomicity that creates the tenant's IdP/Owner but then cannot roll it back cleanly (O3 below - needs the tenant de-provision path confirmed).

## Open design questions for you (O1-O3)

- **O1 - rollback depth:** pre-validation (ruling 3) makes most failures fail before any write. For the residual mid-sequence runtime failure, is best-effort reverse-delete + honest reporting acceptable for v1, or do you want the orchestrator to refuse to start unless all compensating paths are known-good? (Recommend: best-effort + honest report for v1.)
- **O2 - wizard entry point:** where does "Provision..." live? Options: a top-level action on the Clients screen (the provisioning root), or a new nav entry. (Recommend: a Full-gated "Provision customer" primary action on the Clients list - no new nav.)
- **O3 - tenant de-provision for rollback:** `TenantProvisioningService.Provision` seeds an IdP realm + Owner. `directory.DeleteTenant` removes the directory record - does it (or must the orchestrator also) tear down the seeded IdP/Owner so a rolled-back tenant leaves nothing behind? This is the one spot that may need a small new `TenantProvisioningService.Deprovision`. I will confirm during planning; flagging because it is the one place the "atomic" promise could leak.

## Information architecture (decided shape)

Control plane (`admin/control-plane/`):
- `provisioning-orchestrator.ts` (NEW) - `Provision(input): Promise<ProvisionResult>` composing the existing services with pre-validation + reverse-order compensating rollback + a truthful rollback report. `ProvisionInput = { client, tenant, hive }`; `ProvisionResult = { client: ClientRecord; tenant: TenantRecord; hive: HiveRecord; secrets: { ownerEmail; ownerPassword; agentToken } }`.
- `control-plane-host.ts` - add `ProvisionPath = '/api/provision'` + a POST arm calling the orchestrator; `201` with the result DTO (secrets inline), or `400`/`409` (no writes) / `500` with the rollback report. No `OperatorAuthorization` change. (6 pre-existing non-ASCII bytes unchanged.)
- Possibly `tenant-provisioning-service.ts` - a `Deprovision(tenantId)` if O3 requires it.

Portal (`admin/portal/src/`):
- `portal-types.ts` - `ProvisionInputDto` / `ProvisionResultDto` (+ `ProvisionSecretsDto`).
- `api-client.ts` - `Provision(input): Promise<ProvisionResultDto>` (POST `/api/provision`).
- `kit/steps.ts` (NEW) - `Steps` linear multi-step container/indicator. `kit/once-secret.ts` (NEW) - `OnceSecret` one-time reveal (value + copy + required "saved it" confirm).
- `provision-wizard-view.ts` + `provision-wizard-view-model.ts` (NEW) - the multi-step form (client -> tenant -> hive), one `Provision` call, then the `OnceSecret` reveal (owner password + agent token) gated behind the confirm before "Finish". Full-gated via `operator.MutatingAct`.
- Entry point per O2.

Tests:
- Control-plane (`npx tsx --test`): happy path provisions all three + returns both secrets; a duplicate/invalid input -> 400/409 with ZERO writes (assert stores unchanged); a mid-sequence failure (inject a failing CreateHive) -> the client+tenant are rolled back (stores clean) and the error is reported; a compensating-delete failure -> the response reports the leftover honestly; ReadOnly -> 403; unauth -> 401; the secrets appear only in this response (no GET returns them).
- Portal: the VM validates each step; `Provision` is called once with the composed input; the `OnceSecret` reveal shows both secrets and "Finish" is blocked until the confirm; an Observer cannot open/submit; the secrets are never stored in a VM field (reveal Visual only); error from the server surfaces.

## Constraints (inherited, binding)

- OOP; Allman braces; PascalCase public methods/interfaces; enums over string-literal unions; VMs extend `Observable`; `IDisposable` not lambdas; tests under `tests/`.
- No inline reused literals - hoist (route path, body keys, step/field labels, reveal copy, error text).
- New `.ts`: pure ASCII, LF; byte-scan `0 0 N`. `control-plane-host.ts` keeps its 6 pre-existing non-ASCII (add none).
- SECURITY: both secrets by value in the provision response ONLY; never logged/stored/echoed/re-fetchable; in the portal they live only in the reveal Visual, never a VM field/URL. reported == enforced; truthful rollback.
- Full-gated via the central mutation gate (no authz rule change) + `operator.MutatingAct` in the UI.
- Gate asymmetry: control-plane `npx tsx --test` + root `typecheck:tools`; portal `npm test` + `npm run typecheck`. Both green on the merged result.
- No cross-app import; fresh-slot/no-double-parent in the wizard; merge locally, NEVER push.

## Review focus (inputs no happy-path test exercises)

- A duplicate client/tenant/hive id -> 409, ZERO writes (no partial state). (CP test asserting stores unchanged.)
- CreateHive throws after client+tenant succeeded -> both rolled back (reverse order), stores clean, error reported. (CP fault-injection test.)
- A compensating delete ALSO fails -> the response reports exactly what was left behind (no silent swallow). (CP test.)
- Both one-time secrets appear ONLY in the provision response; no GET re-returns them; the portal keeps them out of every VM field. (CP + portal + code review.)
- An Observer -> cannot open/submit the wizard (UI gated) and the server 403s `/api/provision`. (portal + CP tests.)
- "Finish" blocked until the operator confirms they saved the secrets. (portal test.)
- O3: a rolled-back tenant leaves no IdP/Owner residue. (CP test once the de-provision path is settled.)
