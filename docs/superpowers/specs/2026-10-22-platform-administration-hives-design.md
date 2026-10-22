# Platform Administration — Tenants, Hives, and Platform-Software Rollout — Design

**Status:** Draft 2026-10-22 (brainstorm consolidated; builder-check done; all five decisions resolved — ready for approval). Decomposes into per-sub-project specs/plans/SDD. Program prefix: **SP-HIVE**.
**Date:** 2026-10-22
**Owner repo:** pragmatic-server (control plane lives in `admin/`); will touch Plexus/portal and protocol as sub-projects land.
**Program:** the top of the Env/Admin/Plexus program. SP-GRAPH handled graphs, solutions, and promotion *within* an environment. This design is the layer *above* environments: how Pragmatic Studio administers **tenants** and the **infrastructure a tenant runs on**, and how new versions of the platform software itself roll out to the living fleet.

## Intent and Why

Pragmatic Studio runs the platform as a service for customers. Each customer (a **Client**) has one or more **Tenants**; a tenant owns **Environments**; an environment owns **Applications**. Today the control plane can create an environment as a docker container on a single box and serve an app out of it. What is missing is the layer above that: a model of the **tenant** as a first-class, client-bound construct, the **infrastructure** a tenant's environments run on, and a **rollout mechanism** that connects Pragmatic Studio's own platform development to the running systems in the field — including those we cannot reach from our own network.

This design defines that layer. It is the Power-Platform-Admin-Center analogy taken to its top: not "which graph is promoted into which environment" (SP-GRAPH), but "which clients and tenants exist, what compute each tenant occupies, and what version of the platform every environment runs."

## The Model (as decided during brainstorming)

These are the binding decisions the user made. They are the shape of the design.

1. **Hierarchy: Client → Tenant → Environment → Application.**
   - **Tenant** — a high-level construct bound to a client; owns environments; holds policy/defaults they inherit. It is a *record*, not a process. This is what the platform-administration tool manages.
   - **Environment** — the deployment unit: **one pragmatic-server per environment** (one or more docker containers — server + sidecars such as Postgres). Owns applications. Administered one layer down; **out of scope** for this tool.
   - **Application** — lives in an environment. Out of scope here.

2. **Vocabulary correction.** The running server's `tenantId` string is a **misnomer** — it is really the *environment scope key* (it keys the per-environment storage root, identity realm, and ownership lease). As code in this area is touched, rename toward *environment id* so the vocabulary stops lying. No big-bang rename.

3. **Hive — a tenant's slice of compute.** A **Hive** wraps a Kubernetes cluster and runs a tenant's environments on it (each environment materializes as one or several containers/pods). A Hive is bound to **exactly one tenant**, but a **tenant may own many hives** (a client with a multicloud footprint gets several — e.g. AKS in one region and a private cluster elsewhere). The Hive, not the tenant, is where a tenant gains real infrastructure.

4. **Hive Orchestrator — the k8s backend, on two axes.** Every Hive names a **Hive Orchestrator**: the Kubernetes backend it runs on, abstracted so the admin tool talks to the orchestrator and never to k8s directly. Two axes:
   - **Backend:** Azure (AKS), AWS (EKS), GCP (GKE), private, local.
   - **Mode:** **provision** (we are given cloud credentials and stand the cluster up via IaC and own its lifecycle — hive teardown tears the cluster down) or **attach** (we are given a kubeconfig/endpoint for a pre-existing cluster and only schedule our workloads onto it — hive teardown removes our workloads, leaves the cluster).
   The current single-box docker control plane (`loop-orchestrator`/`docker-env-port`/`port-allocator`) generalizes into the **local** backend; today's behavior is its simplest implementation.

5. **Platform-software rollout connects our engineering to the fleet.** The rollout mechanism moves **platform software** (the versioned pragmatic-server image carrying mural/todl/plexus, plus control-plane/portal) from Pragmatic Studio's build pipeline into the running environments — *not* customer content. This yields a clean split: **the platform admin owns the platform *version* running under every environment; the tenant admin owns *what each environment contains*.** Rollout therefore touches environment workloads even though environment content/lifecycle is out of scope.

6. **PlatformDeploymentRegistry — a client-facing version catalog.** A service clients authenticate to. The **tenant admin**, via their tenant admin panel, browses a catalog of **manifests with their available versions**, selects one, and that selection starts the environment update. The Registry lists available manifests and holds the selected target version per environment. It is distinct from the **container registry** (which holds image bytes); a *manifest* is a published release descriptor (image reference, contents, compatibility).

7. **Delivery is hybrid: push where reachable, pull where not.**
   - **Push** — when the cluster is reachable, the control plane reaches in and the orchestrator applies the new version now.
   - **Pull** — when it is not (private / air-gapped / locked-down), an **agent inside the hive** periodically consults the PlatformDeploymentRegistry, sees an **obsoletion flag** (its running version is behind the selected target), and reacts: pulls the image and applies. Expressed as tenant self-service — the tenant chooses the version and the timing.
   - Either way the **actuator is the Hive Orchestrator** doing a rolling update on the environment workloads, and the hive **reports its running version + health** back so the flag clears when it matches target.

8. **Container registry: pull local everywhere; vary only the fill.** Every hive pulls from a registry **local to it** (fast, native pull); the only thing that differs by hive type is how that local registry is *filled* from Studio's source-of-truth registry. Images are **signed** at source and verified before apply.
   - **Cloud** → *attach* the provider registry (ACR/ECR/Artifact Registry); fill by replication.
   - **Private** → *provision* an in-hive OCI registry **or** *attach* the client's existing one (Harbor); fill by mirror/pull-through.
   - **Local** → *provision* an in-hive registry (or the box's shared docker image store); fill by pull-through.
   - **Air-gapped** → *sideload* a signed OCI bundle carried in out-of-band and imported.
   **Both provision and attach are first-class per-hive choices — neither is the default.** Enterprise clients commonly insist on *attach* so images land in their own registry for their scanning/audit. Consequently a **Hive's creation config carries two infrastructure specs side by side: the cluster (orchestrator backend + mode) and the registry (provision/attach + credentials).**

9. **Berth / berthing — reserved, not built now.** The late-game in-process-multitenancy feature (packing several environment-runtimes into one shared process — what `TenantRegistry`/`ServerFor`/ownership-lease/idle-evict prototype today) is named **berthing**; a host process offers N **berths**. Named now only to keep the vocabulary clean; explicitly out of scope.

## Local-first implementation target (decided)

Model and implement local deployments first on **Docker Desktop's built-in Kubernetes** — a real single-node cluster (context `docker-desktop`, **attach** mode). Pragmatic Studio dogfoods as both client and tenant (`pragmatic-dev`). This covers the whole single-hive attach story:

- Hive Orchestrator against a real cluster: deploy/service/health/**rolling update**.
- Environments as workloads (pragmatic-server pod + Postgres), mirroring the e2e's loop-dev/loop-rt/-db.
- Rollout **push** (control plane over kubeconfig) and **pull** (hive **agent pod** polling the PlatformDeploymentRegistry).
- Registry: the shared docker image store as the "no registry" fast inner loop (`imagePullPolicy: IfNotPresent/Never`), **and** a local `registry:2` container to exercise the registry capabilities (provision / attach GHCR / sideload / verify). Docker Desktop is *not itself an OCI registry* — it is a shared image store — so a real `registry:2` is run when registry fidelity is wanted.

**kind/k3d is added later** solely for the two things Docker Desktop cannot do: **provision mode** (stand a cluster up from nothing) and **multi-hive / multicloud** topology (multiple clusters).

## Existing substrate (reuse, do not rebuild)

- **Control plane + portal** — `admin/control-plane` (API, system-of-record) and `admin/portal` (operator UI). Today records environments (`EnvironmentRecord` with a bare `tenantId` string); must gain **Tenant** and **Hive** records.
- **Operator identity** — `admin/control-plane/operator-identity.ts` (platform admins + roles).
- **Audit** — hash-chained operator-action trail.
- **Orchestration primitives** — `loop-orchestrator`, `docker-env-port`, `port-allocator`, `environment-service`, `environment-registry`: the raw-docker lifecycle that becomes the **local** Hive Orchestrator driver.
- **Tenancy runtime** — `TenantRegistry`/`ITenantOwnership`/`ITenantCoordinator`/`TenantProvisioning` and todl-identity `Tenant(Id, Kind, DisplayName)`: the per-environment runtime machinery (to be re-labelled toward "environment") and the seed of berthing.
- **Identity model** — todl-identity (`ResourceKind.Tenant` root, RBAC, OIDC/local/token/mTLS).

## Goals

1. A first-class **Tenant** record (client-bound) and **Hive** record (tenant-bound, 1..N) in the control plane, with portal CRUD.
2. A **Hive Orchestrator** abstraction with the **local/attach (Docker Desktop k8s)** driver: schedule, health-check, and tear down environment workloads on a real cluster.
3. A **container-registry** integration: the effective-registry concept with the local provision path (`registry:2` + shared-store fast path) and the attach path (GHCR), with signature verification.
4. A **rollout** path: PlatformDeploymentRegistry manifest catalog, orchestrator rolling-update actuator (push), tenant-admin self-service selection, and the in-hive **agent** (pull) with the obsoletion flag.
5. Everything proven locally on Docker Desktop k8s, dogfooded as tenant `pragmatic-dev`.

## Non-Goals (this program's first milestone)

- Cloud backends (AKS/EKS/GKE), in either mode.
- Provision mode and multi-hive topology (needs kind/k3d) — the two Docker-Desktop gaps.
- Berthing (in-process environment packing).
- Governance / quota / metering.
- Fleet observability rollup beyond per-hive health.
- Air-gapped sideload bundles and client-registry (Harbor) attach.
- Customer-content promotion — that is SP-GRAPH, already shipped.

## Anti-Goals (would make this a failure even if it technically works)

- The admin tool talking to Kubernetes directly anywhere but inside an orchestrator driver.
- A second meaning of "tenant" leaking back in — the server's env-scope key must not be presented to operators as the tenant.
- Credentials (cloud creds, kubeconfigs, registry secrets) appearing in logs, DTOs, errors, or the portal — they are held server-side by name.
- A rollout path that only works for reachable clusters (the pull/agent path is not optional).
- Making the local path a toy that diverges from the real k8s model — Docker Desktop is a *real* cluster and must be driven as one.

## Constraints (Global)

- **Local-first on Docker Desktop k8s**; drive it as a real cluster via its kubeconfig context.
- **Reuse** the existing control plane, portal, operator-identity, and audit; extend, do not fork.
- **Credentials server-side by name**, never in logs/DTOs/errors/portal.
- **OOP**: classes with methods, no module-level free functions or state. **Allman** braces. **No inline string literals** in TS (hoist to `private static readonly`); `.mu` labels stay inline. **PascalCase** public methods/interfaces.
- **View models extend `Observable`**, not `MuralBase`. **Engine never calls up** (signal-only).
- **Tests in `tests/` subfolders**. **LF-only.**
- Specs/plans authoritative **in-repo** under `docs/superpowers/specs|plans/`; GitHub Project #1 holds Kind=Spec/Plan items that **link** to the files; deferrals become Kind=Feature items.

## Proposed Decomposition (ordered sub-projects; each gets its own spec, plan, SDD)

1. **SP-HIVE-1 — Client, Tenant & Hive records.** Control-plane data model: **Client** (first-class, minimal: id, display name, subscription ref placeholder — builder-check settlement), **Tenant** (client-bound), **Hive** (tenant-bound 1..N, carries cluster-spec + registry-spec + signature trust-root ref). An **Environment carries a `hiveId`** binding it to exactly one hive (set as a placement choice at environment creation; schema added here even though environment lifecycle stays out of scope — builder-check settlement). System-of-record persistence, portal CRUD, operator-identity gates, audit. No orchestration yet. Re-label the environment↔tenant vocabulary where touched.
2. **SP-HIVE-2 — Hive Orchestrator + local/attach driver.** The orchestrator abstraction (backend × mode seam) and the **local Docker Desktop k8s / attach** driver: stand up an environment workload (server + Postgres) as k8s objects, health-check, roll, tear down. Generalize `loop-orchestrator`/`environment-service`.
3. **SP-HIVE-3 — Container registry integration.** Effective-registry concept; local **provision** (`registry:2` + shared-store fast path) and **attach** (GHCR); signed-image verification before apply.
4. **SP-HIVE-4 — Rollout.** PlatformDeploymentRegistry manifest catalog (client-facing, **per-hive target selection** — decision 2), orchestrator rolling-update actuator (push), tenant-admin self-service selection UI, in-hive **agent** (pull) authenticating with a **per-hive machine credential injected at hive creation** and **POSTing its running version + health back to the Registry** (builder-check settlement), obsoletion flag, platform-admin **manifest gating per tenant** (decision 1), rollback = **re-select the prior manifest** (decision 3). Includes a **minimal manifest-publish command** registering image-ref + metadata into the Registry; local dogfood seeded by publishing the current `pragmatic-server:dev` build by hand (full CI publish deferred — builder-check settlement). The self-service catalog is delivered as the first feature of the **SP-HIVE-7** tenant-admin app.
5. **SP-HIVE-5 (later) — kind driver: provision mode + multi-hive.** Closes the two Docker-Desktop gaps.
6. **SP-HIVE-6 — Tenant-level identity realm (decision 4).** A client's user authenticates against **one tenant-level account** shared by every environment under the tenant, replacing today's per-environment realm. Substantial change into todl-identity; sequenced as its own sub-project. SP-HIVE-7's tenant-admin authentication depends on this realm existing, so this lands before or alongside it.
7. **SP-HIVE-7 — Tenant Admin app (decision 5).** A new **first-class root application built on mural, like Plexus** (working name TBD): the mural app shell (Pragmatic theme, Observable VMs, html-bundle build), identity wiring to a **configured provider** (file-based local provider for dev/test), and tenant-scoped navigation over the tenant's hives/environments. SP-HIVE-4's self-service version catalog is its first feature.

Each deferral in Non-Goals is filed as a GitHub Project Kind=Feature item on approval.

## Calls made during brainstorming (stated for veto)

- Program prefix **SP-HIVE**; owner repo **pragmatic-server**.
- Design doc in-repo at `docs/superpowers/specs/2026-10-22-platform-administration-hives-design.md`; Project gets a linking Kind=Spec item (per the 2026-10-20 in-repo-specs preference, which supersedes the older Project-only approach).
- The server `tenantId` rename is **incremental** (as-touched), not a big-bang refactor.
- Local backend reuses the existing docker orchestration code rather than starting fresh.

## Decisions (resolved 2026-10-22)

1. **Manifest gating — GATED.** The platform admin controls which manifests/versions appear in a given tenant's catalog (a canary reaches only chosen tenants; others stay on stable). The tenant admin chooses among what is offered, and when.
2. **Selection unit — PER HIVE.** The tenant admin selects a target version per hive; all environments on that hive move to it together (a hive runs one platform version across its environments).
3. **Rollback — RE-SELECT PRIOR MANIFEST.** Recovery from a bad update is selecting the previous version again; no separate halt/rollback mechanism in the first milestone.
4. **Identity — PER TENANT.** A client's user authenticates against one tenant-level account shared by every environment under the tenant (not per-environment accounts). This is the decided model; delivered by **SP-HIVE-6**.
5. **Tenant-admin surface — DEDICATED FIRST-CLASS MURAL APP.** The tenant-admin panel is a new first-class application at the workspace root, **built on mural like Plexus** (a rich mural app — Pragmatic theme, mural controls, VMs extending `Observable`, html-bundle build — not a role on the operator portal, not a plain web surface on a service). Its users come from a **configured identity provider**; dev/test uses the **local file-based provider** (existing todl-identity local provider). Delivered by **SP-HIVE-7** (app shell + identity) with SP-HIVE-4's self-service catalog as its first feature. Working name TBD.

## Resolution of the builder-check (2026-10-22)

A fresh builder read the design and surfaced six gaps. Five are settled here as builder-facing calls (veto any); the sixth is escalated as Open Decision 5.

- **Env→Hive binding (settled):** an environment runs on exactly one hive and carries a `hiveId`, set as a placement choice at environment creation. SP-HIVE-1's schema adds this edge even though environment lifecycle stays out of scope; SP-HIVE-2's driver resolves "which cluster" from it.
- **Agent identity + report-back (settled):** the in-hive agent authenticates to the PlatformDeploymentRegistry with a **per-hive machine credential injected at hive creation** (held server-side by name); report-back is the **agent POSTing running version + health to the Registry** (not the control plane querying the cluster — pull-path clusters are unreachable from us by definition).
- **Manifest publish (settled):** milestone 1 includes a **minimal publish command** registering a manifest (image ref + metadata) into the Registry; the local dogfood is seeded by publishing the current `pragmatic-server:dev` build by hand. Full CI-pipeline publish is deferred (Feature).
- **Client record (settled):** **Client is first-class** in SP-HIVE-1 (minimal fields); Tenant references it. Modeling the top of the hierarchy now is cheap and awkward to retrofit.
- **Signature trust root (settled):** the verification public key / trust policy is **part of hive-creation config** (held server-side by name); the local path uses a dev key. SP-HIVE-3 consumes it.

## Open decisions

None — all five resolved above (2026-10-22). One small item left to the builder: the working name of the tenant-admin app (SP-HIVE-7).

## What is left to the builder

- Concrete k8s object shapes (Deployment/StatefulSet/Service/Secret) for an environment workload on Docker Desktop k8s — the design fixes the behavior, not the manifests.
- The persistence mechanism for Tenant/Hive records (follow the existing `EnvironmentRecord` store's pattern).
- Portal view/VM structure for tenant and hive management (follow existing portal view/VM conventions; VMs extend `Observable`).
- The polling interval and backoff for the in-hive agent.
- The exact signing/verification toolchain (cosign vs notation) — pick one, justify briefly.
