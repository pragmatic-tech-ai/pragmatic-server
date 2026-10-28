# TA-15 - Environment application operations - Design

**Status:** approved under the Program 2 autonomous mandate (recon done; proceeds to plan + SDD).
**Area:** Tenant Admin > Environment detail - Application & version tab and Access tab (read-only enrichment).
**Builds on:** the Environment detail view (TA-5, three tabs: Application & version / Health & activity / Access), the shared `EnvironmentDtoMapper`, the TA-14 session activity already on the Health tab.
**Reconciliation:** `docs/superpowers/notes/2026-10-27-tenant-admin-reconciliation.md` section 1.3 (Environment detail), section 3 (backend gaps), section 4 item 15.

## The scope decision (recon finding + ruling)

The design's TA-15 is three operational surfaces on Environment detail: Deploy/Redeploy UI bundle, 24 h health history + events + pod/active-user metrics, and an OIDC client credential with Rotate. Recon found that each requires a backend that either does not exist or that the architecture deliberately withholds from the tenant plane:

- **Deploy/Redeploy UI bundle - architecturally gated, deferred.** `EnvironmentService.DeployAppToEnvironment(name, bundle)` and `UiDeployActuator` exist, but they take a `UiDeployBundle` of actual UI *files*; the only bundle in-tree is the hardcoded `NorthwindUiBundle` demo fixture, and `DeployAppToEnvironment` is reachable only from the in-cluster smoke test. There is **no tenant-facing bundle source, no upload surface, and no mapping from an adopted version (a server image) to a UI bundle.** Worse, the actuator signs every bundle with the **hive trust root** (a platform key) and serves it in-cluster. Letting the less-trusted self-service tenant plane push platform-signed, in-cluster-served UI would cross the trust boundary the separation architecture draws (platform controls what is signed and served; the tenant dials home, never the reverse). So a tenant "Deploy UI bundle" action is **deferred** - not merely for lack of a route, but because granting it would invent a product/backend model the architecture withholds. A button that cannot honestly act is not shown.
- **Health history / 24 h strip / events / pod counts / active users - no data, deferred.** `HiveHealthDto` is current-state only (`ready`, `runningImage`, `detail`); the events socket carries no history and the bus keeps none; there is no pod-count or active-user source (recon section 3). The honest live signal already on the Health tab is TA-14's session activity plus the current health line. The 24 h strip, historical event feed, and pod/active-user metrics are **deferred**.
- **OIDC client credential + Rotate - no backing data, deferred.** The `EnvironmentRecord` carries **no OIDC-client credential reference** of any kind - only `endpoint` and `idpBaseDomain`. The design's "Sign-in as by-reference SecretTable `oidc-client/<id>` with Rotate" has nothing to reference and no rotation mechanism (same posture as TA-13's deferred credential Rotate: a security control that cannot act is dishonest). **Deferred.**
- **Verification-failed reason + support reference + fail-closed danger Banner - no data, deferred.** The rollout DTO has `ready`/`obsolete`/`runningImage` only; there is no verify-failed reason or `ADP-xxxx` support reference. **Deferred.**

What **does** exist and is genuine: `EnvironmentRecord.appDeployment` (`appName`, `appVersion`, plus internal registry coordinates `repo`/`artifactTag`/`manifestDigest`) records the UI artifact deployed into the environment - and because `UiDeployActuator` refuses an unsigned deploy, a recorded `appDeployment` was signed against the hive trust root by construction. `EnvironmentRecord.idpBaseDomain` records the federated in-cluster sign-in host when the environment is federated to its tenant IdP.

**Ruling: TA-15 is a read-only enrichment of Environment detail over genuine data, with one safe backend touch.** It surfaces the deployed UI bundle's identity and signed status on the Application & version tab, and the federated sign-in address on the Access tab - all read-only, presence/identity only, never the internal registry coordinates, never a secret. Everything that would require a tenant deploy path, a history store, or a credential/rotation that does not exist is a deferred GAP (filed Feature). This is the standing never-invent-a-backend / secrets-and-internals-by-reference-only / reported==enforced discipline applied to the environment operations surface - the same ruling shape as TA-13.

## The one honest backend touch

`EnvironmentDtoMapper.ToDto` is the single source of truth for the environment wire shape, shared by the operator surface and the tenant read API. TA-15 **extends `EnvironmentDto` with two optional read-only fields**, derived in that mapper - no new route:

```
uiBundle?: { appName: string; appVersion: string }   // from appDeployment presence - IDENTITY ONLY
idpBaseDomain?: string                                // the federated sign-in host base domain, when federated
```

`uiBundle` is derived from `appDeployment` and carries **only** the app name and version the tenant already knows - **never** `repo`, `artifactTag`, or `manifestDigest` (internal registry coordinates stay off the wire, matching the `HiveDto` posture of keeping internals off the tenant surface). `idpBaseDomain` is copied as-is (the public address where the tenant's users sign in). A server test asserts the serialized DTO never carries the internal registry coordinates. Because the mapper is shared, both fields are safe for the operator surface too (no secret, no cross-tenant data).

## Goals

- **Application & version tab** gains two read-only rows over the existing version/type/template/id/created grid:
  - **UI bundle**: `uiBundle.appName uiBundle.appVersion`, or an honest "No UI bundle deployed yet" when absent.
  - **Image signature**: "Signed by the platform trust root" when a `uiBundle` is present (signed by construction), or a neutral "Not applicable" / em-dash when absent. (Honest wording: "Signed", not a live "Verified" claim the tenant surface cannot make.)
- **Access tab** gains a read-only **Sign-in address** row: the federated in-cluster sign-in host derived from `idpBaseDomain` (e.g. `<environmentId>.<idpBaseDomain>`) when federated, or an honest "Standard address" / "Not federated" note when `idpBaseDomain` is absent - alongside the existing live URL.
- The page stays **read-only**: no Deploy/Redeploy, no Rotate, no history strip. No dead or disabled operation controls.
- Honest absent states for every new row (no bundle, not federated).

## Non-goals

- **Deploy/Redeploy UI bundle** (and any bundle upload) - architecturally gated from the tenant plane; deferred GAP. No button that claims to deploy.
- **24 h health history, historical event feed, pod counts, active users** - no store exists; deferred GAP. (TA-14 session activity + the current health line remain the honest Health-tab content.)
- **OIDC client credential reference + Rotate** - no such field or mechanism; deferred GAP. No SecretTable, no Rotate.
- **Verification-failed reason, support reference, fail-closed danger Banner** - no data; deferred GAP.
- **"Newer version offered" panel on Environment detail** - belongs to TA-6 (Releases/Adopt); kept out of TA-15 to hold the scope boundary.
- **Exposing `repo`/`artifactTag`/`manifestDigest` or any secret** - never; app identity + presence only.
- A new mutation route, a bundle store, or any change beyond the two additive optional read-only DTO fields.

## Anti-goals (a failure even if it "works")

- A Deploy/Redeploy or Rotate control that looks functional but acts on nothing - the honesty invariant on an operations/security surface; reported == enforced.
- Leaking the internal registry coordinates (`repo`/`artifactTag`/`manifestDigest`) onto the tenant surface.
- Claiming live "Verified" when the tenant surface only knows the bundle was signed at deploy.
- Fabricating a 24 h health history, pod counts, or active-user numbers to fill the design's mockup.
- Anything cross-tenant/hive/platform.

## Information architecture (the decided shape)

- `EnvironmentDto` (both the server `environment-dto.ts` and the portal `tenant-types.ts`) gains the two optional read-only fields; `EnvironmentDtoMapper.ToDto` derives them from the `EnvironmentRecord` (`uiBundle` from `appDeployment` identity only; `idpBaseDomain` copied).
- `EnvironmentDetailViewModel` gains read-only getters over the (extended) env DTO: a UI-bundle summary, a signature-status label, and a sign-in-address label - each with its honest absent form.
- `EnvironmentDetailView.MakeApplicationTab` adds the UI bundle + image signature rows to the existing `KeyValueGrid`; `MakeAccessTab` adds the sign-in address row. No new controls, no tab added.

## What's left to the builder (plan + implementation calls)

- Exact copy for the new rows and their absent states (all hoisted to `private static readonly`): the "No UI bundle deployed yet", the signature wording ("Signed by the platform trust root" vs neutral absent), and the sign-in-address derivation + "Not federated" note.
- Whether the sign-in address is the bare `idpBaseDomain` or the derived `<environmentId>.<idpBaseDomain>` host - prefer the full host the tenant's users actually use, falling back honestly when `idpBaseDomain` is absent.
- Whether the signature row renders as a plain KV value or a kit `StatusPill` (e.g. `PillKind.Signed`) - builder's call; prefer whatever reads honestly without implying a live action.
- The exact `uiBundle` derivation in `EnvironmentDtoMapper` (app name + version only from `appDeployment`; omit the block when `appDeployment` is undefined) and a server test asserting the DTO never serializes `repo`/`artifactTag`/`manifestDigest`.
- The VM getter names and whether they read the env DTO the view already holds or go through the VM - follow the existing `Version`/`Type`/`LiveUrl` getter pattern.

## Constraints (inherited, binding)

- OOP, Allman braces, PascalCase public methods/interfaces, no inline string literals (hoist to `private static readonly`), enums over unions, VMs extend `Observable`, `IDisposable` not lambdas, tests under `admin/tenant-portal/tests/` (portal) and the control-plane `tests/` (server).
- New portal `.ts` files pure ASCII + LF; byte-scan after every write. The server `environment-dto.ts` is LF (verified) - keep LF. `environment-detail-view.ts` and `tenant-types.ts` are LF - keep LF. Check and preserve each file's EOL; never `sed -i` a CRLF file. Escape any non-ASCII as `\uXXXX` and re-scan after the Write tool.
- **Security:** the DTO change adds app identity + a public sign-in host ONLY; a server test must assert no internal registry coordinate (`repo`/`artifactTag`/`manifestDigest`) and no secret is ever serialized. The mapper is shared with the operator surface - keep it secret-free for both. Nothing cross-tenant; reported capability == enforced.
- Portal gate: `npm test` + `npm run typecheck` in `admin/tenant-portal`. Server gate: repo-root `npm test` + `typecheck:tools`. BOTH green on the merged result (TA-15 touches the server DTO).

## Review focus (inputs no happy-path test exercises)

- The extended `EnvironmentDto` **never** carries `repo`/`artifactTag`/`manifestDigest` or any secret - only `uiBundle.appName`/`appVersion` + `idpBaseDomain`. (Server test on `JSON.stringify(dto)`.)
- An environment with no `appDeployment` -> `uiBundle` omitted (server) and the Application tab shows the honest "No UI bundle deployed yet" (portal), no crash. (Both layers.)
- An environment with no `idpBaseDomain` (not federated) -> the Access tab shows the honest "Not federated"/standard-address state, not a blank or a fabricated host. (Portal.)
- No Deploy/Redeploy, Rotate, or history control renders anywhere on Environment detail. (View test.)
- The signature row reads "Signed", not a live "Verified" claim, and only when a bundle is present. (View test.)
- The shared mapper change does not alter the existing operator-surface fields or URLs. (Server test over the existing DTO shape.)
