# Tenant-Admin UI Kit — shared design-system components (SP-ADMIN TA-1) — Design

**Status:** design
**Date:** 2026-10-27
**Repo:** `pragmatic-server`, `admin/tenant-portal`. Branch off `master`.
**Program:** Backlog Program 2 → SP-ADMIN → **Admin-apps build** (grounded in the `dev-kit/design/admin-apps` design package + UX brief `docs/design/2026-10-26-platform-and-tenant-admin-ux-brief.md`). First spec of the Tenant-Admin build (TA-1); reconciliation in `docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md`.
**Design source:** `dev-kit/design/admin-apps/src/shared.jsx` (React prototype — behaviour/copy/states only; re-implemented on the TS **Mural** stack).

## Intent

Build the reusable Mural component kit the design system calls for, so every later Tenant-Admin screen (TA-2…TA-16) composes the same status pills, five-state screen hosts, name-to-confirm dialogs, and permission-gated actions instead of re-rolling them ad hoc (as B1-1..B1-4 did). These are the "mandatory cross-cutting patterns" of brief §3 and the `shared.jsx` primitives, mapped onto the existing Mural controls and the Pragmatic theme. This is the foundation the rest of the Tenant-Admin program depends on.

## Goals

Build these components (in `admin/tenant-portal/src/kit/`), each matching the design's behaviour/copy/states and composing over existing Mural controls + the Pragmatic theme:

- **`StatusPill`** — a pill with **icon + text, never colour alone** (WCAG). A typed `PillKind` enum + a registry mapping each kind → `{ tone, iconGlyph, label }`, from `shared.jsx` `PILLS` (connection: connected/quiet/never/awaiting/disconnected; health: healthy/degraded/failing/unknown; lifecycle: running/stopped/provisioning/starting/stopping/restarting/deleting/rolling; release: signed/signing/published/withdrawn/draft/adopted/gated/rollfailed/verifyfailed/pending; secret/token: active/revoked/rotating/expired; user: disabled/invited; plus observed/offered/current/allowed/blocked/held/updated/failed/paused). Tone → the Pragmatic theme's semantic status colour.
- **`Screen` (state host)** — renders one of five states around content: **loading** (skeleton, variants table/detail/cards/form), **empty** (`EmptyState`: icon + title + body + primary/secondary action), **error** (`ErrorState`: title/body/retry/ref-code, announced as an alert), **permission-denied** (`DeniedState`: copy "You don't have access to {what}. This needs {need}. Ask {who} to grant it. Nothing here was changed."), and **populated** (content). Driven by `{ allowed, isEmpty, loading, error }` inputs.
- **`ConfirmDialog` (name-to-confirm)** — composes Mural's `Dialog`: title, body, a consequences list, and a confirm `TextBox` where the user must type an exact `confirmName` to enable the destructive action; Cancel + confirm (danger/primary tone); confirm disabled until the typed text matches. For every irreversible action (brief §3).
- **`Act` (permission-gated action)** — a button that stays **visible when denied** (never hidden) and shows which role is needed; inputs `{ can, need, onClick, variant, disabledReason }`. The real permission source arrives in TA-3; for now `can` is a passed boolean.
- **Layout helpers `Section` and `KV`** — a titled section block (title/sub/actions/body) and a key/value grid, used by every detail screen.
- **Theme/icon reconciliation** — confirm (or add) the Pragmatic theme's semantic status-tone tokens (success/warning/danger/info/neutral fg+bg) and mono-font usage for ids/tokens-by-name; establish how the kit references icon glyphs via Mural's `Icon` control (`basic/icon.ts`) for the glyph names the `PILLS`/state blocks use.

## Non-goals / anti-goals (this spec)

- **`OnceSecret`** (shown-once bootstrap/issued-token box) and **`SecretTable`** (secret-by-reference rows + Rotate/Revoke/Re-issue) — part of the kit but built with their first consumer (TA-8 Tokens / TA-13 Settings), to avoid speculative API. Noted here so they stay consistent; B1-2 already has a working one-time-reveal to fold in.
- **Shell / nav / identity plate / PageHeader / Tabs / DataTable / Activity / OpsDrawer** — those are TA-2 (shell) and later; `DataTable` reconciles with the existing Mural `DataGrid` there. This spec is the leaf primitives only.
- **The permission model itself** — TA-3. `Act`/`Screen` take `can`/`allowed` as inputs now.
- **No server changes.** Pure UI/theme.
- **Retiring legacy views** — happens per-area as screens land (TA-2+), not here.

## Rulings

- **R1 — kit lives in `admin/tenant-portal/src/kit/`, authored portal-agnostic.** Built for tenant first (per the run decision); no tenant-specific imports, so it can be promoted to a shared module or reused when Platform-Admin starts. *Why:* avoids up-front cross-tsconfig shared-module build wiring while keeping the components reusable. *Cost if wrong:* a later move/extract to a shared location — mechanical.
- **R2 — compose over existing Mural controls, don't reinvent.** `ConfirmDialog` wraps `framework/surfaces/dialog`; `StatusPill` builds on `Icon` + themed text (or `framework/markers/badge` if it fits); `Act` wraps `Button`; skeletons/state blocks are simple composed panels. *Cost if wrong:* a bespoke control is more code but localized.
- **R3 — `PillKind` is an enum with a `static readonly` registry**, not string unions or inline literals (house rules). Every label/copy string is a `static readonly` constant. *Cost if wrong:* n/a.
- **R4 — icon + text always for status (WCAG, brief §3/§6).** A pill never renders colour alone. If the Pragmatic icon set lacks a design glyph, map to the nearest available and record it (Task-1 recon resolves the glyph set). *Cost if wrong:* a swapped glyph; the a11y guarantee holds regardless.
- **R5 — tone tokens come from the Pragmatic theme, not hand-picked colours** (no literal hex in the kit; brief §3, the "no hand-rolled brushes" house rule). If a semantic status token is missing from the theme, add it to the Pragmatic theme resource as part of Task 1 rather than inlining a colour. *Cost if wrong:* a theme token addition is contained.

## Architecture

New folder `admin/tenant-portal/src/kit/` (all LF). Each component is an OOP Mural control/helper (Allman, PascalCase public, no inline literals, VMs — where any — extend `Observable`). Consumes: `@pragmatic-tech-ai/mural` (`Icon`, `Dialog`/`DialogAction`, `Button`, `TextBox`, `Checkbox`, panels, `GridLength`) + the Pragmatic theme. The existing `TenantViewBase` ad-hoc helpers (`ShowError`, inline state rendering) are **not** modified here; later screens migrate to the kit.

| File | Role |
|---|---|
| `kit/pill-kinds.ts` | `enum PillKind` + `enum PillTone` + a `static readonly` registry `PillKind → { tone, glyph, label }` (verbatim from `shared.jsx` PILLS). |
| `kit/status-pill.ts` | `StatusPill` control — takes a `PillKind` (+ optional label override); renders themed `Icon` + text. |
| `kit/screen-host.ts` | `ScreenHost` (+ `SkeletonPanel`, `EmptyStatePanel`, `ErrorStatePanel`, `DeniedStatePanel`) — the five-state wrapper; skeleton variants table/detail/cards/form; copy from the design. |
| `kit/confirm-dialog.ts` | `ConfirmDialog` — name-to-confirm over Mural `Dialog`; consequences list; typed-name gate. |
| `kit/act.ts` | `Act` — permission-gated action button (visible-when-denied, `need` role hint). |
| `kit/section.ts`, `kit/kv.ts` | `Section` + `KeyValueGrid` layout helpers. |
| (theme) | If needed, add semantic status-tone tokens to `Mural/src/resources/pragmatic/*` — **only if** the tokens are genuinely absent; prefer reusing existing ones. (Touching mural: by-path only, never the unrelated WIP.) |

## Trust-boundary / security UX

- No secrets handled here (OnceSecret/SecretTable deferred to consumers). The kit's job is to make the later secret-by-reference and name-to-confirm patterns one reusable thing.
- `DeniedState`/`Act` encode "denied, not hidden" (brief §4.5/§5.5/§6.4): controls stay visible and explain the needed role.
- Status is icon + text (never colour alone) at the primitive level, so every screen inherits the a11y guarantee.

## Testing

- `tsx --test` unit/visual tests per component against the Mural test harness (mirror the B1 view tests' altitude — themed `Application` where a control needs realization): `StatusPill` renders the right glyph+label+tone per kind (table-driven over `PillKind`); `ScreenHost` renders each of the five states distinctly for given inputs; `ConfirmDialog` disables confirm until the typed name matches and lists consequences; `Act` renders visible-but-disabled with the `need` hint when `can=false`; `Section`/`KeyValueGrid` render their content. If a theme token is added, the pragmatic theme's existing token tests cover it.
- Gates: `npm --prefix admin/tenant-portal test` + `typecheck`; `npm run typecheck:tools`; if the theme changed, `npm --prefix ../Mural run build` + the mural theme tests (and rebuild dist before the portal consumes it). LF new files. OOP/Allman/PascalCase/no-inline-literals.

## Left to the plan

The exact Mural `Icon` glyph-reference mechanism and the glyph-name → available-glyph map (Task-1 recon); whether any semantic status-tone token must be added to the Pragmatic theme (vs reuse); the precise skeleton markup per variant; `ConfirmDialog`'s exact `Dialog` construction; and task decomposition (likely: theme/icon foundation + `pill-kinds` → `StatusPill` → `ScreenHost` + state panels → `ConfirmDialog` + `Act` → `Section`/`KV`).
