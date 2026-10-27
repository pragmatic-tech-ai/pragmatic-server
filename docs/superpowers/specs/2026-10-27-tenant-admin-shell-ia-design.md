# Tenant-Admin Shell & Information Architecture (SP-ADMIN TA-2) — Design

**Status:** design
**Date:** 2026-10-27
**Repo:** `pragmatic-server`, `admin/tenant-portal`. Branch off `master`.
**Program:** Backlog Program 2 → SP-ADMIN → Admin-apps build → Tenant Admin. Second tenant spec (after TA-1 UI kit @114195d). Reconciliation: `docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md`.
**Design source:** `dev-kit/design/admin-apps/src/{shared.jsx (Shell/UserMenu/Tabs), tenant.jsx (TenantApp/nav/identity-plate)}`; brief §5.1/§5.2/§3/§6.1.

## Intent

Replace the tenant portal's current top-bar-of-buttons + "My Hives" tree shell with the design's information architecture: a paper left-nav of six primary sections, a fixed org/tenant/hive identity plate (no switcher), and a calm top bar with a user menu. This makes the one-tenant/one-hive trust boundary felt (brief §6.1) and gives every later screen (TA-3..TA-16) a home. It builds entirely on the TA-1 kit; most target screens don't exist yet, so this spec wires the frame and hosts placeholders + the existing B1 screens, retiring the hive-first tree from the nav.

## Goals

- A **left nav** with exactly six items in order — **Overview, Environments, Users & Access, Releases, Settings, Connection status** — each with the design's Lucide glyph (`home, layers, users, package, settings, radio-tower`), one unlabelled group, paper sidebar, comfortable density; the active item marked (one at a time). Sidebar brand "Tenant Admin" + footer note "Runs inside your hive. Manages one tenant."
- A fixed **identity plate** in the top bar: `org / [users] tenant [hard-drive] hive` (hive id in mono), a non-interactive chip, hover title "This console manages one tenant in one hive". **No switcher, no caret, no disabled dropdown.** Takes `{ org, tenant, hive }` as inputs.
- A **top bar**: identity plate (left), spacer, a minimal **user menu** (email + Logout, replacing the current Logout button). A reserved **banner slot** above content (for the later quiet-hive banner).
- **Section hosting:** `ShowSection(section)` swaps the active screen in the content host and sets the nav active state. Land on **Overview** after boot (not the tree).
- **Placeholders:** a `ComingSoonView` (kit `ScreenHost` empty state) for the four unbuilt sections (Overview, Releases, Settings, Connection status).
- **Fold in existing work:** the four B1 screens move off the top bar into a **Users & Access hub** under that nav item; the existing environment/hive detail views stay reachable under **Environments** via the interim tree until TA-4 replaces it.
- Pure UI — **no server changes.**

## Non-goals / anti-goals (this spec)

- **Nav badges** (degraded-environment count, adoptable-offer count) — need TA-4/TA-5/TA-6 data. Omit; add with the data.
- **Global search, Operations drawer** — need data from later specs. Reserve the top-bar slot at most; don't build.
- **Quiet-hive banner wiring** — reserve the banner slot only; the signal is TA-3/TA-12.
- **Real identity-plate values & role label** — the org/tenant/hive/role come from a session profile + "my permissions" op = **TA-3**. TA-2's plate takes inputs and the user menu omits the role label.
- **Consolidating the B1 screens / the Security-model editor** — TA-8/TA-9. TA-2 only re-homes them under the new nav.
- **Replacing the environment tree with a real Environments list** — TA-4.
- **Icon-rail collapse at 1180px, theme dark-scheme toggle** — stretch only (see R5).

## Rulings

- **R1 — shell is pure UI; identity plate takes `{ org, tenant, hive }` inputs, wired from the session with honest fallbacks.** `tenant = session.tenantId`, `hive = ` a placeholder constant, `org` omitted (hide the `/ org` segment) when absent — **never invent an org name**. TA-3 later passes a real profile object without changing the component. *Note:* the server's `tenantId` is really an environment id (per `project_platform_admin_tenant_semantics`); accepted as the stand-in tenant label until TA-3. *Cost if wrong:* TA-3 swaps the source; the component is unchanged.
- **R2 — retire the "My Hives" tree + hive detail from the primary nav; keep them as INTERIM hosts under Environments.** The tree's hive-first "My Hives" model conflicts with one-tenant/one-hive (the hive is never picked). It comes off the left pane and the nav, but is mounted inside the **Environments** section as the interim list so the one working path to `EnvironmentDetailView` (and `HiveDetailView`) stays reachable until TA-4 builds the real list. Environments stays the active nav item on those detail views. *Cost if wrong:* TA-4 removes the interim tree; reversible.
- **R3 — the four B1 screens move into a `UsersAccessHubView` under the Users & Access nav item; nothing rebuilt.** The hub shows `UsersAccessView` by default plus a tab/button row to Service Tokens / Roles & Privileges / Field Security (reusing their existing `ITenantNavigator` show-methods). The four top-bar buttons are removed so nothing reads as a platform-style menu. TA-8/TA-9 later consolidate these into one page. *Cost if wrong:* the hub is a thin wrapper; TA-8 replaces it.
- **R4 — `ComingSoonView` (kit `ScreenHost` empty state) for the four unbuilt sections; land on Overview.** Reuses the kit's visual language; folds in the existing `DetailPlaceholderView`/`placeholder-root-view`. *Cost if wrong:* each real screen replaces its placeholder in its own spec.
- **R5 — defer data-dependent chrome (badges, search, ops drawer, banner wiring) and the dark-scheme theme toggle.** Reserve the banner slot. The theme toggle ships only if the Pragmatic `ThemeManager` already supports a dark scheme cheaply; otherwise it's deferred (not faked). *Cost if wrong:* additive later.
- **R6 — add the shell's Lucide glyphs to the kit's `IconCatalog` from `icons.json`.** `KitGlyph` lacks `home`, `layers`, `hard-drive` (and `search`/`sun`/`moon`/`monitor`/`chevron-down` if search/theme-toggle land). Add only the ones TA-2 uses, copying element data verbatim from `dev-kit/design/admin-apps/src/icons.json` (same mechanism as TA-1). *Cost if wrong:* nearest-glyph substitution (R4-style), a11y guarantee unaffected.

## Architecture

**New frame in `tenant-app.ts`:** a horizontal split of a left **`NavRail`** and a right column of **`TopBar`** over the existing content host (`detailHost`). The `treeHost` left pane is removed. `Show(view)` (dispose prior → clear host → `AttachNavigator` → add + `Refresh`) is kept unchanged for the right column. `Boot()` lands on `ShowSection(Overview)` instead of the tree; `OnTenantEvent` no longer assumes a tree exists (forwards to the active view only).

**New files (`admin/tenant-portal/src/`, one class each, Allman, no inline literals, any VM extends `Observable`):**

| File | Role |
|---|---|
| `nav-model.ts` | `enum NavSection { Overview, Environments, UsersAccess, Releases, Settings, ConnectionStatus }` + a `NavItem` `{ Label, Glyph: KitGlyph, Section }` + the single static ordered six-item list. |
| `nav-rail.ts` | `NavRail` — paper sidebar: brand ("Tenant Admin"), the six items (Button per item, active via a marker + `Tag`/`aria-current`-equivalent), footer note. Raises/【invokes `ShowSection` via the navigator. |
| `identity-plate.ts` | `IdentityPlate` — `{ org?, tenant, hive }` → the org/tenant/hive chip (users + hard-drive glyphs, hive mono), non-interactive, hover title. Hides the org segment when absent. |
| `top-bar.ts` | `TopBar` — hosts the identity plate (left), spacer, user menu (right); exposes a banner slot above content. |
| `user-menu.ts` | `UserMenu` — avatar initials + email + a menu with Logout (role label deferred to TA-3). |
| `coming-soon-view.ts` | `ComingSoonView extends TenantViewBase` — a title + kit `ScreenHost` empty state ("This screen arrives in a later release"); folds in `DetailPlaceholderView`/`placeholder-root-view`. |
| `users-access-hub-view.ts` | `UsersAccessHubView extends TenantViewBase` — default `UsersAccessView` + a tab/button row to Service Tokens / Roles & Privileges / Field Security (existing show-methods). |
| `kit/icon-catalog.ts` | add `home`, `layers`, `hard-drive` (+ any others TA-2 uses) to `KitGlyph` + the element map. |

**Modified:** `tenant-app.ts` (the frame + `NavSection`/`ShowSection` + land-on-Overview + remove the four top-bar buttons + drop `treeHost`); `tenant-types.ts` (`ITenantNavigator.ShowSection(section)`); the test `Nav` stubs implementing `ITenantNavigator`.

**Section → view mapping (TA-2):** Overview/Releases/Settings/ConnectionStatus → `ComingSoonView`; Environments → interim `TenantTreeView` host (→ `EnvironmentDetailView`/`HiveDetailView`, Environments stays active); Users & Access → `UsersAccessHubView`.

## Trust-boundary / security UX

- The identity plate is **fixed, non-interactive** — reassuring fixity, not a disabled switcher (brief §6.1). No cross-tenant/hive affordance; no "platform" section; nothing hints at other tenants.
- Removing the four top-bar command buttons avoids a platform-style operator menu in the tenant tool.
- The reserved banner slot is where "hive hasn't checked in" reads as calm status later — not an error.
- No secrets in the shell. `ShowError`→login (401) is preserved via `TenantViewBase`.

## Testing

- `tsx --test` against the kit + fakes: `NavRail` renders the six items in order with the right labels/glyphs and marks exactly one active per `NavSection`; `IdentityPlate` renders org/tenant/hive, **hides the org segment when `org` is absent**, and exposes **no interactive control** (assert no Button/clickable in its tree); `UserMenu` shows the email and a Logout action; `ComingSoonView` renders the kit empty state; `UsersAccessHubView` shows `UsersAccessView` by default and the tab row routes to the other three; `TenantApp.ShowSection` swaps the hosted view and sets the active item; Boot lands on Overview; the Environments item stays active on an environment/hive detail view. New icon glyphs parse (extend the TA-1 icon test).
- Pure-UI gates: `npm --prefix admin/tenant-portal test` + `typecheck`; `npm run typecheck:tools`. Files PURE ASCII (straight apostrophes; any em dash `—`) + LF — verify with a byte scan, not grep (bit TA-1 twice). OOP/Allman/PascalCase/no-inline-literals; VMs extend `Observable`.

## Left to the plan

Exact `Button`/panel composition for `NavRail`/`TopBar` (reuse the kit + Mural panels); the active-marker + `aria-current` equivalent via `Tag`; the `UsersAccessHubView` tab mechanism (kit has no Tabs yet — use an `Act`/`SegmentedButton` row or a simple button strip); whether `HiveDetailView` stays reachable via the interim tree (recommend yes, interim); the theme-toggle feasibility check (R5); and task decomposition (likely: nav-model + NavRail → IdentityPlate + TopBar + UserMenu → frame rewire in TenantApp + ComingSoonView + land-on-Overview → Environments interim host + UsersAccessHub + remove old buttons/tree + nav wiring).
