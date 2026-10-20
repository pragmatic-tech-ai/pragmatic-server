# Runtime Publishing Live-Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the full environment loop — local Plexus authoring → contribute → admin promote → publish-env → runtime serves → browser reads the promoted graph live — actually run for the first time, proven by driving the real Plexus Electron app with Playwright + chromium on Contoso/Northwind sample ontologies.

**Architecture:** A new pragmatic-server *loop orchestrator* composes `ControlPlaneHost` in-process (mirroring `control-plane-smoke.ts`) and performs the admin-side steps (create typed envs, mint maker token, promote, provision a credentialed reader) as spawnable subcommands that print a JSON descriptor. A new Plexus Playwright e2e opens a committed Contoso fixture solution, drives the real Generate-UI / Configure / Contribute / Publish-env UI, spawns the orchestrator between phases, then loads the served app in chromium and asserts the promoted data. One server fix lets control-plane runtime containers be browser-served. All spawned windows are placed on the operator's second monitor.

**Tech Stack:** TypeScript (Node ≥22), Playwright `_electron` + chromium, Docker (`pragmatic-server:dev` image), the existing `@pragmatic-tech-ai/todl` build/compile pipeline, `@pragmatic-tech-ai/pragmatic-protocol` wire client.

**Spec:** `docs/superpowers/specs/2026-10-20-runtime-publishing-live-loop-design.md` (approved). Read it with this plan.

## Global Constraints

- **OOP, not functional.** Methods on classes / statics; no module-level free functions or mutable module state (module-level `const`/`type`/`enum` OK). Allman braces (opening brace on its own line). PascalCase interfaces and public methods. Enums over string-literal unions.
- **No inline reused/user-facing string literals** → `private static readonly` PascalCase constants (`.mu` labels exempt; genuinely structural single-use tokens exempt). View-models extend `Observable`, not `MuralBase`.
- **Secrets never surface.** Maker/admin/deploy tokens, passwords, Owner credentials, `modelJson` content are never logged, echoed, returned in a DTO, placed in an error message, or crossed to the renderer. The orchestrator prints tokens **only** on its stdout JSON descriptor consumed by the e2e process; never into server logs.
- **In-graph, not connector.** Data is authored into the graph and read from the promoted graph. No live SQL connection (that is Stage 2).
- **Layering** unchanged: lower layers never call up. No new upper-layer type reaches the engine.
- **LF-only** line endings on every file (verify `tr -cd '\r' < file | wc -c` == 0); never flip pre-existing CRLF.
- **Gating:** the full-loop e2e is operator-run (needs Docker + a built `pragmatic-server:dev` image + chromium) and is gated by `SP_RUNTIME_LOOP_E2E=1`; it is not run in CI or in this build environment. All unit suites and typechecks stay green and unconditional.
- **Second-monitor placement (hard):** every on-screen window the e2e spawns (the Plexus Electron window and the chromium browser) opens on the operator's second monitor. Override env: `SP_E2E_WINDOW_ORIGIN="<x>,<y>"`.
- **Cross-repo:** in-place feature branch `feat/runtime-live-loop` per repo (NOT worktrees — npm install over a worktree detaches sibling symlinks). Build order: `pragmatic-server` then `Plexus`; rebuild a sibling's `dist` before dependents resolve it. Nothing pushed/merged without explicit instruction.

## Review Focus

- **Env-bound read before anything is promoted** → the clear `NoEnvironmentGraphError` surfaces to the client, not a crash/blank. Test owned by Task 5 (pre-promote assertion).
- **A runtime principal with no read grant is denied** while the granted `Viewer` reads succeed (real grant, not an open door). Test owned by Task 5 (granted + ungranted accounts).
- **Re-promote under a running app** → the already-served app's next read reflects the new graph with no redeploy. Test owned by Task 5 (re-promote assertion).
- **Browser origin / cookie correctness** → the served shell loads only when the runtime container was started with the allowed origin and a valid `browser-login` session. Allowed-origin presence owned by Task 1 (unit); the live load owned by Task 5.
- **Secret hygiene** → no token/password in server logs, test stdout beyond the consumed descriptor, DTOs, errors, or the renderer. Owned by Task 2 (descriptor is the only token channel) and asserted in Task 2's tests.

---

## Task 1: Allowed-origin on control-plane runtime containers

**Files:**
- Modify: `environments/seed/docker.ts` (`DockerEnv.RunArgs`, lines 99-117; env-name constants block, lines 50-56)
- Test: `environments/seed/tests/docker-run-args.test.ts` (create if absent; else extend the existing docker test)

**Interfaces:**
- Consumes: `EnvDefinition` (`{ hostPort, type, ... }`), `EnvType` (`environment-record.ts`: `Development='development'`, `Runtime='runtime'`).
- Produces: nothing new in TS surface; `RunArgs` now appends `-e PRAGMATIC_ALLOWED_ORIGINS=http://localhost:<hostPort>` for runtime envs (so a browser can load `/app/...`).

- [ ] **Step 1: Write the failing test.** In `docker-run-args.test.ts`, assert that `DockerEnv.RunArgs(def, bundleDir)` for a `def` with `type: EnvType.Runtime` and `hostPort: 8137` contains the adjacent pair `['-e', 'PRAGMATIC_ALLOWED_ORIGINS=http://localhost:8137']`, and that for a `type: EnvType.Development` def it does **not** (dev envs serve no browser app).

```ts
test('RunArgs sets PRAGMATIC_ALLOWED_ORIGINS to the served origin for runtime envs', () =>
{
    const args = DockerEnv.RunArgs(runtimeDef(8137), bundleDir)
    assert.ok(hasAdjacentPair(args, '-e', 'PRAGMATIC_ALLOWED_ORIGINS=http://localhost:8137'))
})
test('RunArgs omits PRAGMATIC_ALLOWED_ORIGINS for development envs', () => { /* negative */ })
```

- [ ] **Step 2: Run it; verify it fails** (`node --test environments/seed/tests/docker-run-args.test.ts` or the repo's test script). Expected: FAIL (flag absent).
- [ ] **Step 3: Implement.** Add constant `private static readonly EnvAllowedOrigins = 'PRAGMATIC_ALLOWED_ORIGINS'` to the env-name block. In `RunArgs`, before `DockerEnv.ImageName`, when `def.type === EnvType.Runtime`, push `DockerEnv.EnvFlag, \`${DockerEnv.EnvAllowedOrigins}=http://localhost:${def.hostPort}\``. Match the existing origin shape used by `sp0-capstone-e2e.test.ts` (`http://localhost:<port>`).
- [ ] **Step 4: Run tests; verify pass.** Also run the server unit suite + typecheck to confirm no regression.
- [ ] **Step 5: Commit** (`feat(server): set allowed origin on runtime env containers so served apps load in a browser`).

## Task 2: In-process loop orchestrator (admin side)

**Files:**
- Create: `admin/control-plane/loop-orchestrator.ts`
- Test: `admin/control-plane/tests/loop-orchestrator.test.ts`

**Interfaces:**
- Consumes (compose exactly as `control-plane-smoke.ts:215-231`): `DockerEnvAdapter(new DockerEnv())`, `EnvironmentRegistry(join(dataRoot,'registry.json'), docker)` (`.Load()`, `.Reconcile()`), `PortAllocator(floor, new NetPortProbe())`, `AdminProxy(new WsAdminConnector())`, `EnvironmentService(registry, allocator, docker, new BundleBuilderAdapter(), new UserSeederAdapter(new UserSeeder()), dataRoot, proxy)`, `OperatorIdentity.Compose(...)`, `ControlPlaneHost(service, new GraphService(registry, proxy, name => service.AdminInfoFor(name)), staticRoot, operator, false)`, `.Listen(0,'127.0.0.1')`.
- Consumes: `Template.DevBlank='dev-blank'`, `Template.DemoContoso='demo-contoso'`, `EnvType`, the HTTP routes `POST /api/environments`, `POST .../graphs`, `POST .../maker-token`, `POST .../graphs/<g>/promote`; `AdminProtocol.CreateAccount({email,principalId,password})`, `AdminProtocol.GrantRole({subject,role:'Viewer',resourceKind:'Tenant',resourcePath:[]})` over `PragmaticClient.ConnectAsync(wsUrl,{bearerToken})`; provisioned admin credential read from `join(dataRoot, <runtimeEnv>, 'provisioned-secrets.json')` field `` `${tenant}-admin-pw` `` (tenant `contoso` for DemoContoso); env `hostPort` from the `EnvironmentDto` returned by the create/`WaitFor(..., Running)` call.
- **Produces (the cross-task contract consumed by Task 5):** a CLI with subcommands that print one JSON object to stdout and nothing secret to stderr/logs:
  - `create-dev --data-root <dir>` → `{ "dataRoot": string, "devEnv": string, "devWsUrl": string, "graphName": string, "makerToken": string }`
  - `promote-and-provision --data-root <dir> --graph <g>` → `{ "runtimeEnv": string, "tenant": string, "runtimeWsUrl": string, "runtimeHostPort": number, "appOriginBase": string, "deployToken": string, "reader": {"email":string,"password":string}, "ungranted": {"email":string,"password":string} }`
  - `teardown --data-root <dir>` → `{ "ok": true }` (removes created envs/containers).
  Define a `LoopDescriptor` type (a real exported interface, not an inline shape) and a `LoopOrchestrator` class whose public methods (`CreateDev`, `PromoteAndProvision`, `Teardown`) return typed descriptors; the CLI entry (guarded by `IsEntryPoint`, as the smoke does) parses argv and `console.log(JSON.stringify(descriptor))`.

- [ ] **Step 1: Write failing tests** over the pure, Docker-free pieces: (a) argv→subcommand dispatch (`LoopOrchestrator.ParseCommand(argv)` returns the right command + `dataRoot`/`graph`); (b) descriptor serialization round-trips and contains the exact keys above; (c) **secret hygiene** — a fake logger passed to `LoopOrchestrator` is never called with any value equal to a token/password (assert the only token sink is the returned descriptor). Use the adapter-faking style of the existing control-plane tests (fake `EnvironmentService`/`GraphService`/admin client) so no Docker is required.

```ts
test('ParseCommand maps create-dev with data-root', () => { /* ... */ })
test('CreateDev descriptor carries devWsUrl/graphName/makerToken keys', async () => { /* fakes */ })
test('tokens are never written to the injected logger', async () => { /* assert sink */ })
```

- [ ] **Step 2: Run; verify fail.**
- [ ] **Step 3: Implement `LoopOrchestrator`** — compose the control-plane host in-process per the Interfaces block; `CreateDev` creates a `DevBlank` Development env + a graph + mints a maker token and forms `devWsUrl = ws://localhost:<devHostPort>/?tenant=<devTenant>`; `PromoteAndProvision` creates a `DemoContoso` Runtime env, calls promote (`PromotionResultDto`), reads the runtime admin password from `provisioned-secrets.json`, logs in (`UserSeeder`/seeder `Login`) to obtain `deployToken`, creates a `Viewer`-granted reader account and a second ungranted account via `AdminProtocol.CreateAccount`+`GrantRole`, and returns the descriptor with `appOriginBase = http://localhost:<runtimeHostPort>`; `Teardown` deletes the envs. CLI entry prints the descriptor JSON.
- [ ] **Step 4: Run unit tests + server typecheck; verify pass.** (The live Docker exercise happens in Task 5's gated e2e, not here.)
- [ ] **Step 5: Commit** (`feat(server): in-process control-plane loop orchestrator for the live-loop e2e`).

## Task 3: Contoso and Northwind sample-solution fixtures

**Files:**
- Create: `Plexus/apps/plexus/e2e/fixtures/contoso/project.plexus`, `.../contoso/contoso.todl`
- Create: `Plexus/apps/plexus/e2e/fixtures/northwind/project.plexus`, `.../northwind/northwind.todl`
- Test: `Plexus/apps/plexus/e2e/fixtures/tests/fixtures-compile.test.ts`

**Interfaces:**
- Consumes: the TODL dialect shown by `environments/sample-apps/northwind/northwind.todl` and `sp1-app-builder.ts` `ModelText` — `namespace X { concept Name { field : type; } ... model ModelName : X { annotate entrypoint { } <Instances> } }`; optional fields `type?`; refs `f : Concept?` then `f = instance`; scalar types `string`/`number`/`integer`/`boolean`; `@pragmatic-tech-ai/todl` `compilePackage`.
- Consumes: the Architecture manifest shape (`architecture-project-factory.ts` `buildManifest`): `{ type:'architecture', name, version:1, id:<slug>, packageVersion:'0.1.0' }`.
- **Produces (consumed by Task 5):** two openable Architecture project folders; the exported constants the e2e asserts against — the Contoso app id, entrypoint concept, and a seeded instance field value that the generated UI renders (e.g. a `Product.name` of `"Chai"` or a Contoso-specific value distinct from any Northwind the runtime tenant seeds). Put these in a committed `fixtures/fixture-manifest.ts` (exported `ContosoFixture`/`NorthwindFixture` descriptors: `{ folder, appId, tenantConcept, assertField, assertValue }`).

- [ ] **Step 1: Write the failing test.** `fixtures-compile.test.ts`: for each fixture, read its `*.todl`, call `compilePackage([], [{uri, text}], {id, version})`, assert zero error diagnostics and that the package id matches the manifest `id`. Assert `fixture-manifest.ts` `assertValue` text appears verbatim in the fixture `.todl` (so the e2e asserts a value that is really seeded).
- [ ] **Step 2: Run; verify fail** (fixtures absent).
- [ ] **Step 3: Author the fixtures.** Contoso ontology: `concept Product { name:string; unitPrice:number; category:Category?; }`, `concept Category { name:string; }`, `concept Customer { company:string; region:string; }`, `concept Store { name:string; city:string; }`, `concept Sale { product:Product?; store:Store?; qty:integer; }`, with a `model Contoso : contoso { annotate entrypoint { } ... }` holding a handful of seeded instances (catalog + sales). Northwind: mirror `northwind.todl` (Category/Product/Customer/Order) as a second `model`. `project.plexus` per the manifest shape with `id` `contoso`/`northwind`. Choose `assertValue`s unique to each (avoid collision with the demo tenant's seeded Northwind). Keep each a small representative subset.
- [ ] **Step 4: Run the compile test + a Plexus typecheck; verify pass.** Ensure LF-only on all fixture files.
- [ ] **Step 5: Commit** (`test(plexus): committed Contoso and Northwind sample-solution fixtures`).

## Task 4: Second-monitor window-placement helper

**Files:**
- Create: `Plexus/apps/plexus/e2e/support/display-placement.ts`
- Test: `Plexus/apps/plexus/e2e/support/tests/display-placement.test.ts`

**Interfaces:**
- Consumes: Electron `Display` shape (`{ bounds: {x,y,width,height}, id }`) and `process.env.SP_E2E_WINDOW_ORIGIN`.
- **Produces (consumed by Task 5):** a `DisplayPlacement` class with `static TargetOrigin(displays: readonly DisplayBounds[], override?: string): { x: number; y: number }` — returns the override `"x,y"` if set and parseable; else the bounds origin of the first non-primary display; else `{x:0,y:0}` (primary fallback). And `static ChromiumWindowPositionArg(origin): string` → `--window-position=<x>,<y>`.

- [ ] **Step 1: Write the failing test.** Cases: (a) override `"3000,120"` → `{x:3000,y:120}`; (b) two displays, primary at `(0,0)` + secondary at `(2560,0)`, no override → `{x:2560,y:0}`; (c) single display, no override → `{x:0,y:0}`; (d) `ChromiumWindowPositionArg({x:2560,y:0})` === `'--window-position=2560,0'`.
- [ ] **Step 2: Run; verify fail.**
- [ ] **Step 3: Implement `DisplayPlacement`** as pure static methods (no Electron import — operate on the passed display-bounds list, so it is unit-testable headless). Identify the primary display as the one whose bounds origin is `(0,0)` (standard on Windows); the "second monitor" is the first display that is not the primary.
- [ ] **Step 4: Run tests; verify pass.**
- [ ] **Step 5: Commit** (`test(plexus): second-monitor window-placement helper for e2e`).

## Task 5: The live-loop Playwright e2e (drives the real app + browser)

**Files:**
- Create: `Plexus/apps/plexus/e2e/runtime-live-loop.spec.ts`
- Create/extend: `Plexus/apps/plexus/e2e/support/orchestrator-client.ts` (spawns the Task 2 orchestrator, parses the JSON descriptor)
- Reuse: `Plexus/apps/plexus/e2e/plexus-app.ts` (`launchPlexus`, `seedSession`), `Plexus/apps/plexus/playwright.config.ts`
- Test: this file **is** the gated integration test.

**Interfaces:**
- Consumes: Task 2 orchestrator CLI + `LoopDescriptor` JSON contract; Task 3 `ContosoFixture`/`NorthwindFixture`; Task 4 `DisplayPlacement`.
- Consumes (renderer, via the launch-and-reflect pattern already in `sp1-plexus-smoke.spec.ts`): `GenerateUiContributor` (`GenerateCommandId='appui.generate'`; drive its generate command `Run(storage, title)`), `ContributeToGraphContributor` (`ContributeCommandId='graph.contribute'`, `publisher`/contributor `SetProfile(serverUrl, token)` + `Contribute(graphName, solutionId, packages)` via `IGraphContributor`), `PublishTenantContributor` (`PublishEnvCommandId='tenant.publish-env'`; `publisher.SetProfile(url, token)`; drive publish with `RemoteBindMode.Environment`). Resolve via `reg.For('project')`/`reg.For('solution')` + `byCtor(...)`.
- Consumes (server over wire): `POST http://localhost:<rtPort>/auth/browser-login?tenant=<tenant>` `{email,password}` → session cookie; served app at `http://localhost:<rtPort>/app/<tenant>/<appId>/`.
- Env: `SP_RUNTIME_LOOP_E2E` (gate), `SP_SERVER_REPO` (path to pragmatic-server; default sibling `../../../../pragmatic-server`), `SP_E2E_WINDOW_ORIGIN` (optional placement override).

- [ ] **Step 1: Gate + scaffolding.** `test.skip(process.env.SP_RUNTIME_LOOP_E2E !== '1', 'set SP_RUNTIME_LOOP_E2E=1 to run')`; `test.setTimeout(900_000)`. Write `orchestrator-client.ts`: `OrchestratorClient` with `CreateDev()`, `PromoteAndProvision(graph)`, `Teardown()` spawning `npx tsx <SP_SERVER_REPO>/admin/control-plane/loop-orchestrator.ts <cmd> --data-root <tmp>` and `JSON.parse`-ing stdout into the typed descriptor.
- [ ] **Step 2: Launch Plexus on the second monitor.** Use `launchPlexus()`; obtain the launched app's displays via `electronApp.evaluate(({screen}) => screen.getAllDisplays().map(d => d.bounds))`, compute `DisplayPlacement.TargetOrigin(...)`, and set the main window bounds via the Playwright Electron `browserWindow(page)` handle `bw.setBounds({x,y,width,height})`. (No production main change.)
- [ ] **Step 3: Open the Contoso fixture + Generate UI.** `seedSession([ContosoFixture.folder])` before launch (or open via `ProjectCommandsService.OpenProjectAt`); resolve `GenerateUiContributor`, run `EnsureMemberGenerated(member)` then the generate command `Run(storage, title)`.
- [ ] **Step 4: Phase 1 + Contribute.** `const dev = await orchestrator.CreateDev()`; resolve `ContributeToGraphContributor`, `SetProfile(dev.devWsUrl, dev.makerToken)`, build the solution packages and `Contribute(dev.graphName, solutionId, packages)` (reuse the contributor's own build path, as the smoke reuses `pub.buildService.Build`).
- [ ] **Step 5: Pre-promote read assertion (Review focus).** Before promoting, deploy the env-bound app (Step 6 split: deploy first) and issue one read; assert the client surfaces the `NoEnvironmentGraphError` ("no graph loaded") cleanly rather than crashing/blank. (If deploy-before-promote is awkward, assert the error via a direct wire read against the fresh runtime env graph.)
- [ ] **Step 6: Phase 2 + Publish-env.** `const rt = await orchestrator.PromoteAndProvision(dev.graphName)`; resolve `PublishTenantContributor`, `publisher.SetProfile(rt.runtimeWsUrl, rt.deployToken)`, drive publish with `RemoteBindMode.Environment` (the `tenant.publish-env` path).
- [ ] **Step 7: Browser read on the second monitor (the milestone assertion).** Launch chromium headed with `args: [DisplayPlacement.ChromiumWindowPositionArg(origin)]`; `POST /auth/browser-login?tenant=<rt.tenant>` with `rt.reader`; navigate to `${rt.appOriginBase}/app/${rt.tenant}/${ContosoFixture.appId}/`; wait for and assert `ContosoFixture.assertValue` is rendered.
- [ ] **Step 8: Ungranted-denied assertion (Review focus).** With a fresh browser context, `browser-login` as `rt.ungranted`; assert the served app's read is denied (no data; a clear auth/permission failure), proving the grant is real.
- [ ] **Step 9: Re-promote assertion (Review focus).** Contribute a second package / changed instance, `orchestrator.PromoteAndProvision` again (re-promote), reload the already-served app in the same browser, assert the new value appears with no redeploy.
- [ ] **Step 10: Teardown.** `finally`: close chromium, `await l.app.close()`, `restore()`, `await orchestrator.Teardown()` (remove envs/containers).
- [ ] **Step 11: Typecheck + gated-run note.** Plexus typecheck green. Do not run here (no Docker/chromium); the operator runs `SP_RUNTIME_LOOP_E2E=1 npx playwright test runtime-live-loop.spec.ts`. Commit (`test(plexus): live-loop e2e — real app contribute→promote→publish-env→browser read`).

## Task 6: Operator runbook

**Files:**
- Create: `pragmatic-server/docs/superpowers/runbooks/2026-10-20-runtime-live-loop-runbook.md`

**Interfaces:** consumes the gating flag, env vars, and the one-time prerequisites named in the design.

- [ ] **Step 1: Write the runbook.** One-time prerequisites: Docker running; build `pragmatic-server:dev` (`DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<path>/.npmrc -t pragmatic-server:dev ..` from the workspace parent); `npx playwright install chromium`; build Plexus (`npm run build` so `out/main/index.js` exists); rebuild sibling `dist` as needed. Run: set `SP_RUNTIME_LOOP_E2E=1` (and optionally `SP_SERVER_REPO`, `SP_E2E_WINDOW_ORIGIN`), then `npx playwright test runtime-live-loop.spec.ts` from `apps/plexus`. Note the windows appear on the second monitor; note that connectors/provisioned DBs are Stage 2.
- [ ] **Step 2: Verify** the commands match the repos (paths, flags) and that no secret is printed by any documented command. Commit (`docs(server): runbook for the runtime live-loop e2e`).

---

## Self-review notes

- **Spec coverage:** G1/G4 → Tasks 5 (+2,3); G2 (real app + browser + second monitor) → Tasks 5,4; G3 gaps → Task 3 (sample solution), Task 1 (allowed origin), Task 2 (reader provisioning + token/identity), Task 6 (runbook). Non-goal "app-reader-grant" correctly absent; reader is a real credentialed `Viewer` account (Task 2).
- **Review Focus:** pre-promote error (Task 5 Step 5), ungranted-denied (Step 8), re-promote (Step 9), browser origin (Task 1 unit + Task 5 Step 7), secret hygiene (Task 2 tests).
- **Type consistency:** the `LoopDescriptor` keys produced by Task 2 are the exact keys Task 5 consumes; `ContosoFixture`/`NorthwindFixture` and `DisplayPlacement` signatures are referenced identically in Task 5.
- **Proportion:** the heavy integration lives in Task 5 whose "test" is the gated e2e; Tasks 1/3/4 carry real unit tests; Task 2's pure pieces are unit-tested and its live exercise is Task 5.
