# Demo UI Bundle + Full e2e Smoke (Spec 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the whole in-cluster UI-serving pipeline end to end — give northwind a real UI bundle and a gated kind e2e that deploys it (build→push→sign→pod-pull+verify+unpack→browser-serve), plus a tamper test.

**Architecture:** Task 1 adds a minimal northwind UI as a reusable `NorthwindUiBundle.Load(): UiDeployBundle` (the in-process bundle the Spec-3 actuator consumes — config + raw-byte files; the UI reaches the pod via `DeployAppToEnvironment`, NOT the seed, since that is the path the e2e must exercise). Task 2 is a gated standalone smoke (the `IsEntryPoint()`/`Main()`/`Run()` convention the sibling in-cluster smokes use — **not** a `tests/` file, operator-run on kind+Docker+Playwright) that extends the federation-smoke flow with: the Spec-1 registry provisioned (RenderRegistry + the registry node-port added to the kind `extraPortMappings`), `EnvironmentService` composed WITH the Spec-3 `UiDeployActuator` (its 10th ctor arg), a `DeployAppToEnvironment(env, NorthwindUiBundle.Load())`, a Playwright assertion that `https://<env>.<baseDomain>/app/<tenant>/northwind/` serves the shell, and a tamper case proving a mutated artifact fails pod-side verification (UI never serves).

**Tech Stack:** TypeScript (Node), `kind`, `kubectl`, `docker`, ingress-nginx (pinned `controller-v1.11.3`, ssl-passthrough), `playwright` (chromium, already a devDep), the Specs 1-3 classes. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-10-26-sp-hive-in-cluster-app-ui-serving-design.md` (§7 Spec 4). Builds only Spec 4.

## Global Constraints

- OOP, Allman braces, PascalCase public members, no inline string/number literals (hoist). LF endings. NodeNext `.js` imports. Never `npm install` at repo root. Uint8Array (not Buffer) in the artifact surfaces.
- Secrets/keys/signatures by name only. Type gates: `npx tsc -p tsconfig.tools.json --noEmit` and `-p tsconfig.tenant-admin.json --noEmit`. Admin test runner: `npx tsx --test admin/control-plane/tests/<file>.test.ts`.
- The e2e smoke is OPERATOR-GATED: verified here only by `tsc` clean + not test-discovered (no `tests/` path, no `node:test` import); actually running it against kind is a manual/operator step, like the sibling in-cluster smokes.
- Reuse (do not re-implement): `NorthwindApp.AppName='northwind'`/`.Version='1.0.0'`; `UiDeployBundle = { config: UiArtifactConfig; files: readonly UiBundleFile[] }`; `EnvironmentService.DeployAppToEnvironment(name, bundle)` (fails `EnvironmentUiDeployUnavailableError` unless the service got a `uiDeployer`); `UiDeployActuator(oci, signer, keys, orchestrators, manifests, records)`; `InClusterRegistry.NodePort`/`.PushBase()`/`.Namespace`/`.RegistryName`; `K8sManifestBuilder.RenderRegistry(hiveId)`/`.EnvBrowserHostOf`; the federation smoke's keypair setup (`dev-signing` `.pub`/`.key` in `<dataRoot>/keys`, hive `trustRootRef='dev-signing'`).
- Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Never merge/push without explicit instruction.

## Review Focus

- **The served UI actually renders via the live pointer, not the seed.** The e2e must assert the browser gets the DEPLOYED shell (a unique marker), proving the Spec-3 unpack+live-pointer path served it. → Task 2 Playwright asserts the deployed marker.
- **A tampered artifact must NOT serve.** → Task 2's tamper case mutates a pushed blob (or the signature) for a second env and asserts the pod-side verify rejects it (Deployment not ready / `/app` 404), fail-closed.
- **The demo bundle is a valid, packable artifact.** `index.html` references the asset; `UiArtifact.Pack` accepts it. → Task 1 asserts Pack+Unpack round-trips the loaded bundle.
- **The e2e composes the actuator correctly.** Omitting the 10th `EnvironmentService` arg makes `DeployAppToEnvironment` throw `EnvironmentUiDeployUnavailableError`. → Task 2 wires `UiDeployActuator` and the registry push base `http://<PushBase()>`.
- **The registry node-port is mapped on the cluster.** Push to `localhost:30500` only works if the kind cluster maps it. → Task 2 adds `InClusterRegistry.NodePort` to the cluster's `extraPortMappings` alongside `:443`.

---

### Task 1: `NorthwindUiBundle` demo UI

**Files:**
- Create: `admin/control-plane/northwind-ui-bundle.ts`
- Test: `admin/control-plane/tests/northwind-ui-bundle.test.ts`

**Interfaces:**
- Consumes: `UiDeployBundle` (`./ui-deploy-actuator.js`), `UiArtifactConfig`/`UiBundleFile` (`./ui-artifact.js`), `NorthwindApp` name/version (reuse the existing constants, or hoist local `AppName='northwind'`/`AppVersion='1.0.0'` matching them).
- Produces: `class NorthwindUiBundle` with `static Load(): UiDeployBundle` returning `config = { appName: 'northwind', appVersion: '1.0.0', entry: 'index.html', assets: ['assets/app.js'] }` and `files = [{ path: 'index.html', bytes }, { path: 'assets/app.js', bytes }]`. The two file bodies are hoisted `private static readonly` string constants: a minimal HTML shell (`<html><head>…</head><body>` with a recognizable marker and a `<script src="assets/app.js">`) and a one-line JS asset. A hoisted marker constant (e.g. `Marker = 'northwind-ui-ready'`) appears in the shell body so the e2e (and this test) can assert on it; expose it as `public static readonly Marker`.

- [ ] **Step 1: Write the failing test:**

```ts
test('Load returns the northwind config and the two UI files', () =>
{
    const b = NorthwindUiBundle.Load()
    assert.equal(b.config.appName, 'northwind')
    assert.equal(b.config.entry, 'index.html')
    assert.deepEqual([...b.config.assets], ['assets/app.js'])
    assert.deepEqual(b.files.map(f => f.path).sort(), ['assets/app.js', 'index.html'])
    const shell = Buffer.from(b.files.find(f => f.path === 'index.html')!.bytes).toString('utf8')
    assert.ok(shell.includes(NorthwindUiBundle.Marker))
    assert.ok(shell.includes('assets/app.js'))
})
test('the loaded bundle packs and unpacks losslessly', () =>
{
    const b = NorthwindUiBundle.Load()
    const packed = UiArtifact.Pack(b.config, b.files)
    const out = UiArtifact.Unpack(packed.layerBlob)
    assert.deepEqual(out.map(f => f.path).sort(), ['assets/app.js', 'index.html'])
})
```

- [ ] **Step 2: Run the tests, verify they fail.**
- [ ] **Step 3: Implement `NorthwindUiBundle`** with the hoisted shell/asset/marker constants and `Load`. `bytes` via `new TextEncoder().encode(...)`.
- [ ] **Step 4: Run tests, verify pass; both type-gates clean.**
- [ ] **Step 5: Commit** — `feat: NorthwindUiBundle minimal demo UI`.

---

### Task 2: Gated in-cluster UI-serving e2e smoke

**Files:**
- Create: `admin/control-plane/in-cluster-ui-serving-smoke.ts`

**Interfaces:**
- Consumes: the federation-smoke flow as the template (`admin/control-plane/in-cluster-federation-smoke.ts` — cluster create + `InstallIngress` + image load + `ComposeService` + Playwright `chromium.launch({ args: [HostResolverRules()] })` + `newContext({ ignoreHTTPSErrors: true })`), the registry recipe from `registry-roundtrip-smoke.ts` (pre-pull + load `registry:2`, `RenderRegistry` apply, `RolloutStatus`), `NorthwindUiBundle.Load()` (Task 1), `UiDeployActuator`, `OciRegistryClient`, `UiArtifactSigner`, `FileKeyStore`, `K8sManifestBuilder`, `InClusterRegistry`.

This is a **standalone gated smoke** (not a `tests/` file; `IsEntryPoint()` + `static Main()` + `async Run(): Promise<boolean>` + the entry-point tail), run manually. It requires Docker + kind + Playwright + free host ports 443 and 30500.

- [ ] **Step 1: Implement `InClusterUiServingSmoke`** with `Run()` performing, each step pass/fail-logged inside a `try/finally` cluster+env teardown (mirror the federation smoke):
  1. create the kind cluster with `extraPortMappings: [HttpsPort, InClusterRegistry.NodePort]` (443 + 30500); `docker pull registry:2`; `LoadImage` of both the server image and `registry:2`.
  2. `InstallIngress()` (pinned ingress-nginx + ssl-passthrough patch + wait-ready), as the federation smoke does.
  3. `kubectl.Apply(new K8sManifestBuilder().RenderRegistry(hiveId))`; `RolloutStatus(InClusterRegistry.Namespace, InClusterRegistry.RegistryName)`.
  4. set up the `dev-signing` keypair in `<dataRoot>/keys` (reuse the federation smoke's `generateKeyPairSync` + `FileKeyStore` suffixes) and the IdP/tenant-admin/federation prerequisites the federation smoke establishes; compose `EnvironmentService` **with** a 10th arg `new UiDeployActuator(new OciRegistryClient('http://' + InClusterRegistry.PushBase()), new UiArtifactSigner(keys), keys, orchestrators, new K8sManifestBuilder(), registry)`.
  5. `service.Create(EnvName, Template.DevBlank, EnvType.Development, undefined, hiveId)` for a federated env; `await service.DeployAppToEnvironment(EnvName, NorthwindUiBundle.Load())`.
  6. **Serve assertion:** with Playwright, `goto('https://' + EnvBrowserHostOf(env, baseDomain) + '/app/' + tenant + '/northwind/')`; assert the response body contains `NorthwindUiBundle.Marker`, and that `GET …/app/<tenant>/northwind/assets/app.js` returns 200 with the asset body.
  7. **Tamper case:** for a second env (or a re-deploy), after the actuator pushes, overwrite a pushed blob (or the `.sig` companion) in the registry with different bytes (a direct `/v2/` PUT, as the roundtrip smoke pushes), then trigger the pod to re-pull (`RolloutRestart`); assert the Deployment does NOT become ready within a bounded wait and `/app/<tenant>/northwind/` does not serve the marker — pod-side verification fail-closed. (Pick whichever tamper is simplest to inject deterministically; the pod-side unpacker already rejects a digest/signature mismatch.)
  8. `finally`: delete envs + cluster + temp dir.
  `Run()` returns true only if the serve assertion passed AND the tamper case was correctly rejected.

- [ ] **Step 2: Add the entry-point tail** (`if (InClusterUiServingSmoke.IsEntryPoint()) { await InClusterUiServingSmoke.Main() }`); `Main()` runs `Run()`, logs OVERALL PASS/FAIL, sets a non-zero exit on failure.

- [ ] **Step 3: Build + gate checks** — `npx tsc -p tsconfig.tools.json --noEmit` and `-p tsconfig.tenant-admin.json --noEmit` clean; confirm the file is not under `tests/` and imports no `node:test`. Do NOT run the smoke here (operator-gated).

- [ ] **Step 4: Commit** — `test: gated in-cluster UI-serving e2e smoke (deploy→serve + tamper)`.

> **Executor note:** like the other in-cluster smokes, this is proven by compiling + type-checking; a live kind run is a manual operator step. Record in the ledger that smoke execution is operator-gated, and carry forward the two Spec-3 e2e WATCH items (the unpack init container runs under a read-only root filesystem — confirm no write outside the data PVC; and the `dev-signing` key must exist in the keysDir the actuator reads).
