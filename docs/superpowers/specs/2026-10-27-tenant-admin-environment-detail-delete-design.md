# Tenant Admin: Environment detail redesign + Delete — Design

Date: 2026-10-27. Spec TA-5 of the tenant-admin reconciliation program (`docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md`, §1.3 and §3). Precedence, as the note records: the separation spec (2026-10-25) over the brief, the brief over the prototype on vocabulary, the prototype (`dev-kit/design/admin-apps/src/tenant.jsx` `EnvDetail`, :144) the truth for behaviour, copy and states — **but the prototype is a design fiction over a demo data model, and this spec re-implements its layout and behaviour against the REAL server contract, never inventing a backend.** This is the governing principle carried from TA-4.

## Intent and why

The built environment detail (`environment-detail-view.ts` / `-view-model.ts`) is a flat stack: name, a status dot, running version, type, four lifecycle buttons (Start / Stop-with-inline-confirm / Restart), one health line, and a live log tail with Pause/Resume. It works but it does not wear the design's information architecture, and it has **no way to delete an environment** — the one lifecycle operation the tenant admin cannot perform from the portal today, even though `EnvironmentService.Delete` has existed server-side since the hive work.

TA-5 redesigns the detail into the prototype's shape — a **header** (name, status + health pills, identity sub-line, copyable live URL) over **three tabs** (Application & version / Health & activity / Access) — and adds **Delete** with a name-to-confirm dialog over a **new `DELETE /tenant-api/environments/:name` route**. Logs move from an always-open panel into a collapsible region inside the Health & activity tab ("the drawer"). Everything the tabs show is derived from data the server already returns; everything the prototype shows that the server cannot yet back is deferred as a filed Feature, not faked.

Why now: TA-4 just replaced the hive tree with the Environments list, whose rows open this detail (`ITenantNavigator.ShowEnvironmentDetail`). The detail is the list's destination, so it is the next screen to bring up to the design. Delete is the list's missing bulk-exception ("Deleting is one environment at a time" — prototype `Environments`, :100), so it belongs here, at the single-environment surface.

## Goals

- **Header.** Environment name; a **status pill** (Running / Stopped / Failed / Unknown) and a **health pill** (ready / not ready / unavailable) using the existing `StatusPill` kit component and `PillKinds`; an identity sub-line (application/template, type, environment id); and the **live URL** rendered as copyable text with the same honesty as TA-4 (shown only when Running; `httpUrl` is the real host-port URL the server returns).
- **Tabs.** A reusable **`Tabs` kit primitive** (tab strip + single active content region), consumed first here and reusable by later screens (Users & Access, Settings). Three tabs:
  - **Application & version** — a `KeyValueGrid` of what the server actually knows: running version (derived from `runningImage`, the substring after the last `:`, as TA-4's row projection does), type, template, environment id, created-at. No image-signature/bundle/adoption KV (GAP, deferred).
  - **Health & activity** — the current health row (ready/not-ready + detail) and a **collapsible logs region** ("View logs" / "Hide logs") holding the existing live, pausable, bounded log tail. No 24 h history, event feed, pod counts, or active-user counts (GAP, deferred).
  - **Access** — the address (live URL / `httpUrl`) as a `KeyValueGrid`, copyable. No OIDC-client credential table or Rotate (GAP, deferred).
- **Lifecycle actions** in the header: Start / Stop / Restart (preserved behaviour, moved into the new chrome) **and Delete**.
- **Delete.** A header action that opens the kit `ConfirmDialog` in Danger tone with **name-to-confirm** (type the environment name) and a **consequences list** drawn from real effects: the live URL stops serving; the environment's data and files are removed; this cannot be undone. On confirm, call the new client `DeleteEnvironment(name)`; the server's `EnvironmentDeleted` event (already wired in `tenant-app.ts`) navigates the pane back to the Environments list.
- **Server.** `DELETE /tenant-api/environments/:name`: ownership-guarded exactly like the lifecycle action route (404 — never 403 — when the environment is unknown or owned by another tenant, so `Delete` is never reached and existence is never revealed), then `EnvironmentService.Delete(name)`, then `204 No Content`.
- **Client.** `DeleteEnvironment(name): Promise<void>` → `DELETE` on the environment route.
- **State honesty.** A **danger Banner when `status === Failed`** ("This environment failed to start") and a plain note when `status === Unknown` ("Status could not be determined"). This is the real, buildable remainder of the prototype's provisioning/status banner.
- **Tests.** VM and view unit tests extend the existing suites; server route tests extend the tenant-api endpoint suite (owned, unknown, cross-tenant → 204 / 404 / 404); client test for the new method.

## Non-goals (filed as Features, not built here)

Each of these is a §3 backend GAP in the reconciliation note. The tab frame leaves a labelled home for each, so adding it later is additive.

- **Deploy / Redeploy UI bundle** (Application & version). `ui-deploy-actuator.ts` + `EnvironmentService.DeployAppToEnvironment` exist platform-side, but a tenant-facing deploy needs a bundle upload/format flow — that is its own screen and spec (it overlaps the in-cluster UI-serving program), not part of a detail redesign.
- **Per-environment version offer + "Review and adopt" + fail-closed verification Banner with support reference** (Application & version). Belongs to TA-6 (Releases + Adopt wizard); the rollout/health DTOs carry `ready`/`obsolete`/`runningImage` only — no signature status, no support reference.
- **24 h health history, event feed, pod counts, active users** (Health & activity). Needs server-side health-sample persistence and an event log; health today is current-state only and the events socket carries no history.
- **OIDC client credential by reference + Rotate** (Access). Needs a credential-reference listing and rotate op with real OIDC semantics; `maker-token`/`app-reader-grant` have different meanings.
- **Provisioning-in-progress Banner and the fictional async create steps** (Namespace reserved / Image pulled / …). The real lifecycle is synchronous and exposes no provisioning status; only Failed/Unknown are real signals (see Goals).
- **"Open app" launch button.** Mural has no anchor/launch control (same gap TA-4 filed for a clickable Live URL); the URL is copyable text. A launch affordance rides on that Feature.

## Anti-goals

- Do **not** extend `EnvironmentDto`, the rollout DTO, or the health DTO to carry fields the server does not compute. Columns and KV rows come from existing reads and joins, exactly as TA-4 established.
- Do **not** fabricate a provisioning status, a signature-verified state, a bundle-deployed state, or a support reference. A fabricated reassurance is worse than an honest absence.
- Do **not** gate Delete behind a capability the server does not differentially enforce (see the ruling below).
- Do **not** touch the retired-but-kept `tenant-tree-view.*` / `hive-detail-view.*` files (TA-4 R6 keeps them compiling for TA-12/13).
- Do **not** flip existing EOL: `tenant-api-client.ts` and `tenant-app.ts` are CRLF; `tenant-api-endpoint.ts`, `tenant-types.ts`, the detail view/VM and the kit are LF; new files are LF. New `.ts` code is ASCII.

## Decisions made (rulings the builder inherits)

- **R1 — Delete needs no capability gate.** The admin capability model (`TenantAdminCapabilities.For`) gives **every** admin role `envs: true` (owner and Environment admin alike); there is no role with `envs: false`. Delete is an `envs` operation, so a differential server gate would enforce nothing, and the honesty invariant (reported == enforced) holds trivially. Delete is therefore ownership-guarded + authenticated only, exactly like the existing Start/Stop/Restart routes, which are also ungated. Cost if wrong: if a future role gains `envs: false`, the lifecycle routes AND Delete must be gated together in the one audit table — a localized change, flagged here.
- **R2 — Route placement and shape.** Add an `EnvNamePathPattern` = `^/tenant-api/environments/([^/]+)$` (exact, no trailing segment) and a `MethodDelete` branch in `Handle`, dispatching to a `RouteEnvDelete` that mirrors `RouteEnvAction`'s guard verbatim. No overlap with `AdminPathPattern` (which requires `/admin/…`) or `EnvActionPathPattern` (which requires `/start|stop|restart`). Returns `204 No Content` with no body (nothing to return; the Deleted event carries the news). Cost if wrong: a mis-scoped pattern would 404 a valid delete or collide with a lifecycle path — caught by the route tests (owned/unknown/cross-tenant plus a `…/start` still-routes-to-action assertion).
- **R3 — Logs become a collapsible region, not an overlay drawer.** Mural has no overlay/drawer primitive (TA-4 filed the modal-overlay gap). "The drawer" is a toggle button inside the Health & activity tab that shows/hides the existing log tail. The log socket lifecycle is unchanged: opened on first Refresh, closed on Dispose; collapsing only hides the view, it does not stop the stream (consistent with the existing Pause semantics, which also keep the socket open). Cost if wrong: minor UX; the stream keeps running while hidden, bounded by `MaxLogChars`.
- **R4 — `Tabs` is a kit primitive.** Build `kit/tabs.ts` (a tab strip of buttons + one content host, active-tab state, property-change on switch) rather than composing tabs inline, because the design uses tabs on at least three screens. Keep it minimal: no animation, no closeable tabs, no overflow. Cost if wrong: a too-thin Tabs needs extension at TA-8/Settings — additive.
- **R5 — Status/health pills reuse TA-4's mapping.** The status→`PillKind` and health→`PillKind` projections live in `environment-row.ts` (TA-4). To avoid divergence, the detail derives pills through the same mapping; if a shared helper is cleaner than importing the row, hoist the two tiny mappers to a `pill-kinds`-adjacent home. The builder chooses; both reporters (list and detail) MUST show the same pill for the same state.
- **R6 — Delete is a header action gated on `envs !== false`.** Following the TA-3 permissive-fallback pattern, the Delete affordance uses the kit `Act` (visible-when-denied, naming the needed permission) only if a denied state is reachable; since `envs` is always true (R1), Delete renders as a normal Danger action. The builder renders it with `Act` for forward-compatibility only if that costs nothing; otherwise a plain Danger button is correct.
- **R7 — Consequences copy is fixed and generic.** The name-to-confirm consequences never quote an active-user count or a hive/other-tenant detail (none is available and Tenant Admin never hints at internals). Copy: "The live URL stops serving immediately." / "The environment's database and files are deleted." / "This cannot be undone." A Production-specific extra line is a design fiction (no Production type exists in `EnvType`; real values are Development/Runtime) and is omitted.

## What's left to the builder

Idiomatic Mural composition within these decisions: the exact panel nesting for header/tabs, the `Tabs` internals, how the collapsible logs region is toggled, and the test doubles (extend `fake-tenant-control-plane.ts` for the Delete route; the existing fake log stream and health fake already serve the tabs). Follow the workspace conventions (OOP, Allman braces, PascalCase public members, enums over string unions, VMs extend `Observable`, no inline string literals, `Disposable` not lambdas) and the existing patterns in the detail view/VM and kit.

## Review focus (inputs the tabs/route imply but no happy-path test exercises)

- **Delete of an environment owned by another tenant** → 404 before `Delete` is called (never 403, never reveals existence). Owning tenant → 204. Unknown name → 404. (Server route test.)
- **A `…/start` path under DELETE** must not match the new env-name pattern as a deletable name (it has a trailing segment) — it falls through to 404, and under POST still routes to the action. (Server route test.)
- **Delete confirm button stays disabled** until the typed text exactly equals the environment name (kit `ConfirmDialog` already enforces; assert the wiring). Dismiss/cancel closes without calling the client.
- **Switching tabs while logs stream** must not open a second socket or drop the buffer; `StopLogs`/`Dispose` still closes exactly once. (VM/view test.)
- **Failed status** renders the danger Banner and still shows the tabs (the environment exists); **Unknown** renders the plain note. Neither blanks the detail.
```
