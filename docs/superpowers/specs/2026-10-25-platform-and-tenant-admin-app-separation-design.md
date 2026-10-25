# Platform Admin and Tenant Admin — Two Separate Applications

**Status:** design, awaiting approval
**Date:** 2026-10-25
**Supersedes the deployment assumption in:** `2026-10-23-sp-hive-7-tenant-admin-app-design.md` (the tenant admin as a second plane inside `ControlPlaneServer`)

## Intent and why

Today the platform admin (operator) and the tenant admin are two front-end SPAs (`admin/portal`, `admin/tenant-portal`) served by a **single backend process**, `ControlPlaneServer`. That process boots the platform API (`ControlPlaneHost`) and the tenant API (`TenantPlaneHost` + `TenantApiEndpoint`) side by side and hands **both of them the same in-process objects** — the `EnvironmentService`, the `PlatformDirectory`, the deployment registry, the orchestrators, the health monitor. The tenant admin is therefore not a guest in the client's tenant; it is a second door on Pragmatic's own box reaching directly into Pragmatic-internal state. The `HiveDto` ref-stripping (`agentTokenRef`, `trustRootRef`, `configRef`, `credentialRef` never reach the tenant surface) is written as if a trust boundary exists, but at runtime it is DTO politeness, not a wall.

We want two genuinely separate applications with a real deployment and trust boundary between them:

- **Platform admin** never leaves Pragmatic's internal deployment.
- **Tenant admin** is a dedicated container that gets stood up **inside the client's hive**, one per hive, running independently inside the client's infrastructure.

The point is not code tidiness. The tenant admin executes on infrastructure Pragmatic does not own and must not be trusted with Pragmatic-internal state; conversely the platform admin holds the registry keys, cross-tenant view, and provisioning authority that must never ship to a client.

## The two applications

### Platform admin (internal, never ships)

Owns, and is the sole authority for:

- The client → tenant → hive lifecycle and all provisioning, including generating the **one-time bootstrap** a client applies to stand a hive up (see Provisioning).
- The **container registry**. Pragmatic builds, signs, and publishes image versions (`POST /api/manifests` → `PlatformDeploymentRegistry.Publish`) and withdraws/restores them. Image **signing** (the trust-root private key) happens only here.
- Gating and selection policy (`GatingRegistry`, `SelectionRegistry`, `PlatformDeploymentRegistry`): which versions a hive is allowed to adopt, and the authoritative record of what it adopted.
- The **agent-channel server**: the public endpoint that in-hive agents dial into (authenticated by agent token; the hash side already exists as `RolloutRegistrationRecord.agentTokenHash`). This is a **separate, public-facing listener**, never the loopback operator API.
- A **cross-hive observability view**: through the inbound agent channels it can see every hive's environment inventory and health. Read-only oversight.
- Keeping **its own in-hive software current**: the platform may publish new versions of the agent / tenant-admin container and drive those upgrades into hives automatically (see The boundary).

It has no control over anything a tenant owns — creating environments, managing that tenant's users — and cannot reach into those; it only observes them.

### Tenant admin (ships, runs inside the client's hive)

A dedicated container, **one per hive**, running inside the client's hive. **A tenant maps to exactly one hive** (multi-hive-per-tenant is explicitly out of scope for now), which is what lets one in-hive container own both the hive's environments and the tenant's identity without cross-hive coordination. It is the tenant's own control surface and is **blind to every other tenant and hive**. It:

- Creates and manages **environments within its own hive**, by driving the **in-cluster orchestrator locally** against the in-cluster Kubernetes API (it runs inside the hive, under an in-cluster service account; it does not ask Pragmatic to spin workloads up). This is the existing `EnvironmentService` + `HiveOrchestratorFactory` path, co-located with the cluster it targets.
- Manages that one tenant's **users and permissions**. The tenant's **IdP runs inside the hive** (the per-tenant IdP container moves in alongside the tenant admin), reachable over the `admin-proxy` protocol already in place (`CreateAccount`, `DisableAccount`, `GrantRole`, `RevokeRole`, `GetSecurityModel`/`SetSecurityModel`, `IssueToken`). No user-management traffic crosses back to Pragmatic.
- **Adopts newer published versions** of its environments' application images. The platform publishes versions into its registry; the list of versions the hive may adopt reaches the agent over the home channel; the tenant chooses one, the adoption is recorded platform-side (an up-call that runs the gating check against `GatingRegistry`/`SelectionRegistry`), and the actual roll runs **locally** in the hive. Image pulls resolve against Pragmatic's registry using a scoped, pull-only credential seeded at bootstrap.

## The boundary: hive dials home

A single **hive-initiated** channel carries everything between a hive and Pragmatic. An **agent inside the hive opens an outbound, authenticated, long-lived connection to Pragmatic** and holds it. Pragmatic never initiates a connection into the client network, so a fully firewalled hive works with no per-hive ingress, VPN, or tunnel. The channel **generalizes the pull-agent surface that already exists** (`GET …/agent/target`, `POST …/agent/report` — already hive-initiated, already both directions) rather than inventing a second mechanism.

What rides the channel, and the ownership line that keeps B (platform-driven infra upgrade) and C (read-only oversight) consistent:

- **Down (platform → hive):**
  - **Rollout offers** — the published environment-app-image versions this hive may adopt. The *tenant* decides when to adopt; the platform only offers.
  - **Platform-driven upgrades of Pragmatic's own in-hive components** — the agent and the tenant-admin container themselves. These the platform may push and apply **automatically**, because they are Pragmatic's own shipped software, not tenant-owned resources. The agent must therefore be able to replace itself / the tenant-admin container.
- **Up (hive → platform):** environment **inventory and health** telemetry, so the platform's cross-hive view is populated. Read-only — the platform observes, it does not command tenant-owned resources. This is the direction the current `TenantHealthMonitor`/`HiveHealthProducer` already computes, but produced inside the hive and reported up rather than polled in-process.

The down-channel carries **no control over tenant-owned resources** (no force-stop of a tenant's environment, no tenant revocation). The only automatic down-push is Pragmatic upgrading its own components.

The agent authenticates on connect with a token issued at provisioning time; Pragmatic stores only its hash (`RolloutRegistrationRecord.agentTokenHash`). The token, like every other secret, is held server-side by name and never logged, echoed in a DTO, or placed in an error.

## Provisioning (how a hive is stood up, no inbound)

Provisioning is **not** a Pragmatic `docker exec`/push into the client cluster (that only works today because the IdP container sits on Pragmatic's own box). The platform generates a **one-time bootstrap artifact** (install manifest / chart + config) that the **client applies inside their own cluster with their own credentials**. The bootstrap carries a one-time agent token and the pull-only registry credential and stands up, inside the hive: the agent, the tenant-admin container, and the tenant IdP container. On first start the agent dials home, authenticates with the one-time token, and the hive is live. Thereafter Pragmatic touches the hive only over the hive-initiated channel.

## Secret classification across the boundary

**Seeded into the hive at bootstrap (must be there for local orchestration and identity to work):**

- The in-cluster service-account identity the orchestrator runs under (granted by the client when they apply the bootstrap).
- The one-time agent token.
- A **pull-only** credential for Pragmatic's container registry.
- The trust-root **public** key (`trustRootRef` resolves to a public key — `image-verifier` reads `PublicKey`), so the hive can verify signatures on images it pulls.
- The tenant IdP admin token and IdP CA (`idpAdminTokenRef`, `idpCaRef`), now that the IdP is in-hive.

**Must never cross into the hive:**

- Registry **publish/push** credentials.
- The trust-root **private** signing key (signing is platform-only).
- Any other tenant's or hive's material; platform operator credentials; cross-tenant view.

The `HiveDto` / tenant-facing DTO discipline stops being the same process being polite to itself and becomes the schema of what actually crosses a network edge to code on someone else's infrastructure. Anything a tenant must not see is enforced by never being sent, and that is now load-bearing.

## The cut (what moves where)

**Moves out of `ControlPlaneServer`, into the tenant-admin container image:**

- `TenantApiEndpoint` and its `/tenant-api/*` surface (hive read, environments CRUD + lifecycle actions, adoptable-versions list, hive target).
- The tenant's use of `EnvironmentService` + `HiveOrchestratorFactory` + `EnvironmentPlacement`, pointed at the in-cluster Kubernetes API.
- Tenant auth: `TenantAuthEndpoint`, `TenantAuthGate`, `TenantOidcRelyingParty`, `TenantSessionStore`, the tenant host resolver, `TenantPlaneHost`.
- Identity management for the tenant: `IdpService`/`IdpContainerEnv` and the IdP container itself (the per-tenant IdP relocates into the hive), plus the `admin-proxy` client.
- The health **producer** (`HiveHealthProducer`) and the per-hive monitor loop, now producing telemetry reported **up** the channel instead of feeding an in-process emitter.
- The `admin/tenant-portal` SPA, served by that container.
- The in-hive **agent** (new) that owns the home-channel connection and applies down-channel upgrades.

**Stays in the platform (`ControlPlaneServer` / `ControlPlaneHost`):**

- Client/tenant/hive provisioning and bootstrap generation, `PlatformDirectory`, the registries behind it.
- The registry/publishing side: `PlatformDeploymentRegistry`, `ManifestRegistry`, `GatingRegistry`, `SelectionRegistry`, `RolloutReportRegistry`, image signing/verification.
- The **agent-channel server** (new public listener) the hives dial into, and the cross-hive observability read model it populates (per-hive last-seen snapshots keyed by agent identity).
- The `admin/portal` SPA.

## Resolved decisions

- **One tenant-admin container per hive; a tenant maps to exactly one hive.** Both the tenant admin and the tenant IdP run inside that hive; no cross-hive identity coordination. Multi-hive-per-tenant is out of scope for now. *(approver)*
- **Hive dials home over a single channel**, generalizing the existing pull-agent surface, on a separate public listener. The agent token / registration record is the backbone. *(approver, earlier)*
- **Orchestration and identity are local to the hive.** The tenant admin drives its own in-cluster API and its in-hive IdP; neither round-trips to Pragmatic. *(approver + derived)*
- **"Upgrade its hive" covers both** the environments' application images (tenant-adopted) **and** Pragmatic's own in-hive components — the agent and tenant-admin container — which the platform may upgrade **automatically** (platform-driven). The agent must be able to replace its own container. *(approver)*
- **Oversight is read-only over tenant-owned resources.** The platform sees environment inventory and health; it has no break-glass control into a tenant. The only automatic down-push is Pragmatic upgrading its own components. *(approver)*
- **Provisioning is a client-applied bootstrap**, not a Pragmatic push; one-time agent token; agent dials home on first start. *(ruled — only shape consistent with "no inbound")*
- **Gating/selection stay platform-side**; the hive asks up-channel which versions it may adopt and for the image ref, records adoption up there, and rolls locally. *(ruled — follows "platform owns the registry, tenant adopts")*
- **Keep the in-process collapsed mode for local dev**: the same two apps wired over an in-process transport instead of the network channel, so local development stays a single `dev-up`. *(ruled — dev velocity, low risk)*

## Left to the builder

- The concrete wire protocol of the home channel (framing, multiplexing the two down-feeds and the up-feed, reconnect/backoff, at-least-once vs best-effort for telemetry). Reuse `@pragmatic-tech-ai/pragmatic-protocol` patterns where they fit rather than inventing a second style.
- The in-hive agent's exact process boundary: whether the agent and the tenant-admin backend are one process in the container or two cooperating processes, and the mechanics by which the agent replaces the tenant-admin container (and itself) on a platform-driven upgrade.
- How the adoptable-version list is represented on the hive side (cache/mirror vs. query-on-demand over the channel).
- The storage the tenant-admin container owns locally inside the hive (environments, sessions, tenant identity state) and how it is seeded at bootstrap.
- The exact shape and retention of the platform's cross-hive observability read model.
- The packaging of the bootstrap artifact (manifest set vs. Helm chart) and the in-cluster RBAC it requests from the client.
