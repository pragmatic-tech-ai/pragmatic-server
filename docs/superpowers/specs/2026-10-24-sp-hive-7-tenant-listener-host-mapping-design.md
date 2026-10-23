# SP-HIVE-7 #5 + #9 — Dedicated tenant listener + host→tenant login mapping

**Status:** design, pending approval. Implements deferral issues #5 (dedicated tenant listener) and #9 (host→tenant login mapping), which are coupled.

## Problem

Today one listener on `127.0.0.1:PRAGMATIC_ADMIN_PORT` serves **both** planes; the operator/tenant boundary is the `Host` header + cookie + per-route checks (`HostAccepted = operatorHosts ∪ tenantHosts`). Two consequences:

1. **#5 — shared listener + asymmetry.** HTTP `/tenant-api/*` accepts an operator-or-tenant host, while the ws upgrades demand a tenant host. The boundary is behavioural, not structural: a routing mistake can cross planes.
2. **#9 — flat host list forces `?tenant=`.** `PRAGMATIC_TENANT_ADMIN_HOSTS` is a flat list with no tenant binding, so the portal must carry the tenant id in a `?tenant=` query param (persisted to sessionStorage, prompt fallback) to tell the server which tenant's IdP to begin login against.

## Decisions (confirmed with the user)

- **#5: two listeners, one process.** The operator listener stays loopback and serves only operator routes; a second, dedicated listener serves only the tenant routes. Each listener mounts only its own plane, so the operator surface is structurally unreachable on the tenant listener and the HTTP-vs-ws asymmetry disappears.
- **#9: subdomain convention.** The tenant id is derived from the first DNS label of the request host under a configured base domain (`acme.admin.example.com` → `acme`), validated against the platform directory.
- **Retire `?tenant=`.** The server resolves the tenant from the `Host`; the portal drops the `?tenant=` param, its sessionStorage, and the prompt entirely.

## Design

### 1. Configuration (replaces the flat host list + single callback)

- `PRAGMATIC_TENANT_ADMIN_PORT` — the dedicated tenant listener's port. Its presence (with the others below) activates the tenant plane; absent → no tenant listener (fail-closed, operator-only, exactly as today).
- `PRAGMATIC_TENANT_ADMIN_BASE_DOMAIN` — e.g. `admin.example.com`. A request host is a tenant host iff it is `<label>.<baseDomain>`; the tenant id is `<label>`.
- `PRAGMATIC_TENANT_ADMIN_BIND` — the tenant listener's bind address, default `127.0.0.1` (proxy-fronted, same safe default as the operator plane; an operator may widen it).
- `PRAGMATIC_TENANT_ADMIN_EXTERNAL_SCHEME` — `https` (default) or `http`; the scheme of the externally-visible tenant origin, used to build the OIDC callback URL.
- **Removed:** `PRAGMATIC_TENANT_ADMIN_HOSTS` and `PRAGMATIC_TENANT_ADMIN_CALLBACK_URL` (superseded by base-domain + derived callback).

### 2. `TenantHostResolver` (new)

`admin/control-plane/tenant-auth/tenant-host-resolver.ts`:

```ts
export class TenantHostResolver
{
    public constructor(baseDomain: string, externalScheme: string, directory: PlatformDirectory)
    // Returns the tenant id for a request host under the base domain, or undefined when the host is not
    // `<label>.<baseDomain>` or the label is not a known tenant in the directory.
    public TenantFor(hostHeader: string | undefined): string | undefined
    // The OIDC callback URL for a validated tenant host: `${externalScheme}://${host}${CallbackPath}`.
    public CallbackFor(hostHeader: string): string
    public Accepts(hostHeader: string | undefined): boolean   // TenantFor(...) !== undefined
}
```

Label extraction: strip the exact `.<baseDomain>` suffix (case-insensitive, port stripped via the existing host pattern); the remaining single label is the candidate tenant id; reject if it contains a dot (no nested subdomains) or is not `directory.GetTenant(label)`. This both maps and fail-closes: an unknown or malformed host resolves to `undefined` and is refused.

**Label↔tenant-id normalization (resolves the builder-check blocker).** Host labels are case-insensitive and DNS-constrained, while tenant ids are stored case-sensitively (`JsonRecordStore` is an exact Map lookup) and `RecordId.Validate` permits non-DNS characters (e.g. `_`, uppercase). The resolver therefore:
- lowercases the extracted label (hosts fold to lowercase already) and does an exact `directory.GetTenant(label)`;
- so **subdomain admin login requires the tenant id to be a lowercase DNS-label-safe string** (`[a-z0-9-]`, no dot/underscore/uppercase) — which matches the existing lowercase-kebab id convention (`t1`, `t-a`, `acme`).
- A tenant whose id is not DNS-label-safe (uppercase or `_`) cannot reach admin login via a host, and there is no `?tenant=` fallback anymore. This is a **documented constraint**, not a silent failure: such a host simply 403s, and the README states the id requirement. (The alternative — a case-insensitive scan of all tenants — is rejected: it is O(n) and ambiguous when two ids differ only by case.)

### 3. `TenantPlaneHost` (new) — the dedicated tenant listener

`admin/control-plane/tenant-plane-host.ts`. Owns its own `http.Server` + `WebSocketServer(noServer)` and serves ONLY the tenant surface:

- Request handling: validate the host via `TenantHostResolver.Accepts` (else 403); resolve `tenantId` + `callbackUrl` from the host; route `/tenant-auth/*` (public, CSRF-origin-checked against the same host) and `/tenant-api/*` (gated by `TenantAuthGate.Principal`); otherwise serve the tenant static bundle (`admin/tenant-portal/dist`) with the existing traversal guard; 404 otherwise. No `/api/*`, no operator static, ever.
- ws upgrade: `/tenant-api/events` and `/tenant-api/:name/logs/stream` only, each host-validated and cookie-gated as today; any other path destroys the socket.
- Owns the `EnvironmentService.OnChanged → TenantEventBus` subscription (moved here from `ControlPlaneHost`), scoped by `rec.tenantId`.
- `Listen(port, bind)` / `Close()` mirroring `ControlPlaneHost`.

The tenant id + callback are now **per request** (derived from the host), so they are threaded into `TenantAuthEndpoint.Handle` and `rp.Begin/Complete` rather than read from a query param.

**Shared HTTP primitives (lift, don't copy).** The tenant and operator hosts both need a handful of primitives that are currently `private`/`private static` on `ControlPlaneHost`: the host-header pattern + `HostIn`, `OriginInHosts`/`OriginHost`, `IsMutating`, `ServeStatic` with its traversal guard + `MimeTypes` + percent-decode, and `WriteJson`/`WriteNotFound`. Extract these into a shared stateless helper class (e.g. `admin/control-plane/plane-http.ts`, `class PlaneHttp` with static methods) used by both hosts, rather than duplicating them. Each host keeps its own `http.Server`/`WebSocketServer` lifecycle (`Listen`/`Close`/`Address` + `handleUpgrade` wiring) since those differ. Note: the operator body machinery (`ReadBody`/`ReadJsonObject`) stays operator-only — the tenant data API and auth endpoint read their own bodies, so it is not part of the shared surface.

### 4. `ControlPlaneHost` sheds the tenant plane

Revert the operator host to its pre-7a shape: remove `tenantAuth`, `tenantStaticRootAbs`, `tenantChangeSubscription`, `RouteTenant`, `StaticRootFor`, the tenant ws branches in `RouteUpgrade`, and collapse `HostAccepted` back to `HostAllowed` (loopback only). Keep `TenantEventFor` only if still used (it moves with the subscription). Net: with the tenant plane configured or not, the operator listener behaves exactly as pre-7a — a structural guarantee, not a host check.

### 5. Relying-party: callback URL per call (touches #6 code)

`TenantOidcRelyingParty`'s single ctor `callbackUrl` becomes a per-call argument, because the callback host now varies per tenant:

- `Begin(tenantId: string, callbackUrl: string)` and `Complete(tenantId, code, state, callbackUrl)`.
- `configFor` (called in BOTH `Begin` and `Complete` — the authenticator consumes `RedirectUri` at the token exchange, so `Complete` genuinely needs the callback) and the durable `RegisterClient` `redirectUris` (Begin-only) use the passed `callbackUrl`.
- The durable secret path (#6) is otherwise unchanged; the registration simply carries the current host's callback as its redirect URI.
- `ITenantOidcRelyingParty` updates to match. **The ctor's `callbackUrl` (currently the 4th positional param, before `resolverOverride`/`flowStates`/`durability`) is removed**, which shifts every positional ctor call; ~15 prod + test call sites pass the callback at `Begin`/`Complete` instead. The three stub relying-parties (in `control-plane-host-tenant.test.ts`, `tenant-streaming.test.ts`, `tenant-auth-endpoint.test.ts`) implement the new interface signatures.

### 6. `TenantAuthEndpoint`: tenant + callback from the host

`Handle(req, res, path, tenantId, callbackUrl)` — the `TenantPlaneHost` resolves `tenantId`/`callbackUrl` from the validated host and passes them in. `begin`/`callback` drop the `?tenant=` query read entirely and use the passed `tenantId`; `begin` passes `callbackUrl` to `rp.Begin`; `callback` passes it to `rp.Complete`. The OIDC provider redirects to `${callbackUrl}` (no `?tenant=`), which lands back on the same tenant host, so `callback` re-derives the same tenant from its own `Host`.

### 7. Portal: retire `?tenant=`

In `admin/tenant-portal/`: remove the `?tenant=` query read, the sessionStorage persistence, and the prompt view. The tenant is implied by the host — login simply navigates to `/tenant-auth/oidc/begin` and the server knows the tenant. `BeginLogin` and `TenantApp`'s tenant-acquisition path simplify accordingly; `ITenantEnvironment.QueryTenant`/`StoredTenant`/`StoreTenant` and the prompt are removed (or reduced to what remains). Post-login the tenant still rides in the `pts_session` cookie as today.

### 8. `server.ts`: start both listeners

`Main()` builds the operator `ControlPlaneHost` (no `tenantAuth`) and, when the tenant env is set, a `TenantPlaneHost` (resolver from base-domain + scheme + directory; the gate, api, events, durable relying-party, sessions, tenant static root). Start the operator listener on `127.0.0.1:PRAGMATIC_ADMIN_PORT` and the tenant listener on `PRAGMATIC_TENANT_ADMIN_BIND:PRAGMATIC_TENANT_ADMIN_PORT`. `Close()` stops both. The #6 durable wiring (master key, admin-client registry, TTL) moves onto the `TenantPlaneHost` composition. Update `admin/README.md` (which currently documents `PRAGMATIC_TENANT_ADMIN_HOSTS`/`_CALLBACK_URL`) to the new `PRAGMATIC_TENANT_ADMIN_PORT`/`_BIND`/`_BASE_DOMAIN`/`_EXTERNAL_SCHEME` set, including the lowercase-DNS-safe tenant-id requirement for subdomain login.

## Security invariants

- **Plane isolation is structural:** the operator listener has no tenant routes and the tenant listener has no `/api/*` or operator static. Neither can serve the other's surface regardless of `Host`.
- Operator stays loopback by default; the tenant listener's bind is configurable but defaults to loopback (proxy-fronted).
- Host validation fail-closes: a host that is not `<knownTenant>.<baseDomain>` is refused (403) before any routing, on both HTTP and ws.
- All #6 secret invariants hold; the per-call callback carries no secret.
- The CSRF origin check on mutating `/tenant-auth|/tenant-api` requests validates the Origin host against the request's own tenant host.

## Non-goals

Wildcard/multi-label tenant subdomains; an operator-managed host registry; per-tenant TLS termination (the proxy owns TLS); making the operator plane non-loopback; a persistent IdP client store (tracked separately).

## Review Focus

- **Cross-plane isolation:** a request for `/api/*` on the tenant listener → **404** (no such route exists on that listener — note this differs from today's 403 "Host not allowed", because isolation is now structural, not a host check); a request for `/tenant-api/*` on the operator listener → not routed (served as operator static/404). Prove both.
- **Host resolution:** `acme.admin.example.com` → `acme` when `acme` is a known tenant; an unknown label, a bare `admin.example.com`, a nested `a.b.admin.example.com`, and a foreign domain each → refused.
- **Callback correctness:** `begin` on `acme.admin.example.com` registers and authorizes with `redirect_uri = https://acme.admin.example.com/tenant-auth/oidc/callback`; the callback on that host completes.
- **Fail-closed:** tenant env unset → no tenant listener, operator unchanged.
- **Portal:** with no `?tenant=` and no stored tenant, the portal still reaches login (no prompt), because the server derives the tenant from the host.
- **ws host-gating:** a tenant ws upgrade on a non-tenant host is refused on the dedicated listener.

## Open interactions to confirm in the plan

- The per-call callback changes `ITenantOidcRelyingParty` and the #6 tests (fixed callback at call sites). The plan must update those call sites, not the ctor.
- Moving `OnChanged → events` to `TenantPlaneHost` means `ControlPlaneHost` no longer needs `IEnvironmentService.OnChanged`; confirm no other consumer.
