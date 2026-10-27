# Tenant-Admin UI Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reusable Mural component kit (`admin/tenant-portal/src/kit/`) — status pills, a five-state screen host, name-to-confirm dialog, a permission-gated action button, and layout helpers — that every later Tenant-Admin screen composes, matching the design system's behaviour/copy/states.

**Architecture:** Pure UI, composing over existing Mural controls (`Icon`, `Dialog`, `Button`, `TextBox`, panels) and the Pragmatic theme. Status glyphs are parsed from the design's own `icons.json` into Mural `IconDefinition`s via Mural's `parseSvgIcon` (which targets Lucide 24×24 stroke glyphs). No server changes; no Mural changes (tones reference existing theme color resources).

**Tech Stack:** TypeScript, `@pragmatic-tech-ai/mural` (`Icon`/`parseSvgIcon`/`IconDefinition`, `framework/surfaces/dialog`, `Button`, `TextBox`, `Checkbox`, panels, `GridLength`), Pragmatic theme, `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-27-tenant-admin-ui-kit-design.md`

## Global Constraints

- **No server changes; no Mural source changes.** Tones map to EXISTING Pragmatic theme color resources (by key / DynamicResource); do not add theme tokens or edit mural unless Task 1 proves a needed status tone is genuinely absent — if so, that is a separate flagged decision, not done silently.
- **Glyph source:** `C:\Users\Eugene\Projects\architecture-agent\dev-kit\design\admin-apps\src\icons.json` (79 lucide-style glyphs: name → array of `[tag, attrs]` SVG elements, 24×24, stroke, `fill=none`). Build SVG text per glyph and parse with Mural `parseSvgIcon`.
- **Status is icon + text, never colour alone** (WCAG, brief §3/§6). Every `StatusPill` renders a glyph AND a label.
- **Copy is verbatim from the design** (`dev-kit/design/admin-apps/src/shared.jsx`): the `PILLS` labels, the `DeniedState`/`ErrorState`/`EmptyState` copy, the `ConfirmDialog` structure.
- **House style:** OOP, Allman braces, PascalCase public members, no inline string literals (hoist to `static readonly`), enums over string unions, any VM extends `Observable`, teardown via `Dispose()`. Kit components are controls/helpers, authored portal-agnostic (no tenant-specific imports) for later Platform reuse (R1).
- **EOL:** all new `kit/` files LF (verify `tr -cd '\r' < f | wc -c` == 0 after each edit; the Edit tool silently flips EOL).
- **Gates:** `npm --prefix admin/tenant-portal test` + `npm --prefix admin/tenant-portal run typecheck`; `npm run typecheck:tools` at repo root. No mural rebuild expected. Never `npm install` at repo root.
- **Branch off `master`; merge-local (ff) at finish; NEVER push without explicit instruction.** Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **A glyph that fails to parse** must surface at build/test time, not render blank — Task 1 asserts every needed glyph yields a non-empty `IconDefinition`.
- **A `PillKind` with no registry entry** must fall back safely (neutral tone + a default glyph + the raw key as label), never throw — Task 2 test.
- **`ScreenHost` precedence:** when multiple inputs are set (e.g. `loading` and `error`), it must resolve to exactly one state deterministically (loading → denied → error → empty → populated) — Task 3 test.
- **`ConfirmDialog` enables confirm ONLY on an exact name match** (trailing space, case, empty all keep it disabled) — Task 4 test.
- **`Act` denied path** renders the control **visible but disabled** with the `need` role hint (not hidden) — Task 4 test.

---

### Task 1: Icon catalog + tone resolution (foundation)

**Files:**
- Create: `admin/tenant-portal/src/kit/icon-catalog.ts` (LF)
- Create: `admin/tenant-portal/src/kit/tones.ts` (LF)
- Test: `admin/tenant-portal/tests/kit/icon-catalog.test.ts` (LF)

**Interfaces:**
- Produces: `enum KitGlyph` (the glyph names the kit needs — the union used by `PILLS` + the state blocks: at least `radio-tower, wifi-off, circle-dashed, hourglass, ban, circle-check, triangle-alert, circle-alert, play, square, refresh-cw, shield-check, shield, pencil, circle-x, clock, user-x, eye, package, circle-pause, lock, copy, check, user, users, history, server, settings` — confirm against `icons.json`); `class IconCatalog` with `static Definition(glyph: KitGlyph): IconDefinition` (lazily built + cached from the glyph's `icons.json` entry → SVG text → `parseSvgIcon`). `enum PillTone { Success, Warning, Danger, Info, Neutral }` + `class Tones` with `static Brush(tone: PillTone): Brush` and `static SoftBrush(tone)` resolving to EXISTING Pragmatic theme color resources (Task 1 recon finds the key names in `Mural/src/resources/pragmatic/light.mu`/`dark.mu` or the token snapshot; if a tone has no theme colour, record it and pick the nearest — do NOT inline hex).
- Consumes: Mural `parseSvgIcon`, `IconDefinition`.

- [ ] **Step 1 (recon, record in report):** read `dev-kit/design/admin-apps/src/icons.json` for the exact element shape and confirm every `KitGlyph` name exists; read `Mural/src/resources/pragmatic/{light,dark}.mu` (or `token-snapshot.ts`) and record the existing semantic status/accent colour resource keys each `PillTone` maps to. If a tone is genuinely absent, note it (ruling needed).
- [ ] **Step 2: Write failing tests:** `IconCatalog.Definition(k)` returns an `IconDefinition` with ≥1 `Shape` for every `KitGlyph` (table-driven); the same glyph returns a cached identical instance; `Tones.Brush(tone)` returns a non-undefined `Brush` for every `PillTone`.
- [ ] **Step 3: Implement.** `IconCatalog` embeds (or imports) the needed glyph subset from `icons.json` as a `static readonly` map (glyph → SVG element descriptors), builds `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">…</svg>` text, and calls `parseSvgIcon`. `Tones` resolves theme brushes by key. Hoist all strings.
- [ ] **Step 4:** run tests green; `typecheck`.
- [ ] **Step 5:** verify LF; commit.

---

### Task 2: `PillKind` registry + `StatusPill`

**Files:**
- Create: `admin/tenant-portal/src/kit/pill-kinds.ts` (LF)
- Create: `admin/tenant-portal/src/kit/status-pill.ts` (LF)
- Test: `admin/tenant-portal/tests/kit/status-pill.test.ts` (LF)

**Interfaces:**
- Consumes: `KitGlyph`, `IconCatalog`, `PillTone`, `Tones` (Task 1); Mural `Icon`, `TextBlock`, a horizontal panel.
- Produces: `enum PillKind` (every key in `shared.jsx` `PILLS`); `class PillKinds` with a `static readonly` registry `PillKind → { tone: PillTone, glyph: KitGlyph, label: string }` (verbatim tone/label from `PILLS`); `class StatusPill extends <Mural control base>` with a settable `Kind: PillKind` and optional `LabelOverride`, rendering a tone-coloured `Icon` + the label text. A missing registry entry falls back to `{ Neutral, circle-dashed, <raw key> }`.

- [ ] **Step 1: Write failing tests** (themed `Application` where realization is needed): table-driven over every `PillKind` — the pill renders an `Icon` (glyph = registry glyph) and a `TextBlock` whose text = registry label; the icon foreground resolves to the tone brush; an unknown kind falls back to neutral + the raw key as label without throwing.
- [ ] **Step 2:** run to verify fail.
- [ ] **Step 3:** implement `pill-kinds.ts` (enum + registry from `PILLS`) and `StatusPill`.
- [ ] **Step 4:** run green; `typecheck`.
- [ ] **Step 5:** verify LF; commit.

---

### Task 3: `ScreenHost` + state panels

**Files:**
- Create: `admin/tenant-portal/src/kit/screen-host.ts` (LF)
- Create: `admin/tenant-portal/src/kit/state-panels.ts` (LF) — `SkeletonPanel`, `EmptyStatePanel`, `ErrorStatePanel`, `DeniedStatePanel`
- Test: `admin/tenant-portal/tests/kit/screen-host.test.ts` (LF)

**Interfaces:**
- Consumes: `KitGlyph`/`IconCatalog` (Task 1), Mural panels/`TextBlock`/`Button`.
- Produces: `enum ScreenState { Loading, Empty, Error, Denied, Populated }`; `enum SkeletonKind { Table, Detail, Cards, Form }`; `class ScreenHost` taking inputs `{ loading, allowed, isEmpty, error }` + an `empty`/`error`/`denied` config + a content builder, resolving to exactly one state with precedence **loading → denied → error → empty → populated**; the four state panels with the design's copy (DeniedState: "You don't have access to {what}. This needs {need}. Ask {who} to grant it. Nothing here was changed."; ErrorState default title "Couldn't load this page." + ref code + retry; EmptyState icon+title+body+actions). `ErrorStatePanel` is announced as an alert (accessibility role/live-region equivalent in Mural).

- [ ] **Step 1: Write failing tests:** each of the five states renders its distinct panel for the matching inputs; precedence holds when several inputs are set (loading+error → skeleton; denied+error → denied; etc.); the copy constants appear; `SkeletonKind` variants each render.
- [ ] **Step 2:** verify fail.
- [ ] **Step 3:** implement. Hoist all copy to `static readonly`.
- [ ] **Step 4:** run green; `typecheck`.
- [ ] **Step 5:** verify LF; commit.

---

### Task 4: `ConfirmDialog` + `Act`

**Files:**
- Create: `admin/tenant-portal/src/kit/confirm-dialog.ts` (LF)
- Create: `admin/tenant-portal/src/kit/act.ts` (LF)
- Test: `admin/tenant-portal/tests/kit/confirm-dialog.test.ts`, `admin/tenant-portal/tests/kit/act.test.ts` (LF)

**Interfaces:**
- Consumes: Mural `framework/surfaces/dialog` (`Dialog`/`DialogAction`), `Button`, `TextBox`; `KitGlyph`/`Tones`.
- Produces: `class ConfirmDialog` — inputs `{ title, body, consequences: string[], confirmName?: string, actionLabel, tone: 'danger'|'primary', onConfirm }`; builds a Mural `Dialog` with a consequences list and, when `confirmName` is set, a `TextBox` whose exact match (no trim leniency) enables the confirm action; Cancel always enabled. `class Act` — a `Button` wrapper: inputs `{ can: boolean, need?: string, onClick, variant, disabledReason }`; when `can` is false it renders **visible + disabled** with the `need` hint as its disabled reason/tooltip (never hidden).

- [ ] **Step 1: Write failing tests:** `ConfirmDialog` — confirm action disabled until the typed text exactly equals `confirmName` (assert disabled for "", a case-variant, and a trailing-space variant; enabled on exact match); consequences list renders; with no `confirmName`, confirm is enabled immediately; Cancel invokes close. `Act` — `can=true` renders enabled and `onClick` fires; `can=false` renders visible+disabled and exposes the `need` hint and does not fire `onClick`.
- [ ] **Step 2:** verify fail.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run green; `typecheck`.
- [ ] **Step 5:** verify LF; commit.

---

### Task 5: `Section` + `KeyValueGrid`

**Files:**
- Create: `admin/tenant-portal/src/kit/section.ts` (LF)
- Create: `admin/tenant-portal/src/kit/kv.ts` (LF)
- Test: `admin/tenant-portal/tests/kit/section.test.ts` (LF)
- Modify: `admin/tenant-portal/src/kit/index.ts` (LF, new) — a barrel re-exporting the kit's public surface (StatusPill, PillKind, ScreenHost/ScreenState/SkeletonKind, the state panels, ConfirmDialog, Act, Section, KeyValueGrid, IconCatalog/KitGlyph, PillTone/Tones).

**Interfaces:**
- Produces: `class Section` — a titled block `{ title, sub?, actions?, body }`; `class KeyValueGrid` — `{ items: {key,value}[], cols }` rendering a key/value grid. Both pure layout over Mural panels/`TextBlock`.

- [ ] **Step 1: Write failing tests:** `Section` renders its title + body (+ actions when given); `KeyValueGrid` renders one row per item with key + value in the given column count.
- [ ] **Step 2:** verify fail.
- [ ] **Step 3:** implement `Section`, `KeyValueGrid`, and the `kit/index.ts` barrel.
- [ ] **Step 4:** run green; `typecheck`; `typecheck:tools`.
- [ ] **Step 5:** verify LF; commit.

---

## Self-review notes

- **Spec coverage:** R1 (kit folder, portal-agnostic) → all tasks in `kit/`; R2 (compose over Mural) → Dialog/Button/Icon reused; R3 (enums + registry, no inline literals) → Tasks 2/3; R4 (icon+text always) → StatusPill always renders both; R5 (tones from theme, no hex) → Task 1 `Tones`. OnceSecret/SecretTable intentionally deferred (design §Non-goals).
- **Type consistency:** `KitGlyph`/`IconCatalog`/`PillTone`/`Tones` (Task 1) consumed by `StatusPill` (2) and panels (3); `PillKind` (2) is the public status vocabulary later screens use; `kit/index.ts` (5) is the single import surface.
- **Proportion:** the plan carries the glyph source, the tone-resolution rule, the state precedence, the exact-match confirm rule, and the copy source; component bodies are left to the implementer, who composes Mural controls.
