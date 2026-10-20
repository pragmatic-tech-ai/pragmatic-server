# SP-GRAPH-5 — Remote app reads the promoted environment graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A remote-target application deployed to a runtime environment binds to that environment's promoted graph and reads it live over the environment endpoint — closing the author→contribute→promote→serve loop.

**Architecture:** Generalize SP0's `html-bundle-remote` build with a bind-mode: `environment` mode emits a live-data client that connects to the runtime tenant and reads the environment graph via the no-bound-app cypher path SP-GRAPH-4 already exposes (it does NOT `OpenApplication`, which would bind the per-app graph). The server adds a general read-grant so an ordinary authenticated runtime principal can read the env graph (lifting the effective DenyAll SP-GRAPH-4 only proved for the Owner). Plexus gains an action that builds the env-bound remote target and deploys it to a chosen runtime environment. The bundled path is untouched.

**Tech Stack:** TypeScript (strict, ESM); `@pragmatic-tech-ai/todl` build system (`html-bundle` flavors, `EmitRemoteDataAction`, `RemoteBuildTarget`); `vscode-jsonrpc`/WS (`PragmaticClient`, `cypher/query`, `application/deploy`); Mural (Plexus renderer); `node:test` + `tsx`; Electron (Plexus main/preload/renderer); cross-repo `file:` dist siblings.

**Spec:** `docs/superpowers/specs/2026-10-20-sp-graph-5-remote-app-reads-env-graph-spec.md`

## Global Constraints

- **Repos + build order:** `@pragmatic-tech-ai/todl` → (`pragmatic-protocol` only if unavoidable — prefer reuse) → `pragmatic-server` → `Plexus`. After editing a sibling, rebuild its dist before dependents resolve it (`npm run build` in the sibling; for Plexus, `npm run build:core` before the app sees a plexus-core change). In-place branch `feat/sp-graph-5` per repo (NOT worktrees — npm install over a worktree detaches the sibling symlink graph). Base branches: TODL `main`, protocol `master`, server `master`, Plexus `main`.
- **Style:** OOP (methods on classes; no module-level free functions/mutable state; module-level `const`/type/enum OK), Allman braces, PascalCase interfaces + public methods, enums over string-literal unions (the bind mode is an `enum`, never a string union), no inline reused/user-facing string literals (hoist to `private static readonly` PascalCase), view-models extend `Observable` not `MuralBase`, LF-only (verify `tr -cd '\r' < file | wc -c` == 0; never flip pre-existing CRLF in untouched files).
- **Security:** the runtime environment's admin/deploy token and any credential never logged, echoed, returned in a DTO, or placed in an error message. Build options carry no secret (per `RemoteBuildTarget` doc). The read-grant is a real grant — an ungranted principal is still refused.
- **Bundled path is sacrosanct:** the existing `html-bundle` + per-app `html-bundle-remote` (application-bind) behavior and its SP0/SP1 suites must stay green and unchanged.
- **No push** without explicit user instruction.

## Review Focus

- **Env-bound read before any promote:** the served app reads a runtime env graph with nothing loaded → SP-GRAPH-4's clear `NoEnvironmentGraphError`→`ResponseError` surfaces to the client, not a crash/blank — Task 2 test `env_graph_read_without_load_errors_clearly_for_app_principal`.
- **Non-Owner granted principal reads; ungranted refused:** a runtime principal WITH the read grant reads the env graph; a principal WITHOUT it is refused — Task 2 tests `granted_principal_reads_env_graph` + `ungranted_principal_refused`.
- **Re-promotion under a running app:** after a second promote, the env-bound client's next read reflects the new graph (shared live instance), no redeploy — Task 4 (proof) step.
- **Bundled path unchanged:** an application-bind remote build still emits `OpenApplication` + reads its per-app graph — Task 1 test `application_bind_mode_still_opens_app`.
- **Deploy-action secret hygiene:** the runtime deploy token never appears in a log/DTO/error on the Plexus action — Task 3 test.

---

## Task 1: Environment bind mode on the remote build target (TODL)

**Files:**
- Modify: `src/solution-services/build-system-core/build-options.ts` (add bind-mode enum + field on `RemoteBuildTarget`)
- Modify: `src/solution-services/todl-build-system/html-bundle/emit-remote-data-action.ts` (branch the emitted client on bind mode)
- Test: the existing `html-bundle` / emit-remote tests dir (mirror how `EmitRemoteDataAction` is tested — grep `emit-remote` / `html-bundle-remote` under `src/**/tests`)

**Interfaces:**
- Produces (consumed by Plexus Task 3):
  - `enum RemoteBindMode { Application = 'application', Environment = 'environment' }` exported from `build-options.ts`.
  - `RemoteBuildTarget` gains `Bind?: RemoteBindMode` (default, when absent, = `Application` — preserves today's behavior).
  - `EmitRemoteDataAction`: when `Bind === Environment`, the emitted `generated/data.ts` connects (`PragmaticClient.ConnectReconnecting(new BrowserSocketDialer(SocketUrl()))`) and reads `MATCH (n) RETURN n` via `QueryAll` WITHOUT calling `OpenApplication` (so the read resolves to the environment graph on the runtime, per SP-GRAPH-4's no-bound-app path); the embedded `Schema` still comes from `TenantDocumentAssembler.SchemaOf(compiled.fullDocument)`. When `Bind === Application` (or absent), the emitted client is byte-identical to today (calls `OpenApplication(AppName)`).

- [ ] **Step 1: Write failing tests.** Build (or invoke the emit action over) a fixture solution in each mode and assert the emitted `generated/data.ts` text: **`environment_bind_mode_omits_open_application`** — env mode emits NO `OpenApplication(` and still emits the `MATCH (n) RETURN n` read + the embedded `{SCHEMA}`; **`application_bind_mode_still_opens_app`** — default/application mode emits `client.OpenApplication(` exactly as before (snapshot/substring assert). Mirror the existing emit-remote test's harness.
- [ ] **Step 2: Run; confirm fail** (TODL repo test script, e.g. `npm test` filtered to the html-bundle suite).
- [ ] **Step 3: Implement** `RemoteBindMode` + the `Bind` field (hoist the mode strings into the enum), and branch `EmitRemoteDataAction`'s template so the `OpenApplication` line is emitted only in Application mode. Keep one home for the shared template; the only difference is that one line. No new graph-id, no protocol change.
- [ ] **Step 4: Run; green. Build dist:** `npm run build` in TODL so server/Plexus resolve it. Commit.

---

## Task 2: Environment-graph read authorization — general read-grant (pragmatic-server)

**Files:**
- Modify: the runtime env-graph read path and/or its RBAC gate (`src/host/server-connection-handler.ts` `RequireEnvironmentGraph` ~:736 / `RunCypherQuery` runtime arm; and/or the read-grant provisioning seam — pin which at implementation: an identity reader-role grant for the runtime tenant's app principals vs an allow-read on the env-graph read path). Grep the existing `Role`/`reader`/grant machinery (SP-GRAPH-3a-ii `AdminIssueMakerToken`/`GrantRole` is the provisioning template; the SP-ENV seed `reader` role is the capability template).
- Test: `src/host/tests/runtime-env-graph-read.test.ts` (extend) + any grant/provisioning test

**Interfaces:**
- Consumes: SP-GRAPH-4 `IEnvironmentGraphHost.EnvironmentGraphQuery()` + `NoEnvironmentGraphError`; the `CypherProtocol.Query → readTenant` policy gate; the identity `Role`/grant model + control-plane grant mint.
- Produces: the environment graph is READABLE by an authenticated runtime principal holding a tenant read grant (a general read capability — a seeded/provisioned reader grant for the runtime environment, NOT an open door). Authoring gates and the bundled per-app path are unchanged. The exact mechanism (identity grant-seed vs server-side allow-read wrapper) is chosen in Step 3 and MUST keep an ungranted principal refused.

- [ ] **Step 1: Write failing tests.** On a Runtime handler whose env graph is loaded (fake/real): **`granted_principal_reads_env_graph`** — a non-Owner principal holding the read grant runs `CypherProtocol.Query` (no bound app) and gets the env graph's nodes; **`ungranted_principal_refused`** — a principal without the grant is refused by the policy gate (not a crash); **`env_graph_read_without_load_errors_clearly_for_app_principal`** — a granted principal querying before any promote gets the clear `NoEnvironmentGraphError`-mapped `ResponseError`, no null-deref. Authoring (`Create/Contribute/Execute`) still rejected on Runtime (unchanged).
- [ ] **Step 2: Run; confirm fail.**
- [ ] **Step 3: Implement** the read-grant mechanism (provision the general read capability for the runtime environment's app principals; ensure the env-graph read honors it and the bundled/app path + authoring gates are untouched).
- [ ] **Step 4: Run; green** (full `src/host` + control-plane if touched). Build dist if a shared lib changed. Commit.

---

## Task 3: Plexus deploys a remote, environment-bound app to a runtime environment (Plexus)

**Files:**
- Create/Modify (plexus-core renderer): a deploy-remote-env capability port + action mirroring `packages/plexus-core/src/renderer/modules/solution-explorer/services/publish-tenant-contributor.ts` (build `html-bundle-remote` with `Remote: { AppName, Bind: RemoteBindMode.Environment }`); a VM (`Observable`) for any target-selection UI.
- Modify (apps/plexus main): reuse `src/main/tenant-publish/tenant-deploy-service.ts` + `tenant-client.ts` deploy seam + the profile store to deploy to the chosen runtime environment; add an IPC channel if a new one is needed (mirror `graph-contribute-ipc.ts`).
- Test: plexus-core unit (mirror `publish-tenant-contributor` tests) + api/ipc unit

**Interfaces:**
- Consumes: TODL `RemoteBindMode`/`RemoteBuildTarget.Bind` (Task 1, dist rebuilt), `BuildService.Build`/`BuildComposition`, `PublishTenantContributor.buildRemote` as template, the main-process deploy seam (`ApplicationDeployProtocol.Deploy` via `tenant-deploy-service`) + bearer-token `PragmaticClient` + profile store.
- Produces: a renderer capability (e.g. `IRemoteEnvDeployer { DeployToEnvironment(...) }` keyed port, host-agnostic) + a solution-explorer action ("Deploy to runtime environment") that builds the env-bound remote target and deploys it to the configured runtime environment; the deploy token stays in the main process (never crosses to the renderer, never logged).

- [ ] **Step 1: Write failing tests.** Unit: the deployer builds with `flavorId === 'html-bundle-remote'` and `Remote.Bind === RemoteBindMode.Environment` and then calls the deploy seam with the built output + target env; a fake deploy seam records the call; assert NO token/secret appears in any recorded log/result/error (secret-hygiene test). Mirror the `publish-tenant-contributor` test harness.
- [ ] **Step 2: Run; confirm fail** (`tsx --test` per the Plexus package's test script).
- [ ] **Step 3: Implement** the port + action + main-process wiring (reuse the deploy seam + profile), build-core where plexus-core changed.
- [ ] **Step 4: Run; green** (plexus-core unit + apps typechecks: `typecheck`/`typecheck:node`/`typecheck:web` as the touched layers require). Commit.

---

## Task 4: Gated end-to-end proof — the full loop (pragmatic-server, operator-run)

**Files:**
- Modify: the SP0/SP1 capstone e2e harness or the control-plane promotion smoke (`src/tests/e2e/*` / `admin/control-plane/control-plane-smoke.ts`) — reuse the one that already drives promote + a served browser/WS read (grep `sp0-capstone`/`sp1-capstone`/`todl-remote-build-registry` + the SP-GRAPH-4 `PromotionRoundTrip`).
- Test: the gated e2e itself (operator-run; not wired into the default unit run).

**Interfaces:**
- Consumes: SP-GRAPH-4's promote path + env graph; Task 1's env bind-mode build; Task 2's read-grant; Task 3's deploy (or the server-side deploy directly in the harness); the SP0/SP1 remote-app build + serve + browser-read machinery.

- [ ] **Step 1: Add a `RemoteEnvAppRoundTrip` gated step** mirroring the SP0/SP1 capstone + SP-GRAPH-4 `PromotionRoundTrip`: create a Development env → create a graph → contribute a minimal solution → create a Runtime env → promote → build the minimal app in `environment` bind mode and deploy it to the runtime → authenticate as a read-granted principal → perform the served/live read and ASSERT the promoted graph's content is returned; then **re-promote** a changed graph and assert the next read reflects it (shared live instance, no redeploy). Also assert a **bundled** app on the same harness still reads its per-app graph unchanged. New `Labels`/assertions per check; secrets never logged.
- [ ] **Step 2:** Run per the operator-run harness (needs the container/compose + browser); confirm green. Do NOT wire it into the default unit run (mirrors SP0/SP1 + SP-GRAPH-4 gating). If the implementer lacks Docker/browser, deliver code that TYPECHECKS + integrates, and mark the live run operator-gated (as SP-GRAPH-4 Task 7 did).
- [ ] **Step 3: Commit.**

---

## Self-review notes

- **Spec coverage:** FR1 → Task 1 (env bind mode); FR2 → Tasks 1+2 (client reads env graph + it is authorized); FR3 → Task 2 (general read-grant); FR4 → Task 1 (`application_bind_mode_still_opens_app`) + Task 4 (bundled-unchanged assertion); FR5 → Task 3 (Plexus deploy action); FR6 → Task 4 (gated proof). The five Review-Focus inputs map to the named tests in Tasks 1/2/3/4.
- **Type consistency:** `RemoteBindMode` defined once in Task 1 (TODL) and consumed by Task 3 (Plexus) via dist; `RemoteBuildTarget.Bind` optional defaulting to Application keeps every existing caller valid.
- **No protocol change:** the env read reuses `cypher/query` with no `OpenApplication`; the deploy reuses `application/deploy`. Confirm during Task 1/3 that `PragmaticClient` already exposes the needed `QueryAll`/`ConnectReconnecting`/deploy surface (it does per the SP0 client) — add a protocol/client surface ONLY if a gap is found, and flag it as a scope change.
- **Proportion:** signatures + test names only; the engineer writes idiomatic code against the named seams and the inherited SP0/SP1 + SP-GRAPH-4 machinery.
- **Review Focus empty?** No — five inputs listed, each pinned to an owning task's test.
