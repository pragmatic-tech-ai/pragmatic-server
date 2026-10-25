# Agent-Channel Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand the hive→platform home channel on its own dedicated public listener, carrying hive-reported health/inventory snapshots up into a platform observation read model that feeds the operator's cross-hive health view — severing the platform's in-process polling into the hive for the health path.

**Architecture:** Extract the per-hive bearer-authenticated agent protocol out of the loopback operator API (`ControlPlaneHost.RouteAgent`) into a new `AgentChannelHost` bound to its own public listener. Widen the narrow per-environment `report` into a whole-hive snapshot of `HiveHealthDto[]` (the health shape that already exists). Store the latest snapshot per hive in a new `HiveObservationRegistry`, and make the operator `GET /api/hives/:id/health` read that stored observation instead of live-producing via `HiveHealthProducer`. The agent (built in a later plan) will produce the snapshot locally inside the hive; this plan builds the platform side plus the report endpoint it posts to.

**Tech Stack:** TypeScript, `node:http`, existing `PlaneHttp` helpers, `JsonRecordStore`, existing bearer/`AgentUnauthorizedError` auth, `HiveHealthDto`, `PlatformDeploymentRegistry` (`RegisterHive`/`VerifyAgentToken`/`TargetFor`). Tests under `admin/control-plane/tests/` run with `npx tsx --test "admin/control-plane/tests/*.test.ts"`; typecheck with `npx tsc -p tsconfig.tools.json --noEmit`.

**Spec:** `docs/superpowers/specs/2026-10-25-platform-and-tenant-admin-app-separation-design.md` (this is the first of several sub-project plans; it builds the "agent-channel server" the design names as the foundation everything rides).

## Global Constraints

- OOP only: behavior on classes as methods/statics; no module-level free functions or mutable module state. Module-level `const` for true constants and `type`/`enum`/`interface` declarations is fine.
- Allman braces on every block (class/interface/enum, method/ctor, if/else/for/while/try/catch/switch); `else`/`catch`/`finally` on their own line. Object literals, block-arrow bodies, and genuine one-liners stay inline.
- No inline string literals: hoist user-facing text and any reused literal (paths, keys, messages, header names) to `private static readonly` PascalCase constants, referenced at every use. Structural single-use tokens (`typeof` guards, a lone path segment) may stay inline.
- PascalCase for every interface name and every public method.
- Secrets held server-side by name only: the raw agent token, any credential/key/token, and inner-error text never appear in logs, DTOs, thrown messages, or persisted records. `AgentUnauthorizedError` carries only the hive id, as it does today.
- Every test file lives in a `tests/` subfolder. Never run `npm install` at the repo root (breaks workspace symlinks).
- Each task's own requirements implicitly include this section.

## Review Focus

- **A snapshot for an unregistered or wrong-token hive** must be rejected with `AgentUnauthorizedError` (401) before any store write — no observation is recorded for a hive that failed auth. (Task 3.)
- **A snapshot naming environments the hive no longer has** must fully replace the prior observation, not merge — a removed environment disappears from the operator view on the next report. (Task 1.)
- **`GET /api/hives/:id/health` for a hive that has never reported** must return an empty list with 200, not 404 and not a stale/absent crash — "registered but silent" is a normal state. (Task 2.)
- **A malformed snapshot body** (missing `environments`, wrong element shape) must be rejected 400 without partially writing. (Task 3.)
- **The agent listener binding** must be independently configurable and must not force the operator API off its loopback bind; a missing port env var leaves the agent channel disabled, not crashed. (Task 4.)

---

### Task 1: Hive observation read model

**Files:**
- Create: `admin/control-plane/hive-observation-record.ts`
- Test: `admin/control-plane/tests/hive-observation-registry.test.ts`

**Interfaces:**
- Consumes: `HiveHealthDto` from `hive-health-producer.ts` (`{ environmentName, ready, runningImage, detail }`).
- Produces: `type HiveObservationRecord = { id: string; hiveId: string; environments: HiveHealthDto[]; reportedAt: string }` and `class HiveObservationRegistry extends JsonRecordStore<HiveObservationRecord>` with `public RecordSnapshot(hiveId: string, environments: HiveHealthDto[]): Promise<void>` (keys the record by `hiveId`, overwriting) and `public LatestFor(hiveId: string): HiveHealthDto[]` (the stored `environments`, or `[]` when none).

- [ ] **Step 1: Write the failing test** — `RecordSnapshot` then `LatestFor` returns the environments; a second `RecordSnapshot` with a shorter list fully replaces the first (no merge); `LatestFor` on an unknown hive returns `[]`.
- [ ] **Step 2: Run it, verify it fails** — `npx tsx --test "admin/control-plane/tests/hive-observation-registry.test.ts"`; expect module-not-found / undefined.
- [ ] **Step 3: Implement** `HiveObservationRecord` + `HiveObservationRegistry` following `RolloutReportRegistry` as the pattern (root key constant `hiveObservations`, PascalCase constant).
- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat: hive observation read model`).

### Task 2: Operator health view reads the observation

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts` (`RouteHiveHealth`, ctor to accept the registry)
- Modify: `admin/control-plane/server.ts` (construct and inject `HiveObservationRegistry`)
- Test: `admin/control-plane/tests/control-plane-host-hive-health.test.ts` (extend existing)

**Interfaces:**
- Consumes: `HiveObservationRegistry.LatestFor` (Task 1).
- Produces: `GET /api/hives/:id/health` returns `HiveHealthDto[]` from the stored observation; unknown hive → 404; known-but-never-reported hive → `[]` with 200. The in-process `HiveHealthProducer` call is removed from this route.

- [ ] **Step 1: Write the failing test** — seed a hive + an observation, GET returns the stored list; a hive with no observation returns `[]`/200; unknown hive returns 404.
- [ ] **Step 2: Run it, verify it fails** (route still live-produces).
- [ ] **Step 3: Implement** — inject `HiveObservationRegistry`, replace the `new HiveHealthProducer(...).Produce(hive)` body with `LatestFor(id)`; keep the hive-existence 404 via `directory.GetHive`.
- [ ] **Step 4: Run it, verify it passes;** run the full control-plane suite to confirm nothing else regressed.
- [ ] **Step 5: Commit** (`feat: operator health view reads reported observations`).

### Task 3: Snapshot ingestion + rollout status from observations; retire the per-env report store

**Files:**
- Modify: `admin/control-plane/platform-deployment-registry.ts` (swap the `reports` dependency for `observations`; add `ReportSnapshot`; re-point `StatusFor`)
- Modify call sites that construct `PlatformDeploymentRegistry`: `admin/control-plane/server.ts`, `admin/control-plane/control-plane-smoke.ts`, `admin/control-plane/manifest-publish.ts`, `admin/control-plane/rollout-pull-smoke.ts` (and any other `new PlatformDeploymentRegistry(...)` — grep to confirm)
- Delete: `admin/control-plane/rollout-report-record.ts` (the legacy `RolloutReportRegistry`) once no reference remains
- Test: `admin/control-plane/tests/platform-deployment-registry.test.ts` (extend)

**Interfaces:**
- Consumes: `HiveObservationRegistry` (Task 1), `VerifyAgentToken` (existing, unchanged), `TargetFor` (existing).
- Produces:
  - `public async ReportSnapshot(hiveId: string, environments: HiveHealthDto[]): Promise<void>` — the single up-feed; writes the observation via `HiveObservationRegistry.RecordSnapshot`. Auth is the host's job (bearer verified before this is called).
  - `StatusFor(hiveId): HiveRolloutStatus` unchanged in signature, now derived from `observations.LatestFor(hiveId)`: each `HiveHealthDto` maps to `{ environmentName, runningImage, ready, obsolete }`, where `runningImage` of `undefined` is reported as not-yet-running and `obsolete` is `true` whenever a target exists and the running image differs from `target.image` (an undefined running image counts as differing). `EnvironmentRolloutStatus.runningImage` becomes `string | undefined` to match the health shape.
  - The legacy `Report(hiveId, environmentName, runningImage, ready)` method and the `reports` dependency are removed.

- [ ] **Step 1: Write the failing test** — `ReportSnapshot` records an observation that `StatusFor` then reflects (environment present, `obsolete` computed against a set target); replacing the snapshot with a shorter list drops the removed environment from `StatusFor`.
- [ ] **Step 2: Run it, verify it fails.**
- [ ] **Step 3: Implement** — replace the `reports: RolloutReportRegistry` ctor param with `observations: HiveObservationRegistry`; add `ReportSnapshot`; rewrite `StatusFor` to read `observations.LatestFor`; widen `EnvironmentRolloutStatus.runningImage` to `string | undefined`; update every construction call site to pass the observation registry; delete `rollout-report-record.ts`.
- [ ] **Step 4: Run it, verify it passes;** run the full control-plane suite + `npx tsc -p tsconfig.tools.json --noEmit` to catch every call site and the smokes.
- [ ] **Step 5: Commit** (`feat: single snapshot up-feed; rollout status from observations`).

### Task 4: AgentChannelHost — dedicated public listener

**Files:**
- Create: `admin/control-plane/agent-channel-host.ts`
- Test: `admin/control-plane/tests/agent-channel-host.test.ts`

**Interfaces:**
- Consumes: `PlatformDeploymentRegistry` (`VerifyAgentToken`, `TargetFor`, `ReportSnapshot`), `PlaneHttp`, the bearer helper and `AgentUnauthorizedError` (lifted from `ControlPlaneHost`).
- Produces: `class AgentChannelHost` with `public async Listen(port: number, bind: string): Promise<void>` and an internal request handler serving exactly two routes under `/agent/`:
  - `GET /agent/hives/:id/target` → `{ version, image }` or 404 (same body as today's `TargetFor`).
  - `POST /agent/hives/:id/snapshot` body `{ environments: HiveHealthDto[] }` → 204; 400 on a malformed body; both routes call `VerifyAgentToken` with the `Bearer` token first and throw `AgentUnauthorizedError` (401) on absence/mismatch — before any store write.
  Nothing else is served; any other path/method is 404. The per-hive bearer is the only credential; no operator session exists on this listener.

- [ ] **Step 1: Write the failing test** — register a hive to get a token; target returns the selected `{version,image}`; snapshot with the right bearer writes the observation and returns 204; a missing bearer and a wrong bearer each return 401 and write nothing; a malformed snapshot body returns 400 and writes nothing.
- [ ] **Step 2: Run it, verify it fails.**
- [ ] **Step 3: Implement** `AgentChannelHost`. Hoist the `Bearer` pattern, authorization header name, and route-segment literals to PascalCase constants. Reuse the existing error→status mapping for `AgentUnauthorizedError`.
- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** (`feat: dedicated agent-channel listener`).

### Task 5: Boot the agent channel from ControlPlaneServer; retire the operator-API agent routes

**Files:**
- Modify: `admin/control-plane/server.ts` (construct `AgentChannelHost`, resolve its port, `Listen`)
- Modify: `admin/control-plane/control-plane-host.ts` (remove `RouteAgent`, `AgentPathPattern`, `IsAgentApi`, and the agent-route branch; the operator API no longer serves `/api/hives/:id/agent/*`)
- Test: `admin/control-plane/tests/control-plane-host.test.ts` (assert the old agent path is gone), `admin/control-plane/tests/agent-channel-host.test.ts` (unchanged)

**Interfaces:**
- Consumes: `AgentChannelHost.Listen` (Task 4).
- Produces: a new env var `PRAGMATIC_AGENT_CHANNEL_PORT` with a static parser on `ControlPlaneServer` mirroring the existing `ResolveTenantPort` (returns a port in range, or a sentinel meaning "disabled"); when set, the agent channel listens on it with a configurable bind (`PRAGMATIC_AGENT_CHANNEL_BIND`, default `0.0.0.0`); when unset, the agent channel does not start and the server boots normally. The operator API stays on its existing loopback bind, now with no agent routes.

- [ ] **Step 1: Write the failing test** — a request to the old `/api/hives/:id/agent/target` on the operator host is no longer a recognized agent route (falls through as it would for any unknown path); `ParseAgentChannelPort` accepts a valid port, rejects out-of-range to the disabled sentinel.
- [ ] **Step 2: Run it, verify it fails.**
- [ ] **Step 3: Implement** — add the port/bind parsers and the `AgentChannelHost` boot in `server.ts` behind the port being set; delete the agent surface from `ControlPlaneHost`.
- [ ] **Step 4: Run it, verify it passes;** run the full control-plane suite + `npx tsc -p tsconfig.tools.json --noEmit`.
- [ ] **Step 5: Commit** (`feat: boot agent channel, retire operator-API agent routes`).
