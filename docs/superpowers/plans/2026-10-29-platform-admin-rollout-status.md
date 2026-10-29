# Platform Admin Rollout Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface authoritative fleet-wide rollout reality (per hive x environment: target version, running image, on-target/behind/not-ready) as a new "Rollout status" section on Release Policy, backed by one additive non-secret control-plane read.

**Architecture:** The control-plane host composes a global rollout aggregate from `directory.ListHives()` + `deployments.StatusFor(id)` (no registry change) and serves it at `GET /api/rollouts` (safe GET, both roles). The portal fetches it alongside gating/selections and renders a third `DataTable` section on the existing single-screen `ReleasePolicyView`, using the server's authoritative flags verbatim.

**Tech Stack:** TypeScript (ESM, `.js` specifiers); control-plane `node:http` host + `node:test`; portal `@pragmatic-tech-ai/mural` + the portal `kit` + `node:test` with the `Application.current` harness.

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-rollout-status-design.md`

## Global Constraints

- OOP; Allman braces; PascalCase public methods/interfaces; enums over string-literal unions; view-models extend `Observable`; `IDisposable` not lambdas; tests under `tests/`.
- No inline user-facing / reused string literals - hoist to `private static readonly` (route path, column keys/headers, status labels, fallback labels, empty text).
- New `.ts`: pure ASCII, LF. Byte-scan every written `.ts`: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`. `control-plane-host.ts` has 6 PRE-EXISTING non-ASCII bytes - the diff must add NONE (verify: non-ASCII count unchanged before/after). Match EOL (all LF).
- AUTHORITATIVE + HONEST: the portal shows exactly what `StatusFor` reports (targetVersion, per-env runningImage/obsolete/ready). Do NOT re-derive obsolete/target client-side. No fabricated rows or status. reported==enforced.
- `/api/rollouts` is NON-secret operational state: a safe GET allowed to BOTH roles (Full + ReadOnly). Do NOT add it to `OperatorAuthorization.FullOnlyReadPaths`. The response carries only `{ hiveId, targetVersion?, environments:[{ environmentName, runningImage?, obsolete, ready }] }` - no secret/internal ref.
- No cross-app import (`admin/tenant-portal`); status shown as icon+text (pill); stateful view survives a second `Refresh()` (fresh section slot per render).
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; portal `npm test` + `npm run typecheck` in `admin/portal`. BOTH green on the merged result.

## Review Focus

- Hive with a selection but an env on a different image -> "Behind target" (obsolete true). -> Task 1 (CP) + Task 3 (VM).
- Hive with NO selection -> targetVersion undefined -> "No target", not "On target"; obsolete false. -> Task 1 + Task 3.
- Rollout row whose hiveId is absent from the fleet -> "(unknown hive)", kept. -> Task 3.
- Env with `runningImage` undefined -> "Not reported" label, not "undefined". -> Task 3.
- `/api/rollouts` reachable by ReadOnly (200), unauth -> 401 (proves NOT Full-gated). -> Task 1.
- Fleet with rollout rows but zero gating/selections -> screen NOT empty. -> Task 4.
- Second `Refresh()` re-renders all sections with no double-parent. -> Task 4.

---

### Task 1: `GET /api/rollouts` global rollout read

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts`
- Test: the control-plane host test file that already exercises rollout/fleet routes (add cases there; otherwise `admin/control-plane/tests/control-plane-host-rollout.test.ts`)

**Interfaces:**
- Produces: `GET /api/rollouts` -> `HiveRolloutsEntryDto[]` where `HiveRolloutsEntryDto = { hiveId: string; targetVersion?: string; environments: { environmentName: string; runningImage?: string; obsolete: boolean; ready: boolean }[] }`.
- Consumes: existing `this.directory.ListHives()` (authoritative hive list) and `this.deployments.StatusFor(hiveId): HiveRolloutStatus`.

- [ ] **Step 1: Write failing host tests** (study the existing rollout/fleet host tests + how a hive + selection + observation are seeded in that harness, and how auth-as-Full vs ReadOnly vs anon is done):
  - seed a hive with a selected target version + an observed env whose running image != the target image -> `GET /api/rollouts` (authed) returns an entry for that hive with `targetVersion` set and that env `obsolete: true`.
  - an env whose running image == target + `ready: true` -> `obsolete: false`.
  - a hive with NO selection -> its entry has `targetVersion` undefined (absent in JSON) and envs `obsolete: false`.
  - the entry/env objects carry no key beyond the documented ones.
  - authenticated as ReadOnly -> 200 (NOT 403: proves it is not Full-gated); unauthenticated -> 401.
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** - add `private static readonly RolloutsAllPath = '/api/rollouts'`; in `RouteApi`, an exact-path GET arm: `if (path === ControlPlaneHost.RolloutsAllPath && method === PlaneHttp.MethodGet) { const rollouts = this.directory.ListHives().map(h => { const s = this.deployments.StatusFor(h.id); return { hiveId: h.id, targetVersion: s.targetVersion, environments: s.environments } }); PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, rollouts); return true }`. No auth code here (central gate handles authn/role; it is a safe GET so both roles pass - do NOT touch OperatorAuthorization). No registry change.
- [ ] **Step 4: Byte-scan `control-plane-host.ts`** - confirm non-ASCII count is still 6 and CR is 0 (diff added none); test file `0 0 N`.
- [ ] **Step 5: `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; commit** (`feat(control-plane): GET /api/rollouts global rollout status (both roles)`).

---

### Task 2: Portal rollout DTOs + client

**Files:**
- Modify: `admin/portal/src/portal-types.ts`, `admin/portal/src/api-client.ts`
- Test: `admin/portal/tests/api-client-platform.test.ts` (add a `ListRollouts` case mirroring `ListSelections`)

**Interfaces:**
- Consumes: `GET /api/rollouts` (Task 1).
- Produces: `EnvRolloutDto = { environmentName: string; runningImage?: string; obsolete: boolean; ready: boolean }`; `HiveRolloutDto = { hiveId: string; targetVersion?: string; environments: EnvRolloutDto[] }`; `ControlPlaneClient.ListRollouts(): Promise<HiveRolloutDto[]>`.

- [ ] **Step 1: Write failing test** - `ListRollouts` issues `GET /api/rollouts` and returns the parsed `HiveRolloutDto[]` (mirror the `ListSelections` test).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the two DTO types (keep them in the DTO group with the other `*Dto`) and the client method (mirror `ListSelections`/`ListManifests`: no-arg GET via a hoisted `RolloutsRoute` constant, shared `Send` path).
- [ ] **Step 4: Byte-scan each touched file -> `0 0 N`.**
- [ ] **Step 5: `npm test` + `npm run typecheck` in `admin/portal`; root `npm run typecheck:tools`; commit** (`feat(portal): ListRollouts client + rollout DTOs`).

---

### Task 3: `ReleasePolicyViewModel` rollout rows

**Files:**
- Modify: `admin/portal/src/release-policy-view-model.ts`
- Test: `admin/portal/tests/release-policy-view-model.test.ts` (add rollout-row cases)

**Interfaces:**
- Consumes: `HiveRolloutDto` (Task 2), `FleetHiveDto`, `FleetViewModel.OwnerLabel`.
- Produces: `RolloutRow = { hiveName: string; ownerLabel: string; envName: string; targetLabel: string; runningLabel: string; statusLabel: string; statusKind: <pill kind enum> }`; `get RolloutRows(): readonly RolloutRow[]`; `RolloutRowsProperty` change key; the ctor + `Update` gain a `rollouts: readonly HiveRolloutDto[]` parameter (LAST param, so existing positional call sites are updated in Task 4).

- [ ] **Step 1: Write failing VM tests**:
  - flatten hive x env into rows; join `hiveId` -> fleet for `hiveName` + `ownerLabel` (via `FleetViewModel.OwnerLabel`); unknown hive -> `hiveName` '(unknown hive)' + owner '(unassigned)' (reuse the existing PA-9 constants).
  - status mapping: `targetVersion === undefined` -> label 'No target' (neutral kind); else `obsolete` -> 'Behind target' (warn); else `ready` -> 'On target' (healthy); else 'Not ready' (warn/neutral).
  - `runningImage` undefined -> runningLabel 'Not reported' (hoisted); targetVersion undefined -> targetLabel 'No target' (or a dedicated label).
  - stable sort by hive then environment.
  - `RolloutRows` empty when no rollouts; `Update` with rollouts raises `RolloutRowsProperty`.
- [ ] **Step 2: Implement** - extend ctor/`Update` signature (add `rollouts` last), store it, derive `RolloutRow[]`, add the getter + change key + status mapping (hoist all labels as `private static readonly`; reuse the pill-kind enum the view-models already use for tone). Extend any internal "has any data" notion if the VM exposes one (see Task 4 for the view's empty keying).
- [ ] **Step 3: Run VM tests -> PASS.** Byte-scan -> `0 0 N`.
- [ ] **Step 4: `npm test` + `npm run typecheck` in `admin/portal` (the view still compiles - its call site is updated in Task 4; if the signature change breaks the view's compile, Task 3 may leave the portal typecheck red until Task 4 - acceptable WITHIN this task only if the VM unit tests pass; prefer to keep the `rollouts` param OPTIONAL (`rollouts: readonly HiveRolloutDto[] = []`) so the existing view call site still compiles, then Task 4 passes it for real).** Commit (`feat(portal): rollout rows in ReleasePolicyViewModel`).

---

### Task 4: "Rollout status" section in `ReleasePolicyView`

**Files:**
- Modify: `admin/portal/src/release-policy-view.ts`
- Test: `admin/portal/tests/release-policy-view.test.ts` (add rollout-section cases)

**Interfaces:**
- Consumes: `ReleasePolicyViewModel.RolloutRows` (Task 3), `ControlPlaneClient.ListRollouts` (Task 2), the kit `Section`/`DataTable`/`PillKinds`.

- [ ] **Step 1: Write failing view tests**:
  - the view fetches rollouts (extend the fetch) and renders a third "Rollout status" `Section` with a `DataTable<RolloutRow>` whose rows match the model; status rendered as a pill (text + tone).
  - a response with rollout rows but EMPTY gating + selections -> the screen is NOT the empty state (the non-empty condition now also counts rollout rows).
  - a SECOND `Refresh()` re-renders all three sections with no double-parent.
- [ ] **Step 2: Implement** - add the rollout fetch to the view's `Promise.all` (now gating + selections + tenants + clients + fleet + rollouts); pass `rollouts` to the VM ctor/`Update`; add a fresh `rolloutSlot` rebuilt per `BuildContent` (mirror the existing gated/target slots - a Visual holds one parent); add a "Rollout status" `Section` wrapping a fresh `DataTable<RolloutRow>` (columns Hive, Client/tenant, Environment, Target version, Running, Status[pill via the row's statusKind/statusLabel]); extend `isEmpty` to `gated.length === 0 && target.length === 0 && rollout.length === 0`; `ClearSlots()` clears the rollout slot too. Hoist all new literals (section title, column keys/headers).
- [ ] **Step 3: Run view tests -> PASS.** Byte-scan -> `0 0 N`.
- [ ] **Step 4: `npm test` + `npm run typecheck` in `admin/portal`; root `npm run typecheck:tools`. All green. Commit** (`feat(portal): Rollout status section on Release Policy`).
