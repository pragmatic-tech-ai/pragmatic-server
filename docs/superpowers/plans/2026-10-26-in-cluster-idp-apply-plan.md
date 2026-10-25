# In-Cluster IdP Real Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote `InClusterIdpDriver` from test-only to proven-live: generate+seed a per-tenant IdP's TLS + admin-token as k8s Secrets, apply a real per-tenant IdP workload into the cluster via the driver, and prove by a gated live smoke that it reaches rollout-Ready and serves valid OIDC (discovery + authorize/token/jwks) over its CA.

**Architecture:** This is the robust, achievable core of the "full in-cluster browser-OIDC tenant-admin login e2e" deferred. Real browser-OIDC login is already proven by `tenant-login-e2e-smoke.ts` (real Playwright + real OIDC) — but against a **Docker** IdP (`DockerIdpDriver`) with the tenant plane in-process. `InClusterIdpDriver.EnsureRunning` (apply `RenderIdp` → rollout wait → Service-DNS baseUrl) exists but is wired nowhere except its unit test and has never run against a cluster. `RenderIdp` mounts a `tlsSecretName` Secret and an admin-token Secret that nothing currently creates. We add an in-cluster IdP seed source that generates the TLS (via the existing `DevCa` for the Service-DNS SAN) + admin token and renders them as k8s Secrets (secret-safe, mirroring slice-3's `BootstrapSecretSet`), wire `InClusterIdpDriver` with it, and prove the whole apply+serve path live.

**Tech Stack:** TypeScript (NodeNext ESM), node:test + tsx, the existing `admin/control-plane` k8s manifest/kubectl stack, `src/idp/dev-ca.ts` (`DevCa.EnsureAt`), the `pragmatic-server:dev` image (runs `pragmatic-idpd`), kind (docker-desktop) + `kubectl port-forward` for the gated smoke.

**Spec:** `docs/superpowers/specs/2026-10-25-platform-and-tenant-admin-app-separation-design.md` — implements the achievable core of the filed follow-up "Full in-cluster browser-OIDC tenant-admin login e2e".

## Scope boundary (read before implementing)

This slice proves **`InClusterIdpDriver` real apply + the in-cluster IdP serves OIDC** (the deferred's first concrete ask), verified from a client via `kubectl port-forward`. The following are genuinely fragile/architecturally-blocked and OUT OF SCOPE — each filed as a precise follow-up (they overlap the existing SP-HIVE-6c "federation beyond Docker Desktop" item) and the code must not pretend to implement them:

- **Browser-reachable external issuer + host exposure.** The IdP self-issues its OIDC discovery from a `svc.cluster.local` issuer, unreachable by a host browser. Making a browser-trusted external issuer (Caddy over `kubectl port-forward` under `*.lvh.me`, Windows CA trust) is deferred.
- **Fully-in-cluster tenant-admin container OIDC.** `RenderTenantAdmin` injects no IdP connection and `TenantAdminServer.Compose` uses `DockerIdpDriver` (cannot run in a pod). Rewiring the in-cluster tenant-admin to use `InClusterIdpDriver` + inject the IdP connection + resolve the single-issuer-across-two-networks (split-horizon) problem for an in-cluster RP is deferred.
- **The headed Playwright full-in-cluster browser-OIDC login e2e** tying the above together (real browser-OIDC is already proven against a Docker IdP by `tenant-login-e2e-smoke.ts`).

## Global Constraints

- OOP only: methods/statics on classes; no module-level free functions or mutable module state.
- Allman braces; no inline string literals (hoist reused literals to `private static readonly` PascalCase); PascalCase interfaces/public methods; real classes/interfaces, not lambda bags.
- Security (verbatim, non-negotiable): TLS private keys, the admin token, and any secret/inner-error text are held server-side by name only — NEVER in logs, DTOs, errors, thrown messages, or persisted records. The secret-rendering object keeps bytes in private fields, has redacted `toString`/`toJSON`, and its only exit is `RenderManifest()` (Secret objects). Manifests carry secret REFs, not values.
- Tests live in `admin/control-plane/tests/`; files `*.test.ts`. The gated smoke is `*-smoke.ts` (excluded from the test glob; run via `npx tsx`).
- LF-only line endings; do not flip files to CRLF. Do not touch `agent-channel-host.ts`.
- NEVER `npm install` at the repo root.
- Typecheck gates: `npx tsc -p tsconfig.tools.json --noEmit` AND `npx tsc -p tsconfig.tenant-admin.json --noEmit` both clean.
- Control-plane unit suite must stay green (baseline 674 on this branch's master).
- Git commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do not push.

## Review Focus

- **Secret non-leakage:** the TLS key + admin token must never appear in logs, the rendered non-Secret manifests, errors, or any serialization but the Secret objects themselves; the seed object's `toString`/`toJSON` must be redacted. Covered by a Task 1 redaction test.
- **TLS SAN correctness:** the generated server cert's SAN must match the exact Service-DNS host the IdP self-issues + the readiness probe/clients use (`pragmatic-idp-<tenant>.pragmatic-idp-<tenant>.svc.cluster.local`), or TLS verification fails. Covered by a Task 1 SAN test + the Task 2 live discovery fetch over the CA.
- **Secret ref alignment:** the Secret names the seed source renders must byte-match the `tlsSecretName`/admin-token refs `RenderIdp` mounts, or the pod won't start. Covered by a Task 1 manifest-ref test.
- **Idempotent re-apply + teardown:** applying the IdP twice (same tenant) must not error, and teardown must remove the namespace so a re-run is clean. Covered by the Task 2 smoke.
- **No regression to the Docker IdP path:** `DockerIdpDriver` and the existing in-process IdP usages are untouched. Covered by the unit suite staying green.

---

### Task 1: In-cluster IdP seed source + Secret rendering, wired into `InClusterIdpDriver`

**Files:**
- Create: `admin/control-plane/in-cluster-idp-seed.ts` (the seed source: generates TLS via `DevCa` for the Service-DNS SAN + an admin token; a secret-safe set that renders the TLS + admin-token k8s Secrets)
- Modify (only if needed): `admin/control-plane/in-cluster-idp-driver.ts` / `admin/control-plane/k8s-manifest-builder.ts` — ONLY if the existing `IIdpSeedSource`/`RenderIdp` secret-ref contract needs a hook for applying the seed Secrets before the workload. Do NOT change `RenderIdp`'s existing object shape beyond what's required to reference the seeded Secrets (the P2/slice-3 recon says it already references `tlsSecretName`; confirm the admin-token ref).
- Test: `admin/control-plane/tests/in-cluster-idp-seed.test.ts`

**Interfaces:**
- Consumes: `DevCa.EnsureAt(dir, host, openssl)` (from `src/idp/dev-ca.ts`) → CA + server cert/key for `host`; the existing `IIdpSeedSource` contract that `InClusterIdpDriver` expects (read `in-cluster-idp-driver.ts` for the exact shape — it seeds CA/admin-token "from bootstrap"); `K8sManifestBuilder.IdpBaseUrlOf(tenantId, 9443)` and the Service-DNS host it encodes.
- Produces: an in-cluster IdP seed source whose output (a) provides the `IIdpSeedSource` values `InClusterIdpDriver.EnsureRunning` needs, and (b) renders a kubectl-appliable `v1 List` of the TLS Secret + admin-token Secret whose names byte-match the refs `RenderIdp` mounts, in the IdP's namespace. Model the secret-safety on slice-3's `BootstrapSecretSet` (`tenant-admin-bootstrap.ts`): bytes in `#private` fields, `toJSON`/`toString` redacted, only exit `RenderManifest()`.

- [ ] **Step 1:** Read `in-cluster-idp-driver.ts` (the `IIdpSeedSource` it consumes + what `EnsureRunning` applies), `k8s-manifest-builder.ts` `RenderIdp`/`IdpBaseUrlOf`/`IdpServiceObject` (the exact Secret ref names + Service-DNS host), and `tenant-admin-bootstrap.ts` `BootstrapSecretSet` (the secret-safe pattern to mirror). Note the exact Service-DNS host string.
- [ ] **Step 2:** Write `in-cluster-idp-seed.test.ts` (failing-first): (a) the rendered Secret names byte-match the refs `RenderIdp` mounts; (b) the server cert's SAN equals the Service-DNS host `IdpBaseUrlOf` encodes; (c) `toString`/`toJSON` of the seed/secret-set never contain the TLS private key or admin-token bytes (redaction); (d) `RenderManifest()` yields `v1`/`Secret` objects with base64 `data` in the IdP namespace.
- [ ] **Step 3:** Run — FAIL.
- [ ] **Step 4:** Implement `in-cluster-idp-seed.ts` (generate TLS via `DevCa` for the Service-DNS SAN + admin token; the secret-safe set + `RenderManifest`; provide the `IIdpSeedSource` values). Wire `InClusterIdpDriver` to apply the seed Secrets before/with the workload if that hook doesn't already exist.
- [ ] **Step 5:** Run the new test + the full control-plane suite + both tscs → all green, Docker IdP path untouched.
- [ ] **Step 6:** Commit `feat: in-cluster IdP seed source (TLS + admin-token k8s Secrets) wired into InClusterIdpDriver`.

---

### Task 2: Gated live smoke — apply a real in-cluster IdP and prove it serves OIDC

**Files:**
- Create: `admin/control-plane/in-cluster-idp-smoke.ts` (gated; `*-smoke.ts`, run via `npx tsx`, not in the test glob)

**Interfaces:**
- Consumes everything from Task 1 + `InClusterIdpDriver` + the real `KubectlCli`/`K8sManifestBuilder`. Models `k8s-hive-smoke.ts` for the cluster harness (context `docker-desktop`; the `pragmatic-server:dev` image — which carries `pragmatic-idpd` — is already in the kind node). Uses `kubectl port-forward` to reach the IdP from the host (the repo's established host↔cluster pattern; no ingress).

- [ ] **Step 1:** Write the smoke: (a) apply a per-tenant IdP in-cluster via `InClusterIdpDriver.EnsureRunning` (seed Secrets applied + `RenderIdp` applied); assert the IdP Deployment reaches rollout-Ready; (b) `kubectl port-forward` the IdP Service to a local port and fetch `https://<local>/<tenant>/.well-known/openid-configuration` over the seeded CA (`rejectUnauthorized: true`, trusting the CA; use the Service-DNS SNI/host so the SAN matches), asserting the discovery doc parses and exposes `issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri`; (c) confirm the `jwks_uri` returns keys and the admin API is reachable with the seeded admin token; (d) a second `EnsureRunning` for the same tenant is idempotent (no error); (e) `Discard`/teardown removes the IdP namespace. Print PASS/FAIL per step + OVERALL; non-zero exit on any FAIL; teardown in `finally` so re-runs are clean.
- [ ] **Step 2:** Run it live: `npx tsx admin/control-plane/in-cluster-idp-smoke.ts` against docker-desktop. Capture output. If the IdP pod cannot reach Ready or serve OIDC for an environmental reason NOT caused by this slice's code (e.g. the `pragmatic-idpd` in `:dev` needs config the seed doesn't provide), gather the pod logs, record precisely what blocked it in the smoke header + report, and re-scope the readiness assertion to the furthest robustly-verifiable point (Deployment applied + pod scheduled) rather than fake success — ruling pre-authorized.
- [ ] **Step 3:** Commit `test: gated in-cluster IdP apply + serves-OIDC smoke`.

---

## Self-Review Notes

- **Spec coverage:** Tasks 1-2 deliver "wire `InClusterIdpDriver` real apply + in-cluster IdP (serves OIDC)" — the deferred's concrete first ask. The browser-reachable external issuer, the in-cluster tenant-admin container OIDC, and the headed full browser e2e are explicitly deferred (Scope boundary) and filed as SP-HIVE-6c-linked follow-ups.
- **Type consistency:** the seed source output matches the `IIdpSeedSource` shape `InClusterIdpDriver` consumes; the rendered Secret names match `RenderIdp`'s mounted refs.
- **Proportion:** the plan fixes the decisions (DevCa for the Service-DNS SAN, secret-safe BootstrapSecretSet-style rendering, port-forward+CA discovery proof) and defers bodies to the implementer mirroring `BootstrapSecretSet`/`k8s-hive-smoke`.
- **Review Focus:** secret non-leakage, TLS SAN, secret-ref alignment, idempotent apply+teardown, Docker-path non-regression — each tied to a task's tests.
