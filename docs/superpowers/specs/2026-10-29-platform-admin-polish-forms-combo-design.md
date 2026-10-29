# PA-P2 - Polish: preserve open write-forms across auto-refresh + unify ComboBox options - Design

**Status:** approved under the Program 2 autonomous mandate (user said "finish with the polish, then start backend work"; this is the remaining no-backend polish, bundled as one spec). Proceeds to plan + SDD. Portal-only; no backend/route/authz change.
**Area:** Platform Admin portal (`admin/portal/`): the two single-screen write-form views (`SettingsView`, `ReleasePolicyView`) and the three ComboBox option classes (`HiveOption`, `RoleOption`, `ClientOption`).
**Builds on:** PA-S1 (invite form + the "never store the password in a field" invariant), PA-R1 (gate/ungate form + mode sub-state), the `ComboBox` usage in `create-hive-view`/`create-tenant-view`/`settings-view`.

## Context

Two loose ends flagged across PA reviews, both no-backend:

1. **An events-WS auto-refresh wipes an open write-form.** The shell subscribes `client.OnChanged(() => void current.Refresh())`. For the single-screen `ScreenHost` views, `Refresh()` re-fetches and rebuilds `BuildContent` - which rebuilds the form fresh, discarding whatever the operator was typing (email/password/role in `SettingsView` invite; tenant/version in `ReleasePolicyView` gate/ungate). (The `SectionContainerView` create forms - Clients create, Releases publish - are NOT affected: the base `Refresh()` is a no-op in `Custom` state.) Storing the typed values as draft fields would preserve them, BUT holding the PASSWORD in a view field violates PA-S1's binding invariant ("the password lives only in the form `.Text` + the Submit call, never in a field"). 

2. **Three near-identical ComboBox option classes.** `HiveOption {Label, Value}` (`create-hive-view`), `RoleOption {Label, Value}` (`settings-view`), `ClientOption {Label, Id}` (`create-tenant-view`) - the same 2-field label/value shape, duplicated, with `ClientOption` even naming its second field `Id`. PA-S1's review flagged the cross-view coupling risk (it was briefly `import { HiveOption }` into settings).

## Recon findings (binding) + rulings

1. **Defer the auto-refresh while a write-form is open (do NOT store drafts).** Ruling: in `SettingsView.Refresh` and `ReleasePolicyView.Refresh`, early-return (skip the fetch + re-render) when a form mode is active (`mode !== Normal`) and a model already exists - the open form, with everything the operator has typed, is left untouched. This PRESERVES the password safely (it is never copied into a field; the live `TextBox` just isn't torn down), fixes the wipe for email/role/tenant/version too, and needs no draft state. The surrounding data sections show the last-fetched data until the form closes (acceptable: brief staleness during an active edit). After the form closes, refresh resumes: `Submit` already sets `mode = Normal` then `await Refresh()` (now proceeds); cancel via `EnterMode(Normal)` re-renders from the current model. This changes the SEMANTICS of "a Refresh while the form is open" from "rebuilds fresh" to "left intact" - the existing such tests are updated accordingly and gain a typed-value-survives assertion.

2. **One shared kit `ComboOption {Label, Value}`.** Ruling: add `admin/portal/src/kit/combo-option.ts` - `export class ComboOption { public constructor(public readonly Label: string, public readonly Value: string) {} }` - exported from the kit index. Migrate all three sites to it: `create-hive-view` (`HiveOption` -> `ComboOption`), `settings-view` (`RoleOption` -> `ComboOption`), `create-tenant-view` (`ClientOption` -> `ComboOption`, including its read `selected.Id` -> `selected.Value`). Delete the three local classes. This is a tiny DATA class (not a Visual/control primitive), so it does not reintroduce a "kit primitive" in the sense PA-P1 forbade; unifying it is the explicit goal here.

3. **No behavior change beyond the two items.** The defer-refresh is purely a re-render suppression while a form is open (no data/semantic change to what a submit/fetch does); the `ComboOption` migration is a type/name consolidation with identical runtime values. No backend/route/authz/mural change.

## Goals

- An operator typing in the invite or gate/ungate form does not lose their input when a background events-WS refresh fires; the password is still never stored in a field.
- One shared `ComboOption` type replaces the three duplicated option classes; no cross-view option import remains.

## Non-goals / deferred (filed as Features)

- Draft persistence that survives NAVIGATION away from the view (only the open-form-during-auto-refresh case is addressed).
- A loading/stale indicator while a refresh is deferred (the data is briefly stale; no banner in v1).
- Any backend work (that is the next spec: the provisioning wizard).
- Changing the `SectionContainerView` create forms (already unaffected).

## Anti-goals (a failure even if it "works")

- Storing the password (or any field) in a view field to "preserve" it - the defer approach must keep the password in the live `TextBox` only (PA-S1 invariant holds).
- Deferring a refresh in a way that leaves the view permanently stale (it MUST resume once the form closes - submit and cancel both restore normal refresh).
- A `ComboOption` migration that changes a selected value's meaning (e.g. leaving a `.Id` read against a `.Value` field) or drops the ReadOnly default / client-id mapping.
- Re-introducing a cross-view option import; inline literals; a double-parent regression.

## Information architecture (decided shape)

Portal (`admin/portal/src/`):
- `kit/combo-option.ts` (NEW) + `kit/index.ts` export - `ComboOption { Label, Value }`.
- `create-hive-view.ts` - replace `HiveOption` with `ComboOption` (items + the `SelectedItem as ...` read).
- `create-tenant-view.ts` - replace `ClientOption` with `ComboOption`; `new ClientOption(displayName, id)` -> `new ComboOption(displayName, id)`; the submit read `selected.Id` -> `selected.Value`.
- `settings-view.ts` - replace the local `RoleOption` with `ComboOption`.
- `settings-view.ts` + `release-policy-view.ts` - `Refresh()` early-returns when `mode !== Normal` (a form is open) and a model already exists, so the open form is not torn down.

Tests:
- `admin/portal/tests/` - update the existing "Refresh while the form is open rebuilds cleanly" cases in `settings-view.test.ts` + `release-policy-view.test.ts` to the new intent: a Refresh while the form is open LEAVES the form intact AND a value typed into a field SURVIVES the refresh (assert the box's `.Text` still holds the typed value, same instance); after submit/cancel, refresh resumes (a subsequent Refresh re-renders / the roster re-fetches). The create-hive / create-tenant / settings ComboBox tests still pass with `ComboOption` (default selection, client-id mapping, role wire).

## Constraints (inherited, binding)

- OOP; Allman braces; PascalCase public methods/interfaces; enums over string-literal unions; view-models extend `Observable`; `IDisposable` not lambdas; tests under `tests/`.
- No inline reused literals.
- New/edited `.ts`: pure ASCII, LF. Byte-scan each written `.ts` -> `0 0 N`. Match EOL (all LF).
- PA-S1 PASSWORD INVARIANT HOLDS: the password is never copied into a view field; the defer approach keeps it in the live `TextBox` only.
- No cross-app import; no backend/route/authz/mural change. The forms still survive a second render where applicable (the defer does not reintroduce a double-parent; cancel/submit re-render fresh).
- Gate asymmetry: portal `npm test` + `npm run typecheck` in `admin/portal`; root `npm run typecheck:tools`. control-plane unaffected (re-run `npx tsx --test` only if a shared file is touched - it is not). BOTH green on the merged result.

## Review focus (inputs no happy-path test exercises)

- The INVITE form open with a half-typed email/password/role, then an events-WS `Refresh()` fires -> the form and ALL typed values (including the password, still only in the `TextBox`) survive. (settings-view test.)
- The GATE/UNGATE form open with a typed tenant/version, then `Refresh()` -> survives. (release-policy-view test.)
- After submit (mode -> Normal) a refresh RESUMES and re-fetches; after cancel the view shows current data - the defer is not permanent. (both view tests.)
- The password is NOT present in any view field after the refresh (only in the box). (code review + the fact that no draft field is added.)
- `create-tenant-view`'s client picker still maps the selected option to the client ID (the `.Id` -> `.Value` rename did not break the read). (create-tenant test.)
- No `HiveOption`/`RoleOption`/`ClientOption` references remain; no cross-view option import. (grep in the final task.)
