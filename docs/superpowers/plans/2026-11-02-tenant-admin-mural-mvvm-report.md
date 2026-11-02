# Tenant Admin on Mural markup + MVVM: report

Branch `worktree-agent-a31bba532fd659280` (worktree `.claude/worktrees/agent-a31bba532fd659280`), on top of master `5c1ab72`. Not merged, not pushed.

## What was built

`admin/tenant-portal` is now two compiled `.mu` Applications in the dark scheme:
- `login.mu`, a sign-in page shown only when the session probe fails.
- `app.mu`, a bare `EditorShell` composed from six section modules in the design's rail order: Overview, Environments, Users & Access, Releases, Settings, Connection status.

Every screen is a DataTemplate over an `Observable` view-model. The hand-built shell, the imperative views and `src/kit/` are deleted. The backend contract is unchanged: only `/tenant-auth/*` and `/tenant-api/*`, through `TenantApiClient`. The one client-side addition is an optional `onClose` callback on `OpenLogStream`.

## Gates (final)

| Gate | Result |
| --- | --- |
| `npm --prefix admin/tenant-portal test` | 264/264 pass (was 698 old tests before the rebuild) |
| `npm --prefix admin/tenant-portal run typecheck` | 0 errors |
| Root `npm run typecheck:tools` | 0 errors |
| `npm --prefix admin/tenant-portal run build` | OK |
| `npm --prefix admin/tenant-portal run test:e2e` | 10/10, against the fake tenant control plane |

## Dropped or left out (with evidence)

- **Hive detail and the "My Hives" tree.** Neither was reachable: `ShowHiveDetail` was only called by `TenantTreeView`, which `TenantApp` never mounted. Releases' adopt flow covers retargeting and rollback.
- **Coming-soon view and `placeholder-root-view`.** The coming-soon view was only a no-hive fallback, which is now an empty state. `placeholder-root-view` was only used by an old boot test.
- **Design features the API doesn't serve:**
  - Pragmatic components list, check-in history and the 24 h health strip.
  - Pods and active users.
  - Deploy UI bundle.
  - OIDC credential rotation, and IdP credential rotate/revoke.
  - Tenant profile Edit.
  - Per-environment adopt selection and rollout progress (`SelectTarget` targets the whole hive).
  - User names, last sign-in and enable account.
  - Global search, Operations drawer, density toggle and keyboard shortcuts.
  - Self-lockout prediction on security-model save.

## Mural pitfalls worked around (no Mural edits)

- **`SegmentedButton`** is a Selector, so it must be bound with `ItemsSource`. The demo's `Items =` renders an empty strip.
- **Explicit `ItemTemplate`** is set on every ListBox, because its rows are Observables.
- **Collections are replaced, not mutated**, for ComboBoxes and tables.
- **Side pane:** a `NavigationService` subclass keeps it hidden.
- **`compile-mu` realpath fix and the `ThemeFontCopy` Vite plugin** are copied from admin/portal.
- **TextBox measurement:** an empty left-aligned TextBox measures to nothing, so the filter box stretches.
- **Checkbox labels:** a Checkbox's label is a separate TextBlock and isn't clickable. The e2e clicks the box itself.
- **Dotted bindings:** a dotted `$A.B` binding only updates on its first segment. The security-model editor binds through a `DataContext` or `ContentControl` instead.

## Decisions to check

- **Sign-in.** No session still auto-redirects to the IdP; the control-plane login smoke depends on that. A failed probe (not a 401) shows `login.mu` with the reason, plus Sign in and Try again.
- **Environment detail lifecycle** (Start, Stop, Restart, Delete) is gated by "Manage environments". The old app didn't gate these.
- **Revoking someone else's role** and **bulk Stop** now ask for confirmation.
- **Switching environment** with an unsaved security model asks before discarding.
- **Activity** has no rail entry. The header's Activity (N) button and Overview's "See all activity" open a page in the Overview section.
- **The boot rebuilds the first section's root page** after the session starts, because pages capture permissions when they are built.
- **A 403 on security-model save** drops the draft. This keeps the reviewer's minor 25 open, with the reason documented: otherwise a Denied page would keep reporting pending work.
- **`tenant-api-client.ts` was CRLF.** Touching it converted it to LF, per the LF rule, so its diff is whole-file.
- **Stale control-plane smoke.** `admin/control-plane/tenant-login-e2e-smoke.ts` drives the old tree UI ("My Hives", "Set as target"). It was already stale before this branch, since the tree wasn't mounted. It is out of this branch's scope and needs updating to Releases > Adopt.
