# SP-GRAPH-5 — A remote app reads the promoted environment graph live (closes the loop)

**Parent design:** `docs/superpowers/specs/2026-10-20-environments-graphs-admin-design.md` (approved). This spec covers Milestone-1 sub-project 5 — the last slice. SP-GRAPH-1/2/3a/3b/4 shipped (typed environments, admin-created container-owned graphs, maker-authenticated contribution, Plexus contribute client, and the dev→runtime promotion spine: a runtime loads a promoted graph as one live instance and exposes it for reads with no bound app).

## Intent

SP-GRAPH-4 stops at "promoted, loaded, exposed, shown." SP-GRAPH-5 closes the author→promote→serve loop: a **remote-target application**, deployed to a runtime environment, binds to that environment's live promoted graph and reads it **live** over the environment endpoint. This is the end-to-end proof the whole program was built toward — a maker authors a solution in Plexus, contributes it to a dev graph, an admin promotes that graph into a runtime environment, and an app served from that environment reads the promoted data live.

Per the parent design (decisions 6 and 7, resolved defaults): the binding is **implicit in the environment** — one graph per runtime environment, so the app "names its graph by the environment endpoint"; graph-id addressing is unnecessary. A **remote** build target binds to the environment graph; the **bundled** build target (embedded snapshot, SP0/SP1) keeps working unchanged. The remote app's own artifact (UI + manifest) is immutable; the graph it reads is the shared live instance, so a later promotion changes what the app sees, by design.

## Functional requirements

- **FR1 — Remote build target binds to the environment graph.** A remote-target application build (generalizing SP0's `html-bundle-remote`) produces an app whose live-data client reads the **environment graph** rather than a per-app graph built from the app's own packages. The binding carries no graph id — the environment has exactly one graph.
- **FR2 — The served app reads the promoted graph live.** The remote app, served from the runtime environment over the existing same-origin WebSocket transport, issues reads that resolve to the environment graph instance SP-GRAPH-4 loads. A re-promotion changes the data/schema the running app sees without redeploying the app artifact.
- **FR3 — Read authorization: a general read-grant, not fail-closed DenyAll.** The environment graph must be **readable** by the served app's authenticated runtime principal. SP-GRAPH-4 exposed the env-graph read under the existing `readTenant` RBAC gate verified only as the Owner; SP-GRAPH-5 adds the general read-grant so an ordinary authenticated app principal on the runtime tenant can read the promoted graph (replacing the effective fail-closed DenyAll a no-security-model tenant would otherwise apply to a non-Owner). Authoring operations stay closed on a runtime environment; writes against the env graph remain deferred.
- **FR4 — Bundled path unchanged.** A bundled app (its own packages, embedded snapshot) still builds, deploys, serves, and reads its per-app graph exactly as in SP0/SP1. The remote vs bundled choice is the build target; nothing about the bundled path changes.
- **FR5 — Plexus deploys a remote, environment-bound app to a runtime environment.** Plexus gains an action that builds the remote (environment-bound) target for an authored solution/app and deploys it to a chosen runtime environment, generalizing the existing `PublishTenantContributor` remote build + deploy. The runtime environment/endpoint is configured (reusing the existing tenant-publish/admin seam); no secret is logged or surfaced.
- **FR6 — End-to-end proof.** A gated end-to-end test: author a minimal solution → contribute to a dev graph → promote into a runtime environment → deploy the minimal remote app to that runtime → the served app's live read returns the promoted graph's content. Live container/browser e2e is operator-run (mirrors the SP0/SP1 and tenant-publish gating posture).

## Non-goals (this slice)

- **Writes against the environment graph.** The milestone proof is a read; data writes against the shared env graph are deferred (consistent with SP-GRAPH-4's non-goal).
- **Dynamic schema-over-the-wire.** The remote app's build-time schema comes from the maker's authored solution model (which the maker promoted), exactly as `html-bundle-remote` embeds it today. "Signal/await the first graph build over the wire" (ModelView readiness) is a filed, deferred refinement.
- **CSP / X-Frame-Options hardening on the served app shell** (filed) and the **`CypherAppDeployParamsDto` rename** (v1 release prerequisite, filed) — both deferred.
- **Per-app graph-version pinning, multi-graph-per-runtime, placement-choice thin-client Plexus authoring** (SP-GRAPH-6), and provisioned DB/connectors (SP-GRAPH-7).

## Design-detail rulings (made here from the approved design; confirm at plan review)

- **R1 — Environment bind mode on the remote build target, not a per-app graph.** Generalize TODL's `RemoteBuildTarget`/`html-bundle-remote` with a binding mode: `environment` (read the env graph) vs the existing per-app behavior. The `environment` mode emits a data client that connects to the runtime tenant and reads the env graph via the **no-bound-app cypher path SP-GRAPH-4 already exposes** — i.e. it does **not** call `OpenApplication` for reads (opening binds the per-app graph). No new graph-id addressing; no new read protocol op (reuse `cypher/query`). The app UI is still deployed + served via the existing `application/deploy` + `AppServingEndpoint`; its manifest packages may be empty.
- **R2 — Build-time schema from the authored solution model.** The env-bound remote build embeds the schema from the maker's compiled solution model (same mechanism as today's `EmitRemoteDataAction`), which matches what was promoted. No build-time fetch from the runtime this slice.
- **R3 — Read-grant mechanism.** Make the env graph readable by an authenticated runtime principal holding a tenant read grant: provision a general read capability (e.g. a seeded reader role / default read grant for the runtime environment's app principals) so the `readTenant` gate passes for a non-Owner app user, lifting the effective DenyAll. Exact seam pinned at plan time (identity grant/seed vs a server-side allow-read on the env-graph read path); it must NOT weaken authoring gates or per-app policy on the bundled path.
- **R4 — Plexus action generalizes `PublishTenantContributor.buildRemote`.** Add a "deploy as remote (environment-bound) app to a runtime environment" action: build `html-bundle-remote` in `environment` bind mode, deploy via `ApplicationDeployProtocol.Deploy` to the chosen runtime environment (reuse the main-process deploy seam + profile). Bundled/local publish paths stay.
- **R5 — Proof reuses the SP0/SP1 e2e + control-plane harness.** The gated proof extends the existing capstone/control-plane smoke rather than a new harness: promote (SP-GRAPH-4 path) then deploy a minimal env-bound remote app then assert the served read returns the promoted content.

## Review focus (inputs the FRs imply but no single task's happy path exercises)

- **Env-bound app read before anything is promoted:** the served app reads the runtime env graph with no graph loaded → the clear "no graph loaded" error SP-GRAPH-4 added surfaces to the client, not a crash/blank.
- **Non-Owner app principal reads the env graph:** the general read-grant actually lets an ordinary authenticated runtime principal read (the Owner-only SP-GRAPH-4 test did not prove this); a principal with NO read grant is still refused (the grant is a real grant, not an open door).
- **Re-promotion under a running app:** after a second promote, the already-served remote app's next read reflects the new graph (shared live instance), with no redeploy.
- **Bundled app unchanged:** a bundled app on the same (or another) runtime still reads its per-app graph; the env bind mode did not bleed into the bundled path.
- **Secret hygiene on the Plexus deploy action:** the admin/deploy token for the runtime environment is never logged, echoed, or surfaced (same discipline as tenant-publish + graph-contribute).

## What the engineer inherits (do not rebuild)

- SP-GRAPH-4: the runtime env-graph instance + `IEnvironmentGraphHost.EnvironmentGraphQuery()` + the no-bound-app cypher read path + `NoEnvironmentGraphError`; `graph/export`/`graph/load`/`graph/loaded`; the control-plane promote route + portal loaded-graph display.
- SP0/SP1: `html-bundle` + `html-bundle-remote` flavors, `RemoteBuildTarget`, `EmitRemoteDataAction` (the `PragmaticClient.ConnectReconnecting` + `BrowserSocketDialer` + `CypherTenantClient` + `TenantDocumentAssembler` client), `ApplicationDeployProtocol.Deploy` + `AppIngestService` + `AppServingEndpoint`, and the SP0/SP1 capstone e2e builders.
- Plexus: `PublishTenantContributor.buildRemote` (remote build + deploy template), the main-process deploy seam (`tenant-deploy-service`/`tenant-client`), the profile store + bearer-token `PragmaticClient` pattern, `BuildComposition`.
- Identity/RBAC: roles/grants, the `readTenant` policy, `AdminService`/control-plane grant mint (the maker-token mint from SP-GRAPH-3a-ii is the template for provisioning a runtime read grant).

## Cross-repo + conventions

- Repos (build order): `@pragmatic-tech-ai/todl` (build target emit) → `pragmatic-protocol` (only if a new client surface is truly needed; prefer reuse) → `pragmatic-server` (read-grant + serve + proof) → `Plexus` (deploy action). Rebuild each sibling's dist before dependents resolve it. In-place feature branch `feat/sp-graph-5` per repo (NOT worktrees).
- OOP, Allman braces, PascalCase interfaces/public methods, enums over string-literal unions, no inline reused/user-facing string literals (hoist to `private static readonly`), view-models extend `Observable`, LF-only. Secrets never logged/echoed/returned/in DTOs. Nothing pushed without explicit instruction.
- Exit: the gated end-to-end proof is green (operator-run), the bundled path still passes its existing suites, and all repos' unit suites + typechecks are green.
