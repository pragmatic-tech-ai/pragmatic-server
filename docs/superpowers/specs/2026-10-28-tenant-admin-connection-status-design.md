# TA-12 - Connection status (and "what's running in your hive") - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD).
**Area:** Tenant Admin > Connection status (left-nav item, currently a ComingSoon placeholder) + a quiet-hive banner; a graceful Overview connection card is a later tie-in (TA-14), out of scope here.
**Builds on:** the left-nav shell (`nav-model.ts`, `NavSection.ConnectionStatus`), the existing `IReleasesSource`/`IOverviewSource` rollout reads, and `TenantApiError.Status`.
**Reconciliation:** `docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md` section 1.8 and section 4 item 12.

## The boundary decision this spec had to settle (recon finding + ruling)

The reconciliation flagged TA-12 as "BE+UI ... needs a local agent-status source ... the spec must settle what the tenant-admin process can read locally." Recon settled it:

- The in-hive tenant-api reaches the platform through an **on-demand outbound rollout client** (`IRolloutClient`: `ManifestsFor`/`StatusFor`/`AdoptTarget`). When the platform is unreachable or the link is unconfigured, every read **fails closed with `RolloutUnavailableError`, which the tenant-api already maps to HTTP 503**. The portal's `TenantApiError` carries `.Status`, so the portal can already observe "the hive cannot reach the platform right now".
- `GetRollout(hiveId)` already returns `HiveRolloutDto { targetVersion, environments: [{ environmentName, runningImage, obsolete, ready }] }` - the **real** "what version is running in your hive" data, sourced from the platform via the same outbound channel.
- There is **no periodic check-in loop, no recorded check-in history, and no agent/Tenant-Admin/IdP component-version registry** in this repo. The platform-side `AgentChannelHost` is the listener the in-hive agent dials *into*; the in-hive process does not record a timestamped heartbeat or a component-version plate.

**Ruling: TA-12 is PORTAL-ONLY.** It reports exactly what the existing outbound channel truly knows - present reachability (from the 503 signal) and what is running in the hive (from rollout data) - and it does **not** fabricate the design's periodic cadence, rolling history, or component-version plate. Building a fake heartbeat backend to satisfy the mockup would violate the standing "never invent a backend/product model" invariant. The missing pieces are deferred as filed GAPs (below), each needing a real in-hive agent check-in recorder that does not exist yet. This keeps TA-12 honest and low-risk (no new server surface to get wrong) while still delivering a genuinely useful page.

## Intent and why

A tenant admin running the portal inside their own hive needs one honest answer: *is my hive currently in touch with Pragmatic, and what is running here?* The architecture is outbound-only - the hive dials out to Pragmatic; Pragmatic never connects in - and that property is a reassurance worth showing plainly. The page makes the real connection state legible and names the versions actually running, without implying monitoring the system does not do.

## Goals

- A **Connection status** page replacing the ComingSoon placeholder on `NavSection.ConnectionStatus`.
- A **reachability hero**: "Connected" when a live rollout read succeeds, "Quiet" when it returns 503 (`RolloutUnavailableError`) - honest present-tense wording ("Pragmatic is reachable from your hive" / "Your hive can't reach Pragmatic right now"), NOT "last check-in X ago / next within 5 minutes" (there is no cadence to promise).
- An **outbound-only diagram** with honest static copy: Your hive -> outbound HTTPS -> Pragmatic, and the true statement that Pragmatic never initiates a connection into the hive.
- A **"What's running in your hive"** list from `HiveRolloutDto`: the target version and, per environment, the running image and ready state - the genuinely-available component/version facts.
- A **quiet-hive banner** shown when the hive can't reach Pragmatic, with the reassurance that environments keep running normally while the link is quiet (true: workloads run locally; only platform rollout/adoption pauses).
- Honest **loading / quiet / error / permission** states via the kit `ScreenHost`, and a **no-hive / no-environments** empty state.
- The page is **read-only**; it performs one reachability read and renders.

## Non-goals

- **No new backend route, DTO field, or agent-status store** - TA-12 derives everything from the existing `GetRollout`/`StatusFor` reachability (503) and rollout data. (This is the ruling above.)
- **No periodic check-in cadence** ("next expected within 5 minutes") and **no rolling check-in history** ("last 12 check-ins") - the system records neither; deferred GAP.
- **No component-version plate for the agent / Tenant Admin / IdP with updated-at and "automatic"** - those versions are not readably exposed in-hive (the portal's own version is a meaningless "0.0.0"); deferred GAP. Only the rollout-sourced running images/target version are shown.
- **No "last platform-applied upgrade" timeline** - not recorded; deferred GAP.
- The **Overview connection card** tie-in and the **Operations drawer** are TA-14, not here (Overview already degrades gracefully).

## Anti-goals (a failure even if it "works")

- Showing a fabricated check-in timestamp, cadence, or history strip - the honesty invariant: reported == what the system actually knows. A "Connected" hero must mean a read just succeeded, not a faked heartbeat.
- Implying Pragmatic monitors or reaches into the hive - the copy must preserve the outbound-only truth.
- Treating a 503 (quiet link) as a hard error state that alarms the admin - a quiet link is normal and environments keep running; it is a calm "Quiet", not a red failure.
- Leaking any other tenant's/hive's/platform's state; reported capability == enforced.

## Information architecture (the decided shape)

- `NavSection.ConnectionStatus` renders a new `ConnectionStatusView` (replacing the ComingSoon placeholder), resolving the current hive the same way `ShowOverview`/`ShowReleases` do (hive id from the hive list; no hive -> ComingSoon/empty, consistent with those).
- The view has its own `ConnectionStatusViewModel` (extends `Observable`) backed by a thin portal-side `IConnectionSource` that wraps the existing rollout read: one method, e.g. `Probe(hiveId): Promise<ConnectionStatus>` that calls `GetRollout` and maps success -> reachable + the rollout data, and a 503 `TenantApiError` -> quiet. A 401 rethrows to login (unchanged pattern); other errors -> an honest error state.
- A quiet-hive **Banner** (kit) appears on the page (and is structured so Overview can reuse the same derivation later) when the probe is quiet.
- `ConnectionStatus` view-model data: `{ reachable: boolean, detail: string, targetVersion?: string, environments: { name, runningImage?, ready }[] }` - derived, no new DTO on the wire (reuses `HiveRolloutDto`).

## What's left to the builder (plan + implementation calls)

- Exact plain-language copy for the hero, the diagram labels, the quiet banner, and the per-environment running-image rows (all hoisted to `private static readonly`; reuse the TA-10/TA-11 vocabulary and the kit `StatusPill`/`Banner`/`Section`/`ScreenHost` where they fit).
- Whether the reachability probe reuses `IReleasesSource.GetRollout` directly or a dedicated thin `IConnectionSource.Probe` that the `TenantApiClient` implements by calling the same rollout leaf and catching the 503 - prefer a dedicated `IConnectionSource` so the Connection page owns its own honest mapping and does not couple to the Releases view-model.
- How "Connected/Quiet" maps to `StatusPill` kinds (reuse `PillKind`), and whether the diagram is a simple three-node horizontal strip of kit primitives (no custom drawing).

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public, no inline string literals, enums over unions, VMs extend `Observable`, `IDisposable` not lambdas, tests under `admin/tenant-portal/tests/`.
- New `.ts` files pure ASCII + LF; byte-scan after every write. `sed -i` never on a CRLF file; `tenant-app.ts` is CRLF - touch it only for the one nav-case swap (ConnectionStatus -> ConnectionStatusView) and keep its CRLF. No DTO shape changes in `tenant-types.ts` (add only the portal-side `IConnectionSource` interface + the derived `ConnectionStatus` type).
- Secrets/tokens out of scope; nothing cross-tenant; reported capability == enforced.
- Portal gate: `npm test` + `npm run typecheck` in `admin/tenant-portal`. Merged-result gate: server-root `test` + `typecheck:tools` green.

## Review focus (inputs no happy-path test exercises)

- A 503 from the rollout read renders the calm **Quiet** hero + quiet banner (NOT an error state), and the page still shows the outbound-only diagram and whatever last-known running data it has (or an honest "versions unavailable while quiet" line).
- A 401 from the probe rethrows to login (not shown as a connection error).
- A non-503/401 failure renders the honest **error** ScreenHost, not a fake "Quiet".
- No hive / no environments -> the empty state, not a crash or a misleading "Connected".
- The "Connected" hero only ever appears after a read actually succeeded this session - never a cached or assumed-true default before the first probe (initial state is Loading, not Connected).
- The quiet copy states environments keep running - it must not imply the hive is down.
