# In-hive Console Install, TLS and In-cluster Environment Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator turns on "run the tenant console in this hive" for a Local hive in the platform admin portal, picks a host and a TLS choice (existing Secret, cert-manager ClusterIssuer, or development self-signed), and the control plane installs the console (with its in-cluster IdP, Ingress, ServiceAccount and RBAC); the installed console then creates, runs and deletes environments through the in-cluster Kubernetes API instead of kubectl.

**Architecture:** A small node:https Kubernetes API client (service-account token + CA) backs a new `ApiKubectl implements IKubectl`, so the existing orchestrator, seed and secret-read code paths run unchanged inside the pod; an `InClusterHiveOrchestrator` adds namespace creation, the per-namespace RoleBinding, TLS Secret copy and a namespace-prefix guard. The control plane gains a `TenantConsoleInstaller` (modelled on `HiveAgentInstaller`) that renders through `TenantAdminBootstrap` (now the production renderer), a master-key-sealed secret store, a per-base-domain development CA, and operator routes + a portal panel. `IEnvironmentReach` is extracted over `EnvironmentEndpoints` and implemented for the console.

**Tech Stack:** TypeScript (node >= 22.5, ESM), node:https / node:crypto, openssl CLI (already required by `src/idp/dev-ca.ts`), `EncryptedSecretStore` from `@pragmatic-tech-ai/todl-identity-local` (already a dependency), node:test via tsx, Mural `.mu` + TS view models (admin/portal), PowerShell (dev script), Playwright (smoke only).

**Spec:** docs/superpowers/specs/2026-11-04-in-hive-desktop-sign-in-design.md (this is Plan 1 of 3: console install + TLS + in-cluster environment management. Plan 2 = advert route, fingerprint matching, discovery, email domains. Plan 3 = desktop API/relay on the console, Plexus, Plexus system trust.)

## Global Constraints

- OOP only: every function is a method (instance or static) on a class; no module-level functions, no module-level mutable `let`/`const` state (module-level `const` only for true compile-time constants, plus type/enum declarations).
- Allman braces for class/interface/enum/method/constructor/getter/setter bodies and all control-flow blocks; `else`/`catch`/`finally` on their own line. Object literals, block-bodied arrows and genuine one-line blocks stay inline.
- PascalCase for every interface and every public method/property; private members and JSON-mirroring data fields keep camelCase.
- No inline string literals in TS method bodies: user-facing text and reused literals are `private static readonly` PascalCase constants (`.mu` labels stay inline). Fixed value sets are enums, never string unions.
- New view models extend `Observable` (from `@pragmatic-tech-ai/todl-runtime`), never `MuralBase`.
- Tests live in `tests/` subfolders (`admin/control-plane/tests/*.test.ts`, `admin/portal/src/sections/hives/tests/*.test.ts`).
- New files ASCII + LF. Existing files keep their line endings (all files touched here are LF today; verify with `git ls-files --eol <path>` before editing and keep what you find). No explicit `Width`/`Height` in `.mu`.
- Secrets (agent token, IdP admin token, IdP/TLS private keys, dev CA key, fingerprint key, Owner password, service-account token, Secret `data`) are never logged, printed, put in error messages, audit notes or status DTOs. Errors from the Kubernetes API carry only status + `KubectlError.Redact`-ed API message.
- Layering: nothing under `src/` imports `admin/`; `admin/control-plane` may import `src/` (as `docker-idp-driver.ts` already does).
- Stage by explicit path (`git add <file> <file>`), never `git add -A`/`.`. Another agent edits `admin/control-plane/audit-record.ts`, `json-record-store.ts` and `tests/audit-batching.test.ts` concurrently: never stage, revert or reformat them.
- Each commit message ends with `Co-Authored-By: <implementer model name> <noreply@anthropic.com>` naming the model that wrote the change. Merge locally; NEVER push.
- Gates (all green before each commit that touches the area):
  - control plane: `cd admin/control-plane && npx tsx --test tests/*.test.ts`
  - repo root: `npm run typecheck:tools` (covers `admin/control-plane/**`, portal and tenant-portal tsconfigs), `npm run build:tenant-admin` (the console's build; excludes `dev/**`, tests and smokes), and `npm test`
  - portal: `npm --prefix admin/portal run typecheck` and `npm --prefix admin/portal test`
- No new npm dependency. The Kubernetes API is reached with node:https using `/var/run/secrets/kubernetes.io/serviceaccount/{token,ca.crt}` and host `kubernetes.default.svc` (same approach as `src/agent/k8s-api.ts`).
- Values pinned by this plan: console host default `console-<tenantId>.<baseDomain>`; console container/Service port `7100`; IdP port `9443`; development TLS Secret name `pragmatic-dev-tls`; cert-manager annotation `cert-manager.io/cluster-issuer`; field manager `pragmatic-tenant-console`; env-namespace RoleBinding name `pragmatic-tenant-console`; fingerprint key 32 random bytes.

## Review Focus

1. Reinstalling over an installed console after the operator changed host or TLS source: the apply must be idempotent, the Ingress host/TLS must follow the new settings, the fingerprint key must stay the same, and the console + IdP pods must restart onto the new Secrets (Task 13 test `reinstall with a new host updates the Ingress and keeps the fingerprint key`).
2. An operator-named TLS Secret that exists but is not `kubernetes.io/tls` or lacks `tls.crt`/`tls.key`: the install must stop at preparing-certificates with a sentence naming the Secret, not apply a broken Ingress (Task 13 test `existing-secret of the wrong type fails at preparing-certificates`).
3. Hive delete with the console installed: the cluster-scoped console ClusterRoles/ClusterRoleBinding and the console Ingress must go too (the existing selector only covers deployment/service/serviceaccount/secret in pragmatic-system), while the data PVC, seed Secret and IdP namespace stay (Task 5 test `removal manifest names the cluster-scoped RBAC and keeps PVC and seed`, Task 13 test `hive delete removes the console before the agent and forgets its keys`).
4. An environment name whose namespace already exists but belongs to another hive (or was hand-made without labels): the console must refuse to adopt or delete it (Task 6 tests `Apply refuses an existing namespace not labelled for this hive`, `Teardown refuses a namespace labelled for another hive`).
5. Development TLS with an explicit console host outside the base domain: the name-constrained dev CA cannot issue it, so the settings PUT must refuse it up front with a plain sentence instead of failing mid-install (Task 11 test `development TLS refuses a host outside the base domain`).

---

## File Structure

Control plane (`admin/control-plane/`):
- Create `kube-api-client.ts` - `KubeMethod`, `KubeContentType`, `IKubeTransport`, `HttpsKubeTransport`, `InClusterServiceAccount`, `KubeResourceCatalog`, `KubeApiError`, `UnsupportedKubeKindError`, `KubeApiClient`.
- Create `api-kubectl.ts` - `ApiKubectl implements IKubectl` over `KubeApiClient`, `RolloutTimeoutError`.
- Create `ingress-tls.ts` - `IngressTlsSource`, `IngressTls`, `InvalidIngressTlsError`, `IngressTlsPolicy`.
- Create `env-namespace-guard.ts` - `EnvNamespaceRefusedError`, `EnvNamespaceGuard implements IKubectl`.
- Create `pinned-image-verifier.ts` - `VerifiedImage`, `PinnedImageVerifier implements IImageVerifier`.
- Create `in-cluster-hive-orchestrator.ts` - `ConsoleIdentity`, `InClusterOrchestration`, `InClusterHiveOrchestrator implements IHiveOrchestrator`.
- Create `in-cluster-environment-reach.ts` - `InClusterEnvironmentReach implements IEnvironmentReach`.
- Create `sealed-secret-store.ts` - `SealedSecretStore`.
- Create `console-fingerprint-keys.ts` - `ConsoleFingerprintKeys`.
- Create `dev-certificate-authority.ts` - `IssuedCertificate`, `IDevCertificateIssuer`, `DevCertificateAuthority`, `DevCaKeyMissingError`, `DevCaHostOutsideDomainError`.
- Create `hive-console-spec.ts` - `HiveConsoleSpec`, `InvalidHiveConsoleError`, `HiveConsoleSpecs`.
- Create `in-hive-idp-admin.ts` - `InHiveOwnerPassword`, `IInHiveIdpAdmin`, `InHiveIdpUnavailableError`, `InHiveIdpAdmin`.
- Create `tenant-console-installer.ts` - install states/steps/status, errors, `IConsoleDirectory`, `IConsoleImageApproval`, `PlatformConsoleImageApproval`, `TenantConsoleInstaller`.
- Create `dev/dev-ca-trust.ps1` - Windows CurrentUser trusted-root install/remove of the dev CA.
- Create `in-hive-console-smoke.ts` - gated live smoke (not a test).
- Modify `environment-endpoints.ts`, `environment-service.ts`, `server.ts`, `tenant-auth/desktop-relay.ts` (IEnvironmentReach seam; server wiring of the installer).
- Modify `k8s-manifest-builder.ts` (TLS on env/IdP/console Ingress, console RBAC + Ingress + fingerprint mount, removal manifest, new name statics), `tenant-admin-workload.ts`, `tenant-admin-env.ts`, `idp-workload-driver.ts` (spec field), `environment-workload.ts`, `environment-placement.ts`.
- Modify `hive-orchestrator-factory.ts` (in-cluster selection), `tenant-admin-server.ts` (in-pod composition), `tenant-auth/tenant-host-resolver.ts` (console host).
- Modify `tenant-admin-bootstrap.ts` (production renderer inputs), `platform-records.ts` (`HiveRecord.console`), `platform-directory.ts` (`SetHiveConsole`), `control-plane-host.ts` (routes), `hive-agent-uninstaller.ts` (no change in behaviour; console removal is called by the host before it), `tenant-provisioning-service.ts` (make `NewOwnerPassword` public static).
- Modify `dev/README.md` (three lines on the dev CA script).

Portal (`admin/portal/src/`):
- Modify `portal-types.ts`, `api-client.ts`.
- Create `sections/hives/hive-console-view-model.ts`.
- Modify `sections/hives/hive-agent-install-view-model.ts` (widen `AgentInstallStepViewModel.Step` type), `sections/hives/hive-detail-page-view-model.ts`, `sections/hives/hives.resources.mu`.
- Create `sections/hives/tests/hive-console.test.ts`.

---

### Task 1: IEnvironmentReach seam over EnvironmentEndpoints

**Files:**
- Modify: `admin/control-plane/environment-endpoints.ts`
- Modify: `admin/control-plane/environment-service.ts:205` (ctor param type), `:690-720` (unchanged logic)
- Modify: `admin/control-plane/server.ts:90` (`DesktopRelayWiring`)
- Modify: `admin/control-plane/tenant-auth/desktop-relay.ts:8,203` (ctor param type)
- Test: `admin/control-plane/tests/environment-endpoints.test.ts`

**Interfaces:**
- Produces (consumed by Task 7 and by Plan 3):
  ```ts
  export interface IEnvironmentReach
  {
      /** Where this host reaches the environment server; held until Release (a no-op where nothing is held). */
      UrlsFor(rec: EnvironmentRecord): Promise<EnvironmentUrlsLease>
      /** The environment's Owner (admin) password. */
      AdminPasswordFor(rec: EnvironmentRecord, dataRoot: string): Promise<string>
  }
  export class EnvironmentEndpoints implements IEnvironmentReach
  public static AdminPasswordFromSecretJson(rec: EnvironmentRecord, secretJson: string): string  // on EnvironmentEndpoints
  export type DesktopRelayWiring = { endpoints: IEnvironmentReach; audit: AuditRegistry }
  ```
  `EnvironmentService` ctor's last param becomes `endpoints?: IEnvironmentReach`; `DesktopRelay` ctor's `endpoints` param becomes `IEnvironmentReach`.

- [ ] **Step 1: Write the failing tests** in `tests/environment-endpoints.test.ts`:
  - `AdminPasswordFromSecretJson decodes the provisioned-secrets entry`: build `{ data: { 'provisioned-secrets.json': base64(JSON.stringify({ [rec.environmentId + BundleBuilder.AdminSecretSuffix]: 'pw-1' })) } }`; assert result `=== 'pw-1'`.
  - `AdminPasswordFromSecretJson refuses unreadable secrets with the fixed message`: input `'{not json'` -> `assert.throws(..., EnvironmentSecretsUnreadableError)` and the error message does not contain `not json`.
  - `EnvironmentEndpoints is an IEnvironmentReach`: `const reach: IEnvironmentReach = new EnvironmentEndpoints(...)` compiles and `UrlsFor` of a Docker record returns `http://localhost:<hostPort>`.
- [ ] **Step 2: Run** `cd admin/control-plane && npx tsx --test tests/environment-endpoints.test.ts` - Expected: FAIL (`AdminPasswordFromSecretJson` / `IEnvironmentReach` not exported).
- [ ] **Step 3: Implement.** Add the interface; make `AdminPasswordFor`'s in-cluster branch call the new public static (which composes the existing private `SecretsFileOf` / `ParseObject` / `SecretOf` / `AdminRefOf`). Retype the three consumers. No behaviour change.
- [ ] **Step 4: Run** the full control-plane gate and `npm run typecheck:tools` - Expected: PASS.
- [ ] **Step 5: Commit** `refactor(control-plane): extract IEnvironmentReach over EnvironmentEndpoints` (stage the five files explicitly).

### Task 2: Kubernetes API client (node:https, service account)

**Files:**
- Create: `admin/control-plane/kube-api-client.ts`
- Test: `admin/control-plane/tests/kube-api-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export enum KubeMethod { Get = 'GET', Post = 'POST', Patch = 'PATCH', Delete = 'DELETE' }
  export enum KubeContentType { Json = 'application/json', ApplyPatch = 'application/apply-patch+yaml', StrategicMerge = 'application/strategic-merge-patch+json', MergePatch = 'application/merge-patch+json' }
  export type KubeResponse = { status: number; body: string }
  export interface IKubeTransport { Send(method: KubeMethod, path: string, body: string | undefined, contentType: KubeContentType): Promise<KubeResponse> }
  export class InClusterServiceAccount
  {
      public static readonly DefaultRoot = '/var/run/secrets/kubernetes.io/serviceaccount'
      public static readonly Host = 'kubernetes.default.svc'
      public constructor(public readonly TokenPath: string, public readonly CaPath: string)
      /** Present only when KUBERNETES_SERVICE_HOST is set AND `<root>/token` and `<root>/ca.crt` exist. */
      public static Detect(env: NodeJS.ProcessEnv, root: string = InClusterServiceAccount.DefaultRoot): InClusterServiceAccount | undefined
  }
  export class HttpsKubeTransport implements IKubeTransport   // ctor(account: InClusterServiceAccount, timeoutMs: number = 30000); rereads the token on every request
  export type KubeTypeRef = { apiVersion: string; kind: string }
  export class KubeResourceCatalog
  {
      /** `/api/v1/...` or `/apis/<group>/<version>/...`, `namespaces/<ns>/` only for namespaced kinds, `/<name>` when given. */
      public static PathOf(type: KubeTypeRef, namespace: string | undefined, name?: string): string
      /** kubectl-style 'kind/name' or bare plural/singular/short name ('deployment/x', 'secret/x', 'svc/x', 'statefulset/x', 'deployments', 'serviceaccount') to a type + optional name. */
      public static ParseResource(resource: string): { type: KubeTypeRef; name: string | undefined }
      public static IsNamespaced(type: KubeTypeRef): boolean
  }
  export class UnsupportedKubeKindError extends Error   // 'Unsupported Kubernetes kind: <apiVersion>/<kind>'
  export class KubeApiError extends Error { public readonly Status: number }  // 'kubernetes API <METHOD> <kind> failed with status <n>[: <redacted API message>]'
  export class KubeApiClient
  {
      public static readonly FieldManager = 'pragmatic-tenant-console'
      public constructor(transport: IKubeTransport)
      public Get(path: string): Promise<unknown | undefined>                 // 404 -> undefined
      public List(path: string, labelSelector?: string): Promise<unknown[]>  // items[]
      public Create(path: string, body: object): Promise<boolean>            // 409 -> false
      public Apply(path: string, body: object): Promise<void>                // PATCH ?fieldManager=pragmatic-tenant-console&force=true, ApplyPatch
      public Patch(path: string, body: object, type: KubeContentType): Promise<void>
      public Delete(path: string): Promise<boolean>                          // 404 -> false
  }
  ```
  Catalog table (exactly these; anything else throws `UnsupportedKubeKindError`): v1 `Namespace`(cluster) `namespaces`, `Secret` `secrets`, `ConfigMap` `configmaps`, `Service` `services` (short `svc`), `ServiceAccount` `serviceaccounts`, `PersistentVolumeClaim` `persistentvolumeclaims`; apps/v1 `Deployment` `deployments`, `StatefulSet` `statefulsets`; networking.k8s.io/v1 `Ingress` `ingresses`; rbac.authorization.k8s.io/v1 `Role` `roles`, `RoleBinding` `rolebindings`, `ClusterRole`(cluster) `clusterroles`, `ClusterRoleBinding`(cluster) `clusterrolebindings`.

- [ ] **Step 1: Write the failing tests** (a `FakeKubeTransport` class records `[method, path, contentType, body]` and replays queued responses):
  - `PathOf builds core, grouped, namespaced and cluster paths`: `PathOf({apiVersion:'v1',kind:'Namespace'}, undefined, 'pragmatic-env-a') === '/api/v1/namespaces/pragmatic-env-a'`; `PathOf({apiVersion:'apps/v1',kind:'Deployment'}, 'pragmatic-env-a', 'x') === '/apis/apps/v1/namespaces/pragmatic-env-a/deployments/x'`; `PathOf({apiVersion:'rbac.authorization.k8s.io/v1',kind:'ClusterRole'}, undefined, 'r') === '/apis/rbac.authorization.k8s.io/v1/clusterroles/r'`; `PathOf({apiVersion:'networking.k8s.io/v1',kind:'Ingress'}, 'n') === '/apis/networking.k8s.io/v1/namespaces/n/ingresses'`.
  - `PathOf refuses an unknown kind`: `{apiVersion:'example.com/v1',kind:'Widget'}` -> `UnsupportedKubeKindError`.
  - `ParseResource reads kubectl shorthands`: `'svc/a'` -> Service `a`; `'deployment/a'` -> Deployment; `'secret/a-env-secrets'` -> Secret; `'deployments'` -> Deployment with `name === undefined`.
  - `Get answers undefined on 404 and parses JSON on 200`; `Create answers false on 409`; `Delete answers false on 404`.
  - `Apply sends server-side apply with the console field manager`: recorded path ends `?fieldManager=pragmatic-tenant-console&force=true`, content type `application/apply-patch+yaml`, method PATCH.
  - `a failed call redacts the API message`: 422 body `{"message":"token: abcdefabcdefabcdefabcdefabcdefabcdef"}` -> `KubeApiError` with `Status === 422`, message contains `[REDACTED]`, not the token.
  - `Detect needs KUBERNETES_SERVICE_HOST and both files`: temp dir with `token` + `ca.crt` and env `{ KUBERNETES_SERVICE_HOST: '10.0.0.1' }` -> defined with `TokenPath === join(dir,'token')`; env `{}` -> undefined; missing `ca.crt` -> undefined.
- [ ] **Step 2: Run** `npx tsx --test tests/kube-api-client.test.ts` - Expected: FAIL (module missing).
- [ ] **Step 3: Implement** in `kube-api-client.ts`. `HttpsKubeTransport.Send` mirrors `src/agent/k8s-api.ts` `Send` (Authorization Bearer from the token file read per request, `ca` from `CaPath`, host `InClusterServiceAccount.Host`, port 443, timeout destroys with a fixed message); never include token/headers/body in an error. `List` appends `?labelSelector=<encodeURIComponent>`.
- [ ] **Step 4: Run** the test file and the control-plane gate - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): in-cluster Kubernetes API client over the service account`.

### Task 3: ApiKubectl - IKubectl over the API

**Files:**
- Create: `admin/control-plane/api-kubectl.ts`
- Test: `admin/control-plane/tests/api-kubectl.test.ts`

**Interfaces:**
- Consumes: `KubeApiClient`, `KubeResourceCatalog`, `KubeContentType` (Task 2); `IKubectl` (`kubectl.ts`); `IInstallClock`, `SystemInstallClock` (`hive-agent-installer.ts`); `OrchestratorPolling` (`kubectl-hive-orchestrator.ts`).
- Produces:
  ```ts
  export class RolloutTimeoutError extends Error   // 'Deployment <ns>/<name> did not finish rolling out in time.'
  export class ApiKubectl implements IKubectl
  {
      public static readonly DefaultRollout: OrchestratorPolling = { attempts: 150, intervalMs: 2000 }
      public constructor(client: KubeApiClient, clock: IInstallClock = new SystemInstallClock(), rollout: OrchestratorPolling = ApiKubectl.DefaultRollout)
      public get Client(): KubeApiClient
      // + every IKubectl member
  }
  ```
  Mapping: `Apply`/`ApplyServerSide` = server-side apply of each object (a `List`'s items in order; a single object as is) at `PathOf(type, metadata.namespace, metadata.name)`. `Get(ns, 'kind/name')` = JSON text of the object, throws `KubeApiError` 404 when absent; `Find` = text or undefined. `SetImage` = strategic-merge `{spec:{template:{spec:{containers:[{name,image}]}}}}`. `Scale`/`ScaleStatefulSet` = merge-patch `{spec:{replicas}}` on `<path>/scale`. `RolloutRestart` = strategic-merge `{spec:{template:{metadata:{annotations:{'kubectl.kubernetes.io/restartedAt': <ISO of clock.Now()>}}}}}`; `RolloutRestartSelector` = List deployments in ns with the selector, restart each. `RolloutStatus` polls the Deployment until `status.observedGeneration >= metadata.generation` and `updatedReplicas`, `availableReplicas` both equal `spec.replicas` (a `spec.replicas` of 0 is done at once), else `RolloutTimeoutError` after `rollout.attempts`. `DeleteNamespace` = Delete (404 fine). `DeleteManifest` = Delete each item (404 fine). `DeleteBySelector(ns, 'a,b', sel)` = for each comma-separated resource, List then Delete each item.

- [ ] **Step 1: Write the failing tests** (reuse a local `FakeKubeTransport`; a fake clock whose `Delay` resolves immediately):
  - `Apply applies each List item server-side in order` - two items (Service then Deployment) -> two PATCH calls with the two exact paths in that order.
  - `Get reads a Secret by kubectl shorthand`: `Get('pragmatic-env-a','secret/a-env-secrets')` GETs `/api/v1/namespaces/pragmatic-env-a/secrets/a-env-secrets` and returns the body text; 404 -> rejects `KubeApiError` with `Status === 404`; `Find` -> `undefined`.
  - `SetImage sends a strategic merge of the one container`: body deepEquals `{spec:{template:{spec:{containers:[{name:'server',image:'img:2'}]}}}}`, content type strategic.
  - `Scale patches the scale subresource`: path `/apis/apps/v1/namespaces/ns/deployments/d/scale`, merge-patch, body `{spec:{replicas:0}}`.
  - `RolloutStatus waits for the observed generation and available replicas`: responses `[gen 2/observed 1, gen 2/observed 2 updated 1 available 0 replicas 1, gen 2/observed 2 updated 1 available 1 replicas 1]` -> resolves after 3 GETs; with `rollout {attempts:2}` and never-ready -> `RolloutTimeoutError`.
  - `RolloutRestart stamps restartedAt from the clock` -> annotation value `new Date(clock.Now()).toISOString()`.
  - `DeleteManifest tolerates objects already gone`: first DELETE 404, second 200 -> resolves.
  - `DeleteBySelector lists then deletes every match per resource` for `'deployment,service'`.
- [ ] **Step 2: Run** `npx tsx --test tests/api-kubectl.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement** `ApiKubectl`. Parse manifest JSON with a fixed-message error on bad JSON (the manifest may hold Secret data; never echo it).
- [ ] **Step 4: Run** test file + gate - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): ApiKubectl drives IKubectl through the Kubernetes API`.

### Task 4: Ingress TLS model applied to environment and IdP Ingresses

**Files:**
- Create: `admin/control-plane/ingress-tls.ts`
- Modify: `admin/control-plane/k8s-manifest-builder.ts:838-866` (`IdpIngressObject`), `:1380-1410` (`ServerIngress`)
- Modify: `admin/control-plane/idp-workload-driver.ts:43-56` (`IdpWorkloadSpec.ingressTls?: IngressTls`)
- Modify: `admin/control-plane/environment-workload.ts:17-22,63,88-91` (`WorkloadFederation.ingressTls?: IngressTls`; `From(record, hive, ingressTls?)`)
- Modify: `admin/control-plane/environment-placement.ts:22-39` (ctor `(directory, ingressTls?: IngressTls)`)
- Test: `admin/control-plane/tests/ingress-tls.test.ts`, `tests/k8s-manifest-builder.test.ts`, `tests/environment-placement.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export enum IngressTlsSource { ExistingSecret = 'existing-secret', CertManager = 'cert-manager', Development = 'development' }
  export type IngressTls = { source: IngressTlsSource; secretName?: string; clusterIssuer?: string }
  export class InvalidIngressTlsError extends Error   // maps to 400
  export class IngressTlsPolicy
  {
      public static readonly DevelopmentSecretName = 'pragmatic-dev-tls'
      public static readonly CertManagerAnnotation = 'cert-manager.io/cluster-issuer'
      public static readonly TlsSecretType = 'kubernetes.io/tls'
      public static Parse(value: unknown): IngressTls
      /** existing-secret: its secretName; development: pragmatic-dev-tls; cert-manager: `<ingressName>-tls` (cert-manager writes it). */
      public static SecretNameFor(tls: IngressTls, ingressName: string): string
      /** cert-manager: { 'cert-manager.io/cluster-issuer': clusterIssuer }; otherwise {}. */
      public static AnnotationsFor(tls: IngressTls): Record<string, string>
      /** True for existing-secret and development: the Secret must be copied into each Ingress's namespace. */
      public static CopiesSecret(tls: IngressTls): boolean
      public static ToEnv(tls: IngressTls): Record<string, string>     // TenantAdminEnv.IngressTls* keys (Task 5)
      public static FromEnv(env: NodeJS.ProcessEnv): IngressTls | undefined
  }
  ```
  Parse rules: `source` must be an `IngressTlsSource` value; `existing-secret` requires `secretName` (lowercase RFC 1123 subdomain, <= 253) and forbids `clusterIssuer`; `cert-manager` requires `clusterIssuer` (same name rule) and forbids `secretName`; `development` forbids both. Messages are plain sentences, e.g. `'Name the TLS Secret to use (an existing kubernetes.io/tls Secret in pragmatic-system).'`.
  Manifest rules: `ServerIngress` with `federation.ingressTls` -> `tls: [{hosts:[host], secretName: SecretNameFor(tls, name)}]` plus `AnnotationsFor`; without it -> unchanged (controller default cert). `IdpIngressObject` with `spec.ingressTls` -> NO ssl-passthrough; annotations `nginx.ingress.kubernetes.io/backend-protocol: HTTPS` + `AnnotationsFor`; `tls: [{hosts:[idpHost], secretName}]`; without it -> unchanged passthrough. The IdP keeps serving its own internal (DevCa) certificate to in-cluster callers.

- [ ] **Step 1: Write the failing tests:**
  - `ingress-tls.test.ts`: `Parse accepts each source` (three exact objects round-trip); `Parse refuses a missing secret name`, `a secret name with cert-manager`, `an unknown source`, `an uppercase secret name` -> `InvalidIngressTlsError`; `SecretNameFor` returns `'my-tls'`, `'pragmatic-dev-tls'`, `'pragmatic-env-a-server-tls'` for the three sources with ingress name `pragmatic-env-a-server`; `ToEnv`/`FromEnv` round-trip; `FromEnv({})` -> undefined.
  - `k8s-manifest-builder.test.ts`: `env Ingress carries the TLS Secret and cert-manager annotation` (cert-manager, issuer `letsencrypt` -> `metadata.annotations['cert-manager.io/cluster-issuer'] === 'letsencrypt'`, `spec.tls[0].secretName === '<server-name>-tls'`); `env Ingress without TLS settings is unchanged` (no `secretName`, no annotations); `IdP Ingress with TLS settings terminates and re-encrypts` (no `nginx.ingress.kubernetes.io/ssl-passthrough`, `backend-protocol === 'HTTPS'`, `tls[0].secretName === 'pragmatic-dev-tls'` for development); `IdP Ingress without TLS settings stays passthrough`.
  - `environment-placement.test.ts`: `placement stamps the console TLS on federated workloads only` - with `idpBaseDomain` set -> `workload.federation.ingressTls` deepEquals the ctor value; without -> `federation` undefined.
- [ ] **Step 2: Run** those three files - Expected: FAIL.
- [ ] **Step 3: Implement** as specified; hoist the two annotation keys/values as `private static readonly` on `K8sManifestBuilder`.
- [ ] **Step 4: Run** gate - Expected: PASS (existing manifest tests unchanged).
- [ ] **Step 5: Commit** `feat(control-plane): Ingress TLS choice for environment and IdP Ingresses`.

### Task 5: Console manifests - ServiceAccount token, RBAC, Ingress, fingerprint mount

**Files:**
- Modify: `admin/control-plane/tenant-admin-workload.ts`
- Modify: `admin/control-plane/tenant-admin-env.ts`
- Modify: `admin/control-plane/k8s-manifest-builder.ts:914-1131` (`RenderTenantAdmin` and its private builders) plus new statics
- Test: `admin/control-plane/tests/tenant-admin-manifest.test.ts`

**Interfaces:**
- Consumes: `IngressTls`, `IngressTlsPolicy` (Task 4).
- Produces:
  ```ts
  // tenant-admin-workload.ts
  export interface TenantConsoleExposure { host: string; ingressTls: IngressTls }
  // TenantAdminWorkloadSpec gains:
  console?: TenantConsoleExposure          // Ingress emitted only when set
  fingerprintKeySecretName?: string        // mounted read-only at /fingerprint
  // tenant-admin-env.ts (TenantAdminEnv statics)
  public static readonly ConsoleHost = 'PRAGMATIC_TENANT_ADMIN_CONSOLE_HOST'
  public static readonly IngressTlsSource = 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SOURCE'
  public static readonly IngressTlsSecret = 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_SECRET'
  public static readonly IngressTlsIssuer = 'PRAGMATIC_TENANT_ADMIN_INGRESS_TLS_ISSUER'
  public static readonly FingerprintKeyFile = 'PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE'
  // K8sManifestBuilder statics
  public static readonly EnvNamespacePrefix = 'pragmatic-env-'         // expose the existing private NamespacePrefix value
  public static readonly TenantConsoleEnvBindingName = 'pragmatic-tenant-console'
  public static readonly FingerprintKeyFilePath = '/fingerprint/fingerprint.key'
  public static ConsoleHostOf(tenantId: string, baseDomain: string): string          // `console-${tenantId}.${baseDomain}`
  public static TenantConsoleEnvRoleNameOf(tenantId: string): string                 // `pragmatic-tenant-admin-${tenantId}-env`
  public static TenantConsoleTlsRoleNameOf(tenantId: string): string                 // `pragmatic-tenant-admin-${tenantId}-tls`
  public TenantConsoleRemovalManifest(spec: TenantAdminWorkloadSpec): string         // v1 List of identities
  ```
  `RenderTenantAdmin` items, in order: shared Namespace; ServiceAccount (`automountServiceAccountToken: true`); console ClusterRole + ClusterRoleBinding (name `TenantAdminNameOf(tenant)`, hive-labelled); env ClusterRole (`TenantConsoleEnvRoleNameOf`, hive-labelled, NOT bound anywhere by this manifest); when `console` is set and `CopiesSecret(tls)`: Role + RoleBinding `TenantConsoleTlsRoleNameOf` in pragmatic-system granting `get` on `secrets` with `resourceNames: [SecretNameFor(tls, name)]`; PVC; Deployment (pod `automountServiceAccountToken: true`); Service; when `console` is set: Ingress (`ServerIngress` shape: class nginx, `AnnotationsFor`, `tls: [{hosts:[host], secretName: SecretNameFor(tls, name)}]`, rule host -> Service `name` port `spec.port`).
  Console ClusterRole rules exactly:
  ```ts
  [ { apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'create', 'delete'] },
    { apiGroups: ['rbac.authorization.k8s.io'], resources: ['rolebindings'], verbs: ['create'] },
    { apiGroups: ['rbac.authorization.k8s.io'], resources: ['clusterroles'], verbs: ['bind'], resourceNames: [TenantConsoleEnvRoleNameOf(tenantId)] } ]
  ```
  Env ClusterRole rules exactly (wildcard verbs on the resources environment manifests use):
  ```ts
  [ { apiGroups: [''], resources: ['secrets', 'configmaps', 'services', 'persistentvolumeclaims', 'serviceaccounts'], verbs: ['*'] },
    { apiGroups: ['apps'], resources: ['deployments', 'deployments/scale', 'statefulsets', 'statefulsets/scale'], verbs: ['*'] },
    { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['*'] } ]
  ```
  Container env additions: when `console` set -> `ConsoleHost = host`, `TrustedProxy = 'true'`, plus `IngressTlsPolicy.ToEnv(tls)`; when `fingerprintKeySecretName` set -> volume `fingerprint` (Secret, item `fingerprint.key`), read-only mount `/fingerprint`, `FingerprintKeyFile = '/fingerprint/fingerprint.key'`.
  `TenantConsoleRemovalManifest` = identities of every rendered object except the Namespace and the PVC, plus the Secrets `TenantAdminBootstrap.FingerprintKeySecretNameOf`, `IdpCaSecretNameOf`, `IdpTokenSecretNameOf` (names from Task 12; for Task 5 compute them from `TenantAdminNameOf(tenant) + '-fingerprint' | '-idp-ca' | '-idp-token'` and let Task 12 point the bootstrap statics at the same builder statics) and, for development TLS, `pragmatic-dev-tls` in pragmatic-system. Never the seed Secret.

- [ ] **Step 1: Write the failing tests** in `tests/tenant-admin-manifest.test.ts`:
  - `console ServiceAccount and pod mount the token`: SA and pod `automountServiceAccountToken === true`.
  - `console ClusterRole grants only namespaces get/create/delete, rolebindings create and bind on its env role` - deepEqual the rules above.
  - `env ClusterRole is never bound cluster-wide`: no ClusterRoleBinding in the list has `roleRef.name === TenantConsoleEnvRoleNameOf(t)`.
  - `no Ingress without console exposure`; `Ingress on the console host` with `console: { host: 'console-acme.localtest.me', ingressTls: { source: development } }` -> rule host, `tls[0].secretName === 'pragmatic-dev-tls'`, backend port `spec.port`.
  - `cert-manager console Ingress carries the issuer and a generated Secret name` -> annotation `letsencrypt`, `secretName === 'pragmatic-tenant-admin-acme-tls'`; and NO TLS-read Role is rendered.
  - `existing-secret renders a get-only Role on that one Secret` -> Role rules `[{apiGroups:[''],resources:['secrets'],verbs:['get'],resourceNames:['acme-wildcard']}]` and a RoleBinding to the console SA.
  - `console env carries host, trusted proxy and TLS settings` (env var values).
  - `fingerprint key mounted read-only` -> volume item key `fingerprint.key`, mount `readOnly: true`, env `PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE === '/fingerprint/fingerprint.key'`.
  - `removal manifest names the cluster-scoped RBAC and keeps PVC and seed` -> contains ClusterRole x2, ClusterRoleBinding, Ingress, Deployment; contains no PersistentVolumeClaim and no `TenantAdminSeedSecretNameOf(t)`.
- [ ] **Step 2: Run** `npx tsx --test tests/tenant-admin-manifest.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement**; update the `RenderTenantAdmin` doc comment (it no longer says "no API token").
- [ ] **Step 4: Run** gate - Expected: PASS; fix any existing assertion that pinned `automountServiceAccountToken: false` (it is now true by design).
- [ ] **Step 5: Commit** `feat(control-plane): console ServiceAccount, RBAC and Ingress in the tenant-admin manifest`.

### Task 6: In-cluster orchestrator with namespace guard and pinned images

**Files:**
- Create: `admin/control-plane/env-namespace-guard.ts`, `admin/control-plane/pinned-image-verifier.ts`, `admin/control-plane/in-cluster-hive-orchestrator.ts`
- Modify: `admin/control-plane/hive-orchestrator-factory.ts`
- Test: `admin/control-plane/tests/env-namespace-guard.test.ts`, `tests/in-cluster-hive-orchestrator.test.ts`, `tests/pinned-image-verifier.test.ts`, `tests/hive-orchestrator-factory.test.ts`

**Interfaces:**
- Consumes: `KubeApiClient`, `KubeApiError` (Task 2), `ApiKubectl` (Task 3), `IngressTls`, `IngressTlsPolicy` (Task 4), name statics (Task 5), `KubectlHiveOrchestrator`, `EffectiveRegistry`, `IImageVerifier`, `ImageVerificationError`.
- Produces:
  ```ts
  export class EnvNamespaceRefusedError extends Error   // 'The tenant console manages only its own namespaces named pragmatic-env-*: <ns>'
  export class EnvNamespaceGuard implements IKubectl { public constructor(inner: IKubectl) }
  export type VerifiedImage = { imageRef: string; digest: string }
  export class PinnedImageVerifier implements IImageVerifier
  {
      public static readonly NotVerifiedReason = 'not verified for this hive by the platform'
      public constructor(images: readonly VerifiedImage[])
      /** Reads a JSON array of VerifiedImage; a missing file yields a verifier that refuses everything. */
      public static Load(path: string): PinnedImageVerifier
  }
  export type ConsoleIdentity = { tenantId: string; hiveId: string }
  export type InClusterOrchestration = { client: KubeApiClient; identity: ConsoleIdentity; verifier: IImageVerifier; ingressTls?: IngressTls }
  export class InClusterHiveOrchestrator implements IHiveOrchestrator
  {
      public static readonly BindingRetry: OrchestratorPolling = { attempts: 20, intervalMs: 500 }
      public constructor(setup: InClusterOrchestration, registry: EffectiveRegistry, trustRootRef: string | undefined, clock: IInstallClock = new SystemInstallClock(), polling: OrchestratorPolling = KubectlHiveOrchestrator.DefaultPolling)
      public get Kubectl(): IKubectl   // EnvNamespaceGuard(new ApiKubectl(client, clock))
  }
  // HiveOrchestratorFactory ctor: (localContext?, dataRoot?, inCluster?: InClusterOrchestration)
  ```
  Guard rules: every namespaced IKubectl call requires `namespace.startsWith(EnvNamespacePrefix)`; `Apply`/`ApplyServerSide`/`DeleteManifest` parse the manifest and require each item to be either a namespaced kind in a `pragmatic-env-*` namespace or a `Namespace` named `pragmatic-env-*`; anything else -> `EnvNamespaceRefusedError` before any call reaches `inner`.
  `InClusterHiveOrchestrator.Apply(w)`, in order: (1) `ref = registry.ImageRef(w.image)`, `await verifier.Verify(ref, trustRootRef)` (rejects before any API call); (2) render with `K8sManifestBuilder.Render({ ...w, image: ref })`; (3) `client.Create('/api/v1/namespaces', <the Namespace item>)` - on `false` (409) `Get` it and refuse with `EnvNamespaceRefusedError` unless `metadata.labels['pragmatic/hive'] === identity.hiveId`; (4) `client.Create(<rolebindings path in ns>, { metadata: { name: 'pragmatic-tenant-console', namespace: ns, labels: HiveLabelsOf(hiveId) }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: TenantConsoleEnvRoleNameOf(tenantId) }, subjects: [{ kind: 'ServiceAccount', name: TenantAdminNameOf(tenantId), namespace: 'pragmatic-system' }] })` (409 fine); (5) when `w.federation?.ingressTls` and `CopiesSecret`: Get the source Secret from pragmatic-system, refuse (fixed message naming the Secret) unless `type === 'kubernetes.io/tls'` with `tls.crt` and `tls.key`, then server-side apply `{ type, data: { tls.crt, tls.key } }` with the same name into ns; (6) `Kubectl.Apply` of the remaining items, retrying while `KubeApiError.Status === 403` up to `BindingRetry` (RBAC propagation after step 4). `Teardown(w)`: Get the namespace; absent -> done; labelled for another hive (or unlabelled) -> `EnvNamespaceRefusedError`; else `DeleteNamespace`. `WaitHealthy`/`Health`/`Roll`/`Scale`/`ScaleDatabase` delegate to an inner `KubectlHiveOrchestrator(this.Kubectl, new K8sManifestBuilder(), registry, verifier, trustRootRef, polling)`. `PrepareAgent` is a no-op.
  Factory: when `inCluster` is set, `For(hive)` returns an `InClusterHiveOrchestrator` iff `hive.cluster.backend === HiveBackend.Local && hive.id === inCluster.identity.hiveId`, else throws `UnsupportedBackendError`; without `inCluster` behaviour is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - guard: `refuses a call outside pragmatic-env-*` (`Get('pragmatic-system','secret/x')` rejects `EnvNamespaceRefusedError`, inner never called); `refuses a cluster-scoped object in a manifest` (ClusterRole item); `passes env namespaces through` (inner receives the call).
  - pinned: `accepts only listed refs`; `Load of a missing file refuses everything` (rejects `ImageVerificationError` with `Reason === PinnedImageVerifier.NotVerifiedReason`).
  - orchestrator (FakeKubeTransport, immediate clock):
    - `Apply creates the namespace, then the console RoleBinding, then the rest` - first two calls are `POST /api/v1/namespaces` and `POST /apis/rbac.authorization.k8s.io/v1/namespaces/pragmatic-env-a/rolebindings`; no PATCH targets `/api/v1/namespaces/pragmatic-env-a`.
    - `RoleBinding binds the console ServiceAccount to the env ClusterRole` - body roleRef/subjects deepEqual the values above.
    - `Apply retries a 403 right after binding` - first PATCH 403 then 200 -> resolves; 20 consecutive 403s -> rejects `KubeApiError` with `Status === 403`.
    - `Apply refuses an existing namespace not labelled for this hive` - POST 409, GET labels `{ 'pragmatic/hive': 'other' }` -> `EnvNamespaceRefusedError`, no PATCH.
    - `Apply refuses an image the platform did not verify` - empty `PinnedImageVerifier` -> `ImageVerificationError`, zero transport calls.
    - `copies the TLS Secret into a federated namespace for development and existing-secret only` - development: GET `/api/v1/namespaces/pragmatic-system/secrets/pragmatic-dev-tls` then PATCH `/api/v1/namespaces/pragmatic-env-a/secrets/pragmatic-dev-tls`; cert-manager: no secrets GET.
    - `refuses a TLS source Secret that is not kubernetes.io/tls` - type `Opaque` -> rejects; message names the Secret and contains no data.
    - `Teardown refuses a namespace labelled for another hive`; `Teardown deletes its own namespace`; `Teardown of an absent namespace is a no-op`.
  - factory: `in a pod a Local hive of this console gets the in-cluster orchestrator`; `another hive id throws UnsupportedBackendError`; `without in-cluster setup the kubectl orchestrator is unchanged`.
- [ ] **Step 2: Run** the four files - Expected: FAIL.
- [ ] **Step 3: Implement** the three new classes and the factory branch.
- [ ] **Step 4: Run** gate - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): in-cluster hive orchestrator for the tenant console`.

### Task 7: Console composition - in-pod orchestration, IEnvironmentReach, console host

**Files:**
- Create: `admin/control-plane/in-cluster-environment-reach.ts`
- Modify: `admin/control-plane/tenant-admin-server.ts`
- Modify: `admin/control-plane/tenant-auth/tenant-host-resolver.ts`
- Test: `admin/control-plane/tests/in-cluster-environment-reach.test.ts`, `tests/tenant-host-resolver.test.ts`, `tests/tenant-admin-server.test.ts`

**Interfaces:**
- Consumes: `IEnvironmentReach`, `EnvironmentEndpoints.AdminPasswordFromSecretJson`, `EnvironmentEndpoints.LocalAdminPasswordOf`, `EnvironmentUnreachableError` (Task 1); `InClusterServiceAccount`, `HttpsKubeTransport`, `KubeApiClient` (Task 2); `IngressTlsPolicy.FromEnv` (Task 4); `TenantAdminEnv.ConsoleHost` (Task 5); `InClusterOrchestration`, `PinnedImageVerifier` (Task 6); `TenantAdminBootstrap.VerifiedImagesKey` (Task 12 - define the constant here as `public static readonly VerifiedImagesKey = 'verified-images.json'` on `TenantAdminBootstrap` if Task 12 has not landed).
- Produces (Plan 3 consumes `reach`):
  ```ts
  export class InClusterEnvironmentReach implements IEnvironmentReach
  {
      public constructor(kubectl: IKubectl)
      /** record.endpoint as origin-only URLs (scheme://host:port, no path or query); Release and Fail are no-ops. EnvironmentUnreachableError when the record has no endpoint. */
      public UrlsFor(rec: EnvironmentRecord): Promise<EnvironmentUrlsLease>
      /** Docker record: the local bundle; otherwise `<env>-env-secrets` read through the guarded API kubectl. */
      public AdminPasswordFor(rec: EnvironmentRecord, dataRoot: string): Promise<string>
  }
  // tenant-host-resolver.ts
  export type ConsoleHostAlias = { host: string; tenantId: string }
  // TenantHostResolver ctor: (baseDomain, externalScheme, directory, externalPort?, consoleHost?: ConsoleHostAlias)
  // tenant-admin-server.ts
  TenantAdminConfig gains: readonly consoleHost: string | undefined; readonly ingressTls: IngressTls | undefined
  TenantAdminComposition gains: readonly reach: IEnvironmentReach | undefined
  public static InClusterOrchestrationOf(account: InClusterServiceAccount, directory: SeededTenantDirectory, dataRoot: string, ingressTls: IngressTls | undefined): InClusterOrchestration
  public async Compose(env: NodeJS.ProcessEnv = process.env, serviceAccountRoot?: string): Promise<TenantAdminComposition>
  ```
  `Compose`: `account = InClusterServiceAccount.Detect(env, serviceAccountRoot)`. When defined: `orchestrators = new HiveOrchestratorFactory(undefined, dataRoot, InClusterOrchestrationOf(...))` (identity = seed tenant id + `directory.ListHives()[0].id`; verifier = `PinnedImageVerifier.Load(join(dataRoot, TenantAdminBootstrap.VerifiedImagesKey))`), `reach = new InClusterEnvironmentReach(orchestrators.For(hive).Kubectl)`, passed as `EnvironmentService`'s last ctor arg (with `undefined` for `uiDeployer`); `placement = new EnvironmentPlacement(directory, cfg.ingressTls)`. When undefined: today's composition, `reach: undefined`. Resolver gets `{ host: cfg.consoleHost, tenantId }` when `consoleHost` is set. `TenantFor`: a Host whose name equals the alias host (case-insensitive) obeys the same external-port rule and answers the alias tenant if the directory knows it.

- [ ] **Step 1: Write the failing tests:**
  - reach: `UrlsFor returns origin-only endpoint URLs` (endpoint `{ httpUrl: 'http://s.ns.svc.cluster.local:8080', wsUrl: 'ws://s.ns.svc.cluster.local:8080/?environment=e1' }` -> `wsUrl === 'ws://s.ns.svc.cluster.local:8080'`); `UrlsFor without an endpoint is unreachable`; `AdminPasswordFor reads the env Secret through the kubectl` (fake IKubectl records `Get('pragmatic-env-a','secret/a-env-secrets')`).
  - resolver: `console host maps to the seeded tenant`; `tenant subdomains still resolve`; `console host with another port is refused when an external port is set`; `OriginFor(console host) === 'https://console-acme.localtest.me'`.
  - server: `ReadConfig reads the console host and TLS settings`; `InClusterOrchestrationOf takes the identity from the seed` (`{ tenantId: 'acme', hiveId: 'acme-hive' }`); `Compose without a service account keeps kubectl orchestration and no reach` (`reach === undefined`); `Compose in a pod builds the reach` (temp dir with `token`, `ca.crt`, env `KUBERNETES_SERVICE_HOST`, passed as `serviceAccountRoot`; assert `reach instanceof InClusterEnvironmentReach`; no network call is made at compose).
- [ ] **Step 2: Run** the three files - Expected: FAIL.
- [ ] **Step 3: Implement.** `Main` keeps calling `Compose()` with defaults.
- [ ] **Step 4: Run** gate + `npm run build:tenant-admin` - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): console composes in-cluster environment management and its own host`.

### Task 8: Master-key sealed secret store and per-hive fingerprint keys

**Files:**
- Create: `admin/control-plane/sealed-secret-store.ts`, `admin/control-plane/console-fingerprint-keys.ts`
- Test: `admin/control-plane/tests/sealed-secret-store.test.ts`, `tests/console-fingerprint-keys.test.ts`

**Interfaces:**
- Produces (Plan 2 consumes `ConsoleFingerprintKeys.Get`):
  ```ts
  export class SealedSecretStore
  {
      public static readonly FileName = 'sealed-secrets.json'
      public static async Open(filePath: string, masterKey: Buffer): Promise<SealedSecretStore>
      public async Get(ref: string): Promise<Buffer | undefined>
      public async Put(ref: string, value: Buffer): Promise<void>
      public async Delete(ref: string): Promise<void>
      public toJSON(): string    // '[SealedSecretStore: values redacted]'
      public toString(): string
  }
  export class ConsoleFingerprintKeys
  {
      public static readonly KeyBytes = 32
      public constructor(store: SealedSecretStore)
      public static RefOf(hiveId: string): string          // `console-fingerprint-key/${hiveId}`
      public async Ensure(hiveId: string): Promise<Buffer> // existing key, else 32 random bytes stored first
      public async Get(hiveId: string): Promise<Buffer | undefined>
      public async Remove(hiveId: string): Promise<void>
  }
  ```
  Storage: file `{ "sealed": { "<ref>": "<blob>" } }`; blobs produced by `EncryptedSecretStore` (AES-256-GCM, from `@pragmatic-tech-ai/todl-identity-local`) over a `Map` loaded from the file, values passed as base64 of the bytes. Writes go to `<file>.tmp` then rename, mode `0o600`; a missing file opens empty.

- [ ] **Step 1: Write the failing tests:**
  - `round-trips bytes across reopen`; `the file holds neither the bytes nor their base64` (value `randomBytes(32)`; file text contains neither `value.toString('base64')` nor `value.toString('hex')`); `another master key reads nothing` (`Get` -> undefined); `Delete persists`; `JSON.stringify(store)` equals the redacted text.
  - `Ensure creates a 32-byte key once and returns it again`; `Ensure for two hives gives different keys`; `Remove forgets the key`.
- [ ] **Step 2: Run** - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** gate - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): master-key sealed store and per-hive console fingerprint keys`.

### Task 9: Development certificate authority

**Files:**
- Create: `admin/control-plane/dev-certificate-authority.ts`
- Test: `admin/control-plane/tests/dev-certificate-authority.test.ts`

**Interfaces:**
- Consumes: `SealedSecretStore` (Task 8).
- Produces:
  ```ts
  export type IssuedCertificate = { cert: Buffer; key: Buffer }
  export interface IDevCertificateIssuer
  {
      EnsureCa(baseDomain: string): Promise<Buffer>                                   // CA certificate PEM
      Issue(baseDomain: string, hosts: readonly string[]): Promise<IssuedCertificate>
      CaFileOf(baseDomain: string): string
  }
  export class DevCaKeyMissingError extends Error        // CA cert on disk but its sealed key is gone: never silently re-mint
  export class DevCaHostOutsideDomainError extends Error // a host not equal to / under the base domain
  export class DevCertificateAuthority implements IDevCertificateIssuer
  {
      public static readonly DirName = 'dev-ca'
      public constructor(rootDir: string, store: SealedSecretStore, openssl: string = 'openssl')
      public static KeyRefOf(baseDomain: string): string   // `dev-ca-key/${baseDomain}`
  }
  ```
  Approach (openssl CLI, same as `src/idp/dev-ca.ts`; node:crypto cannot sign X.509): one CA per base domain at `<rootDir>/<baseDomain>/ca.crt`, key sealed under `KeyRefOf`. CA: `openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Pragmatic Development CA (<baseDomain>)" -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -addext "nameConstraints=critical,permitted;DNS:<baseDomain>"`. Leaf: rsa:2048, 397 days, extfile `subjectAltName=DNS:<h1>,DNS:<h2>...`, `basicConstraints=CA:FALSE`, `keyUsage=critical,digitalSignature,keyEncipherment`, `extendedKeyUsage=serverAuth`, signed with the CA key written to a `mkdtemp` staging dir under `rootDir` (key files `0o600`, staging removed in `finally`; sweep stale staging dirs first as `DevCa` does). A host is allowed iff it equals the base domain or ends with `.<baseDomain>`; `*.` is allowed only as the whole first label. Base domain and hosts must match `^[a-z0-9*.-]+$` (no shell is used; arguments are arrays).

- [ ] **Step 1: Write the failing tests** (need openssl on PATH, like `src/idp/tests/dev-ca.test.ts`):
  - `EnsureCa makes a name-constrained CA once` - `new X509Certificate(pem).ca === true`; second call returns identical bytes; `openssl x509 -noout -text -in ca.crt` output contains `Permitted:` and `DNS:localtest.me`.
  - `the CA key never stays on disk` - after EnsureCa + Issue, no file under `rootDir` ends with `.key` and none contains `PRIVATE KEY`; the sealed file contains no `PRIVATE KEY`.
  - `Issue signs a wildcard leaf for the base domain` - hosts `['*.localtest.me','localtest.me']`; `leaf.checkIssued(ca)`, `leaf.verify(ca.publicKey)`, `leaf.subjectAltName` includes `DNS:*.localtest.me`, validity <= 398 days, `leaf.ca === false`; returned key matches the cert public key.
  - `Issue refuses a host outside the base domain` (`'console.example.com'` -> `DevCaHostOutsideDomainError`) and `a wildcard in an inner label`.
  - `a CA whose sealed key was lost is not re-minted` - delete the vault entry, `EnsureCa` rejects `DevCaKeyMissingError`.
- [ ] **Step 2: Run** - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** gate - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): development CA per base domain with a sealed key`.

### Task 10: Windows dev script to trust or remove the dev CA

**Files:**
- Create: `admin/control-plane/dev/dev-ca-trust.ps1`
- Modify: `admin/control-plane/dev/README.md` (a short "Development console certificates" paragraph: the command lines below)
- Test: `admin/control-plane/tests/dev-ca-trust-script.test.ts`

**Interfaces:**
- Consumes: the CA file path from `DevCertificateAuthority.CaFileOf(baseDomain)` (Task 9), shown by the portal (Task 14).
- Produces: `powershell -NoProfile -ExecutionPolicy Bypass -File admin\control-plane\dev\dev-ca-trust.ps1 -CaFile <path> (-Install | -Remove | -ShowThumbprint)`.

  Decision: PowerShell, not node - `Import-Certificate` / the `Cert:` drive are the supported way to write the CurrentUser root store and Windows itself shows the trust confirmation. Behaviour: exactly one of the three switches (else write a usage line to stderr and `exit 2`); `-CaFile` mandatory and must exist; thumbprint computed with `[System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path $CaFile))`; `-Install` -> `Import-Certificate -FilePath $CaFile -CertStoreLocation Cert:\CurrentUser\Root` (no elevation; Windows shows its own confirmation); `-Remove` -> if `Test-Path "Cert:\CurrentUser\Root\$thumbprint"` then `Remove-Item` it (Windows confirms), else print `not installed: <thumbprint>`; `-ShowThumbprint` -> print only the uppercase hex thumbprint. Works on Windows PowerShell 5.1 and PowerShell 7. ASCII + LF, `$ErrorActionPreference = 'Stop'`, Allman-style braces as in `trust-ca.ps1`.

- [ ] **Step 1: Write the failing test** (`describe` skipped unless `process.platform === 'win32'`): mint a CA with `DevCertificateAuthority` into a temp root; `execFileSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File', script, '-CaFile', caFile, '-ShowThumbprint'])` stdout trimmed `=== new X509Certificate(pem).fingerprint.replace(/:/g, '')`; running with no switch exits with status 2. Never run `-Install`/`-Remove` in tests.
- [ ] **Step 2: Run** - Expected: FAIL (script missing).
- [ ] **Step 3: Implement** the script and the README paragraph.
- [ ] **Step 4: Run** gate - Expected: PASS. Manually (not automated, optional): `-Install` then `-Remove` against a throwaway CA shows the Windows dialogs.
- [ ] **Step 5: Commit** `feat(dev): trust or remove the development CA in the current user's roots`.

### Task 11: Hive console settings and the settings route

**Files:**
- Create: `admin/control-plane/hive-console-spec.ts`
- Modify: `admin/control-plane/platform-records.ts` (`HiveRecord.console?: HiveConsoleSpec`)
- Modify: `admin/control-plane/platform-directory.ts` (`SetHiveConsole`)
- Modify: `admin/control-plane/control-plane-host.ts` (route + error map)
- Test: `admin/control-plane/tests/hive-console-spec.test.ts`, `tests/platform-directory.test.ts`, `tests/control-plane-host-hive-console.test.ts` (new)

**Interfaces:**
- Consumes: `IngressTls`, `IngressTlsSource`, `IngressTlsPolicy.Parse` (Task 4); `K8sManifestBuilder.ConsoleHostOf` (Task 5).
- Produces:
  ```ts
  export type HiveConsoleSpec = { baseDomain: string; host?: string; tls: IngressTls }
  export class InvalidHiveConsoleError extends Error       // 400
  export class HiveConsoleSpecs
  {
      public static Parse(body: unknown): HiveConsoleSpec
      public static HostOf(spec: HiveConsoleSpec, tenantId: string): string   // host ?? ConsoleHostOf(tenantId, baseDomain)
  }
  // platform-directory.ts
  export class InHiveConsoleTakenError extends Error        // 409: 'Tenant <t> already runs its console in hive <h>; a tenant has one console.'
  public async SetHiveConsole(hiveId: string, console: HiveConsoleSpec | undefined): Promise<HiveRecord>
  ```
  Route: `PUT /api/hives/ID/console` (Full only via the existing central gate) -> 200 updated `HiveDto`; 400 `InvalidHiveConsoleError`/`InvalidIngressTlsError`; 404 unknown hive; 409 `InHiveConsoleTakenError`. Parse rules: `baseDomain` lowercase host name of >= 2 labels, no leading/trailing dot, <= 253; `host` optional, same rule; `tls` via `IngressTlsPolicy.Parse`; with `development` the effective host must be the base domain or under it.

- [ ] **Step 1: Write the failing tests:**
  - spec: `parses a minimal development spec` (`{ baseDomain: 'localtest.me', tls: { source: 'development' } }`); `HostOf defaults to console-<tenant>.<baseDomain>`; `refuses an upper-case or single-label base domain`; `development TLS refuses a host outside the base domain` (`host: 'console.example.com'`).
  - directory: `a second hive of the same tenant cannot also run the console` -> `InHiveConsoleTakenError`; `clearing the setting frees the tenant`; `the setting survives a reload` (new `PlatformDirectory` over the same files).
  - host (compose the host the way `control-plane-host-agent-install.test.ts` does): `PUT stores the console setting` (200, body `console.baseDomain === 'localtest.me'`); `PUT with a bad body is 400 with a plain sentence`; `PUT for a tenant that already has a console is 409`; `a read-only operator gets 403`.
- [ ] **Step 2: Run** - Expected: FAIL.
- [ ] **Step 3: Implement** (add `'console'` segment + `HiveConsolePathPattern` constants; map the two errors in the existing error table).
- [ ] **Step 4: Run** gate - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): per-hive in-hive console settings`.

### Task 12: TenantAdminBootstrap as the production console renderer

**Files:**
- Modify: `admin/control-plane/tenant-admin-bootstrap.ts`
- Test: `admin/control-plane/tests/tenant-admin-bootstrap.test.ts`

**Interfaces:**
- Consumes: `TenantConsoleExposure`, `fingerprintKeySecretName` (Task 5); `IngressTls` (Task 4); `VerifiedImage` (Task 6).
- Produces (Plan 2 consumes the fingerprint Secret shape):
  ```ts
  // TenantBootstrapInput gains:
  reuseAgentToken?: boolean       // true: no RegisterHive, no agent-token Secret in the set; the manifest still references AgentTokenSecretNameOf(hive.id)
  console?: TenantConsoleExposure
  fingerprintKey?: Buffer         // 32 bytes
  verifiedImages?: readonly VerifiedImage[]
  // idp gains ingressTls?: IngressTls (passed to IdpWorkloadSpec.ingressTls)
  // TenantAdminBootstrap statics:
  public static readonly FingerprintKeyKey = 'fingerprint.key'
  public static readonly VerifiedImagesKey = 'verified-images.json'
  public static FingerprintKeySecretNameOf(tenantId: string): string   // `pragmatic-tenant-admin-${tenantId}-fingerprint`
  ```
  Fingerprint Secret: Opaque, `pragmatic-system`, hive-labelled (`SecretRetention.RemovedWithHive`), single key `fingerprint.key` = the 32 raw bytes; mounted by the console at `/fingerprint/fingerprint.key` and named by `PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE` (Task 5). `verified-images.json` (JSON array of `VerifiedImage`) is added to the seed Secret, so the init container copies it to `/data/verified-images.json`. Point `IdpCaSecretNameOf`/`IdpTokenSecretNameOf`/`FingerprintKeySecretNameOf` and Task 5's removal manifest at the same name derivation (one home).

- [ ] **Step 1: Write the failing tests:**
  - `reuseAgentToken never registers and emits no token Secret` - registrar call count 0; `secrets.Names()` lacks `AgentTokenSecretNameOf(hive)`; the tenant-admin container env still has `secretKeyRef.name === AgentTokenSecretNameOf(hive)`.
  - `the fingerprint key is its own hive-labelled Secret` - parse `RenderManifest()`; item named `pragmatic-tenant-admin-acme-fingerprint` has labels `{ 'pragmatic/hive': hive.id }` and `Buffer.from(data['fingerprint.key'],'base64').equals(key)`.
  - `verified images ride in the seed Secret` - decoded `verified-images.json` deepEquals the input.
  - `console exposure reaches the console Ingress and the IdP Ingress TLS` - manifest has an Ingress for `console-acme.localtest.me`; the IdP Ingress has no ssl-passthrough annotation.
  - `nothing secret leaks through JSON` - `JSON.stringify(bootstrap)` contains neither `key.toString('base64')` nor the IdP admin token.
- [ ] **Step 2: Run** - Expected: FAIL.
- [ ] **Step 3: Implement**; update the class doc comment (production renderer, used by `TenantConsoleInstaller`).
- [ ] **Step 4: Run** gate - Expected: PASS (existing smoke-oriented tests unchanged when the new inputs are omitted).
- [ ] **Step 5: Commit** `feat(control-plane): bootstrap renders the in-hive console install`.

### Task 13: TenantConsoleInstaller, in-hive IdP admin and the operator routes

**Files:**
- Create: `admin/control-plane/in-hive-idp-admin.ts`, `admin/control-plane/tenant-console-installer.ts`
- Modify: `admin/control-plane/tenant-provisioning-service.ts:295` (`NewOwnerPassword` becomes `public static`)
- Modify: `admin/control-plane/control-plane-host.ts` (ctor param, routes, busy checks, hive delete)
- Modify: `admin/control-plane/server.ts` (wiring)
- Test: `admin/control-plane/tests/in-hive-idp-admin.test.ts`, `tests/tenant-console-installer.test.ts`, `tests/control-plane-host-hive-console.test.ts`

**Controller amendment (closes the plan's "known gap"):** hive delete, after removing the console, also deletes every
Namespace carrying the hive label the in-cluster orchestrator (Task 6) stamps on the environment namespaces it creates
(`pragmatic-env-*` AND that hive's label value; never a namespace missing either), and the delete outcome's `retained`
list names any that failed. Test: `hive delete removes console-created environment namespaces by hive label and keeps
unlabelled pragmatic-env-* namespaces`.

**Interfaces:**
- Consumes: everything above; `HiveAgentInstaller` types `IInstallOrchestratorSource`, `IInstallClock`, `SystemInstallClock`; `InClusterIdpSeedSource` (`in-cluster-idp-seed.ts`, IdP TLS + admin token, port 9443); `IdpAdminClient`, `IdpAdminError`; `KubectlCli.CanPortForward`, `NodeProcessSpawner`; `PlatformImageSigner` (`platform-signing-key.ts`), `CryptoImageVerifier`, `DockerImageDigest`, `FileKeyStore`.
- Produces:
  ```ts
  // in-hive-idp-admin.ts
  export type InHiveOwnerPassword = { ownerEmail: string; ownerPassword: string }
  export class InHiveIdpUnavailableError extends Error   // 409: 'This control plane holds no credentials for the in-hive identity provider. Install the console first.'
  export interface IInHiveIdpAdmin
  {
      Remember(tenantId: string, ca: Buffer, adminToken: string): Promise<void>
      SeedOwner(hive: HiveRecord, tenant: TenantRecord): Promise<void>
      ResetOwnerPassword(hive: HiveRecord, tenant: TenantRecord): Promise<InHiveOwnerPassword>
      Forget(tenantId: string): Promise<void>
  }
  export class InHiveIdpAdmin implements IInHiveIdpAdmin
  {
      public constructor(orchestrators: IInstallOrchestratorSource, store: SealedSecretStore, spawner: IProcessSpawner = new NodeProcessSpawner(), adminClients: (conn: IdpConnection) => IdpAdminClient = conn => new IdpAdminClient(conn))
      public static CaRefOf(tenantId: string): string      // `in-hive-idp-ca/${tenantId}`
      public static TokenRefOf(tenantId: string): string   // `in-hive-idp-admin-token/${tenantId}`
  }
  // tenant-console-installer.ts
  export enum ConsoleInstallState { Installing = 'installing', Deployed = 'deployed', Failed = 'failed' }
  export enum ConsoleInstallStep { CheckingAgent = 'checking-agent', PreparingCertificates = 'preparing-certificates', ApplyingConsole = 'applying-console', StoringSecrets = 'storing-secrets', WaitingForRollout = 'waiting-for-rollout', SeedingOwner = 'seeding-owner' }
  export type ConsoleInstallStatus = { state: ConsoleInstallState; step: ConsoleInstallStep; startedAt: string; finishedAt?: string; error?: string; consoleUrl?: string; devCaFile?: string }
  export class ConsoleNotConfiguredError extends Error      // 409
  export class ConsoleInstallUnavailableError extends Error // 409 (not Local / channel off / bad id)
  export class ConsoleInstallInProgressError extends Error  // 409
  export interface IConsoleDirectory { GetHive(id: string): HiveRecord | undefined; GetTenant(id: string): TenantRecord | undefined }
  export interface IConsoleImageApproval { Approve(hive: HiveRecord, baseImage: string): Promise<VerifiedImage> }
  export class PlatformConsoleImageApproval implements IConsoleImageApproval   // ctor(signer: PlatformImageSigner | undefined, verifier: IImageVerifier, digests: IImageDigest): sign when signer.SignsFor(hive), Verify(EffectiveRegistry.For(hive).ImageRef(base), hive.trustRootRef), digest via digests.Of
  export class TenantConsoleInstaller
  {
      public static readonly ConsolePort = 7100
      public static readonly IdpPort = 9443
      public constructor(directory: IConsoleDirectory, orchestrators: IInstallOrchestratorSource, bootstrap: TenantAdminBootstrap, fingerprints: ConsoleFingerprintKeys, devCa: IDevCertificateIssuer, idpAdmin: IInHiveIdpAdmin, images: IConsoleImageApproval, trustRoots: IKeyStore, agentChannelUrl: string | undefined, clock: IInstallClock = new SystemInstallClock())
      public Supports(hive: HiveRecord): boolean
      public Start(hiveId: string): ConsoleInstallStatus
      public StatusFor(hiveId: string): ConsoleInstallStatus | undefined
      public IsInstalling(hiveId: string): boolean
      public WhenSettled(hiveId: string): Promise<ConsoleInstallStatus | undefined>
      /** Deletes TenantConsoleRemovalManifest objects; keeps the data PVC, seed Secret and IdP namespace. */
      public Uninstall(hive: HiveRecord): Promise<void>
      /** On hive delete: drops the fingerprint key and the in-hive IdP credentials. */
      public Forget(hive: HiveRecord): Promise<void>
  }
  ```
  Run steps (each `Enter` re-checks the hive still exists, like `HiveAgentInstaller`):
  1. CheckingAgent - `Kubectl.Find('pragmatic-system', 'secret/' + AgentTokenSecretNameOf(hive.id))` undefined -> fail `'Install the agent first: the console uses the hive agent token.'`.
  2. PreparingCertificates - development: `devCa.Issue(baseDomain, ['*.' + baseDomain, baseDomain, ...(host not covered by the wildcard ? [host] : [])])`; existing-secret: `Find` the Secret in pragmatic-system and require type `kubernetes.io/tls` with both keys else fail `'The TLS Secret <name> was not found in pragmatic-system, or is not a kubernetes.io/tls Secret.'`; cert-manager: nothing. Then `images.Approve(hive, K8sManifestBuilder.AgentImage)`, `fingerprints.Ensure(hive.id)`, IdP seed via `new InClusterIdpSeedSource(undefined, baseDomain)`, and `bootstrap.GenerateBootstrap({ tenant, hive, tenantAdminImage: AgentImage, tenantPlanePort: 7100, baseDomain, externalScheme: 'https', channelUrl, reuseAgentToken: true, console: { host, ingressTls }, fingerprintKey, verifiedImages: [approved], idp: { image: AgentImage, port: 9443, tlsSecretName: InClusterIdpSeedSource.TlsSecretNameOf(t), adminTokenSecretName: InClusterIdpSeedSource.AdminSecretNameOf(t), adminTokenRef: InClusterIdpSeedSource.AdminTokenKey, ca, adminToken, ingressTls }, trustRootPublicKey: await trustRoots.PublicKey(hive.trustRootRef) })` (follow `in-cluster-federation-smoke.ts` for the IdP inputs).
  3. ApplyingConsole - `Kubectl.Apply(bootstrap.manifest)`.
  4. StoringSecrets - `ApplyServerSide(bootstrap.secrets.RenderManifest())`; `ApplyServerSide(seeds.SecretsManifestFor(t))`; for development: TLS Secret `pragmatic-dev-tls` (type `kubernetes.io/tls`) into pragmatic-system AND the IdP namespace `IdpNameOf(t)`; for existing-secret: a copy into the IdP namespace; `idpAdmin.Remember(t, ca, adminToken)`; `RolloutRestart` of the IdP and console Deployments (a reinstall picks up the new Secrets).
  5. WaitingForRollout - `RolloutStatus(IdpNameOf(t), IdpNameOf(t))` then `RolloutStatus('pragmatic-system', TenantAdminNameOf(t))`.
  6. SeedingOwner - `idpAdmin.SeedOwner(hive, tenant)`; then `Deployed`, `consoleUrl = 'https://' + host`, `devCaFile = devCa.CaFileOf(baseDomain)` for development.
  Failure text = fixed step message + `KubectlError` text, with every secret value (`adminToken`, fingerprint key base64/hex, TLS key PEM) split out as in `HiveAgentInstaller.Fail`; log line carries the error name only.
  `InHiveIdpAdmin`: `WithTunnel` opens `KubectlCli.PortForward(IdpNameOf(t), 'svc/' + IdpNameOf(t), 9443, spawner)`, builds `IdpConnection { baseUrl: 'https://127.0.0.1:<port>', browserBaseUrl: same, ca, adminToken, adminTokenRef: TokenRefOf(t), caDir: '' }` (the IdP cert carries IP SAN 127.0.0.1 via `DevCa`), runs the op, and `Kill`s the tunnel in `finally`; a kubectl that cannot port-forward or missing refs -> `InHiveIdpUnavailableError`. `SeedOwner`: `EnsureRealm(t, displayName)` then `SeedAccount({ email: ownerEmail, principalId: ownerPrincipalId ?? 'owner', displayName, password: NewOwnerPassword() })` with the password discarded; read `src/idp/idp-admin-endpoint.ts` for the duplicate-account answer and treat exactly that `IdpAdminError` status/code as already seeded. `ResetOwnerPassword`: `OwnerNotRecordedError` when `ownerEmail` is missing; else `ResetPassword(t, principalId, fresh)` and return `{ ownerEmail, ownerPassword: fresh }`.
  Routes (all Full-gated by the central gate for writes):
  - `POST /api/hives/ID/console-install` -> 202 status (no-store); 409 for the three errors, for `hiveWrites` busy, and while the agent installer is installing. `GET` -> 200 status or 404.
  - `POST /api/hives/ID/console/owner-password` -> 200 `InHiveOwnerPassword`, `Cache-Control: no-store`, never audited with the password.
  - `DELETE /api/hives/ID/console` -> 409 while installing; `Uninstall(hive)` when `Supports(hive)` (a `KubectlError` -> 409 with its redacted text); then `SetHiveConsole(id, undefined)`; 200 `HiveDto`.
  - `PUT /api/hives/ID/console` (Task 11) refuses 409 while installing.
  - `RefuseIfHiveBusy` and the agent-install POST also refuse while a console install runs.
  - Hive delete: when `hive.console` is set and `consoleInstaller.Supports(hive)`, `Uninstall` runs before `agentUninstaller.Uninstall`; after the platform records are gone, `Forget(hive)`.
  `server.ts`: `const sealed = await SealedSecretStore.Open(join(dataRoot, SealedSecretStore.FileName), masterKey)`; `new TenantConsoleInstaller(directory, orchestrators, new TenantAdminBootstrap(deployments), new ConsoleFingerprintKeys(sealed), new DevCertificateAuthority(join(dataRoot, DevCertificateAuthority.DirName), sealed), new InHiveIdpAdmin(orchestrators, sealed), new PlatformConsoleImageApproval(signing.PlatformSigner, <CryptoImageVerifier as HiveOrchestratorFactory builds it>, new DockerImageDigest()), new FileKeyStore(join(dataRoot, 'keys')), agentChannelUrl)` passed as the new last `ControlPlaneHost` ctor param `consoleInstaller?: TenantConsoleInstaller`. Hoist `'keys'`/`'signatures.json'` if not already shared constants.

- [ ] **Step 1: Write the failing tests:**
  - in-hive-idp-admin (fake port-forwarding kubectl + fake admin client): `ResetOwnerPassword resets over a loopback tunnel and returns the password once` (`ResetPassword('acme','owner', pw)`, conn `baseUrl === 'https://127.0.0.1:41000'`, result password length >= 20); `the tunnel is killed even when the IdP call fails`; `missing credentials are InHiveIdpUnavailableError`; `SeedOwner treats an existing account as seeded`; `no Owner recorded is OwnerNotRecordedError`.
  - installer (fakes modelled on `tests/hive-agent-installer.test.ts`; immediate clock):
    - `refuses a hive without console settings` (`ConsoleNotConfiguredError`), `a non-Local hive or a disabled channel` (`ConsoleInstallUnavailableError`), `a second start while installing` (`ConsoleInstallInProgressError`).
    - `stops at checking-agent when the agent token Secret is missing` - state Failed, step `checking-agent`, zero Apply calls.
    - `development issues the wildcard and stores pragmatic-dev-tls in pragmatic-system and the IdP namespace` - issuer hosts `['*.localtest.me','localtest.me']`; two server-side applies of a `kubernetes.io/tls` Secret named `pragmatic-dev-tls` in `pragmatic-system` and `IdpNameOf('acme')`.
    - `existing-secret of the wrong type fails at preparing-certificates` - Find returns type `Opaque`; error names the Secret; zero Apply calls.
    - `never registers a new agent token` - the registrar passed to `TenantAdminBootstrap` is never called.
    - `runs the steps in order and ends deployed` - call order Apply(manifest) -> ApplyServerSide(bootstrap secrets) -> ApplyServerSide(IdP seed secrets) -> RolloutRestart x2 -> RolloutStatus x2 -> SeedOwner; final `{ state: 'deployed', consoleUrl: 'https://console-acme.localtest.me', devCaFile: <CaFileOf> }`.
    - `reinstall with a new host updates the Ingress and keeps the fingerprint key` - second run's manifest Ingress host is the new host; the fingerprint Secret bytes equal the first run's.
    - `status, errors and logs never carry secrets` - force a failure at storing-secrets whose KubectlError text includes the admin token; `JSON.stringify(status)` and captured `console.error` output contain neither the admin token nor the fingerprint key (base64 and hex).
    - `Uninstall deletes the console removal manifest` - DeleteManifest received `TenantConsoleRemovalManifest(...)`.
  - host: `POST console-install answers 202 with no-store`; `GET console-install is 404 before any run`; `owner-password answers once with no-store and is not audited with the password` (audit entries contain no password); `DELETE console refuses while installing`; `agent install refuses while the console installs`; `hive delete removes the console before the agent and forgets its keys` (order of fake calls: console Uninstall, agent Uninstall, then Forget).
- [ ] **Step 2: Run** the three files - Expected: FAIL.
- [ ] **Step 3: Implement** the two classes, the host routes and the server wiring.
- [ ] **Step 4: Run** the full control-plane gate, `npm run typecheck:tools`, `npm run build:tenant-admin`, `npm test` - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): install the tenant console in a hive from the control plane`.

### Task 14: Platform admin portal - console panel on the hive detail page

**Files:**
- Modify: `admin/portal/src/portal-types.ts`, `admin/portal/src/api-client.ts`
- Create: `admin/portal/src/sections/hives/hive-console-view-model.ts`
- Modify: `admin/portal/src/sections/hives/hive-agent-install-view-model.ts` (`AgentInstallStepViewModel.Step: AgentInstallStep | ConsoleInstallStep`)
- Modify: `admin/portal/src/sections/hives/hive-detail-page-view-model.ts` (owns `Console`, resumes/stops its polling with the page, like `AgentInstall`)
- Modify: `admin/portal/src/sections/hives/hives.resources.mu` (a "Tenant console" block after the agent-install `ContentControl` in the `HiveDetailPageViewModel` template, plus a `DataTemplate [ DataType = HiveConsoleViewModel ]`)
- Test: `admin/portal/src/sections/hives/tests/hive-console.test.ts`

**Interfaces:**
- Consumes: routes and DTO shapes of Tasks 11 and 13.
- Produces:
  ```ts
  // portal-types.ts (wire mirrors)
  export enum IngressTlsSource { ExistingSecret = 'existing-secret', CertManager = 'cert-manager', Development = 'development' }
  export type HiveConsoleSpecDto = { baseDomain: string; host?: string; tls: { source: IngressTlsSource; secretName?: string; clusterIssuer?: string } }
  export enum ConsoleInstallState { Installing = 'installing', Deployed = 'deployed', Failed = 'failed' }
  export enum ConsoleInstallStep { CheckingAgent = 'checking-agent', PreparingCertificates = 'preparing-certificates', ApplyingConsole = 'applying-console', StoringSecrets = 'storing-secrets', WaitingForRollout = 'waiting-for-rollout', SeedingOwner = 'seeding-owner' }
  export type ConsoleInstallStatusDto = { state: ConsoleInstallState; step: ConsoleInstallStep; startedAt: string; finishedAt?: string; error?: string; consoleUrl?: string; devCaFile?: string }
  export type InHiveOwnerPasswordDto = { ownerEmail: string; ownerPassword: string }
  // HiveDto gains console?: HiveConsoleSpecDto
  // ControlPlaneClient (api-client.ts)
  public async SetHiveConsole(hiveId: string, spec: HiveConsoleSpecDto): Promise<HiveDto>
  public async RemoveHiveConsole(hiveId: string): Promise<HiveDto>
  public async StartConsoleInstall(hiveId: string): Promise<ConsoleInstallStatusDto>
  public async GetConsoleInstall(hiveId: string): Promise<ConsoleInstallStatusDto | null>
  public async ResetInHiveOwnerPassword(hiveId: string): Promise<InHiveOwnerPasswordDto>
  // hive-console-view-model.ts
  export class HiveConsoleViewModel extends Observable   // ctor(session: PortalSessionService, hive: HiveDto, scheduler: IPollScheduler = new TimerPollScheduler(), intervalMs = 2000)
  ```
  VM surface (bound names): `BaseDomain`, `Host`, `HostPlaceholder` (`console-<tenant>.<baseDomain>`), `TlsOptions` + `SelectedTls` (follow the `hive-options.ts` option pattern; labels "Use an existing TLS Secret", "cert-manager ClusterIssuer", "Development self-signed (development only)"), `SecretName`, `ClusterIssuer`, `IsExistingSecret`, `IsCertManager`, `IsDevelopment`, `IsConfigured`, `Steps` (rows reuse `AgentInstallStepViewModel` with labels "Check the hive agent", "Prepare certificates", "Apply the console", "Store its secrets", "Wait for it to start", "Create the Owner account"), `StatusText` (deployed: "Deployed. Waiting for the console to report."), `ConsoleUrl`, `DevTrustCommand` (`powershell -NoProfile -ExecutionPolicy Bypass -File admin\control-plane\dev\dev-ca-trust.ps1 -Install -CaFile "<devCaFile>"`), `OwnerEmail`, `OwnerPassword` (shown once, cleared by `Stop`), `ErrorText`, commands `SaveCommand` (enabled when the operator may mutate and the required field for the chosen TLS source is non-empty), `RemoveCommand`, `InstallCommand`, `RetryCommand`, `SetOwnerPasswordCommand` (enabled once deployed); `Resume()`/`Stop()` as in `HiveAgentInstallViewModel`. `.mu` labels inline; no Width/Height.

- [ ] **Step 1: Write the failing tests** (fakes as in `tests/hive-agent-install.test.ts`):
  - `Save sends the console spec` - development, base domain `localtest.me`, empty host -> `SetHiveConsole('h1', { baseDomain: 'localtest.me', tls: { source: 'development' } })` (no `host` key).
  - `existing-secret needs a Secret name before Save is enabled`; `cert-manager needs an issuer`.
  - `a 400 from Save shows the server sentence in ErrorText`.
  - `Install polls every 2 seconds until deployed and shows the waiting text` - scheduler ticks; final `StatusText === 'Deployed. Waiting for the console to report.'`, `ConsoleUrl === 'https://console-acme.localtest.me'`.
  - `the dev trust command quotes the CA path` - `DevTrustCommand.endsWith('-CaFile "C:\\data\\dev-ca\\localtest.me\\ca.crt"')`.
  - `the Owner password is shown once and cleared when the page is left`.
  - `a read-only operator can neither save, install nor set the Owner password`.
- [ ] **Step 2: Run** `npm --prefix admin/portal test` - Expected: FAIL.
- [ ] **Step 3: Implement** VM, client methods, types, detail-page wiring and the `.mu` template.
- [ ] **Step 4: Run** `npm --prefix admin/portal run typecheck`, `npm --prefix admin/portal test`, repo `npm run typecheck:tools` - Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): run the tenant console in a hive from the hive page`.

### Task 15: Live smoke on docker-desktop

**Files:**
- Create: `admin/control-plane/in-hive-console-smoke.ts` (gated; not a `*.test.ts`; excluded from the tenant-admin build by its `-smoke.ts` name)

**Interfaces:**
- Consumes: the operator routes (Tasks 11, 13), the console's `/tenant-api/environments` routes (existing `RouteEnvCreate`, `RouteEnvDelete`), `DevCertificateAuthority.CaFileOf` path from the install status.

  Invocation (the executor runs it):
  ```
  npx tsx admin/control-plane/in-hive-console-smoke.ts --operator-email admin@control-plane.test --password-file <path-to-file-with-operator-password> [--hive default-pragmatic-hive] [--base-domain localtest.me] [--control-plane http://127.0.0.1:7000]
  ```
  The password is read from the file, trimmed, and never printed, logged or put in an exception; so is the Owner password the smoke obtains. Output is one PASS/FAIL line per labelled step (pattern of `control-plane-smoke.ts`), exit code 1 on any FAIL, teardown always runs.

  Prerequisites the executor establishes before running (stop and ask the user if any cannot be met): (a) rebuild `pragmatic-server:dev` per the header of `docker/Dockerfile` so the image contains this branch's control-plane and tenant-admin code; (b) restart the running control plane (pid listening on 127.0.0.1:7000, tenant plane 127.0.0.1:7002, agent channel 0.0.0.0:7001) from this checkout with the same environment it runs with now - if that environment cannot be determined, ask the user rather than guessing; (c) context `docker-desktop` reachable, hive `default-pragmatic-hive` (tenant `pragmatic-default`) with its agent connected; (d) host port 443 free; (e) openssl on PATH; (f) Playwright Chromium installed.

  Steps (each a labelled check):
  1. Preflight: `kubectl --context docker-desktop get ns pragmatic-system`; agent token Secret exists. If no IngressClass `nginx` exists, apply `https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/cloud/deploy.yaml`, wait for `ingress-nginx-controller` rollout, and record that the smoke installed it.
  2. Operator login: `POST /api/login` with Origin unset; keep the session cookie.
  3. `PUT /api/hives/default-pragmatic-hive/console` `{ baseDomain, tls: { source: 'development' } }` -> 200.
  4. `POST .../console-install` -> 202; poll `GET` every 2 s up to 15 min until `deployed` (FAIL with the status `error` sentence otherwise).
  5. TLS check: node `https.get` to `https://127.0.0.1/` with `servername: console-pragmatic-default.<baseDomain>`, `Host` header the console host, and `ca` = the CA file from `devCaFile` -> TLS handshake succeeds without `rejectUnauthorized: false`, status is 200 or a redirect; the peer certificate's issuer CN is `Pragmatic Development CA (<baseDomain>)`.
  6. `POST .../console/owner-password` -> 200; keep `{ ownerEmail, ownerPassword }` in memory only.
  7. Browser sign-in: Chromium with `--host-resolver-rules=MAP console-pragmatic-default.<baseDomain> 127.0.0.1,MAP idp-pragmatic-default.<baseDomain> 127.0.0.1` and `ignoreHTTPSErrors: true` (the CA is not installed into the user's store by the smoke); open the console URL, follow the IdP login (selectors as in `in-cluster-federation-smoke.ts`), land back on the console with a session.
  8. Create an environment from the console: in the page context, `fetch('/tenant-api/environments', { method: 'POST', body: JSON.stringify({ name: 'smoke-ihc', template: 'dev-blank', type: 'development' }) })` -> 201; then `kubectl get ns pragmatic-env-smoke-ihc -o json` carries label `pragmatic/hive=default-pragmatic-hive`, has RoleBinding `pragmatic-tenant-console`, and the server Deployment becomes ready (`kubectl rollout status`, 5 min).
  9. Delete the environment from the console (`DELETE /tenant-api/environments/smoke-ihc`) -> 2xx; the namespace is gone within 2 min.
  10. Teardown (always, in `finally`, each best-effort and reported): delete the env via kubectl if step 9 did not run; `DELETE /api/hives/default-pragmatic-hive/console` -> 200; then `kubectl delete ns <IdpNameOf('pragmatic-default')> --ignore-not-found`, `kubectl -n pragmatic-system delete pvc <TenantAdminClaimNameOf> secret <TenantAdminSeedSecretNameOf> --ignore-not-found` (the smoke's own leftovers, which the product deliberately retains); uninstall ingress-nginx only if step 1 installed it; assert no ClusterRole named `pragmatic-tenant-admin-pragmatic-default*` remains.

- [ ] **Step 1: Write the smoke** as a class (`InHiveConsoleSmoke` with a static `Main`), constants hoisted, Allman braces; reuse `KubectlCli`/`NodeExecFile` for kubectl calls.
- [ ] **Step 2: Typecheck** `npm run typecheck:tools` - Expected: PASS.
- [ ] **Step 3: Run the smoke** with the invocation above - Expected: every step PASS, exit code 0; output contains no password (grep the captured output for the operator password's first 6 characters: no match).
- [ ] **Step 4: Fix** any product bug the smoke finds in the owning task's files (with a regression test there), re-run the gates and the smoke.
- [ ] **Step 5: Commit** `test(control-plane): live smoke for the in-hive console on docker-desktop` (smoke file plus any fixes, staged by path).

---

## Self-review

**Spec coverage.** Console exposure / Ingress on a client-chosen host (default `console-<tenant>.<baseDomain>`, emitted only with settings) - Tasks 5, 11, 12. TenantHostResolver accepts the console host - Task 7. "A real console install": portal toggle + host + certificate - Tasks 11, 14; control plane generates the console Secrets (agent token reference, fingerprint key, IdP wiring) and delivers via the HiveAgentInstaller-style path with TenantAdminBootstrap as production renderer - Tasks 8, 12, 13; portal install status with "waiting for the console to report" until Plan 2's advert - Tasks 13, 14. In-hive environment management: own ServiceAccount with mounted token, ClusterRole create/get/delete on Namespaces with the prefix enforced in the console, RoleBinding to full rights in each environment namespace created right after it - Tasks 5, 6; in-cluster API orchestrator behind `IHiveOrchestrator`, picked for Local hives when running in a pod - Tasks 2, 3, 6, 7; admin secret read through the API - Tasks 1, 7. TLS both (existing Secret, cert-manager) applied to console, IdP and environment Ingresses - Tasks 4, 5, 6, 13. Development self-signed: CA once in the data root with key sealed by the master key, wildcard certificate, TLS Secret in the cluster, Windows CurrentUser trusted-root script with removal, portal labels it development only - Tasks 8, 9, 10, 13, 14. One console per tenant - Task 11. Goal 2 (reach over Service DNS, never port-forward) for the console - Task 7; the produced `IEnvironmentReach` serves Plan 3. Out of this plan by design: advert route and store, discovery, email domains (Plan 2); `/desktop/*` and relay composition on the console, Plexus (Plan 3).

**Placeholder scan.** No TBD/TODO; the one deferred lookup (duplicate-account status in `idp-admin-endpoint.ts`) names the file and the exact rule. Task 7's dependency on `TenantAdminBootstrap.VerifiedImagesKey` is pinned to the same constant Task 12 owns.

**Type consistency.** `IngressTls`/`IngressTlsSource`/`IngressTlsPolicy` (Task 4) are used unchanged in Tasks 5, 6, 7, 11, 12, 13; `VerifiedImage` (Task 6) in Tasks 12, 13; `InClusterOrchestration`/`ConsoleIdentity` (Task 6) in Task 7; `IEnvironmentReach` (Task 1) in Task 7; `TenantConsoleRemovalManifest` (Task 5) in Task 13; `ConsoleInstallStep` values identical in Tasks 13 and 14; `FingerprintKeySecretNameOf` / `FingerprintKeyKey` / `/fingerprint/fingerprint.key` / `PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE` identical in Tasks 5, 12 and the Plan 2 contract.

**Review Focus.** Each of the five lines names its test in the owning task (13, 13, 5+13, 6, 11).

**Proportion.** Bodies are given only for the RBAC rule sets, the apply ordering and the openssl extension lines, which the signatures do not determine.

## Produced interfaces for Plans 2 and 3

- Plan 2 (advert, fingerprints): control-plane `ConsoleFingerprintKeys.Get(hiveId: string): Promise<Buffer | undefined>` (32 bytes, sealed under `console-fingerprint-key/<hiveId>`); console side reads the key file named by `TenantAdminEnv.FingerprintKeyFile` (`PRAGMATIC_TENANT_ADMIN_FINGERPRINT_KEY_FILE` = `/fingerprint/fingerprint.key`), delivered in Secret `TenantAdminBootstrap.FingerprintKeySecretNameOf(tenantId)` = `pragmatic-tenant-admin-<tenantId>-fingerprint`, key `fingerprint.key`, raw bytes; `HiveRecord.console?: HiveConsoleSpec` marks a tenant as in-hive (discovery exclusion until the first advert); `HiveConsoleSpecs.HostOf(spec, tenantId)` is the expected console host; `TenantConsoleInstaller.StatusFor` final state `deployed` is what the advert later upgrades to "reported".
- Plan 3 (desktop API/relay on the console): `IEnvironmentReach` (`UrlsFor`, `AdminPasswordFor`), `DesktopRelayWiring.endpoints: IEnvironmentReach`, `TenantAdminComposition.reach: IEnvironmentReach | undefined` (an `InClusterEnvironmentReach` in a pod: origin-only `record.endpoint` URLs, no lease; admin password from `<env>-env-secrets` via the guarded API kubectl).
