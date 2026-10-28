# TA-15 Environment application operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only enrichment of Environment detail - the deployed UI bundle's identity and signed status on the Application & version tab, and the federated sign-in address on the Access tab - over genuine `EnvironmentRecord` data, via one safe additive read-only `EnvironmentDto` extension (app identity + sign-in host only, never internal registry coordinates). No deploy/rotate/history controls.

**Architecture:** Mostly read-only. The shared `EnvironmentDtoMapper.ToDto` gains two optional fields derived from the record (`uiBundle` from `appDeployment` identity; `idpBaseDomain` copied); the internal registry coordinates (`repo`/`artifactTag`/`manifestDigest`) stay off the wire. The portal mirrors the type and renders the new rows on the existing two tabs - no new route, no mutation surface, no new tab.

**Tech Stack:** TypeScript. Server: `admin/control-plane` (tests from repo root). Portal: `admin/tenant-portal` (Mural kit, Observable VMs, tsx).

**Spec:** `docs/superpowers/specs/2026-10-28-tenant-admin-env-app-operations-design.md`

## Global Constraints

- OOP only; no module-level free functions or mutable module state. Allman braces. PascalCase public methods/interfaces. VMs extend `Observable`. `IDisposable`, not disposer lambdas.
- No inline string literals: hoist every user-facing/reused literal to `private static readonly`. Enums over string-literal unions (reuse `PillKind` if a pill is used for signature status).
- New portal `.ts` files pure ASCII + LF; byte-scan after every write (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` -> `0 0 N`). Existing files to touch are LF (`environment-dto.ts`, `tenant-types.ts`, `environment-detail-view.ts`, and their tests) - check and PRESERVE; never `sed -i` a CRLF file. Escape any non-ASCII as `\uXXXX`, re-scan after the Write tool.
- **Security (binding):** the DTO change exposes `uiBundle.appName`/`appVersion` + `idpBaseDomain` ONLY. A server test MUST assert the serialized DTO never contains `repo`, `artifactTag`, or `manifestDigest`, nor any secret. The mapper is SHARED with the operator surface - keep it secret-free for both; do not alter the existing fields/URLs.
- No new route; no change to `EnvironmentService`/`ITenantDirectory`; no mutation. No Deploy/Redeploy, Rotate, or history control renders (deferred operations must not appear as dead buttons).
- Portal gate: `npm test` + `npm run typecheck` in `admin/tenant-portal`. Server gate: repo-root `npm test` + `typecheck:tools`. BOTH green on the merged result.

## Review Focus

- `EnvironmentDto` **never** carries `repo`/`artifactTag`/`manifestDigest` or any secret - only `uiBundle.appName`/`appVersion` + `idpBaseDomain`. (Task 1 server test on `JSON.stringify(dto)`.)
- No `appDeployment` -> `uiBundle` omitted (server) and the Application tab shows the honest "No UI bundle deployed yet" (portal). (Both tasks.)
- No `idpBaseDomain` (not federated) -> Access tab shows the honest "Not federated"/standard state, not a blank or fabricated host. (Task 2.)
- No Deploy/Redeploy, Rotate, or history control renders on Environment detail. (Task 2 view test.)
- The signature row reads "Signed" (not live "Verified") and only when a bundle is present. (Task 2 view test.)
- The shared mapper change does not alter existing operator-surface fields/URLs. (Task 1 server test over the existing shape.)

---

### Task 1: Extend `EnvironmentDto` with read-only `uiBundle` + `idpBaseDomain` (server + portal type)

**Files:**
- Modify: `admin/control-plane/environment-dto.ts` (add the two optional fields to `EnvironmentDto`; derive them in `EnvironmentDtoMapper.ToDto`)
- Modify: `admin/tenant-portal/src/tenant-types.ts` (mirror the two optional fields on the portal `EnvironmentDto`)
- Test: the control-plane test covering `EnvironmentDtoMapper` (find the existing env-dto/mapper test under `admin/control-plane/tests/`; follow its style - create `tests/environment-dto.test.ts` matching the server harness if none exists)

**Interfaces:**
- Consumes: `EnvironmentRecord` (`appDeployment?: { appName; appVersion; repo; artifactTag; manifestDigest }`, `idpBaseDomain?: string`), the existing `EnvironmentDtoMapper.ToDto(r)`.
- Produces (used by Task 2): on BOTH server and portal `EnvironmentDto`:
  - `uiBundle?: { appName: string; appVersion: string }`
  - `idpBaseDomain?: string`
  - Derivation in `ToDto`: `uiBundle` included only when `r.appDeployment !== undefined`, set to `{ appName: r.appDeployment.appName, appVersion: r.appDeployment.appVersion }` (NEVER copy `repo`/`artifactTag`/`manifestDigest`); `idpBaseDomain` copied from `r.idpBaseDomain` (omit when undefined). All existing fields unchanged.

- [ ] **Step 1: Write the failing server test:** `ToDto` with a record carrying `appDeployment` (incl. repo/artifactTag/manifestDigest) + `idpBaseDomain` yields `uiBundle.appName`/`appVersion` and `idpBaseDomain`; `JSON.stringify(dto)` does NOT contain the `repo`/`artifactTag`/`manifestDigest` values; a record with no `appDeployment` yields `dto.uiBundle === undefined`; a record with no `idpBaseDomain` yields `dto.idpBaseDomain === undefined`; the existing fields (name/status/httpUrl/wsUrl/...) are unchanged.
- [ ] **Step 2: Run it, verify it fails** (repo-root `npm test` filtered to the new/edited test).
- [ ] **Step 3: Implement** the two optional fields on the server `EnvironmentDto` + the derivation in `EnvironmentDtoMapper.ToDto`; mirror the two optional fields on the portal `tenant-types.ts` `EnvironmentDto`.
- [ ] **Step 4: Run green.** Repo-root `npm test` + `npm run typecheck:tools`; portal `npm run typecheck`. Byte-scan: `environment-dto.ts` + `tenant-types.ts` stay LF/ASCII.
- [ ] **Step 5: Commit** `feat(tenant-admin): expose deployed UI bundle identity + sign-in host on EnvironmentDto, never internal coordinates`.

---

### Task 2: Environment detail - UI bundle + signature rows (Application tab) and sign-in address (Access tab)

**Files:**
- Modify: `admin/tenant-portal/src/environment-detail-view-model.ts` (add read-only getters: UI-bundle summary, signature-status label, sign-in-address label, each with its honest absent form)
- Modify: `admin/tenant-portal/src/environment-detail-view.ts` (add the UI bundle + image signature rows to `MakeApplicationTab`; add the sign-in address row to `MakeAccessTab`; hoist all new literals)
- Test: `admin/tenant-portal/tests/environment-detail-view.test.ts` (and `-view-model.test.ts` if the VM getters are tested there - follow the existing split)

**Interfaces:**
- Consumes: Task 1's extended `EnvironmentDto` (`uiBundle?`, `idpBaseDomain?`); the kit `KeyValueGrid` (and optionally `StatusPill`/`PillKind.Signed`).
- Produces: read-only VM getters (names following the existing `Version`/`Type`/`LiveUrl` pattern), e.g. `UiBundle: string` (`"<appName> <appVersion>"` or the honest absent text), `SignatureStatus: string` (or a pill kind), `SignInAddress: string` (the `<environmentId>.<idpBaseDomain>` host or the honest "Not federated" text). The view renders them on the existing two tabs.

- [ ] **Step 1: Write failing tests:**
  - VM (or view): with a DTO carrying `uiBundle` + `idpBaseDomain`, the getters return the app identity, a "Signed" status, and the derived sign-in host; with neither, they return the honest absent forms ("No UI bundle deployed yet", neutral signature, "Not federated").
  - View: the Application & version tab shows the UI bundle + image signature rows (signature reads "Signed" only when a bundle is present); the Access tab shows the sign-in address row; an environment with no bundle / not federated renders the honest absent states; and NO Deploy/Redeploy, Rotate, or history control is present (structural: assert the tab hosts contain no `Button` beyond the existing lifecycle/logs controls, and no new action affordance).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the VM getters + the view rows. No new controls, no new tab. Hoist all literals. Preserve LF/ASCII.
- [ ] **Step 4: Run green.** Portal `npm test` + `npm run typecheck`. Byte-scan the touched files (LF/ASCII preserved).
- [ ] **Step 5: Commit** `feat(tenant-portal): Environment detail shows deployed UI bundle, signature, and sign-in address (read-only)`.
