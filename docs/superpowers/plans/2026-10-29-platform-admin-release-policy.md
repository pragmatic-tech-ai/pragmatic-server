# Platform Admin — Release Policy (G5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer an explicit, fail-closed release policy (withdraw-enforcement + per-tenant hold + channel-subscription + min-version floor) onto the existing per-tenant gating allowlist, evaluated at one server decision point and surfaced in an editable portal panel.

**Architecture:** A new per-tenant `ReleasePolicyRecord` store and a dependency-free `VersionOrder` comparator feed a single evaluator in `PlatformDeploymentRegistry` (`BlockReasonFor`). Both the operator push (`SelectTarget`/`Record`) and the public agent pull (`RecordAdoption`) throw on a blocked version; both offered lists (`AdoptableFor` for the agent, `GET /api/tenants/:id/manifests` for tenant-admin) filter through the same evaluator, so reported == enforced. Operator mutations are Full-gated routes; the portal `ReleasePolicyView` becomes editable.

**Tech Stack:** TypeScript (Node, `node:test` via `npx tsx`), the admin control-plane + the separate `admin/portal` Mural app. No new npm dependency (no `semver`).

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-release-policy-design.md`

## Global Constraints

- **OOP, no free functions / no module-level mutable state.** Every function is a class method or static member. Module-level `const`/`type`/`enum` only.
- **Allman braces** on every class/interface/enum/method/control-flow block (object literals, arrow bodies, one-line `if (x) return;` stay inline). Hand-maintained; no formatter.
- **No inline string literals** — user-facing text and any reused literal is a `private static readonly` PascalCase constant on the class. Structural single-use tokens (`'.'`, type-guard strings) may stay inline.
- **View models extend `Observable`** (not `MuralBase`).
- **PascalCase** for all interfaces and public methods; private members / JSON-shape fields keep their casing.
- **New `.ts` files: pure ASCII + LF.** `admin/control-plane/control-plane-host.ts` must keep **exactly its 6 pre-existing non-ASCII bytes — add none** (byte-scan after every edit: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` → `6 0 N`).
- **Full-gated == enforced:** every policy mutation is a mutating route; `OperatorAuthorization` denies ReadOnly server-side (403); the portal mirrors (`operator.CanMutate`). No client-side pre-gating of the policy rules themselves.
- **Default channel subscription = all-channels (back-compat):** an absent `channels` field means all channels allowed; the channel rule passes unless a non-empty `channels` set is configured and excludes the version's channel.
- **Never fabricate** a backend/digest/signature. Policy carries no secrets.
- Gate asymmetry: control-plane gate = `npx tsx --test admin/control-plane/tests/*.test.ts` **and** (repo root) `npm run typecheck:tools`; portal gate = `npm --prefix admin/portal test` **and** `npm --prefix admin/portal run typecheck`. Run the two control-plane commands and the two portal commands; root `npm test` does NOT cover control-plane. node:test summary lines prefix with `ℹ`.
- Stage only by explicit path (never `git add -A`); `docs/` is never staged by task commits. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **Agent-channel bypass.** The public `AgentChannelHost` adopt route must be unable to adopt a policy-blocked version — it calls `RecordAdoption` → `Record` → `BlockReasonFor`. Test: an agent adopt of a withdrawn/held/below-floor/unsubscribed-channel version → 403 with the generic `AdoptRefusedMessage` (no per-rule detail leaked to the agent). (Task 5.)
- **Reported == enforced.** `AdoptableFor(hiveId)` and `GET /api/tenants/:id/manifests` must return exactly the set `RecordAdoption`/`SelectTarget` would accept — same evaluator, same fixture, asserted on both paths. (Tasks 4, 5.)
- **Back-compat default.** A tenant with no policy record (and smokes that construct the registry without a `policies` store) behaves exactly as today except a *withdrawn* gated version is no longer adoptable. Test: no-policy tenant adopts any channel; a withdrawn gated version is refused. (Task 4.)
- **Floor numeric ordering.** `1.10.0` is **above** `1.9.0`; an equal version is adoptable, one below is refused; odd input never throws. Table test. (Tasks 1, 4.)
- **Hold actor provenance + reason.** A hold's `actor` comes from the authenticated session, never the request body; an empty/whitespace reason is 400. (Task 5.)

---

### Task 1: `VersionOrder` comparator

**Files:**
- Create: `admin/control-plane/version-order.ts`
- Test: `admin/control-plane/tests/version-order.test.ts`

**Interfaces:**
- Produces: `class VersionOrder { public static Compare(a: string, b: string): number }` → `-1 | 0 | 1`.

- [ ] **Step 1: Write the failing test** — a table over pairs with expected sign: `('1.0.0','1.0.0')→0`, `('1.10.0','1.9.0')→1`, `('1.9.0','1.10.0')→-1`, `('1.4','1.4.1')→-1` (missing segment is lower), `('2.0.0','1.9.9')→1`, `('1.0.0-rc','1.0.0')` (non-numeric segment compares as string, assert deterministic + no throw), `('','0')→-1`, and that `Compare` is antisymmetric on the table (`sign(Compare(a,b)) === -sign(Compare(b,a))`).
- [ ] **Step 2: Run the test, verify it fails** — `npx tsx --test admin/control-plane/tests/version-order.test.ts`.
- [ ] **Step 3: Implement `VersionOrder.Compare`** — split both on `'.'`; iterate to the longer length; for each index, read each side's segment (missing = lower). If both segments are all-ASCII-digits, compare numerically (parse to integer; guard against overflow by comparing digit-stripped length then lexically, or `Number` is fine for realistic versions); otherwise compare the two segment strings with `<`/`>`. Return the first non-zero result, else `0`. Never throw. Pure ASCII, Allman braces, constants hoisted.
- [ ] **Step 4: Run the test, verify it passes.**
- [ ] **Step 5: Byte-scan** `version-order.ts` → `0 0 N`. **Commit** (`admin/control-plane/version-order.ts` + its test).

---

### Task 2: Policy record store + error classes

**Files:**
- Create: `admin/control-plane/release-policy-record.ts`
- Modify: `admin/control-plane/rollout-errors.ts`
- Test: `admin/control-plane/tests/release-policy-record.test.ts`

**Interfaces:**
- Consumes: `Channel` from `./channel.js`; `JsonRecordStore` from `./json-record-store.js`.
- Produces:
  - `type ReleasePolicyRecord = { id: string; tenantId: string; channels?: Channel[]; minVersion?: string; hold?: { reason: string; actor: string; at: string } }` (`id === tenantId`).
  - `class ReleasePolicyRegistry extends JsonRecordStore<ReleasePolicyRecord>` with `RootKey = 'releasePolicies'` (constructor `(filePath: string)`), mirroring `GatingRegistry`.
  - New error classes in `rollout-errors.ts`, each `extends Error` with a hoisted `ErrorName`/`MessagePrefix` (mirror `ManifestNotGatedError`): `ManifestWithdrawnError`, `TenantOnHoldError`, `ChannelNotSubscribedError`, `VersionBelowFloorError` (each ctor takes the version or tenant id and builds a fixed-prefix message).

- [ ] **Step 1: Write the failing test** — construct a `ReleasePolicyRegistry` over a temp file, `Load`, `Put` a record, `Get(tenantId)` returns it, `List()` contains it; `Put` of the same id replaces (store is keyed). (Error classes are exercised by later tasks; here just assert each `new XError('1.2.3').name` and that `.message` contains the id.)
- [ ] **Step 2: Run the test, verify it fails.**
- [ ] **Step 3: Implement** `release-policy-record.ts` (type + registry) and add the four error classes to `rollout-errors.ts`. Allman, hoisted constants, ASCII+LF on the new file; `rollout-errors.ts` stays ASCII.
- [ ] **Step 4: Run the test, verify it passes.**
- [ ] **Step 5: Byte-scan both files** (new file `0 0 N`; `rollout-errors.ts` must stay `0 0 N`). **Commit** (the new file, `rollout-errors.ts`, the test).

---

### Task 3: Registry policy state + mutations + wiring

**Files:**
- Modify: `admin/control-plane/platform-deployment-registry.ts`
- Modify: `admin/control-plane/server.ts` (pass the new store)
- Modify: `admin/control-plane/tests/rollout-fixture.ts` (compose the store so tests can exercise policy)
- Test: `admin/control-plane/tests/platform-deployment-registry.test.ts` (add policy-mutation tests)

**Interfaces:**
- Consumes: `ReleasePolicyRegistry`, `ReleasePolicyRecord` (Task 2); `Channel`.
- Produces (new public surface on `PlatformDeploymentRegistry`):
  - Constructor gains an **optional last** parameter `private readonly policies?: ReleasePolicyRegistry` (after the existing `signer?`). Absent ⇒ hold/channel/floor are no-ops (gating + withdrawn still enforced in Task 4).
  - `AllPolicies(): readonly ReleasePolicyRecord[]`
  - `async SetChannels(tenantId: string, channels: Channel[]): Promise<ReleasePolicyRecord>`
  - `async SetMinVersion(tenantId: string, version: string): Promise<ReleasePolicyRecord>`
  - `async ClearMinVersion(tenantId: string): Promise<ReleasePolicyRecord>`
  - `async SetHold(tenantId: string, reason: string, actor: string): Promise<ReleasePolicyRecord>`
  - `async ClearHold(tenantId: string): Promise<ReleasePolicyRecord>`
  - Each mutation reads the existing record (`policies.Get(tenantId)`), merges the one field (create-or-merge; clearing drops the key via destructure, like `SetWithdrawn`'s restore), `Put`s, and returns the updated record. All mutations throw a hoisted `PolicyStoreUnavailableError` (add to `rollout-errors.ts`, mapped 409/500 in Task 5 — ruling: 500, it is a server misconfiguration) if `this.policies === undefined`; the server always wires it, so this is unreachable in production.

- [ ] **Step 1: Write the failing tests** (in the registry test, composing via `RolloutFixture.Create` after it accepts a policy store): `SetChannels` then `AllPolicies` reflects it; `SetMinVersion` then `SetHold` on the same tenant **merge** (both fields present, one record); `ClearMinVersion` removes only `minVersion` (keeps `hold`); `ClearHold` removes only `hold`. Assert `id === tenantId`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Add the ctor param and the six methods to `platform-deployment-registry.ts`. Update `rollout-fixture.ts` to construct a `ReleasePolicyRegistry` (new temp file `release-policies.json`), `Load` it alongside the others, and pass it last to the ctor. Update `server.ts` to construct the store (`new ReleasePolicyRegistry(join(dataRoot, ControlPlaneServer.ReleasePoliciesFile))` with a hoisted `ReleasePoliciesFile = 'release-policies.json'` constant, `Load` it in the existing `Promise.all`, pass it after the signer arg). Add `PolicyStoreUnavailableError` to `rollout-errors.ts`. **Do NOT** touch the six smoke files — the param is optional, they keep compiling.
- [ ] **Step 4: Run** the registry test (pass) **and** `npm run typecheck:tools` from the repo root (both portals + tools typecheck clean — the ctor change must not break any construction site).
- [ ] **Step 5: Byte-scan** every edited `.ts` (`platform-deployment-registry.ts`, `server.ts`, `rollout-fixture.ts`, `rollout-errors.ts` all `0 0 N`). **Commit** by explicit path.

---

### Task 4: The evaluator + enforcement (security core)

**Files:**
- Modify: `admin/control-plane/platform-deployment-registry.ts`
- Test: `admin/control-plane/tests/platform-deployment-registry.test.ts`

**Interfaces:**
- Consumes: `VersionOrder` (Task 1); the four policy errors + `ReleasePolicyRecord` (Task 2); the `policies` field (Task 3).
- Produces:
  - private `BlockReasonFor(tenantId: string, manifest: ManifestRecord): PolicyBlock | undefined` where `type PolicyBlock = 'not-gated' | 'withdrawn' | 'held' | 'channel' | 'floor'` (a module-level union). Evaluates in that fixed order; returns the first failing reason or `undefined`. `not-gated` = no gate record for `(tenantId, manifest.id)`. `withdrawn` = `manifest.withdrawn === true`. `held`/`channel`/`floor` are skipped when `this.policies` is undefined or has no record / no field. `channel`: the policy record has a **non-empty** `channels` array that does **not** include `manifest.channel ?? Channel.Stable`. `floor`: `minVersion` set and `VersionOrder.Compare(manifest.id, minVersion) < 0`.
  - private `BlockError(reason: PolicyBlock, version: string): Error` → the typed error (`ManifestNotGatedError` / `ManifestWithdrawnError` / `TenantOnHoldError` / `ChannelNotSubscribedError` / `VersionBelowFloorError`).
  - public `AdoptableForTenant(tenantId: string): readonly ManifestRecord[]` = `ManifestsFor(tenantId)` filtered to `BlockReasonFor(...) === undefined`.
  - `AdoptableFor(hiveId)` now returns `AdoptableForTenant(hive.tenantId)`.
  - `Record(hiveId, version)` replaces its inline gate lookup with: resolve hive + manifest, `const reason = this.BlockReasonFor(hive.tenantId, manifest); if (reason !== undefined) { throw this.BlockError(reason, version); }`, then write the selection. (Behaviour unchanged for a plain gated, non-withdrawn, no-policy version.)

- [ ] **Step 1: Write the failing tests.** Using the fixture (hive→tenant wired): (a) gated + non-withdrawn + no policy → `AdoptableForTenant`/`AdoptableFor` includes it and `RecordAdoption` succeeds; (b) **withdrawn** gated version → excluded from both offered lists AND `RecordAdoption` throws `ManifestWithdrawnError`; restore → re-included + adoptable; (c) **hold** set → every version excluded + `RecordAdoption` throws `TenantOnHoldError`; clear → restored; (d) **channel**: default (no `channels`) adopts an `early` version; after `SetChannels([Stable])` the `early` version is excluded + throws `ChannelNotSubscribedError`, a `stable` version still adopts; (e) **floor**: `SetMinVersion('1.10.0')` → `1.9.0` excluded + throws `VersionBelowFloorError`, `1.10.0` adoptable (boundary); (f) **reported == enforced**: assert the set from `AdoptableForTenant` equals the set of versions for which `RecordAdoption` does not throw, over a mixed fixture; (g) **precedence**: a version that is both withdrawn and below-floor throws `ManifestWithdrawnError` (order).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `BlockReasonFor` / `BlockError` / `AdoptableForTenant` and rewire `AdoptableFor` + `Record`. Keep the existing `ManifestsFor` (raw gated set) unchanged — it is the operator dashboard's input and the base for `AdoptableForTenant`.
- [ ] **Step 4: Run** the registry test + `npm run typecheck:tools` (pass).
- [ ] **Step 5: Byte-scan** `platform-deployment-registry.ts` → `0 0 N`. **Commit** by explicit path.

---

### Task 5: Control-plane host routes

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts`
- Modify: `admin/control-plane/agent-channel-host.ts` (map the four new policy errors to the public 403 refusal)
- Test: `admin/control-plane/tests/control-plane-host-rollout.test.ts`

**Interfaces:**
- Consumes: the registry mutations + `AllPolicies` + `AdoptableForTenant` (Tasks 3, 4); the policy errors (Task 2).
- Produces (routes; all mutating ones Full-gated by the central `Authorize` before dispatch):
  - `GET /api/policies` → `[...this.deployments.AllPolicies()]` (add `PoliciesAllPath = '/api/policies'`, sibling to `GatingAllPath`).
  - A new `TenantPolicyPathPattern = /^\/api\/tenants\/([^/]+)\/policy\/(channels|min-version|hold)$/` and a `RouteTenantPolicy(req,res,method,m)` handler, dispatched next to `RouteRollout`:
    - `channels` + `PUT`: body `{ channels: string[] }`; every entry must be a valid `Channel` wire value else 400 (`ChannelInvalidMessage`, reuse); → `SetChannels(id, channels as Channel[])`; 200 with the updated `ReleasePolicyRecord`.
    - `min-version` + `PUT`: body `{ version: non-empty string }` (reuse `ReadVersion`/`VersionRequiredMessage`) → `SetMinVersion`; 200 record. `min-version` + `DELETE` → `ClearMinVersion`; 200 record.
    - `hold` + `POST`: body `{ reason: non-empty trimmed string }` (reuse `ReasonRequiredMessage`); actor = `(await this.Principal(req))?.email ?? ...?.principalId ?? ''` (mirror `RouteManifestWithdrawn`) → `SetHold(id, reason.trim(), actor)`; 200 record. `hold` + `DELETE` → `ClearHold`; 200 record.
    - Unknown `(action, method)` combos → `return false` (fall through to 404), consistent with `RouteRollout`.
  - Map the new errors in `ErrorStatuses`: `ManifestWithdrawnError`→409, `TenantOnHoldError`→409, `ChannelNotSubscribedError`→403, `VersionBelowFloorError`→409, `PolicyStoreUnavailableError`→500.
  - **Agent-channel refusal mapping (folded in from the Task 4 review — Major):** in `admin/control-plane/agent-channel-host.ts`, the `adopt` route's error handler currently maps only `ManifestNotGatedError | UnknownManifestError` → its 403 `AdoptRefusedMessage`. `RecordAdoption` can now throw the four new policy errors; add `ManifestWithdrawnError`, `TenantOnHoldError`, `ChannelNotSubscribedError`, `VersionBelowFloorError` to that same 403 refusal branch (the agent gets the generic refusal, never the per-rule reason) and update the now-stale comment that says "only the adopt route can raise these". Without this they fall through to 500 — fail-closed but wrong status (agent retries).
  - **Reported == enforced for tenant-admin:** change the existing `GET /api/tenants/:id/manifests` handler in `RouteRollout` from `ManifestsFor(id)` to `AdoptableForTenant(id)` (a tenant is shown only what it may actually adopt).
- A `PolicyDto` HTTP shape is the `ReleasePolicyRecord` as-is (channels as the string enum values) — reuse the existing `ManifestDto`-style local type alias if the file has one, else send the record directly.

- [ ] **Step 1: Write the failing tests** (mirror the existing rollout host tests, driving the host with Full and ReadOnly operators): `GET /api/policies` returns the records; `PUT .../policy/channels` with `['stable','early']` persists (then `GET /api/policies` shows it); invalid channel → 400; `PUT .../policy/min-version` `{version:'1.2.0'}` then `DELETE` clears; empty version → 400; `POST .../policy/hold` `{reason:'incident'}` sets with actor from the session (assert actor), `DELETE` clears; empty/whitespace reason → 400; **every** mutating policy route returns 403 for a ReadOnly operator; the policy-blocked error statuses (gate a withdrawn version, then an operator `SelectTarget` → 409; an **agent** adopt of a policy-blocked version → 403 generic). Assert `GET /api/tenants/:id/manifests` omits a policy-blocked gated version.
- [ ] **Step 2: Run, verify fail** — `npx tsx --test admin/control-plane/tests/control-plane-host-rollout.test.ts`.
- [ ] **Step 3: Implement** the routes, the dispatch hookup, `ErrorStatuses` entries, the `agent-channel-host.ts` 403 refusal-mapping addition, and the `ManifestsFor`→`AdoptableForTenant` swap. Hoist every new literal (paths, segments, messages) to `private static readonly` constants. **After each edit byte-scan** `control-plane-host.ts` → must stay `6 0 N` (never add a non-ASCII byte; if the scan rises, find and revert the stray character); `agent-channel-host.ts` must stay `0 0 N`.
- [ ] **Step 4: Run** the host test (pass) + `npx tsx --test admin/control-plane/tests/*.test.ts` (whole control-plane suite green) + `npm run typecheck:tools`.
- [ ] **Step 5: Final byte-scan** `control-plane-host.ts` → `6 0 N`. **Commit** by explicit path.

---

### Task 6: Portal client + DTO

**Files:**
- Modify: `admin/portal/src/portal-types.ts`
- Modify: `admin/portal/src/api-client.ts`
- Test: `admin/portal/tests/api-client.test.ts`

**Interfaces:**
- Produces:
  - `portal-types.ts`: `type PolicyDto = { tenantId: string; channels?: ('stable' | 'early')[]; minVersion?: string; hold?: { reason: string; actor: string; at: string } }` (string-union channels; no control-plane import, matching `ManifestDto`).
  - `api-client.ts` on `ControlPlaneClient`:
    - `async ListPolicies(): Promise<PolicyDto[]>` → `GET /api/policies`.
    - `async SetTenantChannels(tenantId: string, channels: string[]): Promise<PolicyDto>` → `PUT /api/tenants/:id/policy/channels`.
    - `async SetTenantMinVersion(tenantId: string, version: string): Promise<PolicyDto>` / `async ClearTenantMinVersion(tenantId: string): Promise<PolicyDto>` → `PUT`/`DELETE .../policy/min-version`.
    - `async SetTenantHold(tenantId: string, reason: string): Promise<PolicyDto>` / `async ClearTenantHold(tenantId: string): Promise<PolicyDto>` → `POST`/`DELETE .../policy/hold`.
    - Add a `MethodPut` constant if absent; hoist new route/segment/key constants (`PoliciesRoute = '/api/policies'`, `PolicySegment = 'policy'`, `ChannelsSegment`, `MinVersionSegment`, `HoldSegment`, `ChannelsKey`). Build item routes via the existing `ItemRoute`/`PathSeparator` helpers; reuse `PostBody`/add a `PutBody` or inline the `{method, body}`.

- [ ] **Step 1: Write the failing tests** — using the existing api-client test harness (a stub `fetch`): each method hits the expected method+path and returns the parsed DTO; `ClearTenantMinVersion`/`ClearTenantHold` send `DELETE` with no body; `SetTenantChannels` sends the `{channels}` body.
- [ ] **Step 2: Run, verify fail** — `npm --prefix admin/portal test`.
- [ ] **Step 3: Implement** the DTO + methods + route helpers, Allman + hoisted constants, ASCII+LF.
- [ ] **Step 4: Run** `npm --prefix admin/portal test` (pass) + `npm --prefix admin/portal run typecheck`.
- [ ] **Step 5: Byte-scan** edited files → `0 0 N`. **Commit** by explicit path.

---

### Task 7: Release-policy view model

**Files:**
- Modify: `admin/portal/src/release-policy-view-model.ts`
- Test: `admin/portal/tests/release-policy-view-model.test.ts`

**Interfaces:**
- Consumes: `PolicyDto` (Task 6); existing `GatingDto`, `ManifestDto`, `TenantDto`, `ClientDto`.
- Produces: the VM accepts `policies: readonly PolicyDto[]` and `manifests: readonly ManifestDto[]` in its constructor + `Update(...)` (append to the existing parameter lists), and exposes:
  - `PolicyRows: readonly PolicyRow[]` where `interface PolicyRow { ownerLabel: string; tenantId: string; channelsLabel: string; minVersionLabel: string; heldLabel: string; held: boolean; holdReason: string }` (one per tenant that has a policy record; `channelsLabel` = joined names or an "All channels" constant when absent; `minVersionLabel` = the floor or a "No floor" constant; `heldLabel`/`held`/`holdReason` from `hold`).
  - A **blocked annotation** on the existing `GatedRow`: add `blockedLabel?: string` computed from DTOs only — `withdrawn` (manifest.withdrawn), `channel` (a non-empty `channels` set excluding the manifest's channel), and `held` (tenant on hold). **Floor is NOT computed per-row in the portal** (no comparator duplication — ruling §6 of the design); the floor shows in `PolicyRow`. `blockedLabel` joins the applicable reasons via hoisted constants.
  - Keep all derivations pure `private static` methods + stable sort (as the file already does); raise `PropertyChanged` for the new `PolicyRowsProperty` in `Update`.

- [ ] **Step 1: Write the failing tests** — construct the VM with a policy record (channels `['stable']`, `minVersion '1.2.0'`, no hold) + a gated `early` manifest + a gated withdrawn manifest: `PolicyRows` has the tenant with the right labels; the `early` gated row has `blockedLabel` naming "channel"; the withdrawn gated row names "withdrawn"; a held tenant marks its gated rows "held"; a tenant with no policy record yields `channelsLabel === 'All channels'` and no channel-blocked rows.
- [ ] **Step 2: Run, verify fail** — `npm --prefix admin/portal test`.
- [ ] **Step 3: Implement** the derivations. Observable VM, hoisted constants, ASCII+LF.
- [ ] **Step 4: Run** portal test (pass) + `npm --prefix admin/portal run typecheck`.
- [ ] **Step 5: Byte-scan** → `0 0 N`. **Commit** by explicit path.

---

### Task 8: Release-policy view (editable panel)

**Files:**
- Modify: `admin/portal/src/release-policy-view.ts`
- Modify: `admin/portal/src/app.ts` (only if the view constructor signature changes — prefer not to)
- Test: `admin/portal/tests/release-policy-view.test.ts`

**Interfaces:**
- Consumes: the VM (Task 7) + client methods (Task 6) + `operator.CanMutate` / `operator.MutatingAct` / `Act` from the kit.
- Produces: extend the existing view —
  - Add a **Policy** section rendering `PolicyRows` (owner, channels, floor, a **Held** badge with the reason) and the blocked tags on the gated table (`GatedRow.blockedLabel`).
  - Extend the `GatingMode` enum (or add a sibling `PolicyMode`) with `SetChannels`, `SetMinVersion`, `Hold` modes; each opens an inline form (this portal has **no modal** — same inline-panel ruling as PA-9W/PA-S2): channels = a Stable/EarlyAccess multi-select (checkbox pair or segmented); min-version = a `TextBox` + Set/Clear; hold = a reason `TextBox` + Hold/Release with an inline confirm (freezing is destructive-ish). All actions gated via `operator.MutatingAct` (server 403 == visible-but-inert for an Observer). On success, re-fetch and re-render (the view already re-fetches on refresh; follow its existing fetch path — do not optimistic-update).
  - Update the stale note: replace `CurrentModelNote` text (which says channels/min-versions/holds "are not yet available") with copy describing the now-live policy; keep the breadcrumb/title.
  - Keep each render rebuilding fresh slots (the file's existing re-parent guard) and the `EnterMode` test seam pattern (re-render from the held model with no fetch), extended to the new modes.

- [ ] **Step 1: Write the failing tests** — drive the view with a Full operator and the VM: entering each new mode shows the matching inline form; applying a channel/min-version/hold change calls the right client method and leaves non-Normal mode correctly; a ReadOnly operator sees the policy actions inert (CanMutate false); the Policy section renders a Held badge; blocked tags appear on gated rows. Use the existing view test's harness/stub client.
- [ ] **Step 2: Run, verify fail** — `npm --prefix admin/portal test`.
- [ ] **Step 3: Implement** the panel, modes, forms, client wiring, and note update. Allman, every literal hoisted, ASCII+LF. If the constructor must take new data, thread it through `app.ts` (line ~166) — otherwise leave `app.ts` untouched.
- [ ] **Step 4: Run** `npm --prefix admin/portal test` (full portal suite green) + `npm --prefix admin/portal run typecheck`.
- [ ] **Step 5: Byte-scan** edited files → `0 0 N`. **Commit** by explicit path.
