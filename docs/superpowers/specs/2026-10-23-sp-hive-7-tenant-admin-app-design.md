# SP-HIVE-7 — Tenant Admin App (DESIGN / DECISIONS)

**Status: AWAITING USER DECISIONS — NOT approved for build.** Written during the 2026-10-23 AFK run. SP-HIVE-7 is a UI product whose information architecture and interaction design are genuinely the user's to specify; this doc lays out what is buildable-from-template, the open backend seams, and the UX decisions that need the user (ideally with mockups — the brainstorming visual companion is apt here). The user decides, then this becomes a build spec → plan → SDD.

**Parent design:** `docs/superpowers/specs/2026-10-22-platform-administration-hives-design.md` line 114 — "a new first-class root application built on mural, like Plexus: the mural app shell (Pragmatic theme, Observable VMs, html-bundle build), identity wiring to a configured provider, tenant-scoped navigation over the tenant's hives/environments; SP-HIVE-4's self-service version catalog is its first feature."

**Depends on:** SP-HIVE-6c (a reachable tenant IdP to log into — SP-HIVE-7's login is a client of the SP-HIVE-6 realm). SP-HIVE-4's backend (version catalog) is already built and tested.

## 1. Intent

The platform's existing `admin/portal` is the **operator/platform-admin** app (loopback, operator password, cross-tenant). SP-HIVE-7 is the **tenant-admin** app: a tenant's own administrator logs in against their tenant identity realm (SP-HIVE-6) and self-services their slice — their hives, their environments, and which published version each hive runs. It **complements** the portal (different auth plane, tenant-scoped data), and is scaffolded by copying the portal's mural+vite skeleton, not by extending it.

## 2. What is buildable from existing templates/backends (the ~2/3 that is not open)

- **Mural root-app skeleton** — a near-direct copy of `admin/portal`: `main.ts` bootstrap (`app.initialize({ theme: Pragmatic, scheme: PragmaticLight })`, `ThemeManager.Density`, `HtmlTarget(#app).Content = new App()`), the vite "html-bundle" build (`vite build → dist/`, mural `dedupe`, single-mural `overrides` pin), the `*-view.ts`/`*-view-model.ts`/`api-client.ts`/`portal-view-base.ts` structure, and the mural framework shell + `hierarchy/` navigation primitives.
- **Backends already exist and are tested** (control-plane routes): version catalog — `GET /api/tenants/:id/manifests`, `POST /api/hives/:id/target` (select/roll; re-select prior = rollback), `GET /api/hives/:id/rollout` (status + obsoletion); tenant-scoped navigation — `GET /api/hives`, `GET /api/environments`, `GET /api/hives/:id/health`, `/api/events` websocket for live updates.

## 3. Open engineering seams (need a decision, then buildable)

- **S1 — Client-side OIDC redirect login (net-new).** No browser app logs in via OIDC today; `admin/portal` uses an operator password. SP-HIVE-7 must redirect the browser to the tenant IdP's `/authorize` (SP-HIVE-6 serves its own plain-HTML login) and ride the runtime host's `/auth/oidc/begin`→`/auth/oidc/callback`→`/auth/session` (cookie) flow (`src/host/auth-http-endpoint.ts`, `browser-session-auth.ts`). This depends on SP-HIVE-6c making the IdP reachable. The server-side relying party (`OidcAuthenticator`, PKCE) already exists; the browser-side redirect/session handling is the new work.
- **S2 — Tenant-scoped authorization.** The control-plane routes are operator-session-gated and cross-tenant (today the portal filters by tenant client-side). A tenant-admin plane needs either tenant-scoped authz added to those routes (a tenant principal may act only on its own hives/environments/manifests) or a separate tenant-facing façade. **Decide:** extend the existing routes with tenant scoping vs. a new tenant API surface.

## 4. Decisions the user must make (the product design — bring mockups)

- **D1 — Information architecture & navigation.** What does a tenant admin see and in what shape? A tenant-scoped tree (my Hives → their Environments) + a Versions view? A dashboard-first layout? This is the core product decision and is not pinned by any spec. *(Visual companion / mockups strongly recommended.)*
- **D2 — Self-service version-selection interaction.** How does the admin pick a version for a hive: list gated manifests (`/api/tenants/:id/manifests`), show the current per-hive target + obsoletion/health (`/api/hives/:id/rollout`, `/health`), select/roll (`POST /api/hives/:id/target`), rollback = re-select the prior. What confirmation, guardrails, and health/obsoletion surfacing? This is SP-HIVE-7's headline feature and its interaction is the user's to shape.
- **D3 — Shell & VM conventions.** Reuse the mural framework shell (`editor-shell`/`viewer-shell`) + `hierarchy/` nav, or the portal's lighter `App extends StackPanel` pattern? View-models: formalize as `Observable` subclasses (per the standing workspace rule — VMs extend Observable) rather than the portal's hand-rolled plain classes. Window chrome: reuse the shared Plexus/mural window-chrome module, or browser-plain?
- **D4 — Scope of the first release.** Parent design says the SP-HIVE-4 self-service version catalog is the first feature. Is v1 just login + tenant nav + version selection, or also environment start/stop/logs/health? Pin the v1 cut.
- **D5 — Where it is served / its origin.** Served by the control-plane as another static root (like the portal) at a tenant-facing origin, or a separate deployment? This interacts with S1 (the OIDC redirect/callback origin) and SP-HIVE-6c's topology.

## 5. Non-goals
- Not a replacement for `admin/portal` (platform-admin stays separate, operator-gated, cross-tenant).
- Not the platform-admin cross-tenant operations (gating versions, creating tenants/hives) — those stay operator-only.
- No new backend capability beyond S2's tenant-scoping (the catalog + nav backends exist).

## 6. Proof (once built)
- A gated/e2e: a tenant admin logs in against their SP-HIVE-6 realm, sees only their tenant's hives/environments, selects a gated version for a hive, and the rollout reflects it (driving the existing `/api/hives/:id/target` + `/rollout`).

## 7. What to decide first
D1 (information architecture) and D2 (version-selection interaction) are the product core — best done against mockups (offer the brainstorming visual companion). S1/S2 are the two backend seams to settle in parallel; both are modest once decided. D3–D5 have sensible defaults (reuse the mural framework shell + Observable VMs + control-plane-served static root) that the user can confirm. This sub-project is the right one to brainstorm interactively with the user present — it is where unattended building would most risk the wrong product.

---

## DECISIONS RESOLVED (2026-10-23, with the user)

- **S1 (client login) = determined by 6c** — browser redirect to the tenant's own per-tenant IdP `/authorize`, riding the runtime host's `/auth/oidc/begin`→`/auth/oidc/callback`→`/auth/session` cookie flow. Depends on SP-HIVE-6c (reachable per-tenant IdP).
- **S2 = Separate tenant façade.** A distinct tenant-facing API surface (e.g. `/tenant-api/…`) that only ever exposes the caller's own tenant's hives/environments/manifests; the operator `/api` routes stay untouched.
- **D1/D2 (information architecture + version-selection interaction) = PINNED via a mockup session (2026-10-23, user present).** See §8 below for the agreed UX; mockups saved under `.superpowers/brainstorm/9086-1792757898/content/` (`d1-information-architecture.html`, `d2-version-selection.html`, `d4-environment-detail.html`).
- **D3 = Mural framework shell (editor/viewer-shell + hierarchy nav) + Observable view-models** (per the standing workspace VM rule).
- **D4 = v1 scope includes environment lifecycle:** OIDC login to the tenant realm, tenant-scoped nav over hives/environments, the SP-HIVE-4 self-service version catalog (list gated versions, per-hive target + health, select/roll, rollback), AND environment start/stop/logs/live-health.
- **D5 (served origin) = default (confirm):** served by the control-plane as a tenant-facing static root (like `admin/portal`), at a tenant origin consistent with the S1 OIDC callback and 6c topology.

**Status:** all decisions resolved, including the D1/D2 UX (pinned via the 2026-10-23 mockup session — see §8). SP-HIVE-6c (per-tenant IdP + federation) is now BUILT and merged, so the login dependency is satisfied. Pending final user approval of §8, then → plan (superpowers:writing-plans) → SDD.

---

## 8. v1 UX — pinned via the mockup session (2026-10-23, user present)

The app is a mural root app (framework shell: editor/viewer-shell + `hierarchy/` nav; Observable view-models; Pragmatic theme; html-bundle/vite build), served by the control-plane as a tenant-facing static root (D5), talking only to the tenant façade `/tenant-api/…` (S2).

- **D1 — Information architecture = Layout A (tenant-scoped tree + detail).** A top bar (Pragmatic logo · tenant name · user menu with logout). A left navigation tree rooted at **My Hives**, each hive expandable to **its environments**. Selecting a node fills a single **detail pane**: a hive → its version management (D2); an environment → its lifecycle detail (below). This is the mural hierarchy shell's natural shape and scales as hives/environments grow. *Builder's call (minor): no separate top-level "Versions" browse node in v1 — version selection is always reached through its hive; a read-only catalog browse can be a later addition.*

- **D2 — Version selection = inline list + confirm strip**, in the hive detail pane. The pane header shows the hive's **currently running version** + a **live health** indicator. Below, a list of the tenant's **published versions** (`GET /tenant-api/.../manifests`, newest→oldest), each badged by state derived from the hive's rollout (`/rollout`): **current** (running), **previous** (selecting it = rollback), **available**, or **withdrawn/obsolete** (struck-through, disabled). A selectable version's **Set as target** opens an **inline confirm strip** that names the impact ("restarts prod-env & staging-env") → Confirm issues `POST /tenant-api/hives/:id/target`; **rollback is just selecting the previous version** (same endpoint). Rollout-in-progress and obsoletion are surfaced inline from `/rollout`; health from `/health`. *Builder's calls (minor): surface a failed roll inline on the same strip (error + the version it stayed on); empty state when no versions are published yet.*

- **Environment detail (D4 lifecycle) = approved default.** Selecting an environment fills the detail pane with: a **header** (env name · status dot · running version · env type) and **Start / Stop / Restart** actions; a **live Health strip** (status, uptime, last-check) updated via the `/api/events` websocket so it changes without a reload; and a **live-tailing Logs panel** with a Pause control. Same detail-pane frame as the hive view for a consistent tree experience.

- **Login (S1)** is not a screen this app designs: it redirects to the tenant's own IdP login page (SP-HIVE-6), riding `/auth/oidc/begin → callback → session`, then lands back in the app.
