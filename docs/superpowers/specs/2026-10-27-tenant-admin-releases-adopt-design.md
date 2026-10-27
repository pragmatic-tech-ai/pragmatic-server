# Tenant Admin: Releases + Adopt wizard — Design

Date: 2026-10-27. Spec TA-6 of the tenant-admin reconciliation program (`docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md`, §1.4 Adopt and §1.6 Releases, with §3 backend gaps). Precedence as the note records: separation spec > brief > prototype (`dev-kit/design/admin-apps/src/tenant.jsx` `Releases` :372, `Adopt` :242) — **and the prototype is a design fiction over a demo rollout model; this spec re-implements its layout and behaviour against the REAL hive-wide rollout contract, never inventing a backend.** Governing principle carried from TA-4/TA-5.

## Intent and why

The "Releases" nav section is still a ComingSoon placeholder, and the only adopt UI that exists is the retired-but-compiling `hive-detail-view.*` — a hive-wide version list with Set target / Roll back. The design presents two linked screens: a **Releases** page (adoptable-version offer cards + a "which environment runs what" matrix) whose Adopt button opens an **Adopt wizard**. TA-6 builds both, wired into the Releases nav section, on the one adopt operation the server actually exposes.

Why now: TA-4 put the Environments list in place and TA-5 the environment detail; Releases is the next design nav item, and it reuses the rollout reads those screens already touch. The adopt flow's real logic (version badging, current-version resolution, impact text, confirm/fail) already exists in `HiveDetailViewModel` — TA-6 reshapes it into the design's IA rather than inventing it.

## The reality this spec is built on (not negotiable)

- `ManifestDto = { id, image, notes?, publishedAt, withdrawn? }` — **no channel, no migrations, no early-access flag**. Those prototype fields do not exist.
- `HiveRolloutDto = { targetVersion: string | undefined, environments: RolloutEnvDto[] }` and `RolloutEnvDto = { environmentName, runningImage, obsolete, ready }` — a hive has **ONE** target version; its environments roll to it. There is **no per-environment target**.
- The only adopt operation is `SelectTarget(hiveId, version)` → `POST /tenant-api/hives/:id/target`, **hive-wide**. Its server responses are: success (204); a generic `409 { error: "Requested version is not available for this hive" }` for a not-gated / adoption-refused version; `404` for an unknown version/hive; `503` when the rollout operator link is down. No finer outcome codes, no per-step progress, no support reference.
- Reads available: `ListManifests()`, `GetRollout(hiveId)`, `ListEnvironments()`, `GetHealth(hiveId)`. The hive id comes from the session profile (`Navigator.Profile?.hive?.id`, else the first `ListHives()`), consistent with the one-hive-per-tenant identity plate.

## Goals

- **Releases page** (new `ReleasesView` + VM, replacing the ComingSoon for `NavSection.Releases`):
  - **Offer cards** for each adoptable version — a manifest that is neither withdrawn nor the current target. Each card shows: version (the image tag, derived like `EnvironmentRow.VersionOf`), published date, notes (when present), a withdrawn badge where applicable, "**N environments not on this version**" (count of `rollout.environments` whose `runningImage` differs from the manifest's image), and an **Adopt** action.
  - **"Which environment runs what" matrix** — environments (rows) × offered/known versions (columns), each cell marking **Running** when that environment's `runningImage` matches the column version, else a dash. (The prototype's "Refused" cell state is a per-environment verify-failed signal the server does not emit — deferred; see Non-goals.)
  - States via the kit `ScreenHost`: loading / **empty** ("No new versions offered. New versions arrive when your hive checks in.") / populated / error / permission-denied.
- **Adopt wizard** (reshape of the existing hive roll flow into the design's stepped IA, hive-wide):
  - A new kit **`Steps`** primitive (ordered step labels + active index) drives a short wizard with the design's five stops, each filled only with real content:
    1. **Version** — choose an offered version (pre-selected when launched from a card's Adopt). Shows version, published, notes.
    2. **Environments** — an **informational** list of the hive's environments that will roll: those already on the version (noted, not actionable), running ones ("will restart briefly"), stopped ones ("adopts now, starts on next start"). **Not** a selector — adopt is hive-wide (ruling R1).
    3. **Review** — the impact (which environments restart, reusing the hive VM's impact text) and the fail-closed trust note ("If a new version fails verification, your environment keeps serving the version it runs now.").
    4. **Roll out** — calls `SelectTarget(hiveId, version)`; shows a coarse "Rolling…" state, then reloads `GetRollout`. **No** fabricated per-step progress (ruling R7).
    5. **Outcome** — **Adopted** (the hive target is now this version), **Refused** (the server's generic 409 copy, verbatim), or **Unavailable** (503). Reuses the existing `FailedRoll` "stayed on X" semantics.
  - The wizard is hosted inline by the Releases view (the TA-5 R8 pattern — AddChild/RemoveChild, no new navigator seam, no overlay primitive).
- **Adopt gating** via kit `Act` on the "Adopt versions" permission (`Capabilities.adopt`), permissive-fallback (`adopt !== false`), consistent with TA-3.
- **Tests:** `ReleasesViewModel` (offers derivation, "N not on this version", matrix projection, current-version resolution, adopt confirm/refuse/unavailable), `ReleasesView` (cards, matrix, empty/denied, wizard open + step flow + outcome), and the kit `Steps` primitive. Extend the existing portal suite and `fake-tenant-control-plane.ts`.

## Non-goals (filed as Features, not built here — all §3 GAPs)

- **Per-environment adopt / independent per-env target versions.** The rollout model is hive-scoped (one `targetVersion`). A per-env target is a new product capability + server op; out of scope. The wizard's Environments step is informational.
- **Channel pill, migrations list, early-access warning on offers.** `ManifestDto` carries none of these; adding them is a publish-model (platform-side) change.
- **Fine-grained roll progress** (Pull image / Verify signature / Run migrations / Roll pods / Health check / Switch traffic). The server exposes no per-step status; the wizard shows a coarse rolling state. No fake step animation.
- **Distinct outcome codes** — verify-failed (with a support reference) vs gated-out ("on hold for your organisation") as separate, differently-worded outcomes. The server returns one generic 409; TA-6 shows Adopted / Refused (generic) / Unavailable. The finer three-way outcome + support reference needs the rollout engine to surface secret-free codes.
- **"Refused" matrix cell** (per-environment verify-failed). No per-env verify signal exists; the matrix shows Running / not.
- **Roll back as a first-class action.** The design's Releases/Adopt is forward adoption; rolling back is adopting an older offered version through the same wizard (no separate affordance).

## Anti-goals

- Do **not** extend `ManifestDto`, `HiveRolloutDto`, or `RolloutEnvDto`, and do **not** add a server route — TA-6 is portal-only over existing reads + `SelectTarget`.
- Do **not** fabricate a channel, a migration list, an early-access state, per-step progress, a support reference, or a per-environment outcome. An honest coarse outcome beats a fabricated detailed one.
- Do **not** present the Environments step as a selector implying per-env targeting.
- Do **not** modify or delete `hive-detail-view.*` / `hive-detail-view-model.*` (kept dead + compiling per TA-4 R6); lift the reusable derivations into the new VM instead (ruling R3).
- Do **not** flip existing EOL: `tenant-app.ts` and `tenant-api-client.ts` are CRLF; `tenant-types.ts`, the kit and new view/VM files are LF; new files LF. New `.ts` is ASCII.

## Decisions made (rulings the builder inherits)

- **R1 — Adopt is hive-wide.** `SelectTarget(hiveId, version)` is the only adopt op and `HiveRolloutDto` has a single `targetVersion`. The prototype's per-environment multi-select is fiction; the wizard's Environments step is informational, and adopting sets the hive target. Cost if wrong: if per-env targeting becomes a real capability, step 2 becomes a selector + a new server op — localized.
- **R2 — Portal-only, no backend, GAPs deferred.** Every read and the adopt op exist. Channel/migrations/early-access, fine-grained progress, distinct outcome codes + support reference, and the Refused matrix cell are server GAPs filed as Features, not built (building them invents product models or telemetry the spec forbids).
- **R3 — Reshape by lifting, not importing.** Lift the reusable derivations from `HiveDetailViewModel` — version-row badging (Current/Previous/Available/Withdrawn), current-version resolution (`targetVersion` is truth, else the running image only if every environment agrees), and the restart-impact text — into the new `ReleasesViewModel` (or a small shared helper). Leave `hive-detail-view*.ts` untouched and unreferenced; a later cleanup spec removes the dead files.
- **R4 — New kit `Steps` primitive.** `kit/steps.ts`: an ordered list of step labels with an active index and a current-step marker (icon+text, not colour alone), reusable by later wizards (e.g. the Platform Provision wizard). Offer cards compose `Section` + `KeyValueGrid` + `Act`; the matrix uses the existing `DataGrid`. Keep `Steps` minimal (no branching, no validation engine — the view owns step gating).
- **R5 — Adopt gated on `adopt`, UI-only + permissive-fallback.** Render Adopt through kit `Act` keyed on `Capabilities.adopt !== false` (undefined = permissive), naming "the Adopt versions permission" when denied. Note (honesty invariant, per TA-3): the hive target route is **not** server-capability-enforced today and every admin role has `adopt: true`, so this gate never actually denies now — it is forward-compatible, like TA-5's Delete/`envs`. If a future role gets `adopt: false`, the target route must be added to the server capability audit table at the same time (filed Feature).
- **R6 — Honest outcomes.** The Outcome step maps the real `SelectTarget` result: 204 → Adopted (reload shows the new `targetVersion` + per-env running); 409 → Refused, showing the server's generic message verbatim (no added reason, no support reference); 404 → the version is no longer available (reload); 503 → Unavailable (rollout link down), the server message verbatim. No invented verify-failed/gated-out distinction.
- **R7 — Coarse roll-out, no fake steps.** Step 4 awaits `SelectTarget` then reloads `GetRollout`; it shows "Rolling…" while awaiting and never renders fabricated per-step names.

## What's left to the builder

Idiomatic Mural composition within these decisions: offer-card layout, matrix `DataGrid` column/row construction, the `Steps` internals and how the view advances/gates steps, wizard inline hosting, and the test doubles (extend `fake-tenant-control-plane.ts` to serve manifests/rollout/environments and to make `SelectTarget` succeed / 409 / 503 on demand). Follow workspace conventions (OOP, Allman braces, PascalCase public members, enums over string unions, VMs extend `Observable`, no inline string literals, `Disposable` not lambdas) and the existing patterns in `hive-detail-view-model.ts`, `environments-view*.ts`, and the kit.

## Review focus (inputs the screens imply but a happy path misses)

- **Empty offers** (every non-withdrawn manifest is the current target, or only withdrawn ones exist) → the empty state, not a blank or an error.
- **Adopt refused (409)** → the Outcome step shows the generic server message and the hive stays on its current target (reload proves no change); the wizard does not claim success.
- **Adopt while the rollout link is down (503)** → Unavailable outcome with the server message; no fabricated success.
- **A version withdrawn between page load and Adopt** → guarded (withdrawn is never a valid target; the card hides/does not offer Adopt, and a direct confirm is a no-op), ending in a clean Refused/unavailable outcome, never an exception.
- **No environments bound to the hive** → the Environments step and impact text handle the empty case (reuse the hive VM's "no environments are bound to this hive" copy); adopt still sets the target.
- **Adopt denied** (`Capabilities.adopt === false`, a future role) → Adopt rendered visible-but-disabled naming the permission, never hidden; today (all roles `adopt: true`) it is enabled.
