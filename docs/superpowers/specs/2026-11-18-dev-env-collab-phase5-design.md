# Dev-Env Collaboration — Phase 5: Run/Test from the Dev Environment (Design)

**Date:** 2026-11-18
**Program:** Collaborative Development on Dev Environments (Project #1 draft issue DI_lADOE0Zc984Biu4ozgLwnlw)
**Phase:** 5 of 5 — the final phase. Closes the author → build → **run → test** loop.
**Repos:** pragmatic-protocol (`master`), pragmatic-server (`master`), Plexus (`main`). todl-identity is **not** touched.
**Predecessors:** Phases 1–4 merged locally (server eb655909, protocol 7b4c332, Plexus 905c4230). This is an AFK autonomous run: **merge each repo locally, never push.** Fix all review findings including Minors.

---

## Intent

Today a developer authoring in a dev environment can build their solution, but to actually *run* it they must publish to a **separate** runtime environment (an admin-privileged deploy to production-like infrastructure). Phase 5 lets a developer **run and test their current build in place**: the dev environment co-hosts a runtime graph engine, the developer loads their build into it with a developer-level credential, and the built app is served at a URL the whole connected team can open and exercise — all without leaving the dev environment and without handing a developer an admin deploy credential.

## Goals

- A dev environment can advertise **both** the development service surface (author/build) **and** a narrow runtime surface (load + serve), on one `PragmaticServer`.
- A **Run/Test** action in Plexus's dev-environment context builds the current app and loads it into the co-located runtime host, then opens the served-app URL.
- The capability is **least-privilege**: a developer runs/tests with a `Role.Developer` credential on a narrow, short-TTL scope — never an admin deploy token, never the full runtime data-plane over the relay.
- Reuse the proven runtime machinery unchanged: `EnvironmentEngineHost`, app ingest/deploy, `AppServingEndpoint` (`/app/<env>/<app>/`), `DevGraphService.ExportGraph`.

## Non-goals / anti-goals

- **Not** a replacement for publish-to-runtime. Production deploy stays `Action.Administer`-gated and admin-minted. Run/Test is the in-env dev loop, not promotion.
- **Not** a widening of the develop credential. `DevelopMethods.All` is **not** extended with any runtime method. A develop session can never reach the runtime data-plane.
- **Not** a bare-graph headless run (cypher/data testing with no served UI). v1 runs a *servable app*; headless-graph run is deferred (Feature).
- **Not** multi-tenant isolation changes. One dev env = one developer team's shared graph, as in Phases 1–4.

---

## Approaches considered

1. **Second co-located `PragmaticServer` per dev env (one dev, one runtime).** Rejected: `EnvironmentRegistry` is one-server-per-env; two servers double the lifecycle/ownership/dispose surface, and the dev engine and runtime engine already coexist as lazily-memoized getters on a single `PragmaticServer` kept apart only by the purpose asserts. No second object is needed.
2. **Widen `EnvironmentPurpose` env-wide and coalesce shared endpoints (`runtime.x ?? development.x`).** Rejected: the attach already coalesces this way, and on a dual-purpose env it would silently pick the runtime engine for every shared endpoint (`cypher/query`, `model/view`, `connector/*`), hiding the dev engine from develop sessions. The coalescing is the single most security-relevant seam and must be *removed*, not extended.
3. **Per-connection effective purpose (CHOSEN).** `ServerConnectionHandler` is already constructed **per WebSocket connection**, with a per-connection `AccessContext` and `TokenScopeGate`. A dual-purpose env advertises both stacks, but **each connection binds to exactly one**, chosen by its authenticated scope. The `?? ` coalescing dissolves because only one stack is ever computed for a given connection. The develop credential is structurally unable to reach the runtime stack.

---

## Architecture

### 1. Dual-purpose environment (non-exclusive purpose)

`EnvironmentPurpose` stays a two-member enum. `EnvironmentProvisioning` gains `runtimeCoHosted?: boolean` (default `false`). A dev env with `runtimeCoHosted: true` serves both surfaces. `PragmaticServer` exposes membership predicates:

- `Purpose()` — the **primary** purpose (unchanged; `Development` for a dev env). Kept for back-compat and for connections with no scope.
- `ServesDevelopment()` ≡ `Purpose() === Development`.
- `ServesRuntime()` ≡ `Purpose() === Runtime || runtimeCoHosted`.

`AssertDevelopmentPurpose()` / `AssertRuntimePurpose()` on `PragmaticServer` become membership checks (`ServesDevelopment()` / `ServesRuntime()`), so a dual-purpose env may lazily construct **both** `DevEngine()`/`GraphService()`/… and `EnvironmentEngine()`/`Applications()`/…. The two engines use different stores (dev: source-backed `DevGraphEngineHost`; runtime: LMDB `<graphsRoot>/environment-engine`) — no path collision. Runtime security machinery (`StartDirectorySync`, `EnvironmentScopes`) starts when `ServesRuntime()`.

### 2. Per-connection stack selection (replaces `?? ` coalescing)

In `pragmatic-server-host.ts`, authentication resolves an **effective purpose for the connection** before `ServerConnectionHandler.Attach`:

- Authenticated via **app-session cookie** (served app) → `Runtime`.
- Authenticated via **service token** carrying `TokenScope.RunTest` → `Runtime`.
- Authenticated via **service token** carrying `TokenScope.Develop` → `Development`.
- Otherwise (unscoped platform/admin session) → `server.Purpose()` (primary; today's behavior).

The resolver intersects with what the env serves (a `Development` effective purpose on an env that `!ServesDevelopment()` is impossible by construction — tokens are minted per env purpose — and the resolver does not assert it; the fail-closed guarantee is enforced at the attach-args layer by two independent conditions, effective purpose AND `server.ServesX()`). `RuntimeAttachArgs` / `DevelopmentAttachArgs` (each returns all-undefined unless both hold) are gated on the **effective** purpose (passed in) instead of reading `server.Purpose()`, so exactly one side is populated per connection and the `?? ` coalescing resolves to that one side. The handler's `IsDevelopment()`, `EnsureRuntime()`, `EnsureDevelopment()`, the `data/changed` subscription gate, and the `solutionRoots` selection all read the effective (per-connection) purpose.

**This is the load-bearing change.** A develop connection sees only the dev stack; a run-test or served-app connection sees only the runtime stack. There is no connection on which both are visible, so no shared endpoint is ambiguous.

### 3. Least-privilege Run/Test capability

A **new** relay action and token scope, strictly narrower than the existing Publish path:

- **Protocol:** a new run-test load method (e.g. `RunTestProtocol.Load`) taking the existing `CypherAppDeployParamsDto` (graph packages + UI bundle + servable manifest — identical shape to publish).
- **PolicyGate:** the new method classified as **`{ Action.Write, ResourceKind.Realm }`** — which `Role.Developer` already holds. (Contrast: `application/deploy` stays `{ Action.Administer, ResourceKind.Realm }`, Admin-only.)
- **Scope:** new `TokenScope.RunTest = 'environment-run-test'`, allowlisting **only** `{ RunTestProtocol.Load, PragmaticAppProtocol.List, GraphProtocol.Loaded }` — load + verify. **No** `data/write`, `data/share|unshare|assign`, no `application/open`, no `graph/create|delete`.
- **Relay:** new `RelayAction.RunTest` + `DesktopAction.RunTest` + `DesktopRelayAllowlist` entry = the same three methods; `desktop-relay.ts` minting issues a token via a new `AdminIssueRunTestToken` granting **`Role.Developer`** (no new role, no Admin grants) on `TokenScope.RunTest`, short TTL (match the 15-min deploy-token TTL).
- The new load method's handler calls the **same** `deployProvider` the existing deploy uses (app ingest → promote → serve), gated by `EnsureRuntime()` (now membership) + the scope gate + the Write policy. The internal operation is identical to deploy; only the *client method's* classification and the *token's* grants are lowered to developer level.

The **served app's own data-plane** (`data/write`, `cypher/*`) continues to authenticate via the **browser session cookie** through `AppServingEndpoint`, exactly as any served app — the developer's RunTest relay token never carries data-plane scopes. Testing the running app exercises the data-plane under the cookie session, which is the established, separately-authenticated path.

### 4. Plexus Run/Test trigger

A **Run/Test** action in the dev-environment context:

1. Builds the current app locally (reuse the existing `build-remote` / html-bundle build that `EnvironmentDeployService` already consumes).
2. Connects over a new `RelayAction.RunTest` session and calls the new `RunTestProtocol.Load` relay method with the assembled `CypherAppDeployParamsDto`.
3. Opens the served-app URL `/app/<env>/<app>/` (same-origin) for the team. Post-run verification uses the existing `GetLoadedGraph` / `ListApplications` relay methods.

A `RunTestService` (main process) mirrors `EnvironmentDeployService`'s structure (read build output → assemble params → connect → call), differing in the relay action, the called method, and that the target is the developer's **own** co-located host.

---

## Security rulings (pre-authorized by owner for this AFK run — FLAGGED FOR MORNING REVIEW)

These are the security-sensitive decisions the mandate pre-authorized. Each is least-privilege; each is recorded here and in the ledger for the owner's morning review.

- **P5-SEC-1 (dual-purpose, but runtime surface is narrow).** A dev env advertises both the develop surface and a runtime surface, but the runtime surface reachable by a *developer relay token* is gated to the narrow RunTest allowlist — **not** the full runtime data-plane. The full data-plane (`data/write`, shares, assign) over a relay token remains reachable only on a standalone Runtime env. *Cost if wrong:* a dev env exposes more runtime surface than intended; contained by the scope allowlist + per-connection stack selection.
- **P5-SEC-2 (developer-level authz, not admin).** Run/Test uses a new Write-gated load method under `TokenScope.RunTest` minted with `Role.Developer` — strictly less privileged than the Admin + `application-deploy` publish token at both the grant layer and the method layer. Production publish is untouched. *Cost if wrong:* a developer can load/serve an app into their own dev env's runtime host at Write authority; bounded to their own realm, not production.
- **P5-SEC-3 (per-connection stack selection).** On a dual-purpose env each connection binds to exactly one service stack by its authenticated scope (Develop → dev engine; RunTest / served-app cookie → runtime engine), replacing the `runtime.x ?? development.x` coalescing. The develop credential is structurally unable to reach the runtime stack. *Cost if wrong:* a shared endpoint could route to the wrong engine; mitigated because only one stack is ever computed per connection and the scope→purpose map is the single decision point.
- **P5-SEC-4 (served-app data-plane on a dev env).** Relaxing `EnsureRuntime()` to accept a dual-purpose env **necessarily** enables the served app's data-plane under **browser-session (cookie) auth** on that dev env — this is the intended test surface (you cannot test an app without its data-plane) but it is a genuine expansion of what a dev env does. The relay-token boundary (P5-SEC-1/2) is unaffected; this concerns only the cookie-authenticated served-app session, which is the same path a production runtime env uses. **Flagged prominently for morning review.**

## Rulings (non-security)

- **P5-1 (Run/Test target = servable app, not bare graph).** Run/Test deploys a servable app (graph + UI bundle) via the existing ingest/serve path and opens `/app/<env>/<app>/`. Headless bare-graph run is deferred as a Feature. *Cost if wrong:* a developer can't test a headless graph in-env without publishing; cheap to add later.

## Deferred (file as Project #1 Features during finish)

- Headless bare-graph Run (cypher/data testing with no served UI).
- Opt-in provisioning UI / admin control for `runtimeCoHosted` (v1 provisions it in config).
- Per-connection stack selection unit-coverage for the unscoped admin-session edge on a dual-purpose env (verify it routes to primary, not runtime).

## Open implementation notes for the plan

- The effective-purpose resolver needs the auth *kind* (cookie vs scoped token), known inside `AuthenticateAgainst`; thread it out (return `{ context, effectivePurpose }` or compute purpose there) rather than re-deriving downstream.
- `RuntimeAttachArgs` / `DevelopmentAttachArgs` signatures change from reading `server.Purpose()` to taking an explicit effective purpose.
- `DevGraphService.ExportGraph(...).packages` already matches `graph/load`/deploy input shape (modulo a name wrapper) — the Plexus build→params assembly reuses the publish path's assembly.
- Dispose ordering already tears down both stacks (`DoDispose`); verify a dual-purpose env disposes cleanly with both engines live.
