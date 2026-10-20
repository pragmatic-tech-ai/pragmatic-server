# Runtime live-loop e2e: operator runbook

## What it proves

The live-loop e2e drives the whole author-to-serve path on one machine. A local Plexus authors a simple graph (Contoso and Northwind ontologies) and contributes it to a Development environment graph. An admin promotes that graph from Development into the Runtime environment. The test then publishes an environment-bound app, the Runtime serves it, and a real browser on the second monitor reads the promoted graph live. Connectors and provisioned databases are Stage 2 and are out of scope for this run.

## One-time prerequisites

1. Docker is running.

2. Build the server image `pragmatic-server:dev`. The build context must be the workspace parent directory (`architecture-agent/`), not the repo itself. The build needs a private `.npmrc` that holds a GitHub Packages token with the `read:packages` scope. Keep that file outside the repo and never commit it. Replace `<path>` with the location of your `.npmrc`:

```
DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<path>/.npmrc -t pragmatic-server:dev ..
```

The token is mounted only during the `npm install` steps and is never written into an image layer.

3. Install the Chromium build that Playwright uses:

```
npx playwright install chromium
```

4. Build Plexus so that `apps/plexus/out/main/index.js` exists. Rebuild any sibling `dist` that the build consumes before you build Plexus. From `Plexus/apps/plexus`:

```
npm run build
```

## Run

From `Plexus/apps/plexus`, set the gate and run the spec. The gate is `SP_RUNTIME_LOOP_E2E=1`. On Windows PowerShell use `$env:SP_RUNTIME_LOOP_E2E = '1'` before the command. On Git Bash use `SP_RUNTIME_LOOP_E2E=1 npx playwright test runtime-live-loop.spec.ts`.

```
SP_RUNTIME_LOOP_E2E=1 npx playwright test runtime-live-loop.spec.ts
```

The suite skips unless `SP_RUNTIME_LOOP_E2E=1` is set, so it never runs in normal unit or CI runs. It composes the control-plane orchestrator in-process (`pragmatic-server/admin/control-plane/loop-orchestrator.ts`) and creates real Docker containers. It tears them down at the end, including when a step fails.

Optional environment variables:

- `SP_SERVER_REPO` is the path to the pragmatic-server repo. When unset, the suite uses the sibling location of the repo relative to Plexus.
- `SP_E2E_WINDOW_ORIGIN` is an `x,y` screen origin that overrides where the Plexus and chromium windows open. Without it, the windows open on the first non-primary display, and fall back to the origin (0,0) when only one display is present. Set it when your second monitor is not the first non-primary display.

## What the test does

1. Setup: clone the Contoso fixture into a throwaway temp directory and seed the Plexus session to point at it.
2. Launch Plexus and place its window on the second monitor.
3. Open Contoso and run Generate UI for the entrypoint concept.
4. Create the Development environment, then contribute the solution packages into its dev graph. Then create the Runtime environment with its container and provisioning only. No promote happens at this point.
5. Pre-promote check: run one Cypher read against the empty Runtime environment graph. The read must fail with a clean NoEnvironmentGraphError, not a crash or blank result.
6. Promote the dev graph into the existing Runtime environment.
7. Configure the tenant and publish the Contoso app bound to the environment.
8. Milestone: a real chromium browser on the second monitor signs in as a reader and reads the promoted value from the served app.
9. Ungranted read: a user without a grant must be denied by RBAC. The denial must be a permission refusal, not the no-graph error.
10. Re-promote: change the one seeded assert value to a distinct v2 string, re-contribute into the same dev graph, promote again, and reload the already-served app. The v2 value must render and the original must be gone, with no redeploy.
11. Teardown: tear down the containers and restore the seeded session. Each teardown action runs independently, so a failure in one does not skip the others.

## What to watch

Two steps carry the most operator risk, so check them first when a run fails.

Step 5, the pre-promote check, is unconditional. It must reject with NoEnvironmentGraphError. If it returns rows, something has already been promoted into the Runtime, so the environment was not clean when the run started. If it hangs or crashes, the Runtime container or its connection is at fault, not the graph.

Step 10, the re-promote, depends on the second build picking up the rewritten `.todl` source. The test changes the seeded value in the cloned solution, re-contributes, and promotes again. If the reloaded app still shows the original value, check that the re-contribute step reported success and that the promote step rebuilt from the rewritten source, not a cached build.

## Troubleshooting

If the suite fails with a message that the `pragmatic-server:dev` image is missing, run the image build step from the prerequisites.

If it reports that the chromium executable is missing, run `npx playwright install chromium`.

If the Plexus or chromium windows open on the wrong monitor, set `SP_E2E_WINDOW_ORIGIN` to the `x,y` origin of your second monitor and run again.

If it fails with a missing `out/main/index.js` message, run `npm run build` in `Plexus/apps/plexus`.
