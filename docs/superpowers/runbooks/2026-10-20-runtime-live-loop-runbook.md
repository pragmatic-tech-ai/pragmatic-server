# Runtime live-loop e2e: operator runbook

## What it proves

The live-loop e2e drives the whole author-to-serve path the way a customer works, on one machine:

1. A local Plexus signs in to a tenant on a local control plane.
2. Plexus authors a simple graph from the Contoso and Northwind ontologies and contributes it to a Development environment graph. The contribution goes through the tenant's console relay to an environment on the tenant's hive.
3. The operator promotes that graph into the Runtime environment, and the tenant's security setting grants the reader access.
4. Plexus publishes an environment-bound app. A real browser on the second monitor reads the promoted graph live from it.
5. A second app, Catalog, reads live from the Runtime environment's own Postgres.

## The stack

The test runs against a dedicated stack. It never touches the developer's own control-plane data in `admin/control-plane/data/`.

`admin/control-plane/live-loop/live-loop-stack.ts up` stands up:

- A kind cluster `pragmatic-e2e`, with:
  - host ports 443 and the in-cluster registry port 30500 mapped;
  - ingress-nginx with SSL passthrough;
  - the `pragmatic-server:dev`, `registry:2` and `postgres:16` images loaded.
- A control plane:
  - The operator API is on `http://localhost:7000`. The tenant plane, which serves as the tenant's console, is on `http://e2e.lvh.me:7100`.
  - Its state lives in `~/.pragmatic/e2e-stack/data`.
- Through the operator API:
  - client `e2e-client`;
  - tenant `e2e` with owner `o@t.io`, plus its IdP container;
  - hive `e2e-hive`, attached to the kind cluster.
- The owner's one-time password, replaced through the tenant plane with the short test password `e2e-password`. The tenant plane requires at least 12 characters.

`up` writes `~/.pragmatic/e2e-stack/stack.json`. It records:

- the addresses;
- the owner and operator emails;
- the paths of the files holding their passwords;
- the IdP's development CA file.

No password is ever printed. `down` removes everything again: it stops the control plane, removes the IdP container and volume, and deletes the cluster and the stack folder.

## One-time prerequisites

1. **Docker is running.** Check with `docker info`. `kind` and `kubectl` must be on PATH. On this machine, winget installs kind under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Kubernetes.kind_*`.

2. **Build a fresh `pragmatic-server:dev` image.** From the workspace root `architecture-agent/`, with a private `.npmrc` that holds a GitHub Packages token with the `read:packages` scope. Keep that file outside the repo.

   ```
   DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=<path>/.npmrc -t pragmatic-server:dev .
   ```

3. **Install Playwright's Chromium**, in both the server repo and `apps/plexus`:

   ```
   npx playwright install chromium
   ```

4. **Build Plexus** so `apps/plexus/out/main/index.js` exists. From `apps/plexus`, run `npm run build`.

5. **Free the host ports** 443, 30500, 7000 and 7100. In particular, do not run `dev-up.sh` at the same time, because it also uses 443 and 7000.

## Run

From the pragmatic-server repo:

```
npx tsx admin/control-plane/live-loop/live-loop-stack.ts up
```

From `apps/plexus` in the Plexus repo (Git Bash):

```
SP_RUNTIME_LOOP_E2E=1 PLEXUS_E2E_STACK=~/.pragmatic/e2e-stack/stack.json npx playwright test e2e/runtime-live-loop.spec.ts
```

The suite skips unless `SP_RUNTIME_LOOP_E2E=1` is set, so it never runs in unit or CI runs.

`PLEXUS_E2E_STACK` gives the scripted desktop sign-in its inputs: the owner email, the password file, the platform address, the tenant and the IdP CA. Any `PLEXUS_E2E_*` variable that is set explicitly still wins.

The suite spawns the orchestrator, `admin/control-plane/live-loop/loop-orchestrator.ts`, for each step, locating the server repo through `SP_SERVER_REPO` or the sibling default. Do not run it by hand except to clean up (`teardown`).

The orchestrator acts as the people involved:

- **As the tenant owner**, signed in at the tenant plane through the IdP in a headless browser, it creates:
  - the `loop-dev` and `loop-rt` environments on the hive;
  - the dev graph;
  - the reader `r@t.io` and the ungranted `u@t.io` accounts, each with a random password;
  - the reader's role;
  - after each promote, the runtime's security setting.
- **As the operator**, it promotes.

The runtime environment is reached through a `kubectl port-forward` on a free localhost port. That forward outlives the orchestrator process, and teardown stops it.

Afterwards, take the stack down:

```
npx tsx admin/control-plane/live-loop/live-loop-stack.ts down
```

Optional environment variables:

- `SP_SERVER_REPO`: the path to the pragmatic-server repo. When unset, the suite uses the sibling location.
- `SP_E2E_WINDOW_ORIGIN`: an `x,y` screen origin for the Plexus and Chromium windows. Without it, they open on the first non-primary display.

## What the test does

1. **Setup.** Clone the Contoso and Catalog fixtures into temp directories, then launch Plexus on an isolated temporary profile on the second monitor.
2. **Sign-in.** Sign Plexus in to tenant `e2e` with the scripted desktop sign-in. No real browser is used: the IdP login runs over Node https and trusts the IdP's development CA.
3. **Generate UI.** Generate UI for the Contoso entrypoint concept.
4. **Contribute.** Create the Development environment and its graph, then contribute the solution packages through the tenant plane's relay.
5. **Runtime.** Create the Runtime environment with Postgres, plus the reader and ungranted accounts. Nothing is promoted yet.
6. **Pre-promote check.** A Cypher read against the empty runtime environment graph must fail with a clean NoEnvironmentGraphError.
7. **Promote.** Promote, and secure the runtime: the reader reads every promoted concept.
8. **Publish.** Publish the Contoso app bound to the environment. The publish goes through the relay.
9. **Milestone.** A real Chromium on the second monitor signs in as the reader and reads the promoted value from the served app.
10. **Ungranted read.** The ungranted account is refused by RBAC. This must be a permission refusal, not the no-graph error.
11. **Re-promote.** Change the seeded assert value, re-contribute, promote again and reload. The new value renders with no redeploy.
12. **Postgres read-through.**
    - Insert a row into the runtime's Postgres.
    - Generate, contribute, promote and publish Catalog, then see the row in the browser.
    - Update the row and reload only: the new value renders.
13. **Teardown.** Sign Plexus out, then delete both environments and stop the port-forward. Each teardown action runs independently.

## Troubleshooting

- **The suite skips naming the sign-in variables.** `PLEXUS_E2E_STACK` is unset or names a missing file. Run `live-loop-stack.ts up` first.
- **`up` refuses with "the e2e stack is already up".** `stack.json` exists. Run `down` first.
- **`create-dev` fails with 409, or "listed as failed".** A previous run left the environments behind. Run `npx tsx admin/control-plane/live-loop/loop-orchestrator.ts teardown` and run again.
- **An environment create fails with `localhost:5000/pragmatic-server:dev` missing.** The hive was seeded with registry mode `provision`. The stack seeds `attach`, so take the stack down and up again.
- **The control plane does not answer.** Read `~/.pragmatic/e2e-stack/control-plane.log`.
- **The pre-promote check returns rows.** Something was promoted before the run, so tear down and run again.
- **The ungranted read fails with the no-graph error.** Check that the promote step ran.
- **The re-promote still shows the original value.** Check that the re-contribute step reported success.
