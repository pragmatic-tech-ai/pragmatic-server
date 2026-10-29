# PA-S1 - Platform Admin Settings Write v1 (invite / create operator) - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; user chose "Invite/create operator" at the fork, with the credential-surface nuance surfaced). Proceeds to plan + SDD. The portal's first account-credential write. The backend endpoint already exists and is already Full-operator-only via the central gate; this spec wires a Full-gated form to it. No new backend, no new route, no authorization rule.
**Area:** Platform Admin portal (`admin/portal/`) only. No control-plane source change AND no new control-plane test (PA-13's rbac suite already locks `POST /api/operators` -> ReadOnly 403 + password-not-echoed).
**Builds on:** PA-13 Settings READ (`SettingsView` / `SettingsViewModel` / `OperatorContext`, the roster + session), PA-R1 write pattern (`operator.MutatingAct` -> Full-gated `Act`, re-fetch after write, no optimistic mutation; `CreateManifestViewModel` as the create-VM template), PA-R1 `ReleasePolicyView` mode sub-state (a single-screen `ScreenHost` view's write sub-state), `CreateHiveView`/`CreateTenantView` `ComboBox` pattern, `LoginView` masked password field (`TextBox.IsPassword`).

## Context

PA-13 added the read-only Settings page: the signed-in operator's session (email + role) and, for Full operators, the operator roster (`GET /api/operators`). The one operator-management mutation with an EXISTING backend is CREATE:

- `POST /api/operators` body `{ email, password, role }` (role wire `'full'|'readonly'`) -> `HandleCreateOperator` -> `operator.CreateOperator(email, password, role)` -> `201 { email }`. The password is NEVER echoed (documented at `control-plane-host.ts:1292`). `400` with a field message when email is implausible, password `< MinOperatorPasswordLength`, or role invalid. Full-only via the central `OperatorAuthorization.Authorize` (any mutating method for a non-Full role -> 403, before routing).

The other operator mutations (disable / change-role / reset-password / revoke-sessions) have NO endpoint and are out of scope. `SettingsView` (a single-screen `ScreenHost` view) already shows the roster for Full operators and a `DeniedStatePanel` for Observers; it is the natural host for an "Invite operator" form. `app.ts` already mounts `SettingsView(client, operator, email)` (PA-13) - no mount change.

## Recon findings (binding) + rulings

1. **Zero control-plane change (source AND test).** `POST /api/operators` exists and is Full-gated; PA-13's `control-plane-host-rbac.test.ts` already asserts a ReadOnly operator gets 403 on it AND that a Full operator's create response does not echo the password. Ruling: add NO route, NO authz change, and NO new control-plane test (the invariant the UI relies on is already locked). This is a portal-only spec.

2. **An "Invite operator" form on `SettingsView`, gated to Full, via a mode sub-state.** `SettingsView` is a `ScreenHost` single-screen view (like `ReleasePolicyView`). Ruling: add a `SettingsMode { Normal, Invite }` enum + a fresh form slot rebuilt per `BuildContent` (the view's fresh-slot invariant), an "Invite operator" Full-gated `Act` in the Operators section (shown only in the `CanMutate` branch - an Observer already sees the `DeniedStatePanel` and never the action), and the invite form when `mode === Invite`. Do NOT add a new routed view.

3. **The form: email + masked password + role picker.** Ruling: email `TextBox`; password `TextBox` with `IsPassword = true` (masks glyphs, `.Text` holds the real value - same as `LoginView`); role `ComboBox` with two items mapping label->wire (`{ OperatorContext.RoleLabel('full') -> 'full' }`, `{ RoleLabel('readonly') -> 'readonly' }`), DEFAULTING to ReadOnly (least privilege). The role wire strings get a single home: add `ReadOnlyWireRole` next to the existing `FullWireRole` on `OperatorContext` (fills the deferred readonly-wire-const item). Submit is a Full-gated `Act`; plus a cancel `KeyActivatedButton` and an error `TextBlock`.

4. **Validation + honesty: the SERVER owns the password rule.** Ruling: client-side `CanSubmit` requires email present + password present + a role selected (never submits an obviously empty form). It does NOT hardcode the server's `MinOperatorPasswordLength` (reported != enforced risk if the number drifts); the server's `400` field message is surfaced on the error line. The password travels only in the POST body (same mechanism as `Login`), is never logged, and the response (`{ email }`) carries no secret. After a successful create -> `mode = Normal` then `Refresh()` re-fetches the roster (NO optimistic row insertion). On error -> one error line, stay in Invite mode.

5. **A `CreateOperatorViewModel extends Observable`** mirroring `CreateManifestViewModel`: `CanSubmit(email, password, role): boolean`, `async Submit(email, password, role): Promise<void>` (trims email, passes the password verbatim, delegates to `client.CreateOperator`), a busy flag + error surface. Keeps validation testable and matches the established create-VM pattern.

6. **Fresh slot per render / double-parent safety.** The invite `Act`, the form Visuals (`TextBox`/`ComboBox`), the error line, and the "Invite operator" action are rebuilt FRESH every `BuildContent` (a Visual holds one parent). The view already rebuilds `sessionSlot`/`operatorsSlot` fresh; the form slot follows the same rule and `ClearSlots` resets it + `mode`.

## Goals

- Let a Full operator invite/create an operator (email + password + role) from Settings, hitting the existing Full-gated `POST /api/operators`, then see the roster refresh from the server.
- Keep the action Full-gated (Observer never sees it; the server 403s anyway) and honest (server owns the password rule; no optimistic row; the password is never echoed/logged).
- Reuse the PA-R1 create-VM + mode-sub-state pattern, the `ComboBox` role picker, and the masked-password field; add no backend, route, authz rule, or kit primitive.

## Non-goals / deferred (filed as Features)

- Disable / change-role / reset-password / revoke-sessions (NO backend endpoint - a separate backend build).
- A generated/temporary password or an email-invite flow (the endpoint takes a caller-supplied password; no mail backend).
- A password-strength meter or echoing the server's exact min-length as a client rule (server owns it; surface its message).
- Operator status / last-login / created-at columns (no backend field; PA-13 deferred).

## Anti-goals (a failure even if it "works")

- An Observer able to reach the create call (must be gated; the action lives only in the `CanMutate` branch and is built via `MutatingAct`; the server 403s regardless).
- Logging the password, putting it in a URL/query, echoing it back, or storing it in a field beyond the in-flight form (`.Text`).
- Optimistically inserting the new operator row instead of re-fetching the roster (reported != enforced if the server rejects).
- Hardcoding the server's min-password-length as the portal's rule (drift risk) instead of surfacing the server's 400 message.
- Adding a new route, authz rule, kit primitive, or control-plane test; inline user-facing literals; a form that double-parents on re-render.

## Information architecture (decided shape)

Portal (`admin/portal/src/`):

- `operator-context.ts` - add `public static readonly ReadOnlyWireRole = 'readonly'` next to the existing `FullWireRole` (single home for the wire strings the role picker uses).
- `api-client.ts` - add `CreateOperator(email: string, password: string, role: string): Promise<void>` -> `POST /api/operators` body `{ email, password, role }` (mirror `CreateClient`; reuse the `OperatorsRoute` constant and the body-key constants, hoisting `password`/`role`/`email` keys if not already present). Returns void (the roster re-fetch is the source of truth).
- `create-operator-view-model.ts` (NEW) - `extends Observable`, mirrors `CreateManifestViewModel`: `CanSubmit(email, password, role): boolean` (email + password non-blank after trim of email, role non-empty), `async Submit(email, password, role): Promise<void>` (trims email, passes password verbatim, calls `client.CreateOperator`), busy + error surface, change keys. Hoist all literals.
- `settings-view.ts` - add `enum SettingsMode { Normal, Invite }` (module-level) + a `private mode` field + a fresh `formSlot` per `BuildContent`. In the `CanMutate` branch of the Operators section, add an "Invite operator" Full-gated `Act` (`operator.MutatingAct`), and when `mode === Invite` build the invite form into `formSlot`: email `TextBox`, password `TextBox` (`IsPassword = true`), role `ComboBox` (two label->wire items, default ReadOnly), a Full-gated submit `Act`, a cancel `KeyActivatedButton(-> mode Normal)`, an error `TextBlock`. `EnterMode(m)` re-renders WITHOUT a fetch. Submit: `CanSubmit` guard (else required-field line), `try { await vm.Submit(...); mode = Normal; await Refresh() } catch { error line }`. `ClearSlots` resets `formSlot` + `mode`. Hoist every literal (labels, placeholders, role-option labels come from `OperatorContext.RoleLabel`).

Control plane: no change (source or test).

Tests:

- Portal (`admin/portal/tests/`):
  - `api-client-platform.test.ts` - `CreateOperator('a@x.test','pw','readonly')` issues `POST /api/operators` with body `{email,password,role}` (mirror `CreateClient`).
  - `create-operator-view-model.test.ts` - `CanSubmit` false on blank email / blank password / empty role, true otherwise; `Submit` delegates to `client.CreateOperator` with trimmed email + verbatim password + role; error surfaced + busy cleared.
  - `settings-view.test.ts` (extend) - the "Invite operator" action shows for a Full operator and is absent/denied for an Observer (the Observer sees the `DeniedStatePanel`, no invite action); entering Invite mode shows the form (email/password/role); the password box has `IsPassword === true`; submit (Full) calls `CreateOperator(email, password, role)` then re-fetches the roster (`ListOperators` called again) and returns to Normal; blank-field submit is a no-op with a required-field line; a SECOND `Refresh()` with the form open rebuilds cleanly (no double-parent); the role `ComboBox` defaults to ReadOnly.

## Constraints (inherited, binding)

- OOP; Allman braces; PascalCase public methods/interfaces; enums over string-literal unions; view-models extend `Observable`; `IDisposable` not lambdas; tests under `tests/`.
- No inline user-facing / reused string literals - hoist to `private static readonly` (body keys email/password/role, action/field labels, placeholders, error text, mode strings). Role wire strings single-homed on `OperatorContext`.
- New/edited `.ts`: pure ASCII, LF. Byte-scan every written `.ts` -> `0 0 N`. `control-plane-host.ts` NOT touched. Match EOL (all LF).
- HONESTY / SECURITY: the action is gated with `operator.MutatingAct` (== server 403); the password travels only in the POST body (like `Login`), is never logged/echoed/stored beyond the form; the server owns the min-length rule (surface its 400); no optimistic roster row; re-fetch after create.
- Gate asymmetry: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; portal `npm test` + `npm run typecheck` in `admin/portal`. BOTH green on the merged result (control-plane unchanged, but re-run to confirm the merged tree).
- No cross-app import; the form survives a second render / `Refresh()` (fresh slot per render); add no kit primitive, no route, no authorization rule, no control-plane test.

## Review focus (inputs no happy-path test exercises)

- An Observer in Settings -> NO "Invite operator" action (they get the `DeniedStatePanel` for the roster); and the server 403s `POST /api/operators` for ReadOnly (already locked by PA-13's rbac test). (Settings-view test + the existing CP test.)
- Blank email / blank password / no role -> submit is a no-op with a required-field line; no `POST` fires. (VM + view tests.)
- A password shorter than the server's minimum -> the server 400s and its field message shows on the error line (the portal did NOT pre-judge the length). (View test with a client fake returning the 400 message.)
- The password box masks glyphs (`IsPassword === true`) and the password is never placed in a log/URL - only the POST body. (View test asserts `IsPassword`; code review asserts no logging.)
- After a successful create, the roster reflects the SERVER via a re-fetch (`ListOperators` re-called), not an optimistic insert. (View test.)
- A second `Refresh()` with the invite form open rebuilds cleanly, form slot + mode reset, no double-parent. (View test.)
- The role `ComboBox` defaults to ReadOnly (least privilege), and its two options map to the `'full'`/`'readonly'` wire values. (View test.)
