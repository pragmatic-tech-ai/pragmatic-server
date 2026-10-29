# Platform Admin — Release Policy (G5) Design

**Status:** PROPOSED — surfaced for owner review before SDD (this governs what version runs in customer hives; a policy bug can let a withdrawn/unapproved version roll, or wedge all upgrades).
**Date:** 2026-10-29
**Spec id:** PA-G5 (Program 2, Platform Admin)
**Builds on:** PA-9W registry signing (Channel on each manifest) — `docs/superpowers/specs/2026-10-29-platform-admin-registry-signing-design.md`; the gating/adoption model in `admin/control-plane/platform-deployment-registry.ts`.

---

## 1. Intent and why

Today a version is adoptable by a hive **iff it is _gated_ for the hive's tenant** — a per-`(tenantId, version)` allowlist (`PlatformDeploymentRegistry.Gate`). That single boolean is the only release control. It cannot express: "freeze this tenant during an incident", "don't offer the preview channel to a tenant that only wants stable", "never roll below `1.4.0`", or even "a version I withdrew must stop being adoptable".

Release Policy generalizes the one adoption decision into a small, explicit **policy** evaluated at every adoption / selection / offer point, adding four controls:

1. **Withdraw enforcement (bug fix).** The `ManifestRecord.withdrawn` doc comment says a withdrawn version "is not offered as a roll target," but the code only checks gating: a withdrawn-but-gated version is still adoptable today. Close the gap at the policy point.
2. **Hold / freeze.** An operator places a tenant on hold (with a reason); while held no new version may be selected or adopted. Reversible — an incident brake.
3. **Channel subscription (channel-gated adoption).** PA-9W put a `Channel` (Stable / EarlyAccess) on every version but it is display-only. A tenant subscribes to a set of channels; only a version on a subscribed channel is adoptable. Makes the channel load-bearing.
4. **Min-version floor.** A per-tenant floor version; no version **below** the floor may be selected or adopted (block rollback to a known-bad / older release). Needs a version comparator (no `semver` dep in this workspace -> a small ASCII comparator class).

## 2. Security / honesty spine (load-bearing)

- **Single decision point.** All four rules **and** the existing gating check live in ONE server method (`EvaluatePolicy(tenantId, manifest)`), applied identically at `SelectTarget` (operator push), `RecordAdoption` (agent pull, over the public agent channel), and `AdoptableFor` (the list the agent is offered). The agent channel **cannot** bypass policy — it calls the same method. **Reported == enforced:** `AdoptableFor` returns exactly the versions `RecordAdoption` would accept.
- **Fail closed.** Unknown / withdrawn / held / below-floor / unsubscribed-channel -> the version is **refused** (a typed error -> 403/409), never silently rolled. The default (a tenant with no policy record) is spelled out in §4 and chosen to not silently narrow what is adoptable today beyond the channel decision surfaced in §7.
- **Full-gated == enforced.** Every policy mutation is a mutating operator route denied to a ReadOnly operator by the central `OperatorAuthorization` (server 403); the portal mirrors. Actor (for a hold) comes from the session, server-side.
- **No secrets.** Policy carries no secret material. New `.ts` pure ASCII + LF; `control-plane-host.ts` keeps its 6 pre-existing non-ASCII bytes.

## 3. What exists vs. what is a gap (recon result)

| Capability | Exists? | Note |
|---|---|---|
| Per-tenant version allowlist (`gating`) | yes | `Gate`/`Ungate`; `Record` enforces it for push+pull; `AdoptableFor` offers it. Policy is layered on top, not a replacement. |
| `Channel` on a manifest | yes (display only) | PA-9W. Never read in the adoption path. G5 makes it load-bearing via channel-subscription. |
| Withdraw a version | yes (not enforced in adoption) | `SetWithdrawn` flags it; `Record`/`AdoptableFor` do **not** filter it -> **gap**, closed here. |
| Hold / freeze a tenant | no | New. |
| Min-version floor | no | New; needs a version comparator (no `semver` dep). |
| Version comparator | no | New `VersionOrder` class (pure ASCII). `localeCompare` mis-orders `1.10.0` vs `1.9.0`. |
| Read-only policy dashboard | yes | Portal `ReleasePolicyView` already joins gating + selections + rollout status to names. G5 makes it **editable** and adds policy state. |
| Adoption ledger (version-change history) | no | **Deferred** — belongs with the G9 audit store; only the latest selection is kept today. |

## 4. Backend design

**New state — `ReleasePolicyRecord` + `ReleasePolicyRegistry`** (`release-policy-record.ts`, a `JsonRecordStore` keyed by tenantId, loaded in `ManifestPublish.Compose` and passed to the registry):

```ts
export type ReleasePolicyRecord = {
    id: string            // === tenantId
    tenantId: string
    channels?: Channel[]  // subscribed channels; absent => the default in §7
    minVersion?: string   // inclusive floor; absent => no floor
    hold?: { reason: string; actor: string; at: string } // absent => not held
}
```

An **absent** record means: not held, no floor, channels per the §7 default. This keeps policy a thin overlay on gating.

**New `VersionOrder` class** (`version-order.ts`): `public static Compare(a: string, b: string): number` -> `-1 | 0 | 1`. Split on `.`; compare segment-by-segment: both-numeric -> numeric; otherwise the segment compares as a string; a missing segment is lower (so `1.4` < `1.4.1`). Pure, dependency-free, ASCII. Used only for the floor check (`Compare(manifest.id, minVersion) >= 0`).

**`PlatformDeploymentRegistry`** gains:
- private `EvaluatePolicy(tenantId: string, manifest: ManifestRecord): void` — throws the first failing rule's typed error, in a fixed order: not-gated -> withdrawn -> on-hold -> channel-not-subscribed -> below-floor. `Record` calls it (replacing the inline gating check); `AdoptableFor` filters `ManifestsFor(tenantId)` by "does `EvaluatePolicy` pass" (a boolean sibling `IsAdoptable`).
- public mutations (all persist one policy record, create-or-merge): `SetChannels(tenantId, channels)`, `SetMinVersion(tenantId, version)` / `ClearMinVersion(tenantId)`, `SetHold(tenantId, reason, actor)` / `ClearHold(tenantId)`.
- public read `AllPolicies(): readonly ReleasePolicyRecord[]`.

**New error classes** (`rollout-errors.ts`), mapped in `ControlPlaneHost.ErrorStatuses` and the agent channel's refusal mapping: `ManifestWithdrawnError` (409), `TenantOnHoldError` (409), `ChannelNotSubscribedError` (403), `VersionBelowFloorError` (409). Messages are fixed safe labels. The agent channel already funnels `ManifestNotGatedError` -> its `AdoptRefusedMessage` 403; the new errors join the same "not adoptable" refusal (403) there — the agent is never told which rule failed (operator detail stays on the operator plane).

**Gating stays a pure allowlist.** `Gate`/`Ungate` are unchanged; policy is an orthogonal filter evaluated at adopt/select/offer. (Ruling §6: we do **not** also block gating a withdrawn version — gating is harmless while policy refuses the adoption; one enforcement point, not two.)

### Host routes (operator plane, Full-gated, keyed by tenant id in the path — the id is the platform's own, not a secret, consistent with `/api/tenants/:id/gating`)
- `GET /api/policies` -> `AllPolicies()`.
- `PUT /api/tenants/:id/policy/channels` body `{ channels: ('stable'|'early')[] }` -> `SetChannels`. Validate every entry against the wire enum (400).
- `PUT /api/tenants/:id/policy/min-version` body `{ version: non-empty string }` -> `SetMinVersion`; `DELETE` -> `ClearMinVersion`.
- `POST /api/tenants/:id/policy/hold` body `{ reason: non-empty trimmed string }` -> `SetHold` (actor from `this.Principal(req)`); `DELETE` -> `ClearHold`.
All mutating -> Full-gated automatically by `OperatorAuthorization`; ReadOnly -> 403 before the handler.

## 5. Portal design
- Make the existing read-only `ReleasePolicyView` **editable**: a per-tenant policy panel (channel segmented/checkbox control Stable/EarlyAccess; min-version text input with set/clear; **Hold** toggle with an inline reason panel — this portal has no modal, same inline-confirm ruling as PA-9W/PA-S2), all gated on `operator.CanMutate` (visible-but-disabled for an Observer with the existing hint).
- Surface policy state in the dashboard: a **Held** badge (with reason tooltip) on the owner, the floor, and the subscribed channels; the gated/adoptable tables show which gated versions are actually adoptable under policy vs. blocked (a muted "blocked: withdrawn / channel / floor / held" tag — reported == what the agent is offered).
- Client methods on `ControlPlaneClient`: `SetTenantChannels`, `SetTenantMinVersion`, `ClearTenantMinVersion`, `SetTenantHold`, `ClearTenantHold`; `ListPolicies` (or fold into the view's existing multi-fetch). New `PolicyDto = { tenantId; channels?; minVersion?; hold? }` in `portal-types.ts` (string-union channels, no control-plane import).
- The portal does **not** pre-compute floor/channel refusals authoritatively beyond display — the server decision is authoritative; 403/409 reasons surface inline (same reported-permissive / server-enforcing pattern as TA-3).

## 6. Decisions ruled (no owner input needed)
- **Grain = per-tenant** (matches gating). Per-hive holds/floors are a deferred Feature. *Cost if wrong:* a tenant with mixed-criticality hives can't freeze just one; cheap to add a hive overlay later.
- **Min-version floor is a free version string**, not required to be a published manifest id (you floor at a version regardless of what this platform published). Validated only as non-empty + parseable by `VersionOrder`. *Cost if wrong:* a typo'd floor could block everything; the operator sees the floor in the UI and the blocked tags make it obvious.
- **One enforcement point:** policy filters adopt/select/offer; `Gate` stays a permissive allowlist. *Cost if wrong:* an operator can gate a version that policy then refuses — visible as a "blocked" tag, not a silent failure.
- **Withdraw enforcement is in, unconditionally** (it is a bug fix, not a scope option).

## 7. Decisions surfaced for owner sign-off

> **OWNER DECISIONS (2026-10-29):** (1) **Scope A — full four-rule policy.** (2) **Default channel subscription = all-channels (pure back-compat):** an **absent** `channels` field means *all channels are allowed* (adoptable exactly as today); channel gating only restricts a tenant once an operator sets an explicit subscription. The channel rule in `EvaluatePolicy` therefore passes unconditionally when the policy record has no `channels`, and refuses only a version whose channel is not in a configured non-empty `channels` set. Everything below reflects these.

1. **Scope — (A) full four-rule policy (recommended): withdraw-enforcement + hold + channel-subscription + min-version floor, all at the single policy point, with the editable portal.** vs **(B) safety core only: withdraw-enforcement + hold now; defer channel-subscription and min-version floor (the two that add the most new surface — the comparator and channel semantics) as Features.** (A) is cohesive — one evaluator, one portal panel — and delivers the whole G5 headline; (B) is smaller and ships the two highest-safety controls fastest.
2. **Default channel subscription for a tenant with no policy record:** **Stable-only (recommended) — EarlyAccess becomes opt-in**, the useful semantic and safe because there are no production tenants to disrupt yet; vs **all-channels** — pure backward-compat, channel gating only bites once an operator configures it (but then EarlyAccess is adoptable by everyone by default, which undercuts the point of channels).

## 8. Deferred Features (file as Project #1 Kind=Feature)
- **Adoption ledger** — append-only per-hive version-change history (who/what/when). Belongs with the **G9 audit store**; today only the latest selection is kept.
- **Per-hive holds / floors** (vs per-tenant).
- (If scope B) channel-subscription gating; min-version floor + `VersionOrder`.

## 9. Security invariants (review checklist)
- Policy + gating evaluated in ONE method; `SelectTarget`, `RecordAdoption`, and `AdoptableFor` all route through it (agent channel cannot bypass). `AdoptableFor` == the set `RecordAdoption` accepts (reported == enforced).
- Fail closed: every added rule refuses (typed error) rather than rolling; the agent channel's refusal reveals no per-rule detail.
- Every policy mutation Full-gated (server 403 == portal gating); hold actor from the session, not the body.
- Withdrawn version is not adoptable (gap closed) and the existing withdraw/restore round-trips through it.
- `VersionOrder.Compare` orders numeric segments numerically (`1.10.0` > `1.9.0`), treats a missing segment as lower, and never throws on odd input.
- New `.ts` pure ASCII + LF; `control-plane-host.ts` keeps its 6 pre-existing non-ASCII bytes.

## 10. Testing / gates
- **Control-plane** unit tests: each rule refuses in isolation and passes when satisfied; rule precedence order; `AdoptableFor` filters exactly what `RecordAdoption` accepts (same fixture, both paths); withdraw makes a gated version non-adoptable and restore re-enables it; hold set/clear; channel subscribe/unsubscribe (incl. the §7 default); floor boundary (equal = adoptable, one below = refused) with `1.9.0`/`1.10.0`; `VersionOrder` table test; each operator route 403 for ReadOnly; route validation (bad channel 400, empty hold reason 400); agent-channel adopt of a policy-refused version -> 403 with the generic refusal. Gate: `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`.
- **Portal** tests: policy panel gated by role; channel/min-version/hold edits -> client call + re-fetch; hold inline-confirm; blocked tags reflect server state; 403/409 surfaced inline. Gate: `npm --prefix admin/portal test` + `npm --prefix admin/portal run typecheck`.
