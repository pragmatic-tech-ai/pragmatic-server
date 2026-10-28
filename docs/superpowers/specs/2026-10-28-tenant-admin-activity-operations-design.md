# TA-14 - Activity feed and Operations drawer - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD).
**Area:** Tenant Admin - cross-cutting Activity drawer (shell chrome), Overview home cards, Environment detail activity.
**Builds on:** the left-nav shell (`tenant-app.ts`), the existing tenant events websocket (`TenantApiClient.OnEvent`), the Overview home (TA-7), the Connection status VM (TA-12), the Environment detail "Health & activity" tab (TA-5).
**Reconciliation:** `docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md` section 1.1 (Overview "Recent activity" + "Connection to Pragmatic" cards), section 1.3 (Environment detail Health & activity), section 3 ("Recent activity / audit feed" GAP; "Durable operations list" GAP with the note that a client-side store fed by events is feasible for v1), and section 4 item 14.

## The scope decision (recon finding + ruling)

The design has a persistent Operations drawer and, on Overview, a "Recent activity (5)" card and a "Connection to Pragmatic" card. Recon found the only tenant-scoped activity data that exists is the live events socket, and it is thin by deliberate architecture:

- **The events socket carries `{ type, environmentName }` only** (`tenant-events.ts`: `TenantEvent`, four `TenantEventType` values - `environment-created`, `environment-changed`, `environment-deleted`, `health-changed`). No server timestamp, no actor, no operation id, no step detail. `TenantEventBus` is a pure live fan-out: **it keeps no history.** The control plane has no audit read model and no durable operations store (recon section 3 marks both GAP).
- So a **server-backed activity/audit feed does not exist**, and the never-invent-a-backend mandate forbids fabricating one. Recon section 3 already rules the honest v1: a **client-side store fed by the events socket**. That is what TA-14 builds.
- The design's **Operations drawer** implies step-tracked long-running operations (the six create/adopt steps, bundle deploy) with progress. The events give none of that: no operation correlation, no step names, no distinction between an adopt and a start (both surface as a coarse `environment-changed`), and bundle-deploy has no route at all (deferred to TA-15). A drawer that drew progress bars or named steps would **fabricate operational state** - the honesty invariant (reported == real) on an operations surface. So the persistent drawer is realized as an **Activity drawer** hosting the honest session activity list, not a fake operations tracker.

**Ruling: TA-14 is portal-only, and delivers one honest client-side activity log.** A shell-owned, session-scoped `ActivityLog` records every tenant event the browser observes while Tenant Admin is open, stamping each with the client's observed-at time and a derived plain-language summary. It is surfaced in four places (Activity drawer, Overview recent-activity card, Overview connection card, Environment detail activity). It is labeled honestly as activity observed **this session** - not a persisted, actor-attributed audit trail. No new server route; no change to the events contract.

(Contrast TA-13, which had one safe presence-only backend touch. TA-14 has none: the only honest activity data already flows over the existing socket, so touching the server would mean inventing the audit model we are deferring.)

## Goals

- A shell-owned **`ActivityLog`** (extends `Observable`, bounded ring, session-scoped) fed from the shell's single `OnEvent` subscription. Each record is an **`ActivityEntry`**: the event type, the environment name, and the client observed-at timestamp, with a derived plain-language summary and a pill/glyph for display.
- A persistent **Activity drawer** in the shell: a top-bar toggle (activity glyph, with a count of entries observed this session) and a collapsible panel that renders the full log newest-first via a kit **`ActivityList`**. The drawer is shell chrome - it persists across view swaps and keeps accumulating while any section is shown. Honest empty state ("No activity observed yet this session.").
- An **Overview recent-activity card**: a Section showing the latest 5 entries from the same log via `ActivityList`, with a "See all activity" affordance that opens the drawer, and an honest empty state.
- An **Overview connection card**: a compact card reusing TA-12's `ConnectionStatusViewModel` - a reachable/quiet `StatusPill` plus the `ConnectionStatus.detail` sentence (the field TA-12 reserved) and a link to the full Connection status page. Degrades honestly (loading / quiet / error / no-hive).
- **Environment detail activity**: in the existing "Health & activity" tab, a "Recent activity" `ActivityList` filtered to that environment's name from the shell log.
- An honest framing line everywhere the log is shown: this is activity observed since you opened Tenant Admin, client-timed - not a server audit history.

## Non-goals

- **A server audit / activity feed** (actor, server time, persisted history across reloads) - no route exists; deferred GAP (filed Feature). The client log is session-scoped and clears on reload.
- **Step-tracked durable operations** (the six create/adopt step names, per-operation progress, operation correlation ids) - the events carry no such data; deferred GAP. No fabricated progress bars or step lists.
- **Bundle-deploy operations** - no deploy route exists yet (TA-15); deferred GAP.
- **24 h health history / historical event feed on Environment detail** - the health read is current-state only and the socket carries no history (recon section 3); deferred to TA-15. TA-14 adds only the session activity list to that tab, not a history strip.
- **Actor attribution or server timestamps** on any entry - the events carry neither; the entry shows the environment and a client-observed relative time only.
- A new server route or any change to the `TenantEvent` contract.

## Anti-goals (a failure even if it "works")

- A drawer or card that implies a persisted audit trail or names who did something - the log cannot know either; claiming it would be dishonest.
- Fake operation progress (steps, percentages, spinners that track nothing) on the drawer.
- A server timestamp presented as authoritative when the time is the browser's observe-time.
- Re-probing or hammering the server because activity is live (the log is fed by the socket the shell already holds; no polling).
- Anything cross-tenant/hive/platform in the log (the events socket is already tenant-scoped server-side; the log never aggregates beyond it).

## Information architecture (the decided shape)

- **`ActivityEntry`** (plain value/row class, like the existing row VMs - not `Observable`): `{ Type: TenantEventType; EnvironmentName: string; ObservedAt: number }` with derived `Summary` (plain-language, from a hoisted type -> template map, e.g. "Environment <name> was created"), `Pill` (`PillKind.Observed`), and a relative-time helper (`just now` / `Nm ago` / `Nh ago`, computed from the client clock at render).
- **`ActivityLog`** (extends `Observable`): a bounded newest-first list (cap ~200, oldest dropped). `Record(ev: TenantEvent, now?: () => number)` appends an entry and raises a property-changed; `Entries` getter; `EntriesFor(environmentName)` filtered getter; `Count`. The `now` seam makes observed-at deterministic in tests.
- **Shell (`tenant-app.ts`)** owns one `ActivityLog` and one `Drawer`. In `OnTenantEvent`, **record first** (`this.activityLog.Record(ev)`), then the existing routing (environments `ApplyEvent` / deleted-env fallback / `current.Refresh()`). The drawer subscribes to the log and rebuilds itself, so it updates regardless of which view is mounted. Because the shell already calls `current.Refresh()` on every event for non-list views, Overview and Environment detail re-render on each event and read the log at render time - **no per-view log subscription is needed** (only the shell-owned drawer subscribes).
- **Navigator seam:** `ITenantNavigator` gains `get Activity(): ActivityLog` and `OpenActivityDrawer(): void`. Views reach the shared log and the drawer through the navigator, exactly as they already reach `Capabilities` and `ShowSection`. The Overview card's "See all" calls `OpenActivityDrawer()`.
- **Kit `ActivityList`** (new primitive): renders a list of `ActivityEntry` (glyph/pill + summary + relative observed-time), takes an optional `max` and an empty-state config; pure view, no data ownership. Reused by the drawer, the Overview card, and Environment detail.
- **Kit `Drawer`** (new primitive): a collapsible panel with a header (title + close) and a body, an `Open` flag and `SetOpen`/toggle, mounted as shell chrome (a right-hand column in the shell that toggles presence - a simple toggle panel for v1, not an animated overlay). Test seams for open-state and body.
- **Top bar** gains an activity toggle affordance (glyph + count) wired to `OpenActivityDrawer()` / drawer toggle. The `TopBar.BannerSlot` and layout stay as-is.
- **Overview connection card** runs its own `ConnectionStatusViewModel` (constructed from the client, which satisfies `IConnectionSource`) and loads once per Overview mount - decoupled from the env-event refresh loop so live env events do not re-probe the rollout. Shows the reachable/quiet pill + `detail` + a "View connection status" link (`ShowSection(NavSection.ConnectionStatus)`).

## What's left to the builder (plan + implementation calls)

- Exact entry summary copy per `TenantEventType` and the relative-time thresholds (hoist all to `private static readonly`; reuse `PillKind.Observed` and the `History` / `Clock` glyphs from the kit).
- The drawer's exact layout in the shell (right-hand toggle column vs. a panel below the top bar), the toggle's placement in the top bar, and whether the count badge shows total-this-session or a simpler dot. Prefer the simplest honest treatment; no "unread" bookkeeping unless trivial.
- Whether relative times tick live (a timer) or are computed only at render (re-rendered when new activity arrives or the drawer opens). v1 may skip a live ticker (computed-at-render is acceptable); if skipped, note it.
- The Overview card layout relative to the existing env cards and offer banner (the recent-activity and connection cards are new Sections added to the Overview body), and whether the connection card reuses the hero pill/text pattern from `ConnectionStatusView`.
- The `ActivityLog` cap value and the drop policy (newest-first ring).
- Keeping the Environment detail addition confined to a "Recent activity" list in the existing Health & activity tab - not a 24 h strip or historical feed (those are TA-15).

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline string literals (hoist to `private static readonly`), enums over string-literal unions, VMs/stores extend `Observable`, row/value classes are plain delegating classes, `IDisposable` not disposer lambdas, tests under `admin/tenant-portal/tests/`.
- New portal `.ts` files pure ASCII + LF; byte-scan after every write (0 non-ASCII, 0 CR). `tenant-app.ts`, `tenant-api-client.ts`, `tenant-app.test.ts`, `tenant-tree-view.test.ts` are CRLF - preserve; change only the needed lines; never `sed -i` a CRLF file. Escape any `— … · → ○◔◑◕●` as `\uXXXX`, and re-scan after the Write tool (it can literalize escapes).
- Portal-only: `npm test` + `npm run typecheck` in `admin/tenant-portal`, both green on the merged result. No server change, so no control-plane gate for this spec.
- The log is session-scoped and clears on reload; labeled honestly as observed-this-session. Nothing cross-tenant. No secret material in any entry (the events carry none).
- Every new list/card covers loading / empty / error / permission-denied where applicable (the activity list's empty state; the connection card's loading/quiet/error/no-hive).

## Review focus (inputs no happy-path test exercises)

- An `ActivityLog` fed past its cap drops oldest and never grows unbounded; `EntriesFor` returns only the named environment's entries. (Store tests.)
- The drawer keeps accumulating and stays correct across a view swap (shell records into the log while a different section is mounted; the drawer reflects it without the mounted view needing a log subscription). (Shell test.)
- The Overview connection card maps 503 -> Quiet (not Error), 401 -> login, 403 -> a denied/absent card, no-hive -> honest empty - reusing `ConnectionStatusViewModel`'s mapping, and does **not** re-probe on every env event. (Card test.)
- An empty log renders the honest "No activity observed yet this session." empty state in the drawer and the Overview card, not a blank panel. (View tests.)
- Observed-at is client time: no entry presents a server timestamp or an actor. The relative-time helper is driven by the injected `now` seam in tests. (Entry test.)
- Environment detail shows only its own environment's activity, and the addition does not introduce a 24 h history strip. (Env-detail test.)
- No new server route, no `TenantEvent` contract change, no secret in any entry. (Diff review.)
