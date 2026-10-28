# Tenant Admin: Users & Access page (accounts + tokens) — Design

Date: 2026-10-28. Spec TA-8 of the tenant-admin reconciliation program (`docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md`, §1.5 and §4 item 8, with §3 backend gaps). Precedence as the note records: separation spec > brief > prototype (`dev-kit/design/admin-apps/src/tenant2.jsx` `Users` :54). **The prototype is a design fiction over demo data; this spec re-implements its layout, behaviour and copy against the REAL server reads, never inventing a backend.** Governing principle carried from TA-4/TA-5/TA-6/TA-7.

## Intent and why

Today `NavSection.UsersAccess` renders `UsersAccessHubView`: the Users list plus a button strip that routes to three separate destinations (Service tokens, Roles & privileges, Field security). The design is ONE "Users & Access" page with three tabs — **Users**, **Roles & permissions**, **Tokens** — replacing the strip. TA-8 builds that consolidated page frame, re-skins the Users and Tokens surfaces to the design's treatment, and embeds the existing Roles editor as the **Roles & permissions** tab (the entry point TA-9 will replace with the consolidated security-model editor).

Why now: TA-1 built most of the design-system kit (Pill, Banner, Tabs, ScreenHost, ConfirmDialog, Act, Section, KV); TA-2 built the left-nav shell with `NavSection.UsersAccess`. The three identity views (B1-1 users-access, B1-2 service-tokens, B1-3 roles-privileges) already exist and carry their own loads. TA-8 is the consolidation pass that folds them into one page and closes the two kit gaps the design's Tokens surface needs (`SecretTable`, `OnceSecret`), without touching any server route.

## The reality this is built on (no backend, no DTO changes)

- **Accounts + grants:** `GetAdminSnapshot(env)` → `{ accounts: AccountDto[], grants: GrantDto[] }`, where `AccountDto = { principalId, email, disabled }` and `GrantDto = { subject, role, resourceKind, resourcePath[] }`. Roles shown on an account are its grant roles (`TenantRole`: Owner/Admin/Editor/Viewer/Maker), joined from grants — not the prototype's named business roles. `AccountRow` already projects email/principalId/status/roles.
- **Disable:** `DisableAccount(env, principalId)` (server `DELETE .../accounts/:principal` → `AdminDisableAccount`, which flips the store `disabled` flag). Self-disable and self-revoke already guarded by `PendingKind.DisableSelf`/`RevokeSelf` in `UsersAccessViewModel`.
- **Tokens:** `ListTokens(env)` → `ServiceTokenSummaryDto[]` (`{ tokenRef, principalId, scopes[], expiresAt, revoked }`), `IssueToken(env, params)` → `TokenIssuedDto` (secret returned once), `RevokeToken(env, tokenRef)`. `ServiceTokensViewModel` already models list/issue(one-time reveal)/revoke; `ServiceTokenRow` projects the by-reference row.
- **Roles editor:** `RolesPrivilegesView(source)` over `GetSecurityModel`/`PutSecurityModel` (the 8-action × AccessLevel matrix on `security-model-draft.ts`) — embedded as-is for the Roles & permissions tab.
- **Capability + identity:** `ITenantNavigator.Capabilities.access` gates the page; `OwnerContact` names who to ask when denied; `currentPrincipalId` (from the session) identifies "You". All already wired.
- **Tabs host:** kit `Tabs` (`entries: { label, content: Visual }[]`, `Select(i)`, `onSelect`, `ActiveIndex`/`IsActiveTab` test seams) hosts one view per tab; each embedded view keeps its own env picker, load and Dispose.

## Goals

- **`UsersAccessPageView`** replacing `UsersAccessHubView` for `NavSection.UsersAccess`:
  - A `PageHeader`-style header ("Users & Access" + sub "People and service accounts in this tenant, served by the identity provider in your hive.").
  - kit `Tabs` with three entries: **Users** (`UsersAccessView`), **Roles & permissions** (`RolesPrivilegesView`), **Tokens** (`ServiceTokensView`).
  - Whole-page **denied** gate (kit `ScreenHost` denied state naming "the Manage users & access permission" and `OwnerContact`) when `Capabilities.access === false`, as the hub does today and the design's `Screen allowed={allowed}` does. Permissive when capability is unknown.
  - Attaches the navigator to each embedded view (so any 401 drops to login). **Lazy load:** the Users tab refreshes on mount; each other tab refreshes the first time it is selected. Disposes all three on Dispose.
- **Users tab re-skin** (`UsersAccessView` + `AccountRow`): status rendered via kit `StatusPill` (Active/Disabled, icon+text never colour alone); role chips (one chip per distinct grant role); a "You" tag on the signed-in admin's own row (`currentPrincipalId`); the disable action uses a kit `ConfirmDialog` with the design's plain-language consequences ("They are signed out everywhere and can't sign in. Their records and history stay. Their tokens stop working."); self-lockout confirm on self-disable/self-revoke retained.
- **Tokens tab re-skin** (`ServiceTokensView`): the issued-token list rendered through a new kit **`SecretTable`** (by-reference rows — reference, owner/principal note, status pill, Revoke via `Act`; never a secret value); the one-time issue reveal rendered through a new kit **`OnceSecret`** ("shown once" panel: value, copy, "I have stored it" gate → dismiss). Issue/revoke/expiry behaviour unchanged.
- **New kit primitives:**
  - **`OnceSecret`** — inputs `{ title, value, hint?, onDone }`. Shows the value once with a copy affordance and a gated "I have stored it" button that calls `onDone`; never re-displays or persists the value.
  - **`SecretTable`** — inputs `{ rows: { reference, note?, status, revoked }[], canRevoke, need, onRevoke(reference) }`. Renders each row as reference + note + `StatusPill` + a Revoke `Act` (visible-but-denied when `canRevoke` is false, naming `need`); shows no secret material.
- **Shell wiring:** `ShowSection(NavSection.UsersAccess)` builds `UsersAccessPageView(client, currentPrincipalId)`. The hub button-strip is removed.
- **Tests:** the two new kit primitives (reveal/gate/no-value for `OnceSecret`; row projection, revoke-denied affordance, no-value for `SecretTable`); the page (three tabs, denied gate shown/hidden, lazy refresh per tab, navigator attached, dispose); the Users re-skin (status pill, role chips, "You" tag, disable consequences copy, self-lockout retained); the Tokens re-skin (SecretTable list, OnceSecret reveal/gate); the nav wiring.

## Non-goals (filed as Features, not built — §3 GAPs)

Each of these requires extending the in-hive identity-admin surface — `ILocalAccountStore` / `AdminProtocol` in the `todl-identity` package and the agent handler — which is a cross-package identity capability, not a control-plane route. The reconciliation note classifies all five as GAPs.

- **Invitation-style create (no password):** `CreateAccountParams` is `{ email, principalId, password }`; there is no email-invitation flow in the identity provider. The create dialog keeps the real credential-setting shape (honest copy), re-skinned but not faked into an invitation.
- **Enable account:** only `DisableAccount` exists (the store `Disable` has no inverse exposed through `AdminProtocol`). The design's Enable needs a new store op + protocol method + agent handler.
- **Last sign-in:** the identity provider records no last-sign-in timestamp; the column is omitted rather than fabricated.
- **Named business roles** (Tenant owner / Modeller / Reviewer …): the real model is `TenantRole` grants with resource scoping. Role chips show the real grant roles; the prototype's business-role vocabulary is design-only.
- **Tenant-wide aggregation:** the identity surface is per environment (`/environments/:name/admin/*`). The per-environment picker stays on the Users, Tokens and Roles tabs until a fan-out or aggregate route is decided (B1-1's standing "full-tenant aggregation" slice).
- **Live count badges on tab labels:** kit `Tabs` labels are static; the prototype's per-tab counts are a nicety deferred rather than forcing a dynamic-label rebuild.

## Anti-goals

- Do **not** add a server route or extend any DTO, protocol method or the `todl-identity` package. TA-8 is portal-only over existing reads/writes.
- Do **not** fabricate an invitation flow, an Enable action, a last-sign-in value, named business roles, or a tenant-wide view. An honest absence (the real create shape, the real grant roles, the per-env picker) beats a fabricated reassurance.
- Do **not** ever display a token secret except through `OnceSecret` at issue time; the list is by-reference only (`SecretTable`).
- Do **not** build the consolidated security-model editor here — the Roles & permissions tab embeds the existing `RolesPrivilegesView` unchanged; TA-9 replaces it.
- Do **not** churn `ITenantNavigator`: embed the three views directly as tab content rather than routing through navigator methods (avoids the 6-fake ripple noted in TA-5 R8).
- Do **not** flip existing EOL: `tenant-app.ts` and `tenant-api-client.ts` are CRLF; `tenant-types.ts`, all `kit/*`, and all view/VM/row files are LF; new files LF. New `.ts` is ASCII (escape any em dash/ellipsis/middot as `—`/`…`/`·`, never a raw character).

## Decisions made (rulings the builder inherits)

- **R1 — Portal-only consolidation.** TA-8 ships the three-tab page frame, the Users/Tokens re-skins, and two kit primitives. The five identity GAPs (invitation create, Enable, last sign-in, named roles, tenant-wide) are deferred Features because each needs the cross-package identity-admin surface extended. Cost if wrong: the deferred actions are additive — they land in the Users tab/create dialog when the identity package exposes them; nothing built now blocks them.
- **R2 — Embed, don't route.** The page constructs and embeds `UsersAccessView`, `RolesPrivilegesView` and `ServiceTokensView` as `Tabs` content, attaching the navigator to each. The hub button-strip and its `Navigator.ShowServiceTokens/ShowRolesPrivileges` routing are removed from this page. The navigator interface methods are left in place if any other caller or test fake relies on them (confirmed at plan pre-flight); removing dead ones is a contained follow-up, not an interface churn.
- **R3 — Field security stays separate (for now).** The design folds field rules into Roles & permissions > Fields, but that consolidation is TA-9. TA-8 does not surface a Field security tab; `FieldSecurityView` and `ShowFieldSecurity` remain as they are until TA-9 merges them.
- **R4 — Lazy per-tab load.** Only the initial tab (Users) refreshes on mount; a tab refreshes the first time it becomes active (via `Tabs.onSelect`). Each embedded view owns its env picker and load; the page does not aggregate. Re-selecting a tab does not force a reload.
- **R5 — Reuse the existing VMs and rows.** The Users and Tokens re-skins change the VIEW (pills, chips, You tag, SecretTable, OnceSecret, confirm copy); the view-models (`UsersAccessViewModel`, `ServiceTokensViewModel`) and row projections (`AccountRow`, `ServiceTokenRow`) are reused, extended only where the re-skin needs a derived value (e.g. `AccountRow` exposing distinct role chips and an `IsSelf` flag, computed from data already loaded).
- **R6 — Secrets by reference.** `SecretTable` never renders a secret; `OnceSecret` shows the issued value once, gates dismissal on an explicit "I have stored it", and never re-displays it. This is the honesty invariant for the Tokens tab.
- **R7 — Whole-page denied gate, permissive-unknown.** The page shows a denied `ScreenHost` only when `Capabilities.access === false`; unknown (undefined) is permissive, matching the hub and the other TA views. Per-action gates inside the tabs (Create, Revoke) use `Act` as today.

## What's left to the builder

Idiomatic Mural composition within these decisions: the `OnceSecret` and `SecretTable` layouts, the page header and tab assembly, the role-chip and You-tag rendering on the account row, and the test doubles (reuse/extend `fake-tenant-control-plane.ts`, which already serves accounts/grants/tokens/security-model). Follow workspace conventions (OOP, Allman braces, PascalCase public members, enums over string unions, VMs extend `Observable`, no inline string literals, `Disposable` not lambdas) and the patterns in `users-access-view*.ts`, `service-tokens-view*.ts`, the existing `kit/*` primitives, and the TA-5/TA-7 inline-dialog hosting.

## Review focus (inputs the page implies but a happy path misses)

- **Access denied** (`Capabilities.access === false`) → the whole-page denied `ScreenHost` naming the permission and owner, not a half-rendered page or a blank.
- **Capability unknown** (navigator not yet attached / `Capabilities` undefined) → permissive (tabs shown), never a spurious denial.
- **Switching to a never-loaded tab** → that tab loads on first activation; switching back does not reload or lose its state; a load error in one tab does not blank the others.
- **Signed-in admin's own row** → the "You" tag shows; disabling self or revoking own last role triggers the self-lockout confirm, not a silent lockout.
- **Token issue then dismiss** → the secret shows once in `OnceSecret`, is copyable, and is gone after "I have stored it"; the list row is by-reference with no secret; Revoke denied (future role) shows the visible-but-disabled `Act` naming the permission.
- **401 from any tab's load or action** → drops to login (navigator `ShowLogin`), never a swallowed error or a stale page (the TA-7 session-death-hiding lesson).
- **Disabled vs active account** → correct `StatusPill`; the disable ConfirmDialog states the real consequences (signed out everywhere, records/history stay, tokens stop working).
