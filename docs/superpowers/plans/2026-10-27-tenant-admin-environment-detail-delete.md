# Tenant Admin: Environment detail redesign + Delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the tenant-portal environment detail into a header + three tabs (Application & version / Health & activity / Access) with lifecycle actions and Delete, backed by a new `DELETE /tenant-api/environments/:name` route — using only data the server already returns.

**Architecture:** A thin server slice (new DELETE route reusing the lifecycle ownership guard over the existing `EnvironmentService.Delete`), a client method, two small reusable kit primitives (`Tabs`, `Banner`), and a rebuild of the detail VM + view. Pills/version derivation reuse TA-4's `environment-row` mapping so list and detail never diverge. Everything the prototype shows that the server cannot back is out of scope (see spec Non-goals).

**Tech Stack:** TypeScript (Node control-plane + Mural tenant-portal), node:test, Mural (`StackPanel`/`TextBlock`/`Button`/`ScrollViewer`/`Dialog`), portal kit components.

**Spec:** `docs/superpowers/specs/2026-10-27-tenant-admin-environment-detail-delete-design.md`

## Global Constraints

- **EOL (never flip existing):** `admin/control-plane/tenant-api/tenant-api-endpoint.ts` = **LF**; `admin/tenant-portal/src/tenant-api-client.ts` = **CRLF**; `admin/tenant-portal/src/tenant-app.ts` = **CRLF**; `tenant-types.ts`, `environment-detail-view.ts`, `environment-detail-view-model.ts`, all `kit/*` = **LF**. New files = **LF**.
- New `.ts` code is ASCII (straight apostrophes; `—` for em dash, `·` for middot). Match each file's existing comment style.
- OOP: no free functions, no module-level mutable state; methods on classes. Allman braces. PascalCase for public methods and interfaces. Enums over string-literal unions. VMs extend `Observable`. No inline string literals — hoist to `private static readonly` constants. Teardown via `Dispose()`, not stored lambdas where a disposable fits.
- Do NOT extend `EnvironmentDto`, rollout DTO, or health DTO. Do NOT touch `tenant-tree-view.*` / `hive-detail-view.*`.
- Tests live in `admin/tenant-portal/tests/**` and `admin/control-plane/tests/**` (mirroring existing layout), never beside source.
- Delete has no capability gate (spec R1): every admin role has `envs: true`, so Delete is ownership-guarded + authenticated only, exactly like Start/Stop/Restart.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Review Focus

- **Cross-tenant Delete** → 404 before `EnvironmentService.Delete` is reached (never 403, never reveals existence). Owning tenant → 204. Unknown → 404. → Task 1 tests.
- **`DELETE /tenant-api/environments/a-env/start`** (a lifecycle-shaped path) must NOT match the env-name delete pattern (trailing segment) → falls through to 404; the same path under POST still routes to the action. → Task 1 tests.
- **Delete confirm disabled until typed name matches exactly**, and Cancel/dismiss never calls the client. → Task 5 tests (wiring over kit `ConfirmDialog`, which enforces the match).
- **Tab switch while logs stream** opens no second socket and drops no buffer; `Dispose()`/`StopLogs()` still closes exactly once. → Task 4/5 tests.
- **Failed status** shows the danger Banner AND the tabs (env exists, not blanked); **Unknown** shows the plain note. → Task 5 tests.

---

### Task 1: Server `DELETE /tenant-api/environments/:name` route

**Files:**
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts` (LF)
- Test: `admin/control-plane/tests/tenant-api-mutate.test.ts` (extend)

**Interfaces:**
- Consumes: `IEnvironmentService.Delete(name): Promise<void>` (exists on `EnvironmentService`), `this.service.List()`, `TenantApiEndpoint.Decode`, `WriteNotFound`, `StatusNoContent`.
- Produces: route `DELETE /tenant-api/environments/:name` → `204` (owned) / `404` (unknown or cross-tenant).

- [ ] **Step 1: Write the failing tests** in `tenant-api-mutate.test.ts`. Extend `FakeService` with a recorded `Delete(name)` (push to a `Deletes: string[]` or reuse `Calls` with a delete marker; `async Delete(name): Promise<void>`). Add a `describe('DELETE environment', ...)`:
  - owned: `DELETE /tenant-api/environments/a-env` with `Session(TenantA)` → status `204`, `service` recorded the delete of `a-env`.
  - cross-tenant: `DELETE /tenant-api/environments/b-env` with `Session(TenantA)` → `404`, no delete recorded.
  - unknown: `DELETE /tenant-api/environments/nope` with `Session(TenantA)` → `404`, no delete recorded.
  - lifecycle-shaped path not deletable: `DELETE /tenant-api/environments/a-env/start` → `404`, no delete recorded.
  - (the B session CAN delete `b-env` → `204`, proving only the A session was blocked.)
  Add a `Delete()` request helper to `Fixtures` if one is not present (method `DELETE`, no body).

- [ ] **Step 2: Run the tests to verify they fail.** Run: `npm test -w admin/control-plane -- tenant-api-mutate` (or the repo's control-plane test command). Expected: FAIL (route returns 404 for the owned case / `Delete` never called).

- [ ] **Step 3: Implement the route.** Add `private static readonly EnvNamePathPattern = new RegExp('^' + Prefix + EnvironmentsSegment + '/([^/]+)$')`. In `Handle`, after the POST block and before the `AdminPathPattern` block, add:
  ```ts
  if (method === TenantApiEndpoint.MethodDelete)
  {
      const dm = TenantApiEndpoint.EnvNamePathPattern.exec(path)
      if (dm !== null)
      {
          return await this.RouteEnvDelete(res, dm, session)
      }
  }
  ```
  Implement `private async RouteEnvDelete(res, m, session): Promise<boolean>` mirroring `RouteEnvAction`'s guard: decode the name; `rec = name === undefined ? undefined : this.service.List().find(r => r.name === name)`; if `rec === undefined || rec.tenantId !== session.tenantId` → `WriteNotFound(res); return true`; else `await this.service.Delete(rec.name); res.writeHead(TenantApiEndpoint.StatusNoContent); res.end(); return true`. Add a doc comment matching the file's style (404-not-403 so existence is never revealed; no capability gate per spec R1).

- [ ] **Step 4: Run the tests to verify they pass.** Run: `npm test -w admin/control-plane -- tenant-api-mutate`. Expected: PASS. Then run `npm run typecheck:tools` (or the repo's typecheck) → clean.

- [ ] **Step 5: Commit.** `feat(tenant-api): DELETE /tenant-api/environments/:name (ownership-guarded, 204)`.

---

### Task 2: Client `DeleteEnvironment` + detail source extension

**Files:**
- Modify: `admin/tenant-portal/src/tenant-api-client.ts` (CRLF)
- Modify: `admin/tenant-portal/src/environment-detail-view-model.ts` (LF) — extend `IEnvDetailSource`
- Test: `admin/tenant-portal/tests/tenant-api-client.test.ts` (extend)

**Interfaces:**
- Consumes: `this.EnvRoute(name)`, `this.Send<T>`, `TenantApiClient.MethodDelete`.
- Produces: `TenantApiClient.DeleteEnvironment(name: string): Promise<void>`; `IEnvDetailSource.DeleteEnvironment(name: string): Promise<void>`.

- [ ] **Step 1: Write the failing client test** in `tenant-api-client.test.ts`: calling `client.DeleteEnvironment('e1')` issues a `DELETE` to `/tenant-api/environments/e1` (assert against the existing fetch double / recorded request) and resolves. Mirror an existing lifecycle/delete test (`DisableAccount` uses `DELETE`).

- [ ] **Step 2: Run to verify it fails.** Run the portal test for the client. Expected: FAIL (`DeleteEnvironment` not a function).

- [ ] **Step 3: Implement** `public async DeleteEnvironment(name: string): Promise<void>` → `await this.Send<void>(this.EnvRoute(name), { method: TenantApiClient.MethodDelete })`. Add `DeleteEnvironment(name: string): Promise<void>` to the `IEnvDetailSource` interface in `environment-detail-view-model.ts`. (`TenantApiClient` structurally satisfies the interface; it is passed as the source today.)

- [ ] **Step 4: Run to verify it passes** and typecheck the portal. Expected: PASS, clean.

- [ ] **Step 5: Commit.** `feat(tenant-portal): TenantApiClient.DeleteEnvironment`.

---

### Task 3: Kit primitives — `Tabs` and `Banner`

**Files:**
- Create: `admin/tenant-portal/src/kit/tabs.ts` (LF)
- Create: `admin/tenant-portal/src/kit/banner.ts` (LF)
- Modify: `admin/tenant-portal/src/kit/index.ts` (LF) — export both
- Test: `admin/tenant-portal/tests/kit/tabs.test.ts`, `admin/tenant-portal/tests/kit/banner.test.ts` (new)

**Interfaces:**
- Produces:
  - `Tabs` (extends the appropriate Mural panel base, following `Section`'s pattern): constructed with an ordered set of `{ label: string, content: Visual }`; renders a horizontal strip of tab buttons over one content host showing the active tab; `get ActiveIndex(): number`; `Select(index: number): void` switches the content and raises a property-change (test seam). Active-tab label is visually distinguished (reuse a kit tone/variant; do not invent colour-only state). No overflow/close/animation.
  - `Banner` with `enum BannerTone { Info, Warning, Danger }`: constructed with `{ tone, text, actionLabel?, onAction? }`; renders a toned panel with the text and an optional action button. Expose `get Tone()` / text seam for tests.
- Consumes: existing kit `Tones`/`PillTone` or `ButtonVariant` for toned styling; mirror `Section`/`Act` construction and the no-inline-literals rule.

- [ ] **Step 1: Write the failing tests.**
  - `tabs.test.ts`: a `Tabs` built with three `{label, content}` entries starts with `ActiveIndex === 0` and shows entry 0's content; `Select(2)` makes `ActiveIndex === 2` and swaps the visible content to entry 2's; selecting the current index is a no-op (no duplicate children).
  - `banner.test.ts`: a `Banner` with `BannerTone.Danger` and text renders the text and reports `Tone === Danger`; with an `actionLabel`/`onAction`, clicking the action button invokes the callback once; with no action, no action button is present.
  (Tests that touch themed brushes must construct a themed `Application` — follow `kit/section.test.ts` / `status-pill.test.ts`.)

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (modules do not exist).

- [ ] **Step 3: Implement** `kit/tabs.ts` and `kit/banner.ts` per the Interfaces block; export both (and `BannerTone`) from `kit/index.ts`. Keep each minimal and allman/OOP/constants-hoisted.

- [ ] **Step 4: Run to verify they pass** and typecheck the portal. Expected: PASS, clean.

- [ ] **Step 5: Commit.** `feat(tenant-portal): kit Tabs and Banner primitives`.

---

### Task 4: `EnvironmentDetailViewModel` — Delete + detail data

**Files:**
- Modify: `admin/tenant-portal/src/environment-detail-view-model.ts` (LF)
- Test: `admin/tenant-portal/tests/environment-detail-view-model.test.ts` (extend)

**Interfaces:**
- Consumes: `IEnvDetailSource.DeleteEnvironment` (Task 2); existing `env: EnvironmentDto`, `GetHealth`, log stream.
- Produces on `EnvironmentDetailViewModel`:
  - `Delete(): Promise<void>` → `await this.source.DeleteEnvironment(this.env.name)` (no local state change; the shell navigates away on the Deleted event).
  - Read getters for the tabs' KV, each returning real data: `Name`, `Status` (exists), `RunningVersion` (exists), `Type` (exists), `Template`, `EnvironmentId`, `CreatedAt`, `LiveUrl` (the `httpUrl`, or empty when not Running), `Health` (exists). Derive version/pills consistently with `EnvironmentRow` (spec R5): if a shared helper is cleaner than importing the row, hoist the status→`PillKind` map and the `runningImage`→version split to a small shared home and use it in both; otherwise reuse `EnvironmentRow`. Do not duplicate the mapping inline.

- [ ] **Step 1: Write the failing tests.** Extend the VM test:
  - `Delete()` calls `source.DeleteEnvironment` with the env name exactly once and resolves; a rejection propagates (the view surfaces it).
  - `LiveUrl` is the `httpUrl` when `Status === Running` and empty otherwise.
  - `RunningVersion` after `LoadHealth` is the substring after the last `:` of `runningImage` (matches `EnvironmentRow.Version`); empty when no image.
  - Existing log/health/pause tests still pass (regression).

- [ ] **Step 2: Run to verify the new assertions fail.** Expected: FAIL (`Delete`/`LiveUrl` absent).

- [ ] **Step 3: Implement** the `Delete()` method and the getters; wire version/pill derivation through the shared mapping (R5). No `EnvironmentDto` extension.

- [ ] **Step 4: Run to verify pass** + portal typecheck. Expected: PASS, clean.

- [ ] **Step 5: Commit.** `feat(tenant-portal): env detail VM Delete + tab data getters`.

---

### Task 5: `EnvironmentDetailView` — header + tabs + logs drawer + Delete

**Files:**
- Modify: `admin/tenant-portal/src/environment-detail-view.ts` (LF)
- Test: `admin/tenant-portal/tests/environment-detail-view.test.ts` (new or extend if present)

**Interfaces:**
- Consumes: `EnvironmentDetailViewModel` (Task 4); kit `Tabs`/`Banner` (Task 3), `StatusPill`/`PillKinds`, `ConfirmDialog`/`ConfirmTone`, `KeyValueGrid`, `Section`; `TenantViewBase` helpers (`MakeButton`, `Text`, `message`, `ShowError`, `Run`, `Dispose`).
- Produces: the redesigned view. A `DialogRequested` seam (callback or observable) the shell can host the `ConfirmDialog` through — OR host the dialog inline the way `environments-view` / `tenant-app` already host the create dialog (`dialogHost`). Choose the pattern already used by the shell for the create dialog so Delete's confirm appears the same way; wire it in `tenant-app.ts` only if the existing detail host does not already provide a dialog surface (if `tenant-app.ts` must change, preserve its CRLF).

- [ ] **Step 1: Write the failing view tests.** Extend/author `environment-detail-view.test.ts`:
  - Header renders the name, a status `StatusPill` for `Status`, a health `StatusPill`, and the live URL text when Running (absent/placeholder when not).
  - Three tabs exist with the spec's labels; the Application & version tab shows a KV with version/type/template/id/created-at; the Access tab shows the address; switching to Health & activity reveals the health line and a "View logs" toggle that shows the log region.
  - Clicking Delete opens a `ConfirmDialog` whose confirm is disabled until the typed text equals the env name; confirming calls `vm.Delete()` once; cancel/dismiss does not.
  - `Status === Failed` renders a `Banner` (Danger) and the tabs are still present (not blanked); `Status === Unknown` renders the plain note.
  - `Dispose()` closes the log stream exactly once (regression over existing behaviour); switching tabs does not reopen it.

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (old flat view).

- [ ] **Step 3: Implement** the redesign: header (name + two pills + identity sub-line + copyable live URL), `Tabs` with the three tab contents (Application & version = `KeyValueGrid`; Health & activity = health line + collapsible logs region holding the existing `ScrollViewer`/`TextBlock` tail with Pause/Resume; Access = address `KeyValueGrid`), header actions Start/Stop/Restart/Delete (Delete opens the name-to-confirm `ConfirmDialog` in Danger tone with the fixed consequences from spec R7), and the Failed/Unknown Banner/note. Preserve the log socket lifecycle (open on Refresh, close on Dispose; collapse only hides). Keep lifecycle behaviour (the existing `Run`→`Refresh` path, R-noted in TA-4) intact.

- [ ] **Step 4: Run to verify pass**; run the FULL portal suite + `tenant-app.test.ts` (shell wiring) + portal typecheck. Expected: all PASS, clean.

- [ ] **Step 5: Commit.** `feat(tenant-portal): environment detail redesign (header + tabs + Delete)`.

---

## Self-review notes

- **Spec coverage:** header (T5), three tabs (T5), Delete route (T1), Delete client (T2), Delete dialog (T5), logs-in-drawer (T5), pills (T4/T5), copyable URL (T4/T5), Failed/Unknown banner (T3 Banner + T5), `Tabs` primitive (T3). Non-goals are explicitly out.
- **Type consistency:** `DeleteEnvironment(name): Promise<void>` identical across client, `IEnvDetailSource`, VM call site. `Tabs.Select`/`ActiveIndex` and `BannerTone` used only as defined in T3.
- **Review Focus:** cross-tenant/unknown/lifecycle-shaped-path → T1; confirm-match + cancel → T5; tab-switch socket safety → T4/T5; Failed/Unknown non-blanking → T5.
- **Proportion:** server + client are thin; kit primitives are minimal; the weight is the view rebuild, which is inherent to a redesign.
