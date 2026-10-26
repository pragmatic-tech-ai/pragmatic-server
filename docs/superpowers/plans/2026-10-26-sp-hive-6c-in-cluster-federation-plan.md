# SP-HIVE-6c In-cluster OIDC federation (split-host issuer) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real browser OIDC login works against a per-tenant in-cluster IdP — for both the tenant-admin app and a served environment — via a split-host issuer (browser-facing `iss`+authorize, in-cluster token/jwks), proven end-to-end on kind.

**Architecture:** The IdP advertises two bases in its discovery doc (browser base for `issuer`+`authorization_endpoint`+signed `iss`; internal Service-DNS base for `token_endpoint`+`jwks_uri`). The relying party (`todl-identity-cloud`) is UNCHANGED — it already reads endpoints from the discovery doc and validates `iss` against the configured issuer. A per-tenant Ingress (ingress-nginx SSL passthrough) + a dual-SAN DevCa cert expose the IdP to the browser; the tenant-admin pod and served env pods CONNECT to the operator-provisioned IdP via injected connection material (incl. the admin token + CA). Docker-Desktop single-host federation stays byte-identical (internal base defaults to browser base when `baseDomain` is absent).

**Tech Stack:** TypeScript (NodeNext ESM), `tsx --test`, kubectl/kind, ingress-nginx, Playwright (gated smoke), openssl (DevCa). Repos: pragmatic-server (all tasks); `todl-identity-cloud` is NOT modified (confirmed by builder-check — assert by diff).

**Spec:** `docs/superpowers/specs/2026-10-26-sp-hive-6c-in-cluster-federation-design.md`

## Global Constraints

- OOP: methods/statics on classes; no module-level free functions or mutable state. Allman braces. No inline string literals (hoist to `private static readonly` PascalCase). PascalCase interfaces + public methods. Engine-never-calls-up.
- SECRET-SAFETY (verbatim): IdP admin token, OIDC client secret, owner password, CA **private** key — held server-side by name only; NEVER in logs, DTOs, errors, thrown messages, or persisted records (refs/mounts only). The CA private key stays unshipped (DdLv8 invariant — do not reintroduce it into any Secret). The injected tenant-admin/env connection carries the admin token + CA **cert** by Secret ref/mount, never inline.
- **SERVER-KEY SAFETY (producer side, load-bearing):** a relying-party pod (tenant-admin, served env) needs only the PUBLIC `ca.crt` to trust the IdP — NEVER the IdP's server **private key**. The existing per-tenant IdP TLS Secret holds `server.crt`+`server.key`+`ca.crt` together; it MUST NOT be mounted into an RP pod. The producer projects a **separate `ca.crt`-only Secret** (or mounts only the `ca.crt` key via a Secret item selector) for RP pods. Pin a test that the RP pod's mount exposes `ca.crt` only, never `server.key`.
- Docker-Desktop / single-host path BYTE-IDENTICAL: `baseDomain` absent ⇒ internal base = browser base ⇒ single-host discovery, single-SAN cert, `PRAGMATIC_IDP_BASE_URL` = internal base exactly as today. The P4 `in-cluster-idp-smoke`, `idp-sso-smoke`, `tenant-login-e2e-smoke`, and the Docker federation must not change behavior.
- `todl-identity-cloud` (the RP) is NOT modified. If a task thinks it must change the RP, STOP — re-check the split-host model (the RP already supports it).
- Tests live in `tests/` subfolders. NEVER `npm install` at repo root. LF-only. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- No worktree; branch `feat/sp-hive-6c-in-cluster-federation` off master. (A stale `sp-hive-6c-proper-idp-federation` branch exists and is behind master — do NOT reuse it.)

## Review Focus

1. **`iss` consistency** — token `iss` (signed in `TokenEndpoint` from the host `baseUrl`) and discovery `issuer` are the BROWSER base and equal the RP's configured issuer byte-for-byte; token/jwks are the INTERNAL base. A cross-wired base fails login. (Task 1 + Task 4/5 unit.)
2. **Docker path byte-identical** — `baseDomain`/internal base unset ⇒ single-host IdP + single-SAN cert + unchanged `Federate` Docker branch. (Task 1/2/5 unit + the P4 smoke's no-arg construction still compiles & behaves.)
3. **Pod never needs external reach** — the RP fetches discovery+token+jwks over the internal base only; only the browser hits the external host. (Task 4/5 unit: RP configured discovery = internal base.)
4. **TLS trust both ways** — server cert SANs cover browser + internal hosts; pod trusts the DevCa (tenant-admin via `ca:`; served env via `NODE_EXTRA_CA_CERTS`); browser via smoke ignore/host-resolver. A missing SAN fails. (Task 2 unit + Task 4/5 mounts + smoke.)
5. **Secret non-leakage** — admin token / client secret / owner password / CA **key** never logged, in an error, in a DTO, or persisted; CA key stays unshipped. (Every task's tests + whole-branch review.)

---

## Task 1: IdP split-host discovery (S1)

**Files:**
- Modify: `src/idp/idp-host.ts` (new internal-base ctor param, used ONLY in `Discovery()` for `token_endpoint`+`jwks_uri`; `baseUrl` stays the browser base so `iss`/authorize/issuer are unchanged), `src/idp/idp-main.ts` (`PRAGMATIC_IDP_INTERNAL_URL` env var, https-guarded like the existing vars, defaulting to the browser `baseUrl` when unset; pass to `IdpHost`)
- Test: `src/idp/tests/idp-host.test.ts` (extend; create if absent — follow existing idp test idiom)

**Interfaces:**
- Produces: `IdpHost` ctor gains a trailing optional `internalBaseUrl?: string` (default = `baseUrl`). `Discovery(tenantId)` emits `issuer` + `authorization_endpoint` from `baseUrl` (browser) and `token_endpoint` + `jwks_uri` from `internalBaseUrl`. `TokenEndpoint` (`iss`) is UNCHANGED (still from `baseUrl`). `idp-main` reads `PRAGMATIC_IDP_INTERNAL_URL` (optional, https-required if present).

- [ ] **Step 1: Write failing tests.** (a) with `internalBaseUrl` set ≠ `baseUrl`: `Discovery()` returns `issuer`==`<baseUrl>/<t>`, `authorization_endpoint` on `baseUrl`, `token_endpoint`+`jwks_uri` on `internalBaseUrl`; (b) with `internalBaseUrl` UNSET: all four on `baseUrl` (byte-identical to today); (c) a token minted via `TokenEndpoint` carries `iss`==`<baseUrl>/<t>` regardless of `internalBaseUrl` (iss follows the browser base).
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** the ctor param + `Discovery()` split; `idp-main` env var + https guard + pass-through. Hoist any new literals.
- [ ] **Step 4: Run tests — expect pass.** Then the full IdP suite (`npx tsx --test "src/idp/tests/**/*.test.ts"`) + `tsc` tools. Confirm `todl-identity-cloud` untouched.
- [ ] **Step 5: Commit** (branch `feat/sp-hive-6c-in-cluster-federation` off master).

## Task 2: Connection bases + dual-SAN cert plumbing (S2a)

**Files:**
- Modify: `src/idp/dev-ca.ts` (`EnsureAt` host param becomes `host: string | readonly string[]` — a bare string keeps ALL ~15 existing call sites byte-identical; a list enables dual-SAN. CN = first host; each validated by `HostPattern`; `subjectAltName` emits `DNS:<h>` for each + `IP:127.0.0.1`. Only the new dual-SAN caller passes a list; do NOT touch the other call sites), `admin/control-plane/idp-workload-driver.ts` (`IdpConnection` += `browserBaseUrl: string`; `IdpWorkloadSpec` += optional `baseDomain?: string`), `admin/control-plane/in-cluster-idp-seed.ts` (`HostOf` → optional `baseDomain` → returns [internal] or [internal, browser]; mint with the SAN list), `admin/control-plane/in-cluster-idp-driver.ts` (thread `baseDomain`; return `browserBaseUrl` = `IdpBrowserUrlOf` when `baseDomain` present, else = `baseUrl`), `admin/control-plane/k8s-manifest-builder.ts` (`IdpBrowserUrlOf(tenant, baseDomain, port?)`; keep `IdpBaseUrlOf` internal)
- Test: `src/idp/tests/dev-ca.test.ts`, `admin/control-plane/tests/in-cluster-idp-seed.test.ts`, `admin/control-plane/tests/in-cluster-idp-driver.test.ts` (extend each)

**Interfaces:**
- Consumes: Task 1's IdP (no direct dep; parallel-safe but sequenced after T1 for a clean tree).
- Produces: `DevCa.EnsureAt(dir, host: string | readonly string[], openssl?)` (existing bare-string callers unchanged; the dual-SAN caller passes a list); `IdpConnection { baseUrl; browserBaseUrl; ca; adminToken; … }` (`browserBaseUrl` defaults to `baseUrl`); `K8sManifestBuilder.IdpBrowserUrlOf(tenantId, baseDomain, port?) => https://idp-<tenant>.<baseDomain>`; `InClusterIdpSeedSource.HostOf(tenantId, baseDomain?)` returns the SAN list.

- [ ] **Step 1: Write failing tests.** (a) `DevCa.EnsureAt(dir, [a, b])` mints a cert whose SAN includes `DNS:a`, `DNS:b`, `IP:127.0.0.1` (parse with `X509Certificate`), CN=a; `EnsureAt(dir,[a])` == the prior single-host behavior (byte-shape); the DdLv8 no-persist guard still holds (no `ca.key` in dir). (b) `HostOf(t)` → `[internalHost]`; `HostOf(t, 'd.localtest')` → `[internalHost, 'idp-<t>.d.localtest']`. (c) `IdpBrowserUrlOf(t,'d.localtest')` == `https://idp-<t>.d.localtest`. (d) the in-cluster driver returns `browserBaseUrl` == browser URL when `baseDomain` set, == `baseUrl` when unset (Docker/no-domain byte-identical). (e) existing no-`baseDomain` seed/driver construction (the P4 smoke path) is unchanged.
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** the union-type `EnsureAt` (bare string still works — do NOT edit the ~15 existing call sites; only the dual-SAN seed caller passes a list), the connection/spec fields, `HostOf`/`IdpBrowserUrlOf`, and the driver threading. Hoist literals (`IdpHostPrefix='idp-'`, etc.).
- [ ] **Step 4: Run tests — expect pass.** Full IdP + control-plane suites + `tsc` tools+tenant-admin+build.
- [ ] **Step 5: Commit.**

## Task 3: Per-tenant IdP Ingress (S2b)

**Files:**
- Modify: `admin/control-plane/k8s-manifest-builder.ts` (`RenderIdp` appends a per-tenant `Ingress` when `baseDomain` is present: host=`idp-<tenant>.<baseDomain>`, backend=the IdP Service:9443, annotation `nginx.ingress.kubernetes.io/ssl-passthrough: "true"`, `ingressClassName` nginx), `admin/control-plane/idp-workload-driver.ts`/`in-cluster-idp-driver.ts` (pass `baseDomain` into the render)
- Test: `admin/control-plane/tests/k8s-manifest-builder.test.ts` (extend) / the IdP render test

**Interfaces:**
- Consumes: Task 2 (`baseDomain` on the spec; `IdpBrowserUrlOf`).
- Produces: `RenderIdp` output includes the Ingress object only when `baseDomain` is set (absent ⇒ no Ingress, ClusterIP-only as today).

- [ ] **Step 1: Write failing tests.** With `baseDomain` set: `RenderIdp` includes an `Ingress` whose rule host == `idp-<t>.<baseDomain>`, carries the ssl-passthrough annotation, and backends the IdP Service on 9443. With `baseDomain` unset: NO Ingress object (byte-identical to the P4 render).
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** the conditional Ingress render. Hoist the annotation key/value + host template.
- [ ] **Step 4: Run tests — expect pass.** control-plane suite + `tsc`.
- [ ] **Step 5: Commit.**

## Task 4: Tenant-admin pod connects to the IdP (S3 / DdLtc)

**Files:**
- Create: a connection-only `IIdpService` impl (e.g. `admin/control-plane/injected-idp-service.ts`) whose `EnsureForTenant(tenantId, displayName)` returns an `IdpConnection` built from injected env + a mounted Secret (browser base, internal base, CA cert, admin token) — NO apply, NO seed
- Modify: `admin/control-plane/tenant-admin-server.ts` (`Compose` wires the injected service in-cluster instead of `DockerIdpDriver`), `admin/control-plane/tenant-admin-env.ts` (+ `PRAGMATIC_IDP_*` vars: browser base, internal base, CA path, admin-token ref), `admin/control-plane/k8s-manifest-builder.ts` (`RenderTenantAdmin` injects those env + a CA/admin-token Secret mount), `admin/control-plane/tenant-auth/tenant-oidc-relying-party.ts:331-334` (`issuer = conn.browserBaseUrl`, `discoveryUrl = conn.baseUrl`)
- Test: `admin/control-plane/tests/` — the injected service, the RP config split, the RenderTenantAdmin injection

**Interfaces:**
- Consumes: Task 2 (`IdpConnection.browserBaseUrl`), the operator-provisioned IdP connection (from env/Secret).
- Produces: in-cluster tenant-admin uses the injected connection; the RP configures issuer=browser, discovery=internal.

- [ ] **Step 1: Write failing tests.** (a) the injected `IIdpService.EnsureForTenant` returns a connection from a fake env/Secret source (browser base, internal base, CA, admin token) and does NOT call kubectl/seed; (b) `TenantOidcRelyingParty.configFor` yields `issuer==browserBaseUrl`, `discoveryUrl==baseUrl` (and `==baseUrl` for both when browserBaseUrl defaults to baseUrl — Docker path); (c) `RenderTenantAdmin` with an IdP connection injects the `PRAGMATIC_IDP_*` env + the CA/admin-token Secret mount (admin token by ref, never inline).
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** the injected service, the compose wiring (in-cluster branch), the env/render injection, the RP split. Secret-safety: admin token + CA by ref/mount only.
- [ ] **Step 4: Run tests — expect pass.** control-plane + tenant-admin suites + `tsc` tools+tenant-admin+build.
- [ ] **Step 5: Commit.**

## Task 5: Per-env served-app federation (S4 / DclV4)

**Files:**
- Modify: `admin/control-plane/environment-service.ts` (`Federate` extended to the in-cluster backend: `issuer=conn.browserBaseUrl`, `discoveryUrl=conn.baseUrl`, `redirect_uri=https://<env>.<baseDomain>/auth/oidc/callback…`, register the client, inject providerSettings + secret-by-ref), `admin/control-plane/k8s-manifest-builder.ts` (per-env `Ingress` host=`<env>.<baseDomain>` when federated; env `ServerDeployment` mounts a **ca.crt-only** Secret + sets `NODE_EXTRA_CA_CERTS` — NEVER the IdP server.key, per SERVER-KEY SAFETY), `environments/seed/bundle.ts` (no shape change — split issuer/discovery values flow through). PRODUCER: project/reference a ca.crt-only Secret for the env pod.
- Test: `admin/control-plane/tests/environment-service.test.ts`, `k8s-manifest-builder.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 (`browserBaseUrl`), Task 4's connection pattern, the in-cluster backend (`PublishesHostPort()==false`).
- Produces: in-cluster bound env federates with a browser-reachable, byte-stable redirect_uri; env pod trusts the CA via `NODE_EXTRA_CA_CERTS`.

- [ ] **Step 1: Write failing tests.** (a) `Federate` in-cluster emits providerSettings with `issuer==browser`, `discoveryUrl==internal`, `redirect_uri==https://<env>.<baseDomain>/…`, + the secret by ref; the Docker host-port branch is byte-identical (issuer==discovery==host.docker.internal, localhost redirect). (b) the env `ServerDeployment` carries a CA volume mount + `NODE_EXTRA_CA_CERTS` pointing at it when federated, and the mounted Secret exposes `ca.crt` ONLY — assert no `server.key` key is mounted (SERVER-KEY SAFETY). (c) a per-env `Ingress` host==`<env>.<baseDomain>` is rendered for a federated in-cluster env.
- [ ] **Step 2: Run tests — expect fail.**
- [ ] **Step 3: Implement** the in-cluster `Federate` branch, the env Ingress, the CA mount + `NODE_EXTRA_CA_CERTS`. Keep the Docker path byte-identical.
- [ ] **Step 4: Run tests — expect pass.** Full control-plane suite + `tsc` tools+tenant-admin+build+portal.
- [ ] **Step 5: Commit.**

## Task 6: producer wiring + kind substrate + gated browser-OIDC e2e (S5 / Dcles + DbMhM)

**Files:**
- Modify: `admin/control-plane/tenant-admin-bootstrap.ts` (PRODUCER — populate `spec.idp` for the tenant-admin pod from the operator-provisioned IdP connection: browser base, internal base, the admin-token Secret ref, and a **ca.crt-only** Secret ref), and the IdP provisioning/seed path to PROJECT a ca.crt-only Secret for RP pods (derive it from the minted cert's `ca.crt` alone — do NOT expose `server.key`). This is the missing producer half of Task 4's consumption side.
- Modify: `admin/control-plane/kind.ts` (`CreateCluster` gains a kind config with `extraPortMappings` for :443→host; `IKind` signature extended with an optional config; existing callers pass none = unchanged; the one `implements IKind` test double updates its signature)
- Create: a gated in-cluster federation smoke (e.g. `admin/control-plane/in-cluster-federation-smoke.ts`) — installs ingress-nginx with `--enable-ssl-passthrough`, provisions a tenant IdP (dual-SAN), deploys tenant-admin (port-forward) + a bound env (via its Ingress), drives Playwright through the Ingress(es) for a real OIDC login, asserts a session with `email`/`name`, second env rides SSO; operator-run
- Delete/retire: the Docker-era `admin/control-plane/idp-federation-smoke.ts` (Dcles) if still present
- Test: `admin/control-plane/tests/` for the bootstrap producer (spec.idp populated; ca.crt-only Secret projected — assert NO `server.key`); smoke is type-checked + run by the operator (not in CI); unit-test any pure helpers extracted

**Interfaces:**
- Consumes: Tasks 1–5 (the InjectedIdpService connection contract, the dual-SAN cert, the Ingresses).
- Produces: a fully wired tenant-admin pod (spec.idp populated) consuming a ca.crt-only Secret + admin-token Secret; the e2e proof.

- [ ] **Step 1 (producer):** Write failing tests — `tenant-admin-bootstrap` populates `spec.idp` (browser/internal bases + admin-token ref + ca-only Secret ref); the IdP provisioning projects a `ca.crt`-only Secret for RP pods and the tenant-admin pod mount exposes `ca.crt` only (NO `server.key`, per SERVER-KEY SAFETY). Implement; pass.
- [ ] **Step 2 (kind substrate):** Extend `KindCli.CreateCluster` to accept an optional cluster config (extraPortMappings for :443); update the `implements IKind` test double; unit-test the rendered config includes the :443 mapping; existing no-config callers unchanged. Failing test first, then implement, then pass.
- [ ] **Step 3 (smoke):** Write the gated smoke (ingress-nginx install + `--enable-ssl-passthrough`, provision, deploy tenant-admin + bound env, Playwright login through the Ingress(es), SSO second env, teardown). Mark operator-run; do NOT execute (needs a cluster + browser). Follow the `tenant-login-e2e-smoke` host-resolver/ignoreHTTPSErrors idiom; retire the Docker-era federation smoke.
- [ ] **Step 4:** Full control-plane suite + `tsc` tools+tenant-admin+build+portal clean; grep confirms `todl-identity-cloud` untouched, no `ca.key` reintroduced into any Secret, and no RP-pod mount exposes `server.key`.
- [ ] **Step 5: Commit.**

---

## Self-Review

- **Spec coverage:** S1=Task1, S2=Tasks2+3, S3=Task4, S4=Task5, S5=Task6. Cloud certs/DNS, upstream federation, IdP teardown are explicit non-goals/filed follow-ups.
- **Step scan:** each step one action; test steps carry concrete URL/SAN/env assertions.
- **Type consistency:** `IdpConnection.browserBaseUrl`, `IdpBrowserUrlOf(tenant, baseDomain)`, `HostOf(tenant, baseDomain?)`, `DevCa.EnsureAt(dir, string[])`, `PRAGMATIC_IDP_INTERNAL_URL` — consistent across tasks. `browserBaseUrl`/`baseDomain` default-to-single-host everywhere (Docker byte-identical).
- **Review Focus:** RF1 (T1,T4,T5), RF2 (T1,T2,T3,T5 + P4 smoke), RF3 (T4,T5), RF4 (T2,T4,T5,T6), RF5 (all + whole-branch) pinned.
- **Proportion:** six staged tasks for a four-item program; the plan carries signatures, the split-base rulings, and assertions — no code bodies. `todl-identity-cloud` unchanged is a standing guard, re-checked each task.
