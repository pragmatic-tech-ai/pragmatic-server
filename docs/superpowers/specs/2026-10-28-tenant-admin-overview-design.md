# Tenant Admin: Overview (home) — Design

Date: 2026-10-28. Spec TA-7 of the tenant-admin reconciliation program (`docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md`, §1.1, with §3 backend gaps). Precedence as the note records: separation spec > brief > prototype (`dev-kit/design/admin-apps/src/tenant.jsx` `Overview` :14). **The prototype is a design fiction over demo data; this spec re-implements its layout and behaviour against the REAL server reads, never inventing a backend.** Governing principle carried from TA-4/TA-5/TA-6.

## Intent and why

`NavSection.Overview` is the Boot landing but still renders the `ComingSoonView` placeholder. The design's Overview is the tenant admin's home: a header with a primary "Create environment", an info banner when a newer stable version is offered and environments are behind it, a grid of environment cards, and three read-only context cards (Recent activity, Connection to Pragmatic, Updated by Pragmatic). TA-7 builds the home against what the server actually exposes and defers the cards that have no backing read.

Why now: TA-4 (Environments list + create), TA-5 (Environment detail) and TA-6 (Releases + Adopt) are in, so Overview can aggregate their reads and link into them — the "Create environment" reuses TA-4's dialog, the offer banner links to the TA-6 Releases page, and each card opens the TA-5 detail.

## The reality this is built on (no backend, no DTO changes)

- **Environments + health:** `ListEnvironments()` + per-hive `GetHealth()` — exactly the join TA-4's `EnvironmentRow` already projects (name, status pill, health pill, running version, live URL when Running). Reuse `EnvironmentRow`; do not re-derive.
- **Offer signal:** `ListManifests()` + `GetRollout(hiveId)` — a "newer stable version is offered and some environment is behind it" boolean, derived the same way TA-6's `ReleasesViewModel.Offers` is (a non-withdrawn manifest that is not the current version, with at least one environment not on it).
- **Create:** reuse `CreateEnvironmentDialog(source, existingNames, onCreated)` (TA-4).
- **Navigation:** `ITenantNavigator` already has `ShowEnvironmentDetail(env)` and `ShowSection(section)` — no new seam.
- The hive id (for `GetHealth`/`GetRollout`) comes from the session profile (`Navigator.Profile?.hive?.id`, else the first `ListHives()`), as in TA-6.

## Goals

- **Overview view + VM**, replacing the ComingSoon for `NavSection.Overview`:
  - **Header:** "Overview" + a primary **Create environment** action.
  - **Offer banner (kit `Banner`, Info):** shown only when the offer signal is true — copy in the spirit of the design: "A newer version is available. Nothing changes until you choose to adopt." with an action **Review and adopt** → `Navigator.ShowSection(NavSection.Releases)`. Hidden when no offer.
  - **Environment cards:** a grid of cards, one per environment, each showing name, a status pill, a health pill, the application/running version, and the live URL (when Running) — all via `EnvironmentRow`. Clicking a card opens the environment detail (`Navigator.ShowEnvironmentDetail`).
  - **States (kit `ScreenHost`):** loading / **empty** ("No environments yet. Create your first environment." with the Create action) / populated / error. (No whole-page denied gate — Overview is the home, visible to any authenticated admin; Create is gated on `envs`, the banner action on `adopt`, both permissive-fallback.)
  - **Quick-create:** the Create action opens `CreateEnvironmentDialog` hosted **inline** by the Overview (the TA-5 R8 pattern — AddChild/RemoveChild, no shell/interface change); on success `Navigator.ShowEnvironmentDetail(env)`.
  - **Live updates:** `Refresh()` aggregates; `ApplyEvent(ev)` reloads (cards + offer signal reflect created/started/stopped/deleted envs).
- **Reusable `EnvironmentCard`** component (from an `EnvironmentRow` + an open callback), composable by Overview and future dashboards.
- **Shell wiring:** `ShowSection(NavSection.Overview)` builds the Overview (resolving the hive id like TA-6's `ShowReleases`).
- **Tests:** VM (aggregation, offer signal true/false, ExistingNames, states, ApplyEvent), card, view (header/Create/banner-shown-and-hidden/cards/empty/error + inline create + card-click + banner action), and the nav wiring.

## Non-goals (filed as Features, not built — §3 GAPs)

- **Recent activity (5):** needs an activity/audit feed read; none exists. (Overlaps TA-14 activity/ops drawer.)
- **"Connection to Pragmatic" card** (last check-in, next-expected, history): needs a home-channel status read; none exists. (Overlaps TA-12 Connection status.)
- **"Updated by Pragmatic" / component versions list:** needs a component-version read; none exists.
- **Verify-failed pill on a card:** no per-environment verify signal exists (same gap TA-6 filed for the Refused matrix cell).
- **`<envId>.<baseDomain>` pretty address:** `baseDomain` is not in any DTO (TA-4 gap); the card shows the real `httpUrl` (when Running), as TA-4/TA-5 do.

## Anti-goals

- Do **not** add a server route or extend any DTO. TA-7 aggregates existing reads only.
- Do **not** fabricate an activity feed, a connection/check-in status, component versions, a verify-failed state, or a `baseDomain` address. An honest absence (card not shown) beats a fabricated reassurance.
- Do **not** re-derive the environment card fields or the version tag — reuse `EnvironmentRow` (and its lifted `VersionOf`/`UrlOf`).
- Do **not** add a new `ITenantNavigator` method (host the create dialog inline, per TA-5 R8).
- Do **not** flip existing EOL: `tenant-app.ts` is CRLF; `tenant-types.ts`, kit and new view/VM/card files are LF; new files LF. New `.ts` is ASCII (escape any em dash/ellipsis as `—`/`…` — never a raw character).

## Decisions made (rulings the builder inherits)

- **R1 — Honest scope.** Overview ships header + Create + offer banner + environment cards + states. The three context cards (activity, connection, components) and the verify-failed pill are server GAPs, deferred as filed Features. Build only the real aggregation. Cost if wrong: the deferred cards are additive — the layout leaves room, and each lands when its read exists.
- **R2 — Portal-only, reuse the reads.** Cards from `ListEnvironments` + `GetHealth` via `EnvironmentRow`; offer signal from `ListManifests` + `GetRollout`. No backend, no DTO change.
- **R3 — Reuse `EnvironmentRow`.** Card data (name, pills, version, URL) comes from `EnvironmentRow`; do not duplicate the projection or the version/URL derivation.
- **R4 — Offer signal, minimal derivation.** The VM computes a single boolean (+ the offered version label) the same way TA-6's `ReleasesViewModel` identifies offers: a non-withdrawn manifest that is not the current version, with at least one environment not on it. Copy the minimal derivation rather than coupling Overview to `ReleasesViewModel`. A shared rollout-derivation helper across hive-detail / releases / overview is now worth it — filed as a consolidation Feature (three VMs carry versions of this).
- **R5 — Inline create dialog.** Reuse `CreateEnvironmentDialog`; host it inline in the Overview (AddChild/RemoveChild, guard one-at-a-time), `onCreated → Navigator.ShowEnvironmentDetail`. No shell change, no interface ripple (TA-5 R8).
- **R6 — Overview is ungated.** No whole-page capability gate (it is the home). Create uses kit `Act` gated on `envs !== false`; the banner's Review-and-adopt uses `Act` gated on `adopt !== false`. Both permissive-fallback and never deny today (every role has both true), forward-compatible like TA-5/TA-6.
- **R7 — Banner only when behind.** The offer banner renders only when the offer signal is true; no banner when every environment is current or no version is offered.

## What's left to the builder

Idiomatic Mural composition within these decisions: the card layout and the Overview grid, the inline-create hosting, and the test doubles (reuse/extend `fake-tenant-control-plane.ts`, which already serves environments/health/manifests/rollout for TA-4/TA-6). Follow workspace conventions (OOP, Allman braces, PascalCase public members, enums over string unions, VMs extend `Observable`, no inline string literals, `Disposable` not lambdas) and the patterns in `environments-view*.ts`, `releases-view*.ts`, and the kit.

## Review focus (inputs the home implies but a happy path misses)

- **No environments** → the empty state with a working Create action, not a blank or error.
- **Offer available vs not** → the banner shows only when a newer non-withdrawn version exists AND an environment is behind it; it is absent when all environments are current. (VM boolean both ways.)
- **Load error** (e.g. `GetHealth`/`GetRollout` fails) → the error state (or, for health specifically, degrade like TA-4 — decide and test), never a half-rendered home.
- **A card for a Stopped/Failed/Unknown environment** → correct status/health pills (reusing `EnvironmentRow`), live URL absent when not Running.
- **Live event after load** (create/start/stop/delete) → cards and the offer banner update via `ApplyEvent`.
- **Create denied / Adopt denied** (a future role) → the action is visible-but-disabled naming the permission; today both are enabled.
