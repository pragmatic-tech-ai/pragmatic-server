# Interactive Per-Hive Policy Editing (deferred burn-down D5)

**Status:** design — FORK RESOLVED 2026-10-29: placement = **hive-detail page**;
scope = **all three knobs (channels + floor + hold)**.
**Date:** 2026-10-29
**Program:** Program 2 deferred burn-down, spec D5. Closes the D4 follow-up
"interactive per-hive policy editing forms in the portal (hive-detail is
render-only; enforcement + routes + api-client done)".

## Intent and why

D4 (Per-Hive Release Policy) shipped the whole backend and client surface for
per-hive policy: the fail-closed composition evaluator, the Full-gated operator
routes (`/api/hives/:id/policy/(channels|min-version|hold)`), the five
`ControlPlaneClient` methods (`SetHiveChannels`, `SetHiveMinVersion`,
`ClearHiveMinVersion`, `SetHiveHold`, `ClearHiveHold`), and a **read-only**
"Per-hive policy" panel on the hive-detail page. What D4 deferred — as out of
proportion to the rest of that spec — was making that panel **interactive**: an
operator can set a per-hive policy today only by calling the API directly, not
from the portal.

This spec adds the editing controls. It writes no new backend, no new route, no
new evaluator and no new client method: it drives the methods D4 already built.
It is purely the operator portal catching up to the capability that already
exists and is already enforced.

## Goals

- On the **hive-detail page**, below the existing read-only "Per-hive policy"
  panel, add inline forms to **set the hive's subscribed channels**, **set or
  clear the hive's minimum-version floor**, and **hold or release the hive** —
  for the hive that is the page's context (its id is `vm.Hive.id`; the operator
  never types a hive id).
- Gate every mutating control behind operator capability via
  `OperatorContext.MutatingAct` (reported == enforced: Full operators act,
  ReadOnly operators see the disabled affordance with the "ask" copy). This
  mirrors the server, which Full-gates all five routes.
- After a successful mutation, reload the hive detail so the read-only panel
  reflects the new policy.
- Mirror the tenant-policy form machine in `ReleasePolicyView` (its
  `GatingMode` enum, `EnterMode`, `BuildPolicyForm`, `ChannelToggle`,
  `ApplyPolicy`, cancel) so the two policy editors read as one system.

## Non-goals / anti-goals

- **No backend change.** No new route, evaluator, record field, or client
  method. If the editor needs something the client cannot do, that is a bug in
  this plan, not license to touch the backend.
- **No central per-hive editor on the Release Policy page.** The fork chose the
  hive-detail placement; the Release Policy screen keeps its tenant-only forms.
- **No tenant-portal change.** `admin/tenant-portal` gets no per-hive policy
  control — per-hive policy is an operator-only capability (as in D4).
- **No new composition or enforcement logic in the portal.** The read-only
  panel already derives its labels; this spec only adds forms that call the
  client and trigger a reload.

## Design (decided parts)

- **Thread the operator context into the Hives section.** `HivesView` is today
  the only main view whose constructor does not receive an `OperatorContext`
  (`app.ts` mounts `new HivesView(this.client)` with no operator guard, unlike
  ClientsView / ReleasesView / ReleasePolicyView / SettingsView). Give
  `HivesView` an `OperatorContext` constructor parameter and guard its mount in
  `app.ts` the same way the others are guarded (operator defined → mount).
- **Thread client + operator + reload into `HiveDetailView`.** Extend its
  constructor with optional-last parameters `(vm, onBack, client?, operator?,
  onPolicyChanged?)` so every existing construction site and test that calls
  `new HiveDetailView(vm, onBack)` keeps compiling untouched. `HivesView`
  `BuildDetail` passes `this.client`, the operator, and
  `() => this.Refresh()` (the `SectionContainerView` seam that re-runs
  `ShowDetail(detailRow)` → re-`BuildDetail` → fresh policy fetch + remount).
- **Edit forms live on the hive-detail content**, rendered only when
  `client`, `operator`, and `onPolicyChanged` are all present. The mutating
  actions themselves are built through `operator.MutatingAct`, so a ReadOnly
  operator sees the gated affordance rather than a live button. The forms
  operate on `vm.Hive.id`; there is no hive-id input.
- **Form modes** mirror `ReleasePolicyView.GatingMode`: a hive-scoped
  `Set channels` (stable/early toggles → `SetHiveChannels`), `Set floor` /
  `Clear floor` (`SetHiveMinVersion` / `ClearHiveMinVersion`), and `Hold` /
  `Release` (`SetHiveHold(reason)` / `ClearHiveHold`). Same validation copy
  shape (version required, reason required), same inline error line, same
  cancel.
- **Apply path** mirrors `ApplyPolicy`: clear the error line, validate, call the
  client method, on failure show the "could not be saved" line and keep the
  form open, on success leave edit mode and `await onPolicyChanged()` to reload
  the detail.

## Constraints (Global)

- New/modified `.ts`: ASCII, LF. Every touched file is LF + 0 non-ASCII at base
  (`hive-detail-view.ts`, `hive-detail-view-model.ts`, `hives-view.ts`,
  `app.ts`) — keep it that way; byte-scan each on the way out.
- OOP + Allman braces; VMs extend `Observable`; no module-level free
  functions/state; **no inline string literals** (every label / key / message a
  `private static readonly` constant); enums over string unions; PascalCase
  public members.
- `admin/portal` must not import from `admin/control-plane`; `admin/portal` and
  `admin/tenant-portal` stay separate apps.
- Gates: portal `npm --prefix admin/portal test` + `npm --prefix admin/portal
  run typecheck`. (No control-plane source changes, but `typecheck:tools`
  typechecks both portals, so run it too.)
- Merge locally (ff-only); **NEVER push.**

## Review focus

- **reported == enforced (capability).** Every mutating control must be built
  through `OperatorContext.MutatingAct`; a ReadOnly operator must get no live
  path to any of the five hive mutations. The server Full-gates the routes
  regardless, but the UI must not offer what it cannot do.
- **Correct hive id.** The forms must act on `vm.Hive.id` — the hive on screen —
  and never on a stale or wrong id; a reload must re-fetch and re-render that
  same hive's policy.
- **Existing construction sites compile untouched.** The optional-last ctor
  params must not force any current `new HiveDetailView(vm, onBack)` caller or
  test to change; the read-only path (no client/operator) must render exactly
  as it does today.
- **No form-eats-refresh.** As in `ReleasePolicyView`, an open edit form must
  survive a background refresh (the detail reload happens only on a successful
  apply or an explicit cancel), so the operator's typing is never discarded.
- **Back-compat / empty states.** A hive with no per-hive policy must still show
  the "Inherits tenant" / "No per-hive hold" read-only labels, and the forms
  must set a first-ever policy correctly (not assume an existing record).
