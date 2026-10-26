# SP-HIVE-6c — In-cluster OIDC federation (split-host issuer) (design)

**Status:** AWAITING USER APPROVAL — not approved for build. Decisions D1/D2 resolved with the user
(2026-10-26); the rest are builder rulings below. Scope chosen: **all four block-2 items in one program**.
Opus builder-check done (2026-10-26): model sound (RP split-endpoint support CONFIRMED), one blocking
finding (S3) + pins folded in — see the resolutions footer.

**Project items unblocked:** `DclV4` (per-env OIDC federation, in-cluster), `DdLtc` (fully in-cluster
tenant-admin OIDC), `Dcles` (in-cluster federation smoke), `DbMhM` (full browser-OIDC e2e). All ride one
issuer substrate.

**Consumes (already shipped):** the Docker-Desktop federation (SP-HIVE-6c-proper, `host.docker.internal`
single-issuer) and the in-cluster IdP *apply* (P4: `InClusterIdpDriver` + `RenderIdp` serve OIDC on a
ClusterIP Service, proven by `in-cluster-idp-smoke`). This design makes that in-cluster IdP **federate** —
a real browser login against a tenant realm, through a real cluster, for both the tenant-admin app and a
served environment.

## 1. The problem this solves (the issuer knot)

OIDC needs three parties to agree on URLs that, in a real cluster, live on different networks:
- the **browser** (outside the cluster) must reach `authorization_endpoint`;
- the **relying-party pod** (tenant-admin / served env, inside the cluster) must reach
  `token_endpoint` + `jwks_uri` + discovery;
- the **`iss`** claim in issued tokens must byte-match the RP's configured issuer.

Docker Desktop cheated this with `host.docker.internal` (one name resolvable from host and container). A
real cluster (kind, cloud) has **no single name** that resolves identically outside and inside AND matches
`iss`. Today the in-cluster IdP is a **ClusterIP Service only** (no Ingress/NodePort), its cert SAN is just
the Service-DNS host, the tenant-admin pod wires a **`DockerIdpDriver`** (shells `docker run` — cannot work
in a pod) and is injected **no** issuer/CA, and the in-cluster env path injects **no** OIDC/CA either.

## 2. The chosen model — IdP advertises split hosts (D1)

Recon pinned the lever: the relying party (`todl-identity-cloud` `OidcDiscovery`/`OidcAuthenticator`) reads
`authorization_endpoint`/`token_endpoint`/`jwks_uri` **from the discovery document independently**, fetches
discovery from the configured `discoveryUrl` (any host), and validates `iss` only against the **configured
issuer string** (jose `jwtVerify`, byte-exact) — it never forces endpoints onto the issuer origin, and the
tenant-admin RP already carries a real `ca:` plumb (`CaTrustingHttpClient`).

So the IdP emits **two bases** in its discovery doc and token `iss`:
- **Browser base** `https://idp-<tenant>.<baseDomain>` → used for `issuer` and `authorization_endpoint`, and
  signed into the token `iss`. Reachable by the browser via an Ingress; the RP's configured issuer = this.
- **Internal base** `https://pragmatic-idp-<tenant>.pragmatic-idp-<tenant>.svc.cluster.local:9443` → used for
  `token_endpoint` and `jwks_uri` (and is where the pod fetches discovery). Reachable only inside the cluster.

Flow: pod RP fetches discovery over the **internal** base (already reachable, DevCa-trusted via `ca:` /
`NODE_EXTRA_CA_CERTS`) → gets a doc whose authorize = **browser** base, token/jwks = **internal** base, issuer
= **browser** base. Browser → authorize at the browser base (through the Ingress). Pod → token/jwks at the
internal base. `iss` (browser base) == RP configured issuer (browser base). **No cluster-DNS rewrite, no
hairpin egress, no pod reach to the external host.** The cost is a focused IdP change: one base → two.

## 3. Deliverables (all four, one substrate)

**S1 — IdP split-host issuer (the core).** The IdP host's `baseUrl` STAYS the **browser** base — the token
`iss` is signed in `TokenEndpoint` from `baseUrl` (`idp-host.ts:181`, `token-endpoint.ts:87`), so keeping
`baseUrl` = browser base makes `iss` = browser base with **no** `TokenEndpoint` change, and the discovery
`issuer` + `authorization_endpoint` (`idp-host.ts:430-436`) also derive correctly from it. The ONLY addition
is a new **internal-base** ctor param, used **solely** in `Discovery()` to emit `token_endpoint` + `jwks_uri`
at the internal Service-DNS base. `idp-main` flips the deployment's `PRAGMATIC_IDP_BASE_URL` to the browser
base and adds `PRAGMATIC_IDP_INTERNAL_URL` (https-guarded like the existing vars), defaulting the internal
base to the browser base when **unset** — so every single-host caller (Docker, idp-sso, tenant-login-e2e,
the current `in-cluster-idp-smoke`) is byte-identical (single-host discovery, one `baseUrl`). `todl-identity-cloud`
(the RP) is untouched — recon confirmed it reads endpoints from the discovery doc and validates `iss` against
the configured issuer independently.

**S2 — Browser-reachable exposure + dual-SAN cert.** `RenderIdp` gains a per-tenant **Ingress** (host =
`idp-<tenant>.<baseDomain>`, backend = the IdP Service:9443, **ingress-nginx SSL passthrough** so TLS
terminates at the IdP and the browser validates the IdP's own DevCa cert — see rulings). `InClusterIdpSeedSource`/
`DevCa` mint the IdP server cert with **both** SANs (browser host + internal Service-DNS host) so SNI validates
from the browser and the pod. `IdpBaseUrlOf` stays the internal base; a new `IdpBrowserUrlOf(tenant, baseDomain)`
gives the browser base. **`baseDomain` is optional** everywhere it threads (`IdpWorkloadSpec`/`RenderIdp`,
`InClusterIdpSeedSource.HostOf`, `InClusterIdpDriver`): absent ⇒ single-SAN (internal only) + browser base =
internal base (today's behavior, so the P4 smoke's no-arg construction is unchanged); present ⇒ dual-SAN +
distinct browser base.

**S3 — Tenant-admin pod OIDC (DdLtc).** The tenant-admin pod **connects** to an already-provisioned IdP — it
does NOT apply or re-seed one. (Builder-check A1: `InClusterIdpDriver` does `kubectl.Apply` and
`InClusterIdpSeedSource` mints a fresh CA per process; the pod has `automountServiceAccountToken: false` + no
RBAC and would mint a CA that mismatches the served cert.) So: the **operator/control-plane** provisions the
tenant IdP (as `in-cluster-idp-smoke` already drives `InClusterIdpDriver`), and a new **connection-only**
`IIdpService` implementation reads the connection from injected env + a mounted Secret — **browser base,
internal base, CA, AND the IdP admin token** (the RP needs `conn.adminToken` to `RegisterClient`,
`tenant-oidc-relying-party.ts:216`) — with no apply/seed. `TenantAdminServer.Compose` wires that connection
service in-cluster instead of `DockerIdpDriver`; `RenderTenantAdmin` injects the issuer/internal-base/CA/admin-token
(the token + CA by Secret ref/mount) via new tenant-admin env/volumes. The pod is reached by the operator via
`kubectl port-forward` (as `tenant-admin-smoke` does today) and its OIDC callback is request-derived, so it
stays self-consistent; only the IdP authorize redirect must be browser-reachable (the IdP Ingress, S2).

**S4 — Per-env served-app federation (DclV4).** `EnvironmentService.Federate` runs today **only** for the
Docker/host-port backend (`environment-service.ts:231-234`); extend it to the in-cluster case. Because the
served app is **ClusterIP-only with no host port** and its `redirect_uri` must be both browser-reachable AND
byte-stable at client-registration time, the in-cluster served env gains its **own per-env Ingress** (host =
`<env>.<baseDomain>`), and the registered `redirect_uri` = `https://<env>.<baseDomain>/auth/oidc/callback…`
(browser-reachable via that Ingress, stable at provision). The env path injects: split issuer (browser) /
discoveryUrl (internal) providerSettings + the client secret by ref into the bundle (bundle shape already
supports issuer≠discovery — `EnvOidc`/`bundle.ts:24,191-192`), and — because the served app uses the default
fetch client with **no `ca:` plumb** — a mounted `ca.crt` + `NODE_EXTRA_CA_CERTS` on the env `ServerDeployment`
(`k8s-manifest-builder.ts`; the in-cluster analog of `docker.ts`'s CA mount, which recon confirms the
in-cluster env path lacks today). The Docker `host.docker.internal` single-base path stays byte-identical.

**S5 — Gated browser-OIDC e2e on kind (Dcles + DbMhM).** A real kind smoke: create the cluster with
`extraPortMappings` for :443 and install **ingress-nginx with `--enable-ssl-passthrough`** (passthrough is
OFF by default; `KindCli.CreateCluster` currently runs bare `kind create cluster` — it gains a config);
provision a tenant IdP in-cluster (dual-SAN); deploy the tenant-admin (reached via port-forward) + a bound env
(reached via its Ingress host); drive a real Playwright browser through the Ingress(es) to log in against the
tenant realm (host-resolver `MAP idp-<tenant>.<baseDomain> 127.0.0.1` + `MAP <env>.<baseDomain> 127.0.0.1`,
`ignoreHTTPSErrors` — the pattern `tenant-login-e2e-smoke` already uses), assert a session with `email`/`name`,
and a second env rides SSO (the IdP SSO cookie is host-only on the browser base, shared across both env logins).
Operator-run. Retire the Docker-era `idp-federation-smoke` (Dcles).

## 4. Decisions (D1/D2 user; rest builder rulings)

- **D1 = IdP advertises split hosts (user).** §2. The IdP owns the browser/internal split; the RP is unchanged
  (it already reads endpoints from discovery and validates `iss` against config).
- **D2 = all four in one program (user).** One branch, one substrate, staged tasks (S1→S5) with a review gate
  per task and a whole-branch opus review; the e2e smoke is the headline proof.
- **Ruling — DevCa, not real certs, for this build.** The pod trusts it via the existing `ca:` plumb
  (tenant-admin) / `NODE_EXTRA_CA_CERTS` (served env); the browser via `ignoreHTTPSErrors` + host-resolver in
  the smoke (as the existing e2e does). cert-manager/real-CA + real external DNS is the **cloud follow-on**,
  filed. The CA private key stays unshipped (DdLv8 holds).
- **Ruling — dual-SAN cert.** `DevCa.EnsureAt` takes a SAN **list** (browser host + internal Service-DNS host)
  rather than one host; the single-host callers pass a one-element list (byte-identical mint). This is the
  one DevCa change; it composes with DdLv8's no-persist guard.
- **Ruling — internal base defaults to browser base.** When `PRAGMATIC_IDP_INTERNAL_URL` is unset the IdP is
  single-host exactly as today, so every Docker/dev caller and the current in-cluster-idp-smoke are unchanged;
  the split is opt-in via the new env var set only by the in-cluster render path.
- **Ruling — Ingress backend scheme.** The IdP serves HTTPS with a DevCa cert the ingress controller won't
  trust by default; use **ingress-nginx SSL passthrough** (annotation) so TLS terminates at the IdP (the
  browser validates the IdP cert directly, SAN covers the browser host) — avoids re-terminating and a second
  cert. Plan pins the exact annotation; the kind smoke installs ingress-nginx with passthrough enabled.
- **Ruling — baseDomain source.** Reuse the tenant-admin's existing `BaseDomain` env/concept so the IdP
  browser host and the tenant-admin host share one ingress domain; the smoke uses a `*.localtest`-style domain
  mapped to 127.0.0.1 (matching the existing e2e).
- **Ruling — idempotent federation, no rollback churn.** Client registration + bundle injection follow the
  shipped Docker federation's idempotent-retry policy (6c D6); re-apply never rotates secrets.
- **Ruling — tenant-admin connects, operator provisions (A1).** A new connection-only `IIdpService` reads the
  IdP connection (browser base, internal base, CA, admin token) from injected env + a mounted Secret; it
  NEVER applies or seeds (the pod has no cluster API and must not mint a divergent CA). The operator/control-plane
  provisions the IdP; `RenderTenantAdmin` injects the connection material.
- **Ruling — served-env per-env Ingress + stable redirect_uri (B4).** The in-cluster served app gets its own
  Ingress (`<env>.<baseDomain>`) and registers `redirect_uri = https://<env>.<baseDomain>/auth/oidc/callback…`
  at provision (browser-reachable + byte-stable). Tenant-admin itself stays on port-forward with a
  request-derived callback.
- **Ruling — `IdpConnection` gains `browserBaseUrl` (B3).** Both RPs (`tenant-oidc-relying-party.ts:331-334`,
  `environment-service.ts:187-190`) switch to issuer = `conn.browserBaseUrl`, discoveryUrl = `conn.baseUrl`
  (internal); `browserBaseUrl` defaults to `baseUrl` when unset (Docker byte-identical).
- **Ruling — ingress-nginx SSL passthrough, both knobs (B6).** Pin BOTH the controller `--enable-ssl-passthrough`
  flag AND the per-Ingress `nginx.ingress.kubernetes.io/ssl-passthrough: "true"` annotation + the kind
  `extraPortMappings`. Passthrough routes by TLS SNI, so the browser-host SAN must match (it does).

## 5. Security

- Admin token, client secret, owner password: generated, used in memory, written only where required, **never
  logged / in an error / in a persisted record** (refs only) — unchanged bar from 6c/P4. The split adds no new
  secret.
- The CA private key stays unshipped (DdLv8); the dual-SAN change touches only the public server cert's SANs.
- Per-tenant realm + admin token isolate tenants; the Ingress exposes only the IdP's public OIDC surface
  (authorize/discovery/jwks/token), same as any public OP.
- `iss` is validated byte-exact against the configured browser base; a mismatched token is rejected.

## 6. Non-goals / anti-goals

- No real external DNS or CA-signed certs (cloud follow-on, filed); the dev proof is kind + DevCa + a
  host-resolver-mapped `*.localtest` browser host.
- No change to the Docker-Desktop federation path (single-host `host.docker.internal`) — it stays
  byte-identical (internal base defaults to browser base).
- No upstream Entra/Google federation (the tenant IdP federating UP); no IdP HA / persistent stores.
- No cluster-wide CoreDNS rewrite and no hairpin-egress dependency (the split-host model avoids both).

## 7. Component shape (for the plan — staged)

- **S1 IdP split issuer:** `src/idp/idp-host.ts` (new internal-base ctor param used ONLY in `Discovery()` for
  `token_endpoint`+`jwks_uri`; `baseUrl` stays browser base so `iss`/`TokenEndpoint` unchanged), `src/idp/idp-main.ts`
  (`PRAGMATIC_IDP_INTERNAL_URL`, https-guarded, default = browser base). No RP change (`todl-identity-cloud` untouched).
- **S2 exposure + cert:** `src/idp/dev-ca.ts` (`EnsureAt` takes a SAN **list** — composes with DdLv8's no-persist
  guard), `admin/control-plane/in-cluster-idp-seed.ts` (`HostOf` → [internal, browser?] optional; mint dual-SAN),
  `admin/control-plane/k8s-manifest-builder.ts` (`RenderIdp` +per-tenant Ingress w/ passthrough; `IdpBrowserUrlOf`;
  `IdpBaseUrlOf` stays internal), `admin/control-plane/idp-workload-driver.ts` (`IdpConnection` += `browserBaseUrl`;
  `IdpWorkloadSpec` += optional `baseDomain`), `admin/control-plane/in-cluster-idp-driver.ts` (thread baseDomain;
  return both bases + CA + admin token).
- **S3 tenant-admin OIDC:** a new connection-only `IIdpService` impl (reads env + mounted Secret: browser base,
  internal base, CA, admin token; no apply/seed), `admin/control-plane/tenant-admin-server.ts` (wire it in-cluster
  instead of `DockerIdpDriver`), `admin/control-plane/k8s-manifest-builder.ts` (`RenderTenantAdmin` injects
  issuer/internal-base/CA/admin-token via env+Secret), `admin/control-plane/tenant-admin-env.ts` (+IdP vars),
  `tenant-auth/tenant-oidc-relying-party.ts:331-334` (issuer=browserBaseUrl, discovery=baseUrl).
- **S4 per-env federation:** `admin/control-plane/environment-service.ts:187-190,231-234` (`Federate` in-cluster
  split-base; register `redirect_uri=https://<env>.<baseDomain>/…`), `admin/control-plane/k8s-manifest-builder.ts`
  (per-env Ingress `<env>.<baseDomain>`; env `ServerDeployment` CA mount + `NODE_EXTRA_CA_CERTS`),
  `environments/seed/bundle.ts` (unchanged shape; split issuer/discovery values).
- **S5 smoke + substrate:** `admin/control-plane/kind.ts` (`CreateCluster` gains a config w/ `extraPortMappings`
  for :443), a new in-cluster federation smoke (ingress-nginx install w/ `--enable-ssl-passthrough` + Playwright
  through the Ingress(es)), retire the Docker-era `idp-federation-smoke` (Dcles).

## 8. Verification

- **Unit (no cluster):** IdP discovery doc emits split hosts when the internal base is set and single-host when
  not (iss always = browser base); `DevCa` mints both SANs; `RenderIdp` renders the Ingress (host, passthrough
  annotation, Service backend); `RenderTenantAdmin` injects issuer/discovery/CA; the env `ServerDeployment`
  carries the CA mount + `NODE_EXTRA_CA_CERTS`; `EnvironmentService.Federate` in-cluster emits browser-issuer /
  internal-discovery providerSettings + secret-by-ref; the tenant-admin RP configures issuer=browser,
  discovery=internal; the Docker single-host path is byte-identical. Secret non-leakage re-verified.
- **Gated e2e (kind, operator-run):** ingress-nginx up; provision a tenant → in-cluster IdP (dual-SAN);
  deploy tenant-admin + a bound env; a real browser logs in through the Ingress against the tenant realm →
  session with `email`/`name`; a second env rides SSO; teardown. This is DbMhM + Dcles.
- IdP + control-plane unit suites green; tsc tools+tenant-admin+build clean; `todl-identity-cloud` untouched
  (no RP change) — confirm by diff.

## 9. Review focus (pin each)

1. **`iss` consistency** — the token `iss` and the discovery `issuer` are the BROWSER base and equal the RP's
   configured issuer byte-for-byte; token/jwks are the INTERNAL base; a cross-wired base fails login. (Unit +
   e2e.)
2. **Docker path byte-identical** — unset internal base ⇒ single-host IdP exactly as today; no Docker/dev
   regression. (Unit: discovery doc + `Federate` Docker path unchanged.)
3. **Pod never needs external reach** — the RP fetches discovery + token + jwks over the internal base only;
   only the browser hits the external host. (Unit: RP config; e2e: no pod egress to the external host.)
4. **TLS trust both ways** — the server cert SAN covers both hosts; the pod trusts the DevCa (ca: /
   NODE_EXTRA_CA_CERTS); the browser via the smoke's ignore/host-resolver. A missing SAN or untrusted CA fails.
5. **Secret non-leakage** — admin token / client secret / owner password / CA key never logged, in an error,
   in a DTO, or persisted (refs only); the CA key stays unshipped (DdLv8). (Unit + review.)

## 10. Deferred (file as Features)

- Cloud federation: real external DNS + cert-manager/CA-signed certs + a real ingress domain (replaces the
  `*.localtest` + DevCa dev proof).
- Upstream IdP federation (tenant realm federating to Entra/Google); IdP HA / persistent stores.
- IdP `Teardown` on tenant-delete + client-deregister on env-delete (orphan reclaim — carried from 6c).

---

## Builder-check resolutions (opus, 2026-10-26)

- **Lynchpin CONFIRMED:** the RP (`todl-identity-cloud`) reads authorize/token/jwks from the discovery doc and
  validates `iss` against the configured issuer independently (`oidc-discovery.ts:38-48`, `oidc-authenticator.ts:74,113,121,129`,
  `oidc-resolved-config.ts:4-5`). The split-host model works with NO RP change.
- **A1 (blocking) FIXED:** S3 rewritten — tenant-admin pod CONNECTS via an operator-injected connection-only
  `IIdpService` (browser base, internal base, CA, **admin token**); no in-pod apply/seed. (Was: "use
  InClusterIdpDriver", which needs cluster API the pod lacks + would mint a divergent CA.)
- **B1 FIXED:** `baseDomain` optional throughout; absent ⇒ single-host (today's behavior, P4 smoke unchanged).
- **B2 FIXED:** host `baseUrl` stays browser base (iss signed in `TokenEndpoint`); internal base is a new param
  used only in `Discovery()` for token/jwks; `idp-main` https-guards + passes `PRAGMATIC_IDP_INTERNAL_URL`.
- **B3 FIXED:** `IdpConnection += browserBaseUrl`; both RP config sites split issuer(browser)/discovery(internal);
  default browserBaseUrl=baseUrl.
- **B4 FIXED:** served-env gains a per-env Ingress + a byte-stable browser-reachable `redirect_uri`.
- **B5 confirmed:** served-env CA mount + `NODE_EXTRA_CA_CERTS` on the env `ServerDeployment` required + additive;
  bundle shape already supports issuer≠discovery.
- **B6 FIXED:** ingress-nginx `--enable-ssl-passthrough` (controller flag) + per-Ingress annotation + kind
  `extraPortMappings` all pinned.
- **C1–C4 (minor):** https-guard the new internal var (C1); SSO cookie host-only on the browser base (C2);
  DevCa SAN-list change localized to three spots + composes with DdLv8 (C3); task order kind→ingress→provision→
  deploy→Playwright (C4) — all carried into the plan.
