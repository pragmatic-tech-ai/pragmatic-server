# Platform Admin — Registry G2/G3 (publish channel + signing/provenance, withdraw with reason) Design

**Status:** PROPOSED — surfaced for owner review before SDD (signing is security-sensitive).
**Date:** 2026-10-29
**Spec id:** PA-9W (Program 2, Platform Admin)
**Backlog:** reconciliation note `docs/superpowers/notes/2026-10-27-platform-admin-reconciliation.md` section 3 (G2/G3); PA-8R registry design `docs/superpowers/specs/2026-10-28-platform-admin-registry-design.md` deferred list.

---

## 1. Intent and why

The operator Registry (PA-8R read side + PA-R1 publish/gate/ungate + PA-R2 withdraw/restore) today treats a published version as a bare `{ id, image, notes?, publishedAt, withdrawn? }` record. Two gaps the design corpus names as G2/G3:

- **G2 — publish lacks a channel and lacks provenance.** There is no way to mark a version Stable vs Early-access, and nothing records whether the image is *signed*. The platform already owns a complete Ed25519 signing/verification stack (`ImageSigner`, `ISignatureStore`, `IImageDigest`, `CryptoImageVerifier`) — but it is wired only into the hive rollout-pull path, never the operator publish op. So an operator publishes an image whose signature (if any) was produced out-of-band; the Registry UI cannot tell the operator whether a version will actually deploy to a verifying hive.
- **G3 — withdraw is a bare boolean.** Withdrawing a version records no *reason*, no *actor*, no *date*, and offers no *consequence preview*. An operator withdrawing a version cannot see which environments are still running it, and a later operator cannot see why it was withdrawn or by whom.

This increment closes both, **grounded entirely in code that already exists**, and makes the operator publish op finally produce real provenance.

## 2. The honesty invariant (load-bearing)

**What the Registry UI reports about a version's signature MUST equal what a verifying hive will actually accept — never a fabricated digest, signature, or "Signed" badge.**

The hive's `CryptoImageVerifier.Verify` fails closed: an image with no stored signature, or a signature that does not verify against the hive's trust-root public key, is refused *before anything reaches the cluster* (`registry-provenance-smoke.ts` proves this end to end). Therefore:

- "Signed" means: a signature for this image's digest exists in the signature store and was produced by the platform signing key. Nothing weaker earns the badge.
- **"Unsigned" is a first-class, truthful state.** If a digest cannot be obtained honestly (no local docker, image not present) or no signing key is configured, the version is recorded `signed: false` and the UI shows an honest "Unsigned" pill. Publish still succeeds — an unsigned version simply will not roll out to a hive that has a trust root configured, and the UI says so.
- We never invent a digest string or a signature. The digest comes from the same source the verifier uses, or it is absent.

## 3. What already exists (no fabrication needed)

| Piece | Location | Shape |
|---|---|---|
| Manifest model | `admin/control-plane/manifest-record.ts` | `ManifestRecord { id, image, notes?, publishedAt, withdrawn? }`, `ManifestRegistry` (JsonRecordStore) |
| Registry ops | `admin/control-plane/platform-deployment-registry.ts` | `Publish(version, image, notes?)`, `SetWithdrawn(version, bool)`, `AllManifests()`, `ManifestsFor(tenant)`, `Gate/Ungate`, `StatusFor(hive)` |
| Publish/withdraw routes | `admin/control-plane/control-plane-host.ts` | `POST /api/manifests` (`RoutePublishManifest`); `POST`/`DELETE /api/manifests/:version/withdrawn` (`RouteManifestWithdrawn`); both Full-gated by `OperatorAuthorization` |
| Digest | `admin/control-plane/image-digest.ts` | `IImageDigest.Of(imageRef) → digest`; `DockerImageDigest` = `docker image inspect --format {{.Id}}` (reads the **local docker daemon**) |
| Signer | `admin/control-plane/image-signer.ts` | `ImageSigner.Sign(imageRef, signingKeyRef)` — digests the ref, signs with the keystore's private key, `store.Put(digest, signature)` |
| Signature store | `admin/control-plane/signature-store.ts` | `ISignatureStore.Get(digest)→sig?`, `Put(digest, sig)`; `FileSignatureStore` (atomic JSON map, corrupt-safe) |
| Key store | `admin/control-plane/key-store.ts` | `IKeyStore.PrivateKey/PublicKey(ref)`; `FileKeyStore(keysDir)` reads `<ref>.key`/`.pub`, path-escape-safe |
| Verifier (hive side) | `admin/control-plane/image-verifier.ts` | `CryptoImageVerifier.Verify(imageRef, trustRootRef)` Ed25519, fails closed |
| Server wiring | `admin/control-plane/server.ts` | `dataRoot`; `FileKeyStore(join(dataRoot, 'keys'))` already built for the UI deployer; `PlatformDeploymentRegistry` composed here |
| Portal registry | `admin/portal/src/releases-view.ts`, `api-client.ts`, `portal-types.ts` | `ReleasesView` self-routing container with Publish form + withdraw/restore; `PublishManifest`, `SetManifestWithdrawn`; `ManifestDto = { id, image, notes?, publishedAt, withdrawn? }` |

**Constraint that shapes everything:** the only digest source is `docker image inspect` against the daemon local to the control-plane process. Publish-time signing therefore works wherever the control-plane can inspect the image locally (dev, and in-cluster hosts that can see the image), and is **best-effort** elsewhere — recorded honestly as unsigned.

## 4. Out of scope (explicitly — this is NOT G5)

- Min-version floors, version holds, adoption ledger, and **channel-gated rollout eligibility** are **G5 Release Policy**, a separate spec. In this increment `channel` is honest metadata that is recorded, displayed, and filterable; it does **not** change which versions a hive may adopt.
- OCI-registry digest probing (signing an image the local docker cannot inspect) — deferred Feature.
- Re-signing an already-published version, and signing-key rotation UI — deferred Features.

## 5. G2 — publish with channel + signing/provenance

### 5.1 Model
`ManifestRecord` gains three optional fields (all additive; old records load unchanged):
```
channel?: 'stable' | 'early'     // Channel enum; absent == stable (back-compat default)
digest?: string                  // the image content digest actually signed/recorded; absent == not obtained
signed?: boolean                 // true iff a signature for `digest` exists in the store under the platform key
```
A new `Channel` enum (`stable`, `early`) lives in a `channel.ts` (or on the record module) per the enums-over-string-literals rule.

### 5.2 Registry op
`PlatformDeploymentRegistry.Publish(version, image, notes?, channel?)` gains an **optional signing collaborator** injected at construction (so the route stays thin and the registry owns the honest best-effort logic):

```
interface IManifestSigner
{
    // Best-effort: returns the digest it obtained and whether it signed. NEVER throws; a failure
    // (no docker, inspect error, no key) yields { digest: undefined, signed: false }.
    SignForPublish(imageRef: string): Promise<{ digest?: string; signed: boolean }>
}
```
- When a signer is present, `Publish` calls `SignForPublish(image)`; records `digest`/`signed` from its result; records `channel` (default `stable`). Publish succeeds regardless of signer outcome.
- When no signer is configured, `Publish` records `channel` only; `signed` is `false`/absent.
- The concrete `ManifestSigner` composes `IImageDigest` + `ImageSigner` + `ISignatureStore`: `Of(image)` → digest (catch → unsigned); `ImageSigner.Sign(image, platformKeyRef)` (catch → `signed: false` but keep the digest it did obtain); `signed = store.Get(digest) !== undefined`. All failures are swallowed into the honest "unsigned" outcome; nothing from the signing path can fail a publish or leak key material (the existing errors already name only refs, never material).

### 5.3 Host + server
- `RoutePublishManifest` accepts an optional `channel` field (validated against the enum; invalid → 400), passes it through. No change to the Full-gate.
- `server.ts` composes the `ManifestSigner` **only when a platform signing key is configured** (see Decision 1), reusing `dataRoot/keys` (`FileKeyStore`) and a new `signatures.json` under `dataRoot` (`FileSignatureStore`), plus `DockerImageDigest`. Unconfigured → no signer passed → honest unsigned publishes.

### 5.4 Portal
- `ManifestDto` gains `channel?`, `digest?`, `signed?`.
- Publish drawer (`ReleasesView` Publish form): add a **Channel** ComboBox (Stable / Early access; default Stable). No digest/signature input — provenance is produced server-side.
- Registry list + detail: a **Channel** pill (Stable/Early) and a **Signed / Unsigned** pill (icon + text, never color-alone, per the a11y rule), plus the short digest and `publishedAt` provenance in the detail. The "Unsigned" pill carries the honest consequence ("will not deploy to a hive with signature verification").
- **Adoption spread** (the "list-all with adoption spread" part of G2): the detail shows how many observed environments/hives are running this version, computed **client-side from `ListFleet`** (already honest "observed" data) — no new server read.

## 6. G3 — withdraw/restore with reason + actor + date + consequence preview

### 6.1 Model
Enrich the bare boolean into a withdrawal record while keeping the boolean derivable (back-compat for every existing consumer, including the rollout path that only reads `withdrawn`):
```
withdrawn?: boolean                                   // kept; === (withdrawal !== undefined)
withdrawal?: { reason: string; actor: string; at: string }   // actor = operator email; at = ISO
```
`SetWithdrawn(version, withdraw, reason?, actor?)`: on withdraw, requires a non-empty reason, sets `withdrawal` and `withdrawn: true`; on restore, clears `withdrawal` and sets `withdrawn: false`.

### 6.2 Route
- `POST /api/manifests/:version/withdrawn` now reads a JSON body `{ reason }` (required, non-empty → else 400); the **actor is the operator session's email**, resolved server-side (never taken from the body). `DELETE` (restore) takes no body. Both stay Full-gated. Unknown version → 404 (unchanged).
- *Wiring note for the plan:* resolve the acting operator's email from the authenticated session the same way PA-13's roster derives `{email, role}` from the session principal; confirm the exact accessor during T-plan.

### 6.3 Portal
- `ManifestDto` gains `withdrawal?: { reason; actor; at }`.
- Withdraw action opens a dialog with a **required reason** field and a **consequence preview**: the observed environments still running this version (client-side from `ListFleet`), shown before the operator confirms. Restore is a plain confirm.
- The detail shows the withdrawal reason, actor, and date when withdrawn.

## 7. Decisions surfaced for owner sign-off (security-sensitive)

1. **Platform signing key — introduce it now, or defer actual signing?**
   - **(A, recommended)** Add a platform image-signing key config to the control-plane (a key ref env var over the existing `dataRoot/keys` `FileKeyStore` + a `signatures.json` signature store). Publish then *actually signs* best-effort; unsigned is the honest fallback when the key or digest is unavailable. This is the full G2 the user asked for ("publish channel + SIGNING + digest/provenance").
   - **(B)** Record + display `digest`/`channel` and a Signed/Unsigned pill derived from the *existing* signature store (populated out-of-band), but do **not** add a signing key to the host. The "operator publish signs" story defers. Smaller security surface.
2. **Digest source** — v1 uses the existing local-docker digest (`docker image inspect`), best-effort; an **OCI-registry digest probe** (to sign images the local daemon can't see) is deferred as a Feature. Confirm this bound.
3. **Channel is display/filter-only this increment** — recording and showing Stable/Early, with rollout eligibility unaffected (channel-gated adoption = G5). Confirm.

G3 (reason + actor + date + consequence preview) is low-risk and not gated on these — it ships regardless of the Decision-1 outcome.

## 8. Deferred Features (file as Project #1 Kind=Feature)

- OCI-registry digest probe (sign images not present to the local docker daemon).
- Channel-gated rollout eligibility (part of G5 Release Policy).
- Re-sign an already-published version; signing-key rotation UI.
- (If Decision 1 = B) wiring the operator publish op to an actual signing key.

## 9. Security / honesty invariants (review checklist)

- Reported signed-status == what a verifying hive accepts; no fabricated digest/signature/badge.
- Signing-path failures never fail a publish and never leak key material (existing errors name only refs).
- Withdraw actor comes from the server session, never the request body.
- Writes stay Full-gated (publish, withdraw, restore) == server 403 for a non-Full operator; portal mirrors (reported == enforced).
- New `.ts` pure ASCII + LF; `control-plane-host.ts` keeps exactly its 6 pre-existing non-ASCII bytes, adds none.

## 10. Testing / gates

- Control-plane: `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`. New unit tests: `ManifestSigner` honest outcomes (digest+signed / digest+unsigned on sign failure / no-digest unsigned on inspect failure), `Publish` records channel/digest/signed, `SetWithdrawn` reason/actor/at round-trip + restore clears, route 400 on missing reason / invalid channel, actor-from-session.
- Portal: `npm --prefix admin/portal test` + `npm --prefix admin/portal run typecheck`. New tests: channel picker, Signed/Unsigned + Channel pills, withdraw reason-required + consequence preview, detail provenance/withdrawal display.
- Both gates run sequentially (cwd race).

## 11. Proportion

G2 is the larger half (model + registry op + signer collaborator + server config + portal pills/picker). G3 is small (one field, one body param, one dialog). Together: "small-medium" per the reconciliation note. No new subsystem — every primitive already exists; this wires them to the operator publish/withdraw ops honestly.
