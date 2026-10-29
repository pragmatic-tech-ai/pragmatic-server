# Platform Admin — Registry G2/G3 (publish channel + signing/provenance, withdraw with reason) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing Ed25519 signing stack into the operator publish op (channel + real digest/signature/provenance) and enrich withdraw into a reason+actor+date record with a consequence preview — honestly, never fabricating a digest or signature.

**Architecture:** Backend-first. A new `ManifestSigner` (composing the existing `IImageDigest`/`ImageSigner`/`ISignatureStore`) produces a best-effort `{ digest?, signed }` that never throws; `PlatformDeploymentRegistry.Publish` records it plus a `channel`; `SetWithdrawn` records a `{reason, actor, at}` withdrawal. The host passes channel/reason through (actor from the server session). `server.ts` composes the signer only when a platform signing key is configured. The portal surfaces channel/signed/digest pills + provenance and a reason-required withdraw dialog with a consequence preview.

**Tech Stack:** TypeScript (Node), node:test via `npx tsx --test`; TS Mural portal (`admin/portal`) with imperative views + `Observable` VMs.

**Spec:** `docs/superpowers/specs/2026-10-29-platform-admin-registry-signing-design.md`

## Global Constraints

- **Honesty invariant:** reported signed-status == what a verifying hive accepts; NEVER fabricate a digest, signature, or "Signed" badge. "Unsigned" is first-class and truthful. The signing path NEVER throws and NEVER leaks key material.
- Writes stay **Full-gated** (publish, withdraw, restore) == server 403 for non-Full; portal mirrors (reported == enforced).
- Withdraw **actor comes from the server session** (`this.Principal(req)`), never from the request body.
- `channel` is display/filter-only this increment — it does NOT change rollout eligibility (that is G5).
- Digest source is the existing local-docker `DockerImageDigest`; no OCI probe.
- New `.ts` files: **pure ASCII + LF**. `control-plane-host.ts` keeps exactly its **6 pre-existing non-ASCII bytes** — add none. Byte-scan every new/edited `.ts`: `python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"` must be `0 0 N` (host: `6 0 N`).
- House style: OOP (no module-level free functions/vars), Allman braces, no inline string literals (hoist to `private static readonly`), enums over string literals, VMs extend `Observable`, PascalCase public methods/interfaces.
- Two gates, run SEQUENTIALLY: control-plane = `npx tsx --test admin/control-plane/tests/*.test.ts` + root `npm run typecheck:tools`; portal = `npm --prefix admin/portal test` + `npm --prefix admin/portal run typecheck`. Root `npm test` MISSES control-plane tests.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage by explicit path, never `git add -A`. Never touch/stage `docs/`.

## Review Focus

- **Publish when docker is absent / image not pulled:** `DockerImageDigest.Of` rejects → the version must publish `signed:false` with no digest, NOT fail the publish (T1 signer swallows; T2 publish-without-signable-image test).
- **Publish when a signing key is configured but the store already holds a signature for the digest:** `signed` must reflect the store truthfully, not the attempt (T1 store-hit test).
- **Withdraw with an empty/whitespace/missing reason:** 400, no state change (T3 route test).
- **Invalid channel value on publish:** 400, no record written (T3 route test).
- **Old manifest records with no channel/digest/withdrawal fields:** load and render unchanged; `channel` absent reads as Stable, `withdrawn` boolean still derivable (T2 back-compat test; T6/T7 portal render-with-absent-fields test).

---

### Task 1: Channel enum, ManifestRecord provenance fields, and the honest ManifestSigner

**Files:**
- Create: `admin/control-plane/channel.ts`
- Create: `admin/control-plane/manifest-signer.ts`
- Modify: `admin/control-plane/manifest-record.ts`
- Test: `admin/control-plane/tests/manifest-signer.test.ts`

**Interfaces:**
- Consumes: `IImageDigest` (`image-digest.ts`), `ImageSigner` (`image-signer.ts`), `ISignatureStore` (`signature-store.ts`).
- Produces:
  - `export enum Channel { Stable = 'stable', EarlyAccess = 'early' }`
  - `ManifestRecord` gains `channel?: Channel; digest?: string; signed?: boolean; withdrawal?: { reason: string; actor: string; at: string }` (all optional; `withdrawn?: boolean` kept).
  - `export interface IManifestSigner { SignForPublish(imageRef: string): Promise<{ digest?: string; signed: boolean }> }`
  - `export class ManifestSigner implements IManifestSigner` — ctor `(digests: IImageDigest, signer: ImageSigner, store: ISignatureStore, signingKeyRef: string)`.

- [ ] **Step 1: Write failing tests** `admin/control-plane/tests/manifest-signer.test.ts`, with fakes for `IImageDigest`/`ISignatureStore` and a real `ImageSigner` over an in-memory store + a throwaway Ed25519 key (follow `tests/image-verifier.test.ts` fixtures):
  - `test('signs and reports signed when digest and key are available')`: digest resolvable, key present → result `{ digest: <d>, signed: true }` and the store holds a signature at `<d>`.
  - `test('reports unsigned without a digest when the image cannot be inspected')`: `digests.Of` rejects → `{ digest: undefined, signed: false }`, never throws.
  - `test('keeps the digest but reports unsigned when signing fails')`: `digests.Of` resolves but the key is missing (`ImageSigner.Sign` rejects) → `{ digest: <d>, signed: false }`, never throws.
  - `test('reports signed from the store truthfully')`: store already has a signature for the digest → `signed: true` reflects the store, not the attempt.
- [ ] **Step 2: Run tests, verify they fail** — `npx tsx --test admin/control-plane/tests/manifest-signer.test.ts` (FAIL: `ManifestSigner` not defined).
- [ ] **Step 3: Implement.** `channel.ts` = the `Channel` enum. Add the four optional fields to `ManifestRecord`. `ManifestSigner.SignForPublish(imageRef)`: obtain the digest via `this.digests.Of(imageRef)` in a try/catch (catch → `return { signed: false }`); call `await this.signer.Sign(imageRef, this.signingKeyRef)` in a try/catch (swallow failure); then `const signed = (await this.store.Get(digest)) !== undefined` (guard this read too); `return { digest, signed }`. No throw path escapes. All literals hoisted; Allman; pure ASCII + LF.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Byte-scan new/edited files (`0 0 N`), commit** the three `.ts` + test by explicit path.

### Task 2: Registry — Publish records channel/digest/signed; SetWithdrawn records withdrawal

**Files:**
- Modify: `admin/control-plane/platform-deployment-registry.ts`
- Test: `admin/control-plane/tests/platform-deployment-registry.test.ts` (or the existing registry test file; follow what's there)

**Interfaces:**
- Consumes: T1 `Channel`, `IManifestSigner`, enriched `ManifestRecord`.
- Produces:
  - `Publish(version: string, image: string, notes?: string, channel?: Channel): Promise<ManifestRecord>`
  - `SetWithdrawn(version: string, withdraw: boolean, reason?: string, actor?: string): Promise<ManifestRecord>`
  - New optional LAST ctor param `signer?: IManifestSigner` (do not reorder existing params).

- [ ] **Step 1: Write failing tests:**
  - `test('publish records the channel, defaulting to stable')`: `Publish(v, img)` → `channel === Channel.Stable`; `Publish(v, img, undefined, Channel.EarlyAccess)` → `channel === Channel.EarlyAccess`.
  - `test('publish records digest and signed from the signer')`: with a fake signer returning `{ digest: 'd', signed: true }` → record has `digest: 'd', signed: true`.
  - `test('publish without a signer records channel only')`: no signer → no `digest`, `signed` falsy, still succeeds.
  - `test('publish succeeds and records unsigned when the signer cannot sign')`: fake signer `{ signed: false }` → record `signed: false`, no digest, publish resolves.
  - `test('withdraw records reason, actor and timestamp and sets the boolean')`: `SetWithdrawn(v, true, 'bad build', 'op@x')` → `withdrawal = { reason:'bad build', actor:'op@x', at:<iso> }`, `withdrawn === true`.
  - `test('restore clears the withdrawal and the boolean')`: then `SetWithdrawn(v, false)` → `withdrawal === undefined`, `withdrawn === false`.
  - `test('an old record with no new fields still loads and withdraws')` (back-compat).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** `Publish`: build the record, set `channel = channel ?? Channel.Stable`; if `this.signer !== undefined`, `const { digest, signed } = await this.signer.SignForPublish(image)` and assign `digest` (only when defined) and `signed`. `SetWithdrawn`: on withdraw set `withdrawal = { reason: reason!, actor: actor!, at: new Date().toISOString() }` and `withdrawn: true`; on restore delete/omit `withdrawal` and set `withdrawn: false`. (Reason/actor presence is enforced at the route; the registry trusts its caller but the type keeps them optional for restore.)
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Byte-scan, commit** by explicit path.

### Task 3: Host routes — channel on publish, reason+actor on withdraw

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts`
- Modify: `admin/portal/src/portal-types.ts` is NOT here (that's T5); `ManifestDto = ManifestRecord` alias in the host already flows the new fields.
- Test: `admin/control-plane/tests/` host test file covering manifests (follow the existing publish/withdrawn host tests).

**Interfaces:**
- Consumes: T2 `Publish(...channel)`, `SetWithdrawn(...reason, actor)`, T1 `Channel`; existing `this.Principal(req): Promise<OperatorPrincipal | null>` (`{ email, principalId, role }`).

- [ ] **Step 1: Write failing tests:**
  - `test('publish accepts a channel and passes it through')`: POST `/api/manifests` `{version,image,channel:'early'}` → 201, record `channel:'early'`.
  - `test('publish rejects an invalid channel')`: `{...,channel:'beta'}` → 400, nothing published.
  - `test('publish without a channel defaults to stable')`.
  - `test('withdraw requires a non-empty reason')`: POST `/api/manifests/:v/withdrawn` with `{}` or `{reason:'  '}` → 400, not withdrawn.
  - `test('withdraw records the reason and the session actor')`: `{reason:'bad build'}` as the Full operator → 200, record `withdrawal.reason==='bad build'` and `withdrawal.actor` == the session email.
  - `test('restore takes no body and clears the withdrawal')`: DELETE → 200, `withdrawal` cleared.
  - `test('a non-Full operator is still 403 on publish and withdraw')` (gate unchanged).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** In `RoutePublishManifest`: after the existing validations, read optional `body.channel`; if present and not one of the `Channel` values → 400 (new hoisted message); pass `channel` into `Publish`. In `RouteManifestWithdrawn`: for POST, read a JSON object body, require a non-empty trimmed `reason` string (else 400, new hoisted message); resolve `const who = await this.Principal(req)` and `const actor = who?.email ?? who?.principalId ?? ''`; call `SetWithdrawn(version, true, reason, actor)`. DELETE unchanged except it calls `SetWithdrawn(version, false)`. Keep exactly the 6 pre-existing non-ASCII bytes.
- [ ] **Step 4: Run control-plane gate (tests + typecheck:tools), verify pass.**
- [ ] **Step 5: Byte-scan (host `6 0 N`), commit** by explicit path.

### Task 4: Server wiring — compose the signer when a platform signing key is configured

**Files:**
- Modify: `admin/control-plane/server.ts`
- Test: `admin/control-plane/tests/` server test file if one exists; otherwise add a focused test of the new static factory.

**Interfaces:**
- Consumes: T1 `ManifestSigner`, existing `DockerImageDigest`, `FileSignatureStore`, `FileKeyStore`, `ImageSigner`.
- Produces: `private static ManifestSignerOf(env: NodeJS.ProcessEnv, dataRoot: string): IManifestSigner | undefined` (mirrors the existing `UiDeployerOf` pattern) + a new env-var constant `PRAGMATIC_ADMIN_SIGNING_KEY_REF` + `SignaturesFileName = 'signatures.json'`.

- [ ] **Step 1: Write a failing test** `ManifestSignerOf` returns `undefined` when the key-ref env var is unset, and a `ManifestSigner` when it is set (point `dataRoot` at a temp dir). If server.ts has no existing unit test harness, add the smallest one that imports the class and calls the static.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `ManifestSignerOf`: when `env[PRAGMATIC_ADMIN_SIGNING_KEY_REF]` is a non-empty string, build `store = new FileSignatureStore(join(dataRoot, SignaturesFileName))`, `keys = new FileKeyStore(join(dataRoot, KeysDirName))`, `digests = new DockerImageDigest()`, and return `new ManifestSigner(digests, new ImageSigner(digests, store, keys), store, ref)`; else `undefined`. Pass the result as the new last arg to `new PlatformDeploymentRegistry(...)`.
- [ ] **Step 4: Run control-plane gate, verify pass.**
- [ ] **Step 5: Byte-scan, commit** by explicit path.

### Task 5: Portal DTO + client — channel on publish, reason on withdraw

**Files:**
- Modify: `admin/portal/src/portal-types.ts`
- Modify: `admin/portal/src/api-client.ts`
- Test: `admin/portal/tests/` api-client test (follow existing).

**Interfaces:**
- Produces:
  - `ManifestDto` gains `channel?: 'stable' | 'early'; digest?: string; signed?: boolean; withdrawal?: { reason: string; actor: string; at: string }`.
  - `PublishManifest(version: string, image: string, notes?: string, channel?: string): Promise<ManifestDto>` (adds `channel` to the POST body when present).
  - `SetManifestWithdrawn(version: string, withdraw: boolean, reason?: string): Promise<ManifestDto>` (POST body `{ reason }` when withdrawing; DELETE unchanged).

- [ ] **Step 1: Write failing tests:** the client includes `channel` in the publish body when given and omits it otherwise; includes `{ reason }` in the withdraw POST body; DELETE (restore) sends no body.
- [ ] **Step 2: Run portal test, verify fail.**
- [ ] **Step 3: Implement** the DTO + client changes (new hoisted route/field-name consts; no inline literals).
- [ ] **Step 4: Run portal gate (test + typecheck), verify pass.**
- [ ] **Step 5: Commit** by explicit path.

### Task 6: Portal publish picker + channel/signed pills + provenance

**Files:**
- Modify: `admin/portal/src/kit/pill-kinds.ts` (add `Stable`, `EarlyAccess`, `Signed`, `Unsigned`)
- Modify: `admin/portal/src/create-manifest-view-model.ts` (channel into `ICreateManifestSink.PublishManifest` + `Submit`)
- Modify: `admin/portal/src/releases-view.ts` (channel ComboBox in Publish form; Channel + Signed/Unsigned pills in list and/or detail)
- Modify: `admin/portal/src/release-detail-view-model.ts` + `release-detail-view.ts` (digest + channel + signed in the profile/provenance)
- Modify: `admin/portal/src/releases-view-model.ts` / `release-list-row` if the list shows a channel/signed column
- Test: the corresponding `admin/portal/tests/` files.

**Interfaces:**
- Consumes: T5 DTO fields + `PublishManifest(...channel)`; existing `ComboOption {Label, Value}`, `PillKinds.For`, `StatusPill`.
- Produces: `PillKind.Stable/EarlyAccess/Signed/Unsigned` + registry entries (glyph + label + tone, icon+text, never color-alone).

- [ ] **Step 1: Write failing tests:** publish form renders a channel picker defaulting to Stable and passes the chosen channel to the sink; the detail (and list, if a column is added) renders a Channel pill and a Signed/Unsigned pill with icon+text; a record with `signed:false` shows "Unsigned"; a record with no `channel` renders as Stable; the digest shows (shortened) in the detail provenance when present and is absent otherwise.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Add the four `PillKind` entries + labels. `CreateManifestViewModel.Submit(version, image, notes, channel)` and `ICreateManifestSink.PublishManifest(..., channel?)`. In `BuildPublish`, add a Channel `ComboBox` (`ComboOption` Stable/Early access; default Stable) and thread the value into `Submit`. In the detail VM/view, add channel + Signed/Unsigned pill + digest (shortened) + `publishedAt` to the profile. Keep all copy in hoisted consts; pure ASCII + LF.
- [ ] **Step 4: Run portal gate, verify pass.**
- [ ] **Step 5: Byte-scan new/edited files, commit** by explicit path.

### Task 7: Portal withdraw reason dialog + consequence preview + withdrawal provenance

**Files:**
- Modify: `admin/portal/src/release-detail-view.ts` (reason-required withdraw dialog + consequence preview; withdrawal reason/actor/date display)
- Modify: `admin/portal/src/releases-view.ts` (thread the reason into `client.SetManifestWithdrawn`)
- Modify: `admin/portal/src/release-detail-view-model.ts` if the consequence/withdrawal display needs derivation (it already exposes `AdoptionRows` and can expose the withdrawal)
- Test: `admin/portal/tests/` detail/releases tests.

**Interfaces:**
- Consumes: T5 `SetManifestWithdrawn(version, withdraw, reason?)`; existing `ConfirmDialog`/dialog-support; existing `ReleaseDetailViewModel.AdoptionRows` (envs observed running `manifest.image`) for the consequence preview.
- Changes the detail view's withdraw callback shape to `(withdraw: boolean, reason?: string) => Promise<void>`.

- [ ] **Step 1: Write failing tests:**
  - withdraw opens a dialog that requires a non-empty reason (confirm disabled/blocked until a reason is entered);
  - the dialog shows the consequence preview (the environments still running the version — from `AdoptionRows`; empty-state when none);
  - confirming calls `SetManifestWithdrawn(version, true, reason)` with the typed reason;
  - restore does NOT prompt for a reason and calls `SetManifestWithdrawn(version, false)`;
  - when the manifest is withdrawn, the detail shows the withdrawal reason, actor, and date.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Replace the direct withdraw toggle with a reason-required dialog (reuse `ConfirmDialog`/dialog-support; the consequence preview lists `AdoptionRows`). Change `onToggleWithdrawn` to accept `(withdraw, reason?)`; `ReleasesView.BuildDetail` passes the reason through to `client.SetManifestWithdrawn`. Add withdrawal reason/actor/date to the detail when `manifest.withdrawal` is present. Hoisted copy; pure ASCII + LF.
- [ ] **Step 4: Run portal gate, verify pass.**
- [ ] **Step 5: Byte-scan, commit** by explicit path.

---

## Self-Review Notes

- **Spec coverage:** G2 channel (T1 enum, T2 record, T3 route, T6 picker/pill), G2 signing/digest/provenance (T1 signer, T2 publish, T4 server config, T6 pills/digest), G2 adoption spread (T6/existing `AdoptionRows`), G3 reason+actor+date (T2 record, T3 route actor-from-session, T7 display), G3 consequence preview (T7 via `AdoptionRows`). All covered.
- **Type consistency:** `Channel` (T1) used by T2/T3 (control-plane) and mirrored as the `'stable'|'early'` string union in `ManifestDto` (T5) — intentional (portal does not import control-plane types). `SignForPublish` shape is identical in T1 and its T2 consumer.
- **Review Focus:** each of the five lines has an owning test (T1 store-hit + inspect-fail, T2 publish-without-signable-image, T3 empty-reason + invalid-channel, T6/T7 absent-fields render).
- **Proportion:** backend is T1-T4 (signer + two op changes + thin route + config); portal is T5-T7 (DTO/client + picker/pills + dialog). No new subsystem.
