# SP-HIVE-7b — Tenant Admin Portal (mural web app) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build `admin/tenant-portal/` — a mural single-page web app a tenant admin logs into (via their per-tenant IdP) to see their hives as a tree, roll each hive to a published version with an inline confirm, and start/stop/restart environments while watching live health and live logs — served by the control-plane at a tenant-facing static root and talking only to the SP-HIVE-7a `/tenant-api` + `/tenant-auth` backend.

**Architecture:** A new package copied from the operator `admin/portal/` (same mural stack: `Application` + `HtmlTarget` + imperative `StackPanel` views + `Observable` view-models + a `fetch`-based API client; vite build; `node:test` unit tests + a gated Playwright e2e). It adds what the portal lacks: a hive→environment **tree + detail pane** (mural `TreeView` + `Splitter`), an inline **version list + confirm strip**, and **live** health/logs driven by the tenant websockets. The control-plane learns to serve a second, tenant-facing static root selected by Host; everything else in 7a is reused unchanged.

**Tech Stack:** TypeScript (ESM, DOM), `@pragmatic-tech-ai/mural` (basic + framework + visual-engine) consumed as built `dist`, `@pragmatic-tech-ai/todl-runtime` (`Observable`), vite ^8 build, `node:test` + `tsx` unit tests, Playwright (gated) e2e.

**Spec:** `docs/superpowers/specs/2026-10-23-sp-hive-7-tenant-admin-app-design.md` (§8 pinned UX, §9 serving/auth topology).

## Global Constraints

- OOP: behavior on classes (methods/statics), no module-level free functions or mutable state; module-level `const`/`enum`/`type` declarations are fine. View-models extend `Observable` (not `MuralBase`).
- Allman braces (opening brace on its own line) for every block.
- No inline reused/user-facing string literals — hoist to `private static readonly` PascalCase constants (route strings, labels, event-type values, cookie-independent query keys). Single-use structural tokens may stay inline.
- PascalCase for interfaces and public methods; private members camelCase; DTO data-shape fields keep their wire casing (mirror the 7a JSON exactly).
- Enums over string-literal unions for fixed value sets.
- Mural is consumed as built `dist` (vite `resolve.conditions` WITHOUT `development`, `dedupe` of mural + todl-runtime) — exactly as `admin/portal/vite.config.ts` does. The only theme is Pragmatic (`PragmaticLight`).
- **Do NOT run `npm install` at the repo root** (it relinks sibling packages). The tenant-portal package is bootstrapped by copying `admin/portal/node_modules` (its `@pragmatic-tech-ai/*` symlinks are absolute paths valid at the same directory depth) — see Task 1. `npm --prefix admin/tenant-portal install` is a documented manual runbook step only, not something a task runs.
- Unit tests live in `admin/tenant-portal/tests/*.test.ts`, run with `npm --prefix admin/tenant-portal test` (`tsx --test tests/*.test.ts`). Typecheck with `npm --prefix admin/tenant-portal run typecheck` (`tsc --noEmit`), and the root `typecheck:tools` is extended to include the package. Commit after each task.
- The app talks ONLY to `/tenant-api/*` and `/tenant-auth/*` (same-origin `fetch`, `credentials:'same-origin'`; the `pts_session` cookie is HttpOnly). It never calls `/api/*`.
- Backend changes (Task 2 only) must leave the operator plane and the existing tenant backend behaviorally unchanged; the existing control-plane suite stays green.

## Review Focus

- **Serving the wrong bundle:** a request to the tenant static root for `/` or an unknown path must serve the TENANT bundle, and an operator-host request must still serve the operator bundle — the Host selects the root; a path-traversal attempt on either root is still refused (pinned in Task 2).
- **Auth-state confusion:** a 401 from `/tenant-auth/session` (or any `/tenant-api/*` call) must land the user on the login redirect, not a broken/blank app or a crash; a valid session must boot straight to the tree (pinned in Tasks 3, 4).
- **Cross-hive/version mistakes:** rolling a hive must target the selected hive and the selected version only; the confirm strip must name the real impact and a failed roll must surface the error and leave the displayed target unchanged (pinned in Task 6).
- **Stale live state:** an `environment-changed` event must refresh the affected environment's status/health without a full reload and without duplicating or leaking a websocket/subscription; a closed log stream must stop appending and release the socket (pinned in Tasks 5, 7).
- **Empty / degenerate data:** a hive with no published versions, a tenant with no hives, an environment that is stopped/failed, and a log stream that closes immediately must each render a defined state, not an exception (pinned in Tasks 5, 6, 7).

## Rulings (decisions the design/spec left open — settled here; see each task)

- **R1 — Shell approach:** build on the portal's proven **imperative `StackPanel` + mural `TreeView`/`Splitter`** composition, NOT the framework `ViewerShell`/`hierarchy/` route. The design doc mentions a "framework shell," but no app in the workspace consumes `ViewerShell`, the portal template does not, and `TreeView`+`Splitter` deliver layout A directly at far lower risk. *Cost if wrong: a later visual refactor to the heavier shell — cosmetic, not structural.*
- **R2 — Tenant id before login:** the SPA reads the tenant id from a `?tenant=<id>` query param on its own URL, persists it to `sessionStorage` across the IdP redirect, and uses it to build `GET /tenant-auth/oidc/begin?tenant=<id>`. If the param and stored value are both absent when login is needed, render a minimal "enter your tenant" prompt (a single field → begin). After login the session supplies the tenant id. Host→tenant mapping is a deferred Feature. *Cost if wrong: the login entry UX changes; the authenticated app is unaffected.*
- **R3 — Live health:** the backend emits only `environment-changed` (never `health-changed` in v1). The health strip therefore (re)fetches `/tenant-api/hives/:id/health` on boot and on every `environment-changed` event for an environment on that hive; no polling loop. A backend `health-changed` emitter is a deferred Feature. *Cost if wrong: health updates ride the lifecycle event rather than a dedicated one — still live, slightly coarser.*
- **R4 — Version badges:** v1 derives badges from what `/tenant-api` provides. `current` = the manifest whose `image` matches the hive rollout's running image / `targetVersion`; `available` = every other published manifest, newest-first by `publishedAt`; the manifest directly older than current is labeled `previous` (its "Set as target" reads "Roll back"). `withdrawn`/`obsolete` has no manifest-level API field, so v1 shows no withdrawn badge (a per-manifest withdrawn flag is a deferred Feature); per-environment `obsolete` from the rollout DTO is shown on the env rows. *Cost if wrong: a missing "withdrawn" affordance, additive later.*
- **R5 — Tenant static root:** the control-plane selects the static root by Host — operator host → `admin/portal/dist` (unchanged), tenant host → `admin/tenant-portal/dist`. `TenantPlane` gains a `staticRoot` and `ServeStatic` branches on it; both roots keep the path-traversal guard. *Cost if wrong: contained to Task 2's host branch.*
- **R6 — DTO types:** the tenant DTO shapes are declared client-side in `tenant-types.ts` (the portal's established pattern — it duplicates DTOs rather than importing server types), matching the 7a wire shapes verbatim.

---

### Task 1: Scaffold the `admin/tenant-portal/` package (boots an empty app)

**Files:**
- Create: `admin/tenant-portal/package.json`, `admin/tenant-portal/tsconfig.json`, `admin/tenant-portal/vite.config.ts`, `admin/tenant-portal/index.html`, `admin/tenant-portal/.gitignore`, `admin/tenant-portal/playwright.config.ts`
- Create: `admin/tenant-portal/src/main.ts`
- Modify: root `package.json` (`typecheck:tools` script), `admin/README.md` (runbook)
- Test: `admin/tenant-portal/tests/boot.test.ts`

**Interfaces:**
- Produces: `export class TenantPortalMain { public static Run(): void }` in `src/main.ts` — mirrors `admin/portal/src/main.ts` `PortalMain.Run()`: `Application.current = new Application()`, `app.initialize({ theme: Pragmatic, scheme: PragmaticLight })`, `ThemeManager.Density = Density.Compact`, `new HtmlTarget(root)`, `target.Content = new TenantApp()` (TenantApp lands in Task 4 — Task 1 uses a placeholder `StackPanel` with a title `TextBlock` so the app boots; replace in Task 4).

**Setup note (node_modules):** copy `admin/portal/node_modules` into `admin/tenant-portal/node_modules` (its `@pragmatic-tech-ai/mural` and `todl-runtime` entries are symlinks with absolute targets, valid here). Do NOT run `npm install`. Copy `admin/portal/package-lock.json` too (rename package name inside to `pragmatic-tenant-portal`).

- [ ] **Step 1:** Copy the six config/scaffold files from `admin/portal/` and adapt: `package.json` name `pragmatic-tenant-portal`, same scripts (`dev`/`build`/`typecheck`/`test`/`test:e2e`) and the same `file:../../../Mural` + `file:../../../todl-runtime` deps + devDeps; `index.html` title "Pragmatic Tenant Admin", `<div id="app">`, `<script type="module" src="/src/main.ts">`; `vite.config.ts` identical (`resolve.conditions` without `development`, `dedupe` mural+todl-runtime, `keepNames`); `tsconfig.json` identical (ES2022, Bundler, DOM, strict, `include: [src, tests, vite.config.ts, playwright.config.ts]`); `.gitignore` (`dist`, `test-results`, `playwright-report`, `node_modules`); `playwright.config.ts` (`testDir: tests`, `workers: 1`).
- [ ] **Step 2:** Bootstrap `node_modules` by copying from `admin/portal/node_modules` (see Setup note). Write `src/main.ts` `TenantPortalMain.Run()` with the placeholder root view.
- [ ] **Step 3: Write the failing boot test** `tests/boot.test.ts`: import `TenantPortalMain` and the placeholder root view class; assert `Run` is a function and the placeholder root view, when constructed, exposes the title text via the `Fixtures.Texts`-style walk (copy that helper from `admin/portal/tests/environment-detail-view.test.ts`). (A full DOM boot isn't unit-testable under node; assert the composition, as the portal tests do.)
- [ ] **Step 4:** Run `npm --prefix admin/tenant-portal test` → fails (module absent), then make it pass. Run `npm --prefix admin/tenant-portal run typecheck` and `npm --prefix admin/tenant-portal run build` (vite) → both clean.
- [ ] **Step 5:** Extend root `package.json` `typecheck:tools` with `&& tsc -p admin/tenant-portal/tsconfig.json --noEmit`; run `npm run typecheck:tools` from repo root → clean. Add the tenant-portal build line to `admin/README.md` next to the portal one.
- [ ] **Step 6: Commit** `feat(tenant-portal): scaffold the mural package (boots an empty themed app)`.

### Task 2: Serve the tenant bundle by Host (backend)

**Files:**
- Modify: `admin/control-plane/tenant-auth/tenant-plane.ts` (`TenantPlane` gains `staticRoot: string`), `admin/control-plane/control-plane-host.ts` (`ServeStatic` selects the root by Host), `admin/control-plane/server.ts` (compose the tenant `staticRoot` = `admin/tenant-portal/dist`)
- Test: `admin/control-plane/tests/control-plane-host-tenant.test.ts` (add static-serving cases)

**Interfaces:**
- Consumes: the existing `ControlPlaneHost.ServeStatic(req, res, path)` and `HostAllowed`/`tenantAuth.allowedHosts` (7a). `TenantPlane` from `tenant-plane.ts`.
- Produces: `TenantPlane.staticRoot: string`. `ServeStatic` resolves its base root per request: if `tenantAuth !== undefined` AND the request Host is in `tenantAuth.allowedHosts` (reuse the 7a host-membership check) → `tenantAuth.staticRoot`; else the operator `staticRootAbs`. The path-traversal guard and `/` → `/index.html` mapping apply to whichever root is chosen. Operator-host behavior is byte-identical.

- [ ] **Step 1: Write failing tests** in `control-plane-host-tenant.test.ts` (using the harness that builds a host WITH a `TenantPlane`; point `staticRoot` at a tmp dir holding a sentinel `index.html`, and the operator `staticRoot` at a different tmp dir with a different sentinel): a `GET /` from a configured tenant host serves the TENANT sentinel; a `GET /` from an operator (loopback) host serves the OPERATOR sentinel; a `../`-style traversal on the tenant host is still refused (same status/behavior as the operator guard); a request with no tenant plane configured serves the operator root exactly as before.
- [ ] **Step 2:** Run the file → the new cases fail.
- [ ] **Step 3:** Add `staticRoot` to `TenantPlane`; in `ServeStatic`, compute the base root by Host (resolve it once, early; keep the existing resolve/guard logic operating on the chosen root). In `server.ts`, set the tenant `staticRoot` to the absolute `admin/tenant-portal/dist` path alongside the existing `ComposeTenantPlane` wiring.
- [ ] **Step 4:** Run `npx tsx --test "admin/control-plane/tests/*.test.ts"` → all green (operator cases unchanged); `npm run build`; `npm run typecheck:tools`.
- [ ] **Step 5: Commit** `feat(control-plane): serve the tenant portal bundle on the tenant host`.

### Task 3: Tenant API client + types (fetch + websockets, with a socket seam)

**Files:**
- Create: `admin/tenant-portal/src/tenant-types.ts`, `admin/tenant-portal/src/tenant-api-client.ts`
- Test: `admin/tenant-portal/tests/tenant-api-client.test.ts`

**Interfaces:**
- Produces in `tenant-types.ts` (verbatim 7a wire shapes — R6):
  - `export type SessionDto = { tenantId: string; principalId: string; email?: string }`
  - `export type HiveDto = { id: string; tenantId: string; displayName: string; cluster: { backend: string; mode: string }; registry: { mode: string; endpoint?: string }; createdAt: string }`
  - `export type EnvironmentDto = { name: string; template: string; type: string; environmentId: string; hiveId?: string; tenantId?: string; hostPort: number; status: string; createdAt: string; httpUrl: string; wsUrl: string }`
  - `export type ManifestDto = { id: string; image: string; notes?: string; publishedAt: string }`
  - `export type RolloutEnvDto = { environmentName: string; runningImage: string | undefined; obsolete: boolean; ready: boolean }`
  - `export type HiveRolloutDto = { targetVersion: string | undefined; environments: RolloutEnvDto[] }`
  - `export type HiveHealthDto = { environmentName: string; ready: boolean; runningImage: string | undefined; detail: string }`
  - `export enum TenantEventType { EnvironmentChanged = 'environment-changed', HealthChanged = 'health-changed' }`
  - `export type TenantEvent = { type: TenantEventType; environmentName: string }`
  - `export enum VersionBadge { Current, Previous, Available }` (R4; no Withdrawn in v1)
  - `export interface ITenantNavigator { ShowLogin(): void; ShowTree(): void; ShowHiveDetail(hive: HiveDto): void; ShowEnvironmentDetail(env: EnvironmentDto): void }` and `export interface ITenantView { AttachNavigator(nav: ITenantNavigator): void; Refresh(): Promise<void> | void; Dispose?(): void }` — model on `admin/portal/src/portal-types.ts`. `Dispose?()` is the optional teardown hook the detail pane calls when it swaps a view out (Task 7's environment view implements it to stop its log stream; other views leave it unimplemented). The tree calls `ShowHiveDetail`/`ShowEnvironmentDetail` on selection (Task 5); `TenantApp` implements all four (Task 4).
  - `export interface IWebSocketFactory { Open(url: string): IWebSocketLike }` and `export interface IWebSocketLike { OnMessage(cb: (data: string) => void): void; OnClose(cb: () => void): void; Close(): void }` — the injectable socket seam (real interfaces, default impl wraps `globalThis.WebSocket`).
- Produces in `tenant-api-client.ts`:
  - `export class TenantApiError extends Error { public readonly Status: number; public static readonly UnauthorizedStatus = 401 }`
  - `export class BrowserWebSocket implements IWebSocketLike` + `export class BrowserWebSocketFactory implements IWebSocketFactory` (real classes wrapping `globalThis.WebSocket`; no lambda bag).
  - `export class TenantApiClient` ctor `(sockets?: IWebSocketFactory)` (default `new BrowserWebSocketFactory()`). Methods (all routes hoisted to `private static readonly` constants):
    - `public async Session(): Promise<SessionDto | null>` — `GET /tenant-auth/session`; 401 → null.
    - `public BeginLogin(tenantId: string): void` — `location.href = '/tenant-auth/oidc/begin?tenant=' + encodeURIComponent(tenantId)` (behind a tiny seam method so tests can assert the URL without navigating — see the test).
    - `public async Logout(): Promise<void>` — `POST /tenant-auth/logout`.
    - `public async ListHives(): Promise<HiveDto[]>`, `ListEnvironments(): Promise<EnvironmentDto[]>`, `ListManifests(): Promise<ManifestDto[]>`.
    - `public async GetRollout(hiveId: string): Promise<HiveRolloutDto>`, `GetHealth(hiveId: string): Promise<HiveHealthDto[]>`.
    - `public async SelectTarget(hiveId: string, version: string): Promise<void>` — `POST /tenant-api/hives/:id/target` body `{version}`; a 409 maps to a `TenantApiError` whose message is the server's generic body.
    - `public async StartEnvironment(name)`, `StopEnvironment(name)`, `RestartEnvironment(name): Promise<EnvironmentDto>`.
    - `public OnEvent(handler: (ev: TenantEvent) => void): () => void` — lazily opens `/tenant-api/events` via the socket factory (ws/wss by `location.protocol`, `location.host`), parses JSON frames to `TenantEvent`, fans out; reconnects after `ReconnectDelayMs = 2000` on close (mirror the portal's `OnChanged`); returns an unsubscribe.
    - `public OpenLogStream(name: string, onChunk: (text: string) => void): () => void` — opens `/tenant-api/environments/:name/logs/stream`, forwards raw text frames to `onChunk`, returns a dispose that closes the socket.
  - Private `Send<T>(route, init)` exactly like the portal: `fetch(route, { credentials: 'same-origin', ... })`, JSON parse, non-OK → `TenantApiError(status, payload.error ?? default)`.

- [ ] **Step 1: Write failing tests** (`tenant-api-client.test.ts`) — copy the portal's `FetchStub` (swaps `globalThis.fetch`, records `{route, init}`) and add a `FakeWebSocketFactory`/`FakeWebSocket` implementing the seam (records opened URLs, lets the test push a message / fire close). Cases: `Session` returns the DTO on 200 and null on 401; `ListHives`/`ListManifests`/`GetRollout`/`GetHealth` hit the right route and parse; `SelectTarget` sends `POST …/<hive>/target` with body `{version}` and maps a 409 to a `TenantApiError`; `StartEnvironment` posts to `…/<name>/start` and returns the DTO; `BeginLogin` composes `/tenant-auth/oidc/begin?tenant=<encoded>`; `OnEvent` delivers a pushed frame as a parsed `TenantEvent` and its unsubscribe stops delivery; `OpenLogStream` forwards a raw chunk and its dispose closes the fake socket.
- [ ] **Step 2:** Run `npm --prefix admin/tenant-portal test` → fail.
- [ ] **Step 3:** Implement `tenant-types.ts` then `tenant-api-client.ts` per the Interfaces block.
- [ ] **Step 4:** Run the test, `npm --prefix admin/tenant-portal run typecheck`, and `npm run typecheck:tools` (root) → all green.
- [ ] **Step 5: Commit** `feat(tenant-portal): tenant API client + types (fetch + event/log sockets)`.

### Task 4: App shell — boot, auth gate, top bar, tree+detail frame

**Files:**
- Create: `admin/tenant-portal/src/tenant-app.ts`, `admin/tenant-portal/src/tenant-view-base.ts`
- Modify: `admin/tenant-portal/src/main.ts` (use `TenantApp`)
- Test: `admin/tenant-portal/tests/tenant-app.test.ts`

**Interfaces:**
- Consumes: `TenantApiClient`, `TenantApiError`, `ITenantNavigator`, `ITenantView`, `SessionDto` (Task 3).
- Produces:
  - `export class TenantViewBase extends StackPanel implements ITenantView` — mirror `admin/portal/src/portal-view-base.ts`: `MakeButton(label, onClick)`, `ShowError(e)` where a `TenantApiError` with `Status === 401` calls `nav.ShowLogin()`, `Run(action)` (run → on error `ShowError` → `Refresh`), shared label constants. Abstract `Refresh()`.
  - `export class TenantApp extends StackPanel implements ITenantNavigator` — ctor builds `client = new TenantApiClient()`, a top bar (`StackPanel`: Pragmatic logo/title text, the tenant display name once known, a Logout button → `client.Logout()` then `ShowLogin()`), and a body `Splitter`/two-pane frame: left = the tree host, right = the detail host. `public async Boot(): Promise<void>` calls `client.Session()`; non-null → store the tenant id, open the event subscription (`client.OnEvent`), and `ShowTree()`; null (or a thrown `TenantApiError`) → `ShowLogin()`. `ShowTree()` mounts the tree (Task 5) and leaves the detail pane on an empty-selection placeholder. `ShowLogin()` resolves the tenant id (R2: `?tenant=` query param → `sessionStorage` → else the minimal tenant-id prompt) and calls `client.BeginLogin(tenantId)` (or renders the prompt that collects it first). `Show(view)` sets the detail pane content (clear, `AttachNavigator`, add, `Refresh`), mirroring the portal's `Show`. Expose a seam for reading the `?tenant=` param + `sessionStorage` (inject in tests).

- [ ] **Step 1: Write failing tests** (`tenant-app.test.ts`) with a `FakeClient` (records calls; `Session` returns a DTO or null; `OnEvent` returns a no-op unsubscribe) and an injected location/storage seam: `Boot` with a session → mounts the tree host and subscribes to events (assert `OnEvent` called once); `Boot` with `Session()` → null → calls login with the `?tenant=` value; `Boot` where `Session` throws a 401 `TenantApiError` → login; the top bar shows the tenant name after a session; Logout calls `client.Logout()` then returns to login. Use the `Fixtures.Texts` walk to assert top-bar text.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement `TenantViewBase` then `TenantApp`; wire `main.ts` to `new TenantApp()` and call `Boot()`.
- [ ] **Step 4:** Test, typecheck, `npm --prefix admin/tenant-portal run build` → green.
- [ ] **Step 5: Commit** `feat(tenant-portal): app shell with auth-gated boot, top bar, tree+detail frame`.

### Task 5: Hive→environment tree (VM + view, live-updating)

**Files:**
- Create: `admin/tenant-portal/src/tenant-tree-view-model.ts`, `admin/tenant-portal/src/tenant-tree-view.ts`
- Test: `admin/tenant-portal/tests/tenant-tree-view-model.test.ts`

**Interfaces:**
- Consumes: `TenantApiClient` (a slice: `ListHives()`, `ListEnvironments()`), `HiveDto`, `EnvironmentDto`, `TenantEvent`. Uses mural `TreeView`/`TreeViewItem` (from `@pragmatic-tech-ai/mural/framework`).
- Produces:
  - `export interface ITreeSource { ListHives(): Promise<HiveDto[]>; ListEnvironments(): Promise<EnvironmentDto[]> }`.
  - `export class TenantTreeViewModel extends Observable` ctor `(source: ITreeSource)`. `public async Load(): Promise<void>` loads hives + environments and builds a `Nodes` structure: one `HiveNode { hive: HiveDto; environments: EnvironmentDto[] }` per hive, environments grouped by `env.hiveId === hive.id` (ignore environments whose `hiveId` is unset or names an unknown hive). Exposes `Nodes: readonly HiveNode[]` (raise change on load). `public ApplyEvent(ev: TenantEvent): void` — on `environment-changed`, mark the matching environment node stale / re-pull just that environment's status (keep it simple: re-run `Load` or update the one env's fields; raise change). `public Selected` get/set (a `{ kind: 'hive'|'environment'; id|name }` discriminated value) with change notification.
  - `export class TenantTreeView extends StackPanel implements ITenantView` — builds a `TreeView`: root label "My Hives" (constant), a `TreeViewItem` per hive (displayName), child items per environment (name + a status dot). Selecting an item sets the VM `Selected` and calls `nav` to show the hive- or environment-detail view in the detail pane. `Refresh()` → `vm.Load()` then rebuild items. Empty state: no hives → a "No hives yet" text node (constant).

- [ ] **Step 1: Write failing tests** (`tenant-tree-view-model.test.ts`) with a `FakeTreeSource` seeded with two hives and environments (some bound to each hive, one with an unset `hiveId`): `Load` groups environments under the right hive and drops the unbound one; the empty case (no hives) yields empty `Nodes`; `ApplyEvent({environment-changed, <envName>})` refreshes that environment (assert via the source being re-queried or the node's updated status); `Selected` raises change.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement the VM then the view.
- [ ] **Step 4:** Test, typecheck, build → green.
- [ ] **Step 5: Commit** `feat(tenant-portal): hive→environment tree with live refresh`.

### Task 6: Hive detail — version list + confirm strip (VM + view)

**Files:**
- Create: `admin/tenant-portal/src/hive-detail-view-model.ts`, `admin/tenant-portal/src/hive-detail-view.ts`
- Test: `admin/tenant-portal/tests/hive-detail-view-model.test.ts`

**Interfaces:**
- Consumes: `TenantApiClient` (slice: `ListManifests()`, `GetRollout(hiveId)`, `GetHealth(hiveId)`, `SelectTarget(hiveId, version)`), `ManifestDto`, `HiveRolloutDto`, `HiveHealthDto`, `VersionBadge`, `TenantEvent`.
- Produces:
  - `export interface IHiveDetailSource { ListManifests(): Promise<ManifestDto[]>; GetRollout(hiveId: string): Promise<HiveRolloutDto>; GetHealth(hiveId: string): Promise<HiveHealthDto[]>; SelectTarget(hiveId: string, version: string): Promise<void> }`.
  - `export class HiveDetailViewModel extends Observable` ctor `(source: IHiveDetailSource, hive: HiveDto)`. `public async Load()` fetches manifests + rollout + health; computes `Versions: readonly VersionRow[]` where `VersionRow = { manifest: ManifestDto; badge: VersionBadge; isTarget: boolean }` sorted newest-first by `publishedAt`, badge per R4 (current = manifest.image === rollout.targetVersion-or-running image; the one directly older than current → `Previous`; else `Available`). Exposes `RunningImage`, `Health: HiveHealthDto[]`, and an empty flag when no manifests. `public BeginTarget(version)` sets a `Pending { version, impact }` where `impact` is the list of environment names from the rollout that will restart (constant-formatted message). `public async ConfirmTarget()` calls `SelectTarget(hive.id, pending.version)`; on success clears `Pending` and reloads; on error sets `FailedRoll { message, stayedOn }` (stayedOn = the current running version) and clears `Pending` WITHOUT changing the displayed target. `public CancelTarget()`. `public ApplyEvent(ev)` → reload health/rollout on an `environment-changed` for one of this hive's environments (R3).
  - `export class HiveDetailView extends TenantViewBase` — header (hive name, running version, a live health dot), a version list (each row: version pill + badge label + a "Set as target"/"Roll back" button that calls `BeginTarget`), the inline confirm strip (impact text + Confirm → `ConfirmTarget`, Cancel → `CancelTarget`), the failed-roll inline error, and the empty state ("No versions published yet", constant). `Refresh()` → `vm.Load()` + render.

- [ ] **Step 1: Write failing tests** (`hive-detail-view-model.test.ts`) with a `FakeHiveDetailSource` seeded with manifests (3, varying `publishedAt`), a rollout (targetVersion + two environments), and health: `Load` sorts newest-first and badges current/previous/available per R4; the empty-manifests case sets the empty flag; `BeginTarget` sets `Pending` with an impact naming the rollout's environments; `ConfirmTarget` success calls `SelectTarget(hive.id, version)` and reloads; `ConfirmTarget` where `SelectTarget` rejects (e.g. a 409 `TenantApiError`) sets `FailedRoll` with `stayedOn` = current and does NOT change the shown target; `CancelTarget` clears `Pending`; `ApplyEvent` for one of the hive's environments reloads health.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement the VM then the view.
- [ ] **Step 4:** Test, typecheck, build → green.
- [ ] **Step 5: Commit** `feat(tenant-portal): hive detail with inline version list + confirm strip`.

### Task 7: Environment detail — lifecycle + live health + live logs (VM + view)

**Files:**
- Create: `admin/tenant-portal/src/environment-detail-view-model.ts`, `admin/tenant-portal/src/environment-detail-view.ts`
- Test: `admin/tenant-portal/tests/environment-detail-view-model.test.ts`

**Interfaces:**
- Consumes: `TenantApiClient` (slice: `StartEnvironment(name)`, `StopEnvironment(name)`, `RestartEnvironment(name)`, `GetHealth(hiveId)`, `OpenLogStream(name, onChunk)`), `EnvironmentDto`, `HiveHealthDto`, `TenantEvent`.
- Produces:
  - `export interface IEnvDetailSource { StartEnvironment(name: string): Promise<EnvironmentDto>; StopEnvironment(name: string): Promise<EnvironmentDto>; RestartEnvironment(name: string): Promise<EnvironmentDto>; GetHealth(hiveId: string): Promise<HiveHealthDto[]>; OpenLogStream(name: string, onChunk: (t: string) => void): () => void }`.
  - `export class EnvironmentDetailViewModel extends Observable` ctor `(source: IEnvDetailSource, env: EnvironmentDto, hiveId: string | undefined)`. Exposes `Status`, `RunningVersion`, `Type`, and a `Health: HiveHealthDto | undefined` (the entry for this env). `public async Start()/Stop()/Restart()` call the source and update `Status` from the returned DTO (raise change). `public async LoadHealth()` (if `hiveId` known) pulls the hive health and picks this env's row. `public StartLogs(): void` opens the log stream, appending chunks to a `LogBuffer` (bounded — keep last `MaxLogChars`, a constant) unless `Paused`; `public TogglePause()`; `public StopLogs()` disposes the stream (stops appending AND closes the socket). `public ApplyEvent(ev)` → if it names this env, refresh status + health (R3).
  - `export class EnvironmentDetailView extends TenantViewBase` — header (name, status dot, running version, type) + Start/Stop/Restart buttons (inline confirm on Stop, like the portal's env view), a live Health strip (status/uptime/last-check from the health DTO — show what the DTO provides), a logs panel (a `ScrollViewer` with the buffer) + a Pause toggle. `Refresh()` loads health and (re)starts the log stream; leaving the view (new selection) must `StopLogs()` — wire the nav/`Show` so the previous detail view is disposed (add a `Dispose()`/teardown hook on `ITenantView` and call it in `TenantApp.Show`). Stopped/failed env → the logs panel shows a defined placeholder, not an error.

- [ ] **Step 1: Write failing tests** (`environment-detail-view-model.test.ts`) with a `FakeEnvDetailSource`: `Start/Stop/Restart` call the source and update `Status` from the returned DTO; `LoadHealth` picks this env's health row; `StartLogs` appends streamed chunks to the buffer and `TogglePause` stops appending while the stream stays open; `StopLogs` disposes the stream (assert the fake's dispose ran and further chunks are ignored); the buffer is bounded to `MaxLogChars`; `ApplyEvent` naming this env refreshes status/health; `ApplyEvent` naming another env is ignored.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement the VM then the view. Wire `TenantApp.Show` to call the outgoing view's `Dispose?.()` before mounting the next (so switching selection stops the old log stream); `EnvironmentDetailView.Dispose()` calls `vm.StopLogs()`. Tree/hive views need no `Dispose`.
- [ ] **Step 4:** Test, typecheck, build → green.
- [ ] **Step 5: Commit** `feat(tenant-portal): environment detail with lifecycle, live health, live logs`.

### Task 8: Gated end-to-end (fake backend) + runbook

**Files:**
- Create: `admin/tenant-portal/tests/tenant-portal.spec.ts` (Playwright, gated), `admin/tenant-portal/tests/fake-tenant-control-plane.ts`
- Modify: `admin/README.md` (tenant-portal run + e2e runbook), `docs/superpowers/plans/2026-10-23-sp-hive-7b-tenant-portal.md` (mark the deferred real-login e2e)

**Interfaces:**
- Consumes: the built `dist/` (vite build) + a `FakeTenantControlPlane` (a `node:http` server serving `dist/` + canned `/tenant-auth/session`, `/tenant-api/*` JSON, and a `/tenant-api/events` + logs websocket) — model on `admin/portal/tests/portal.spec.ts`'s `FakeControlPlane`.
- Produces: a gated Playwright spec (needs `npm --prefix admin/tenant-portal run build` + Playwright browsers; same gating convention as the portal e2e — it is not part of the default unit run) that drives: a session-present boot → the tree renders hives/envs; selecting a hive → the version list renders and a "Set as target" → confirm → the target POST fires; selecting an environment → Start fires and the logs panel receives a streamed chunk. Assert against the fake's recorded requests.

- [x] **Step 1:** Write `FakeTenantControlPlane` + the spec (it builds first, then serves `dist/`). Gate it exactly as the portal's `portal.spec.ts` is gated.
- [x] **Step 2:** Run `npm --prefix admin/tenant-portal run build`, then the e2e locally if Playwright browsers are present; if not present, leave it as the documented gated step (do NOT block the task on browser availability — the unit suites are the gate).
- [x] **Step 3:** Update `admin/README.md`: build (`npm --prefix admin/tenant-portal install && npm --prefix admin/tenant-portal run build`), the env vars to serve it (`PRAGMATIC_TENANT_ADMIN_HOSTS`, `PRAGMATIC_TENANT_ADMIN_CALLBACK_URL`), and the gated e2e command. Note in this plan that the **real-login e2e** (against a live 6c IdP + relying-party) is a separate gated Feature.
- [x] **Step 4:** `npm --prefix admin/tenant-portal test` (unit) + `npm run typecheck:tools` (root) green; the e2e either green locally or left gated.
- [x] **Step 5: Commit** `test(tenant-portal): gated end-to-end against a fake control-plane + runbook`.

**Done:** fake-backend e2e passes locally (3 tests). The real-login e2e (live 6c IdP + relying-party) remains a separate deferred Feature.

---

## Final verification (before whole-branch review)
- `npm --prefix admin/tenant-portal test` green; `npm --prefix admin/tenant-portal run build` clean; `npm --prefix admin/tenant-portal run typecheck` clean; root `npm run typecheck:tools` green (includes the new package); the existing `admin/control-plane` suite green (Task 2's backend change is behavior-neutral for operators).
- Whole-branch review on the most capable model, Review-Focus re-checked: wrong-bundle serving (Task 2), auth-state (Tasks 3/4), cross-hive/version roll (Task 6), stale live state / socket leak (Tasks 5/7), empty/degenerate data (Tasks 5/6/7).
- The real-login browser e2e (real per-tenant IdP + relying-party + a real roll) is a gated Feature, not run here.

## Out of scope (file as Features on completion)
- Host→tenant mapping for login (v1 uses `?tenant=` / a prompt — R2).
- A backend `health-changed` emitter + a per-manifest `withdrawn` flag (v1 derives health from `environment-changed` and shows no withdrawn badge — R3, R4).
- The real-login e2e against a live 6c IdP.
- Any operator-portal/tenant-portal shared-component extraction (v1 copies from the portal; a shared mural admin-kit is a later refactor).
