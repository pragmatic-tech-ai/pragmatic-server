# SP-HIVE-3b In-cluster env seed projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A seeded (e.g. Demo) in-cluster environment boots with its full `data/<environmentId>/` tree — identity/security-model + compiled packages + `application.json` — present in the base-dir PVC, giving data-layer parity with the Docker seed.

**Architecture:** `EnvServerSeedSource` walks the control-plane-generated `data/<environmentId>/` bundle sub-tree and projects it as ONE secret-safe k8s Secret (a single data key whose value is a JSON manifest mapping each relative path to its base64 bytes), applied in the existing `ApplyBundle` List. `K8sManifestBuilder.ServerDeployment` gains a hardened node init-container that unpacks that Secret into `/pragmatic/data/<environmentId>/` before the server starts, marker-guarded so a restart never clobbers live state. All keyed off `environmentId` (NOT the record name).

**Tech Stack:** TypeScript (NodeNext ESM), `tsx --test`, kubectl via `IKubectl`, docker-desktop k8s for the gated smoke. Single repo: pragmatic-server.

**Spec:** `docs/superpowers/specs/2026-10-26-sp-hive-3b-in-cluster-env-seed-projection-design.md`

## Global Constraints

- OOP: methods/statics on classes; no module-level free functions or mutable state.
- Allman braces; no inline string literals (hoist to `private static readonly` PascalCase). PascalCase interfaces + public methods.
- **Secret-safety (verbatim):** seed bytes held by name only — NEVER in logs, DTOs, errors, thrown messages, the `EnvironmentWorkload`, the environment record, or any non-Secret manifest. Values exit ONLY through `EnvServerSecretSet.RenderManifest()` into a k8s Secret. Redact `toJSON`/`toString`.
- Tests live in `tests/` subfolders. NEVER `npm install` at repo root. LF-only. Commit trailer: Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>.
- **`environmentId`, not name:** the tree path, the init-container destination sub-dir, and the marker all key off `def.environmentId` (the key `BundleBuilder.Generate` writes and `tenant-registry` reads). The Secret RESOURCE name stays on `environmentName`. For a Demo env these DIFFER (`contoso` vs the user's name); keying off name boots unseeded with no error.
- Docker is untouched: `K8sManifestBuilder` is in-cluster-only; no `environments/seed/docker.ts` or Docker-runtime change. The init-container is unconditional on this builder (no `PublishesHostPort` guard — it would be unreachable).
- No worktree (consistent with the repo's in-place SDD); branch `feat/sp-hive-3b-seed-projection` off master.

## Review Focus

1. **environmentId keying (silent trap)** — unpack destination/mount/marker must be `data/<def.environmentId>/`, not `data/<record.name>/`; a Demo env (id=`contoso`, name≠id) boots unseeded otherwise. (Task 1 test: seed Secret/manifest + Task 2 init-container destination both use environmentId with id ≠ name.)
2. **Marker idempotency** — a second init-container run (restart/re-Apply) must not overwrite live data; `data/<environmentId>/.env-seeded` guards the copy. (Task 2 test: rendered command is marker-guarded; Task 1/2 assert the marker path.)
3. **Nested-path fidelity** — `packages/<id>/<ver>/model.json` and `applications/<app>/application.json` round-trip with parent dirs created; a flat write breaks registration. (Task 1 test.)
4. **Secret non-leakage** — seed bytes never in `toJSON`/`toString`/errors/DTO/record/non-Secret manifest. (Task 1 test.)
5. **Size ceiling** — a rendered seed Secret over ~1 MB raises a named error, not a silent truncation. (Task 1 test.)

---

## Task 1: EnvServerSeedSource seed-tree projection

**Files:**
- Modify: `admin/control-plane/env-server-seed.ts` (seed-tree walk → path→base64 manifest → Secret; `SeedSecretNameOf`; size-ceiling guard; `ApplyBundle` gains `environmentId` and includes the seed Secret)
- Test: `admin/control-plane/tests/env-server-seed.test.ts` (extend)

**Interfaces:**
- Consumes: a bundle dir containing `data/<environmentId>/…` (produced by `BundleBuilder.Generate`), the environment name (Secret resource naming), the environment id (tree path), the optional db password ref.
- Produces:
  - `EnvServerSeedSource` gains a seed-tree projection contributing a Secret `SeedSecretNameOf(environmentName)` (e.g. `<env>-env-seed`) with ONE data key (e.g. `seed.json`) whose value is a JSON object `{ "<relpath>": "<base64 bytes>" }` for every file under `data/<environmentId>/` (relative paths with forward slashes). Built via the existing `EnvServerSecretSet` discipline (bytes `#private`, redacted serializers, values only via `RenderManifest()`).
  - A named error (e.g. `SeedTooLargeError`) thrown when the rendered Secret data for the seed exceeds a `private static readonly` byte ceiling (~1 MB).
  - `static ApplyBundle(kubectl, bundleDir, environmentName, environmentId, dbPasswordRef?)` — signature gains `environmentId`; the applied List now also contains the seed Secret (when `data/<environmentId>/` exists/non-empty).

- [ ] **Step 1: Write failing tests.** Build a temp bundle dir with `data/<id>/identity/tenant-config.json`, `data/<id>/packages/northwind/0.1.0/model.json`, `data/<id>/applications/northwind/application.json` (id ≠ name). Assert: (a) the seed Secret's `seed.json` parses to a map whose keys are those three relative paths and whose base64 values decode to the original bytes (nested-path fidelity, RF3); (b) the manifest uses `<id>`-relative paths and the walk root is `data/<id>/` (RF1 — a name-rooted walk would find nothing / wrong tree); (c) `toJSON()`/`toString()` of the set contain none of the seed bytes (RF4); (d) a tree whose rendered seed Secret exceeds the ceiling throws the named `SeedTooLargeError` (RF5); (e) `ApplyBundle` includes a Secret named `SeedSecretNameOf(name)` in the applied List.
- [ ] **Step 2: Run tests — expect fail** (`npx tsx --test admin/control-plane/tests/env-server-seed.test.ts`).
- [ ] **Step 3: Implement** the recursive walk of `join(bundleDir, 'data', environmentId)` (skip if absent), the path→base64 manifest, the `EnvServerSecretSet` entry, the size-ceiling guard, `SeedSecretNameOf`, and the `ApplyBundle` signature/List addition. Hoist literals.
- [ ] **Step 4: Run tests — expect pass.**
- [ ] **Step 5: Commit.**

## Task 2: ServerDeployment seed init-container

**Files:**
- Modify: `admin/control-plane/k8s-manifest-builder.ts` (`ServerDeployment` init-container; `EnvironmentWorkload`/spec gains the seed Secret name + `environmentId` — names/ids only), `admin/control-plane/environment-workload.ts` (name/id fields)
- Test: `admin/control-plane/tests/k8s-manifest-builder.test.ts` (extend)

**Interfaces:**
- Consumes: the seed Secret name (`EnvServerSeedSource.SeedSecretNameOf`, Task 1) and `environmentId` from the workload.
- Produces: `ServerDeployment` renders `initContainers: [<seed>]` — same image as the server container; `volumeMounts` = seed Secret (ro, e.g. `/pragmatic/seed`) + base-dir PVC (rw, `/pragmatic/data`); `command` = a hoisted node unpack script that, IF `/pragmatic/data/<environmentId>/.env-seeded` is absent, reads `/pragmatic/seed/seed.json`, writes each entry to `/pragmatic/data/<environmentId>/<relpath>` creating parent dirs, then writes the marker; `securityContext` = `runAsUser: 10001`, `readOnlyRootFilesystem: true`, drop ALL capabilities. Plus the matching seed Secret `volume`.

- [ ] **Step 1: Write failing tests.** (a) an in-cluster workload with id ≠ name renders a ServerDeployment whose init-container destination path and marker use `<environmentId>` (RF1), mounts the base-dir PVC rw and the seed Secret (name == `SeedSecretNameOf`) ro, and carries the hardened securityContext (RF: hardening); (b) the rendered command is marker-guarded on `data/<environmentId>/.env-seeded` (RF2); (c) the volume referencing the seed Secret exists with a matching name.
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** the init-container, its volume/mounts, the hoisted node command, and the workload/spec `environmentId` + seed-Secret-name fields. Keep ordering stable.
- [ ] **Step 4: Run tests — expect pass.**
- [ ] **Step 5: Commit.**

## Task 3: Wire environmentId through BringUp + promote the gated smoke

**Files:**
- Modify: `admin/control-plane/in-cluster-environment-runtime.ts` (`BringUp` passes `ctx.def.environmentId` to `ApplyBundle`), `admin/control-plane/environment-placement.ts` (or wherever `WorkloadFor` is) to carry `environmentId` + seed Secret name into the workload
- Modify (smoke): `admin/control-plane/in-cluster-env-create-smoke.ts` (or `k8s-hive-smoke.ts`) to create a DEMO env and assert the seeded tree + a northwind query
- Test: `admin/control-plane/tests/in-cluster-environment-runtime.test.ts` (extend)

**Interfaces:**
- Consumes: `ApplyBundle(..., environmentId, ...)` (Task 1); the workload `environmentId` + seed Secret name (Task 2).
- Produces: a `BringUp` that applies the workload then `ApplyBundle` including the seed Secret, with `environmentId` threaded from `ctx.def.environmentId`.

- [ ] **Step 1: Write failing tests (fake IKubectl + fake orchestrator).** (a) `BringUp` for a ctx whose `def.environmentId` ≠ `record.name` calls `ApplyBundle` with that `environmentId`, and the applied List contains the seed Secret (`SeedSecretNameOf(record.name)`); (b) the existing BringUp ordering (workload Apply then kubectl Apply) is preserved.
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** the `environmentId` threading at `BringUp`/`WorkloadFor`. Then rewrite the gated smoke to create a DEMO in-cluster env, drive Apply → WaitHealthy, and over the tenant WS assert northwind is registered and its graph is queryable (reads succeed under app-private governance); assert a re-Apply keeps the marker (no re-seed).
- [ ] **Step 4: Run tests — expect pass.** Then run the full control-plane unit suite + `tsc` (tools, tenant-admin, build, portal); confirm green. (The live smoke is operator-run on docker-desktop.)
- [ ] **Step 5: Commit.**

---

## Self-Review

- **Spec coverage:** seed-tree projection + size guard (Task 1), init-container render (Task 2), environmentId wiring + smoke (Task 3). UI serving is an explicit non-goal (filed follow-up); no task touches it or `docker.ts`.
- **Step scan:** each step writes one thing; tests carry concrete assertions (id ≠ name, nested paths, redaction, ceiling, marker).
- **Type consistency:** `SeedSecretNameOf(environmentName)`, `ApplyBundle(..., environmentId, ...)`, workload `environmentId` + seed-Secret-name, init-container destination `data/<environmentId>/` — consistent across tasks.
- **Review Focus:** RF1 (Tasks 1+2), RF2 (Task 2), RF3/RF4/RF5 (Task 1) all pinned.
- **Proportion:** plan carries decisions + assertions, not code bodies; shorter than the spec.
