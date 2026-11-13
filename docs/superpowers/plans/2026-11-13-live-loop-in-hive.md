# Live-loop e2e in a hive: implementation plan

**Goal:** the Plexus runtime live-loop (`apps/plexus/e2e/runtime-live-loop.spec.ts`, Contoso + Northwind fixtures plus the Catalog/Postgres leg) runs end to end the way a customer works: Plexus signs in to a tenant on a local control plane, and contribute and publish go through that tenant's in-hive console to environments on the tenant's hive.

**Why:** since Plexus commit ab4d4393 (2026-11-06), contribute and publish go through the signed-in tenant's console. The console only allows environments that belong to its tenant. Today's orchestrator (`admin/control-plane/loop-orchestrator.ts`) creates plain Docker environments in a private temp data root, with no tenant or hive behind them, so no account can own them. The spec could not pass after that change, and it always skipped because the account variables were never set.

**Owner decision (2026-11-13):** option 1, the realistic in-hive path. Use throwaway accounts with short fake emails and short, simple passwords.

## As built (2026-11-13): what changed from the design below

- **No in-hive console, and no Windows certificate trust.**
  - A tenant without an in-hive console uses the platform's own tenant plane as its console. Discovery hands Plexus `http://127.0.0.1:7100`, and Plexus allows plain http to loopback.
  - That plane relays to environments the platform created on the tenant's hive. Those can also be promoted by the operator, which environments made by an in-hive console cannot be today.
  - So the stack installs no console, and the owner-only certificate step is gone.
- **The hive** is a Local/Attach hive on the stack's own kind cluster (`kind-pragmatic-e2e`), with registry mode `attach` (preloaded images). Mode `provision` expects a host registry at `localhost:5000`.
- **The owner password** is `e2e-password`, the shortest the tenant plane accepts (at least 12 characters).
- **The owner's operations** run in a headless Chromium signed in at the tenant plane (`TenantOwnerSession`). The tenant's IdP serves a JavaScript login page.
- **Plexus's scripted sign-in** uses the browser login, pinning the IdP's server certificate (`PLEXUS_E2E_IDP_CERT_FILE`). This also needs no OS trust.
- **The runtime environment** has no public host here, because the tenant's IdP is a container and not in-cluster, so there is no base domain. The e2e reaches it through a detached `kubectl port-forward` that outlives each orchestrator call.
- **Reader sign-in** uses `?environment=`. The Plexus spec still sent the old `?tenant=` name, from before the environment-id rename.
- **The orchestrator** moved to `admin/control-plane/live-loop/` with its adapters (`loop-stack-adapters.ts`). That folder is excluded from the tenant-admin image build.

## Design (as planned)

- **Test stack, kept apart from the developer's data.**
  - A control plane on `:7000` runs with its own data root (`~/.pragmatic/e2e-stack/`), never `admin/control-plane/data/` (the owner's real dev data).
  - It runs on its own kind cluster (`pragmatic-e2e`, provisioned by the platform as a Local/Provision hive), so Docker Desktop's built-in cluster is not needed.
- **Seed through the operator API, as an operator would:**
  - client `e2e`
  - tenant `t` with owner `o@t.io`
  - hive `t-hive` bound to `t`
  - the console installed on the hive, with development TLS and base domain `localtest.me`
- **Short owner password.** The provisioning-time owner password is changed to a short test password through the tenant password-change route. It is written to a file and never printed.
- **The orchestrator drives the running stack over HTTP and no longer composes services in-process.**
  - As the **tenant owner** (tenant API): create the Development and Runtime environments on `t-hive`, the dev graph, the reader and ungranted accounts, the reader role grant, and the security setting (`RuntimeReaderSecurity`).
  - As the **operator** (operator API): promote.
  - **db-exec:** `kubectl exec` of `psql` in the runtime environment's Postgres pod.
  - The CLI verbs (`create-dev`, `create-runtime`, `promote`, `db-exec`, `teardown`) and the JSON descriptors keep their shape. URLs become the environments' Ingress hosts (`https://<env>.localtest.me`). The temp `--data-root` becomes `--stack <descriptor file>`.
- **Plexus spec.**
  - Reads the stack descriptor for the platform address, owner email and password file.
  - The served-app reader's Chromium trusts the dev CA. Plexus main reaches the console through the OS store.
  - Contribute and publish keep `TargetSource.Console`.

## Owner-only step

The console's development CA must be trusted in the Windows **user** store so Plexus main reaches the console over https. This is `dev-ca-trust.ps1 -CaFile <ca> -Install`; Windows shows a confirmation that only the owner can accept. It is removed again at teardown with `-Remove`.

## Tasks

1. **Control-plane data root override (server).** `server.ts` reads `PRAGMATIC_ADMIN_DATA_ROOT` (default unchanged: `admin/control-plane/data`). Test: the composed data root follows the variable.
2. **`live-loop-stack.ts` up/down (server, operator-run).**
   - `up`: starts the control plane (detached, logs to the stack dir), then runs the operator seed above. It installs the console and polls until it is `deployed`, sets the short owner password, and writes `stack.json`. The file holds: platform address, console URL, dev CA file, owner email, owner password file, tenant, hive, and operator credentials file.
   - `down`: removes the console, the environments and the hive (which deletes the kind cluster), stops the control plane and deletes the stack dir.
   - Unit tests cover the seed sequence against a fake operator API.
3. **Orchestrator over HTTP (server).** `LoopOrchestrator` gets HTTP adapters for `ILoopEnvironments`, `ILoopGraphs` and `ILoopDatabase`, using tenant-API endpoints as the owner, operator endpoints for promote, and kubectl for psql. The existing orchestrator tests keep their fakes; new adapter tests use a fake HTTP server.
   - Reader and ungranted accounts are created in the environment (`accounts`). Their browser login on a federated environment must still accept local passwords, or the accounts are seeded in the tenant IdP instead (decided at implementation from the env's auth config, and recorded here).
4. **Plexus spec + client (Plexus).**
   - `OrchestratorClient` passes `--stack`.
   - `ScriptedDesktopSignIn` can take its inputs from `stack.json` (`PLEXUS_E2E_STACK`).
   - `BrowserReader` and `RuntimeEnvGraphReader` use the https Ingress origin and trust the dev CA.
   - Update the runbook `2026-10-20-runtime-live-loop-runbook.md`.
5. **Run.** `live-loop-stack up`, then the owner trusts the CA, then the spec runs with `SP_RUNTIME_LOOP_E2E=1`. Every step must pass: Contoso milestone, ungranted denial, re-promote, and the Catalog Postgres read-through. Then `down` and the CA is removed.

## Risks

- The reader's local-password login on a federated in-cluster environment (task 3).
- A Runtime environment with Postgres in-cluster has never run under a live browser.
- The console relay holding long publish calls (G3 in the 2026-11-06 plan).
