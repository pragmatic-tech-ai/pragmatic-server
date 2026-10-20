# Environments, Graphs, and the Admin Promotion Console — Design

**Status:** Approved 2026-10-20 (all four open decisions accepted at the recommended defaults). Decomposed into per-sub-project specs and plans; implementation proceeds sub-project by sub-project via SDD.
**Date:** 2026-10-20
**Owner repo:** pragmatic-server (admin center lives in `admin/`); spans Plexus, TODL, pragmatic-protocol.
**Program:** continues the Environments → Admin → Plexus program (SP-ENV, SP-ADMIN-1/2 are done). This is the graph-deployment and typed-environment chunk the program flagged as "next."

## Intent and Why

Today the platform can create an environment (a pragmatic-server container + tenant) from a browser admin center, and it can deploy a single bundled application into a runtime tenant and serve it (proved by SP0/SP1). What it cannot do is model the real maker workflow: author a body of work in one place and promote it, as a unit, into a place where it runs.

The Power-Platform-Admin-Center analogy the program adopted earlier sharpens here. An environment is the Dataverse-instance analog. It comes in two kinds, and the platform already carries the distinction as the TenantPurpose enum with Development and Runtime members:

- A **Development environment** is a workshop. It holds solutions. Makers open Plexus against it to author meta-models, libraries, and applications over a graph that a solution session composes dynamically — the live, editable working graph, not a frozen snapshot.
- A **Runtime environment** is where things run. A graph gets deployed into it; the graph initializes as a live instance exposed on the environment's endpoint; applications deployed to that same environment read and write that instance.

The spine connecting the two is a promotion procedure, Development to Runtime, and the admin center is its console. This design defines the typed environments, the graph artifact, and that promotion path. Databases, connectors, and container-provisioned data stores (Postgres first) layer onto this flow afterward and are explicitly out of scope here.

## The Model (as decided)

The following were decided by the user during brainstorming and are the binding shape of the design.

1. **New Environment chooses a type up front:** Development or Runtime. Start with Development environments first; a Runtime environment is the promotion target.

2. **A graph is an admin-created container with an evolving, additive manifest.** In the admin panel an operator creates a graph by name and description; its manifest starts empty. The manifest is a versioned list of compiled packages that grows as solutions contribute to it. Graph evolution is additive — the graph is the durable, named thing; contributions accumulate into it over time.

3. **Plexus solutions contribute compiled packages into a named graph; Plexus never pushes to runtime.** "Build" in Plexus compiles a solution's packages and contributes them into a target graph's manifest, held in the Development environment (the development environment is the system of record for graphs and their packages). Re-contributing updates that solution's own slice of the manifest; different solutions contribute different packages; the manifest is their union. Promotion to a runtime is never a Plexus action.

4. **The admin panel performs the Development to Runtime promotion.** The admin center lists a development environment's ready graphs and promotes a chosen one into a chosen runtime environment. Promotion is an admin-center action against stored artifacts, not a Plexus action against a target.

5. **The runtime loads the manifest and initializes a graph instance.** On promotion, the runtime environment pulls the compiled packages the manifest names, initializes a live graph instance within the environment, and exposes it on the environment's endpoint. The admin panel shows the loaded graph for a runtime environment.

6. **Applications on the same runtime environment consume the graph instance** through the environment endpoint. SP0/SP1's "one app reads its own live data over the WS" generalizes to "the environment hosts a graph, and its apps read and write that."

7. **Local and remote coexist, resolved by placement and build targets — nothing local goes away.**
   - Solutions get a placement choice at creation: local (Plexus as a rich client over its in-process engine, exactly as today) or remote (Plexus as a thin client onto a development environment).
   - Applications get a build-target choice: bundled (embedded model snapshot, as today — not going away) or remote (binds to a runtime environment's graph instance). This is the html-bundle vs html-bundle-remote split SP0 introduced, generalized from one app's data to the environment's graph.

## Existing Substrate (reuse, do not rebuild)

- **Admin control plane plus browser-Mural portal** under the pragmatic-server `admin/` tree (control-plane: environment create/start/stop/delete/list, operator auth with httpOnly cookie plus CSRF/Origin gating; portal: Mural web app). Environment lifecycle and the promotion console build on this.
- **Tenant purpose:** the TenantPurpose enum (Development = 0, Runtime = 1) already exists; tenants.json carries purpose as the numeric value.
- **App manifest:** PragmaticAppManifest carries name, version, a packages list of id-plus-version refs, and an optional ui section; the app-ingest service already loads apps that reference compiled packages and serves them under the per-tenant app path. A graph manifest generalizes this package list from per-app to per-environment.
- **Compiled packages plus publish:** TODL's compile-package / publish / PackageStore machinery and the manifest-first-lazy module loading on the server are the raw materials for building and loading a graph's packages.
- **Remote app build flavor:** SP0's html-bundle-remote target (live-data client bound to a tenant API over a same-origin WebSocket) is the starting point for the remote application build target; it is generalized to bind to a graph instance.
- **Server runtime data plus security:** cypher/query, data/write, and the RBAC gate are real; a graph instance exposes reads and writes through them.

## Goals

- Typed environments in the admin center: create a Development or a Runtime environment; the admin panel distinguishes and lists them by type.
- A graph artifact: the admin creates a named graph (empty manifest) in a development environment; Plexus solutions contribute compiled packages into it, growing the manifest additively; the development environment holds graphs plus packages.
- Promotion console: the admin center lists a development environment's graphs and promotes a chosen graph's current manifest into a chosen runtime environment.
- Runtime graph instance: a promoted graph loads, initializes as a live instance, and is exposed on the runtime environment's endpoint; the admin panel shows it.
- End-to-end proof: an application deployed to the runtime environment reads the promoted graph instance live (minimal remote-target app), closing the Development to Runtime loop.

## Non-Goals (this milestone)

- Full thin-client Plexus authoring against a development environment's live solution-session graph (collaborative, server-held working graph). Deferred to a later slice; this milestone may use a lighter "place or save a solution into a development environment and build a graph from it" path.
- Postgres, external connectors, and admin-provisioned database or data-store containers. Explicitly layered on after this flow exists.
- Multi-graph-per-runtime orchestration, graph versioning or rollback UX beyond "which manifest is loaded," blue/green promotion, and cross-environment package deduplication.
- Live Google/OIDC identity (parked by user; local users suffice for tests).
- Multi-cloud hosting, durable Postgres app-data store, restart-survival hardening (that is the separate durability slice).

## Anti-Goals (would make this a failure even if it technically works)

- Making the local/rich Plexus experience or bundled apps second-class, or removing them. Local and remote must coexist; a maker who never touches an environment keeps working exactly as today.
- Letting Plexus push artifacts straight into a runtime environment, bypassing the admin promotion console.
- Baking a graph's data or packages into an application bundle for the remote path (that is the bundled path; the remote path binds to the shared instance).
- Introducing a standalone package registry as a required moving part for this milestone when the development environment is the system of record.

## Constraints (Global)

- Workspace coding conventions apply across all touched repos: OOP (no free functions or module-level state; methods on classes, statics where appropriate), Allman braces, enums over string-literal unions, no inline string literals (hoist to private static readonly PascalCase constants), PascalCase for interfaces and public methods, view models extend Observable (not MuralBase).
- Per-repo lexical style: TODL uses double quotes, semicolons, and `.js` import suffixes; protocol, server, and Plexus use single quotes, no semicolons, and `.js` suffixes; Allman everywhere. LF-only line endings (zero carriage-return bytes).
- Layering is strict and one-directional: todl-runtime to todl to mural/plexus-core to apps. Lower layers never import, call, or type against higher layers; upward communication is signal-only. The engine stays UX-free.
- Tests live under `tests/` or `src/**/tests/` folders. Fix all review findings including Minors.
- Secrets, tokens, session-cookie values, and credentials are never logged, echoed, committed, or baked into Docker image layers; a literal-token npmrc enters a build only via a BuildKit secret.
- Server application versions are immutable (app-ingest-service); redeploys require a bumped version. Any graph-manifest versioning must respect the same immutability discipline where it reuses that machinery.
- Nothing is merged or pushed until the user explicitly asks. Specs and plans live in-repo under `docs/superpowers/specs` and `docs/superpowers/plans` (not in a temp directory), with GitHub Project #1 holding Spec and Plan tracking items that link to the in-repo files.
- Commit trailer exactly as the standing convention; PR descriptions end with the Claude Code generation line.

## Proposed Decomposition (ordered sub-projects; each gets its own spec, plan, and SDD)

Milestone 1 is sub-projects 1 through 5 (walking skeleton of the create-contribute-promote loop). Sub-projects 6 and 7 are deferred.

1. **Typed environments.** New Environment picks Development or Runtime; the control plane records and provisions by type (purpose), and the portal lists and distinguishes them. Smallest slice; leans directly on the existing control plane and the TenantPurpose enum.

2. **Graph as an admin-created additive container (admin plus dev env).** The admin creates a graph by name and description in a development environment; its manifest starts empty. Defines the graph manifest format (an additive, versioned package list), the development-environment graph store seam, and the admin-portal graph create/list surface.

3. **Solutions contribute to a graph (Plexus plus TODL).** Plexus compiles a solution's packages and contributes them into a named graph's manifest (additive; re-contributing updates that solution's slice). Defines the maker-authenticated upload protocol operations and the merge-into-manifest semantics.

4. **Runtime loads a promoted graph (server, protocol, admin).** The admin promotes a graph's current manifest into a runtime environment: the runtime fetches the named packages, initializes the graph instance, and exposes it on the environment endpoint. The admin portal shows a runtime environment's loaded graph.

5. **Application binds to the remote graph (Plexus build target plus server serve).** A remote application build target binds a deployed app to the runtime environment's graph instance (generalizing html-bundle-remote); a minimal app deployed to the runtime reads the promoted graph live, proving the loop. The bundled target continues to work unchanged.

6. **(Deferred) Thin-client Plexus authoring against a development environment.** Solution placement choice (local rich versus remote thin) and live authoring over a development environment's solution-session graph.

7. **(Deferred) Postgres, connectors, and provisioned data-store containers.** Admin-provisioned database containers (Postgres first), deploy-time connection binding and validation, connection and secret admin, and a live external-source end-to-end on the flow built above.

## Calls Made During Brainstorming (stated for veto)

- **The development environment is the system of record for graphs** (manifests plus compiled packages); the admin panel reads its graph list to promote. A standalone registry is avoided for this milestone.
- **The graph is admin-created and evolves additively.** The admin creates the named, described, empty-manifest graph; solution contributions add to it over time. There is no per-build "ready to publish" flag (superseded): the graph is the durable named thing, the manifest is its current accumulated state, and the admin promotes that current state whenever it chooses. A maker contributing a solution's packages is itself the signal that their slice is ready.
- **Milestone 1 includes sub-project 5** (an app actually reads the promoted graph), because the promotion only earns "done" when something on the runtime consumes the graph — mirroring how SP0/SP1 earned theirs.
- **Contributions compile client-side in Plexus** (using the TODL compiler already in Plexus); the compiled packages plus the manifest contribution are then uploaded to the development environment. The server does not compile from a placed solution in this milestone.
- **A compiled package is immutable once contributed; the graph manifest is mutable** (it grows additively, and re-contributing updates a solution's slice). Package immutability stays consistent with app-version immutability; manifest mutability is the whole point of the additive model.
- **Development and Runtime environments share the same container image and template**, differing only by the tenant purpose value (and the operations each purpose gates); no resource, port, or role differences in this milestone. Any pre-existing environment is treated as Development.
- **The development environment gains a new graph/package store seam plus maker-authenticated protocol operations** for Plexus to upload a built graph; the maker authenticates to the development environment as a local user (the operator cookie covers the admin control plane only).

## Resolution of the Builder-Check (2026-10-20)

The builder-check surfaced that the server today builds a graph **per application** (from that app's manifest packages) and gates model and cypher operations off on Runtime tenants — there is no environment-level graph yet. That is expected: sub-project 3 introduces the environment-scoped graph instance. The settled position:

- **A graph instance is environment-scoped**, built from the promoted manifest's packages and exposed on a **dedicated environment graph endpoint** — beside, not replacing, the existing per-app graph machinery. Bundled apps keep their per-app graph; remote-target apps bind to the environment graph. Sub-project 3 decides how the Runtime purpose gating is relaxed for this environment graph while keeping dev-only authoring operations closed.
- **Remote-target applications bind to the environment's current graph instance; their own artifact (UI plus manifest) stays immutable, but the graph they read and write is the shared live instance.** Promoting a newer graph therefore changes the schema and data a remote app sees, by design — the application artifact is pinned, the graph is not. No per-app graph-version pinning in this milestone (one graph per runtime environment; replace-on-promote).

## Decisions (resolved 2026-10-20)

Resolved from the builder-check: graph-instance scope and endpoint, remote-app-versus-graph immutability, the additive admin-created-graph / contribution model, client-side compilation, typed-environment provisioning, and the upload seam. The four decisions below were the user's and are now accepted at the stated defaults:

- **A graph is created within a development environment and owned by it.** The admin creates the graph inside a chosen development environment, which remains the system of record; solutions in that development environment contribute to it, and the admin promotes it to any runtime environment. (Not a top-level entity independent of environments.)
- **Promotion transport is admin-relayed.** The admin control plane reads the manifest plus packages from the development environment (operator-authenticated) and loads them into the runtime (operator-authenticated), so the two containers never need network reachability to each other. Large packages may later need chunking because of the wire frame-size limit.
- **One graph per runtime environment, replace-on-promote.** This milestone loads a single environment graph; promoting a newer graph replaces the instance. Multiple concurrently-loaded graphs per runtime are out of scope.
- **The graph-instance endpoint is per-environment, reusing the existing query and data-write transport.** A remote app names its graph by the environment endpoint; graph-id addressing is unnecessary until a runtime hosts more than one graph, which this milestone does not.

## What Is Left to the Builder

Interface names, file placement, test structure, and the concrete manifest and DTO field names are the per-sub-project spec and plan's job. This document fixes the model, the seams between the pieces, the scope line for milestone 1, and the constraints — not the implementation.

## Folded-in backlog (opportunistic, closed as the owning sub-project ships)

A sweep of Project #1 (2026-10-20) surfaced existing backlog items that sit directly on this program's code paths. Rather than leave them as separate work, each sub-project clears the items on its path and closes their Project items (set Done + archive) as it ships. SP-GRAPH-1's five are already written as Tasks 7-10 of its plan.

- **SP-GRAPH-1 (typed environments):** Create concurrency guard (PVTI_lADOE0Zc984Biu4ozhBU2IA); provisioning accepts the purpose enum name as well as numeric (PVTI_lADOE0Zc984Biu4ozhA0sSE); seed CLI `up` exits non-zero on missing image (PVTI_lADOE0Zc984Biu4ozhBTTfo); seed.ts reuse BundleBuilder admin-cred constants (PVTI_lADOE0Zc984Biu4ozhBU2Ws); type-check gate for environments/ + admin/ (PVTI_lADOE0Zc984Biu4ozhBTTlg).
- **SP-GRAPH-2/3 (admin graph CRUD + solution contribution):** service-token management UI — maker auth to contribute (PVTI_lADOE0Zc984Biu4ozhBY6Ig); close /api/events sockets on logout/expiry (PVTI_lADOE0Zc984Biu4ozhBWBMA); masked password/token field in the Mural portal (PVTI_lADOE0Zc984Biu4ozhBWBnk) and the matching masked token input in Plexus (PVTI_lADOE0Zc984Biu4ozhB1zso).
- **SP-GRAPH-4 (runtime loads the promoted graph):** remote-app read-authorization model — a general read-grant instead of fail-closed DenyAll so a promoted graph is readable (PVTI_lADOE0Zc984Biu4ozhB1zEc); ModelView readiness — signal/await the first graph build over the wire (PVTI_lADOE0Zc984Biu4ozg__xxY); runtime tenant rejects/limits dev-only handlers while exposing the env graph (PVTI_lADOE0Zc984Biu4ozhA0sJI).
- **SP-GRAPH-5 (app binds to the remote graph + serving):** CSP / X-Frame-Options on the served app shell (PVTI_lADOE0Zc984Biu4ozhB1zho); v1 release prerequisite — the CypherAppDeployParamsDto rename on the deploy path (PVTI_lADOE0Zc984Biu4ozhB1zzM).

These are opportunistic, not scope expansions: an item is only pulled in if the sub-project already edits its file. Anything that would be its own slice (full control-plane auth/TLS, durable DB stores, DataGrid, connectors) stays in the backlog.
