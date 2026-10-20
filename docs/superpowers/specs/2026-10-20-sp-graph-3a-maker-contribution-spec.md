# SP-GRAPH-3a: Maker-Authenticated Graph Contribution (Server + Protocol) — Spec

**Status:** Draft. Sub-project 3a of the Environments/Graphs/Admin program.
**Date:** 2026-10-20
**Parent design:** `pragmatic-server/docs/superpowers/specs/2026-10-20-environments-graphs-admin-design.md`
**Depends on:** SP-GRAPH-1 (typed environments), SP-GRAPH-2 (admin graph container — reworked here; see below).
**Repos:** `pragmatic-protocol` (new graph protocol ops) and `pragmatic-server` (container-side graph store + handlers, control-plane proxy rework, portal maker-token surface). No Plexus work — that is SP-GRAPH-3b.

## Intent

Make the development-environment **container** the system of record for a graph, and give a maker a way to contribute a solution's compiled packages into a named graph over the wire, authenticated as a non-admin maker. This is the server-and-protocol half of "solutions contribute to a graph"; the Plexus Build→contribute action and maker-token input (SP-GRAPH-3b) are the clients of what this slice builds.

This slice establishes: (1) a **graph protocol surface** (create/list/get/delete/contribute) on the running server; (2) a **container-side graph store** in the tenant's data volume holding each graph's identity and its additive, per-solution manifest; (3) **additive merge + package ingest** semantics; (4) a **maker capability** and a **portal-minted maker service token**; and (5) the **control-plane rework** so the SP-GRAPH-2 portal manages graphs by proxying the container instead of writing a host-side file.

## Decisions carried in (brainstormed and approved 2026-10-20)

- **Container-owned.** The graph's manifest and packages live in the dev-env container volume. The maker uploads directly to the container (maker-authenticated protocol op); the container merges. The control plane reads/manages via the existing admin proxy. This reworks SP-GRAPH-2's host-side `graphs.json` into a container-backed proxy.
- **Maker auth = portal-minted scoped service token + a maker capability.** The control plane (holding the env Owner credential) mints a scoped service token in the dev env and shows it in the portal; a new maker capability gates the contribute op (not over-privileged Admin/Owner).
- **Split 3a / 3b.** This spec is 3a (server + protocol + control plane). SP-GRAPH-3b is the Plexus client.

## Model

- A **graph is owned by the dev-env container**: its identity (`name`, `description`) and its manifest live under the tenant data volume (e.g. `/data/<tenant>/graphs/`), alongside the tenant's `packages/`. Managing or contributing to a graph therefore requires the environment's container to be running — an accepted change from SP-GRAPH-2 (which managed graph metadata host-side without a running container). The dev-env workshop is running while a maker is using it.
- The **manifest is additive and per-solution**. Internally the store keeps each contributing solution's slice keyed by a stable solution id; the graph's effective package list is the **union** of all slices (deduplicated by `id@version`). Re-contributing from the same solution **replaces that solution's slice** (so a solution can drop or re-version its packages); other solutions' slices are untouched. A newly created graph has no slices and an empty effective package list.
- **Package immutability.** A contributed package is immutable once stored: contributing the same `id@version` with byte-identical content is an idempotent no-op; contributing the same `id@version` with **different** content is rejected (Conflict), mirroring the existing app-ingest immutability rule. Packages are ingested into the tenant's existing `packages/<id>/<version>/model.json` layout.
- **Maker authentication.** The control plane, authenticated as the env Owner over the existing admin proxy, mints a **scoped service token** bound to a maker principal in the dev env and returns it to the operator in the portal (shown once, treated as a secret). The maker presents this token (Bearer) when connecting to the dev-env container. A new **maker capability** authorizes the graph-contribute op and nothing else privileged; operator-relayed create/list/get/delete continue to run as the env Owner.
- **Control-plane rework.** SP-GRAPH-2's host-side `GraphService`/`GraphRegistry` (writing `bundleDir/graphs.json`) is replaced by a control-plane graph service that **proxies the container** over the admin connection (the same pattern as `AdminProxy` for accounts/grants). The portal's existing create/list/detail graph surface keeps working but now reflects container truth; the host-side `graphs.json` store is retired.

## Scope

- **Protocol (`pragmatic-protocol`):** a `GraphProtocol` contract class exposing `graph/create`, `graph/list`, `graph/get`, `graph/delete`, and `graph/contribute`, with flat camelCase DTOs in `wire-dtos.ts`, barrel exports, `PragmaticClient` wrapper methods, and a `PolicyGate` table entry per op. Reuse the established `RequestType` pattern and the five-step "add a protocol method" convention in `pragmatic-protocol/ARCHITECTURE.md`.
- **Server / container:** a dev-purpose-gated graph service and a container-side graph store under the tenant data volume; package ingest reusing the immutability discipline; additive per-solution merge; connection handlers wired into `ServerConnectionHandler` through the existing provider plumbing, each `guarded(...)` by the policy gate. Graph CRUD ops authorize at an admin/owner level; `graph/contribute` authorizes at the new maker capability.
- **Identity / authz:** a **maker capability** that authorizes `graph/contribute` (and only that, among privileged actions), added to the role-capability model in `todl-identity`, together with the principal/role a minted maker token carries. Reuse the existing service-token issuance (`AdminProtocol.IssueToken`) and session/token validation; add no new auth transport.
- **Control plane:** rework the graph service to proxy container graph ops over the admin connection; add a **maker-token mint** path (operator-authed) that issues a scoped maker token in the dev env via the proxy; portal surfaces to (a) keep create/list/detail working against the container and (b) mint and display a maker token for a development environment, handling it as a secret (never persisted in a DTO, shown once).

## Out of Scope

- **All Plexus work** — the Build→contribute action, the compiled-package upload client, and the maker-token input UI are SP-GRAPH-3b.
- **Promotion to a runtime**, runtime graph-instance loading, and the per-environment graph endpoint (SP-GRAPH-4).
- **Frame/transport chunking** for very large package payloads — note it as a known risk; this slice assumes package payloads fit the existing deploy-sized frame, matching `application/deploy`.
- **A masked token input control** in the Mural portal beyond showing the minted token once (the masked-field backlog item may ride along if cheap, but is not required here).
- **Removing or changing** the existing `application/deploy` path, bundled apps, or the SP-GRAPH-1/2 environment lifecycle beyond the graph-store rework described above.
- **Multi-graph orchestration, package deduplication across graphs, versioning/rollback UX.**

## Functional Requirements

1. The running server exposes graph operations over the protocol: create (name + description), list, get, delete, and contribute — each a real `GraphProtocol` request with typed DTOs and a `PragmaticClient` wrapper. All are **rejected on a non-Development environment** (dev-purpose gate), mirroring the existing development-only ops.
2. A graph's identity and manifest are **persisted in the tenant data volume** and survive a reconnect: creating a graph then listing/getting it (on a fresh connection) returns the same name, description, and effective package list; a brand-new graph's effective package list is an **empty array** (never null/undefined).
3. **Contribution is additive and per-solution.** `graph/contribute` takes a graph name, a stable solution id, and a set of compiled packages (`{ id, version, modelJson }`). It ingests the packages and records them as that solution's slice; the graph's effective package list becomes the union of all slices (deduped by `id@version`). Re-contributing from the same solution **replaces that solution's slice** (a dropped package disappears from the union if no other slice holds it).
4. **Package immutability is enforced.** Contributing an `id@version` whose bytes match an already-stored package is an idempotent success; contributing an `id@version` whose bytes **differ** is rejected with a clear Conflict, and the manifest is **not** mutated (no partial contribution persists on rejection).
5. **Contribution is maker-authenticated.** `graph/contribute` is authorized by a new **maker capability**; a token carrying only the maker capability can contribute but cannot perform admin ops (accounts/grants/config/deploy). Graph create/list/get/delete authorize at admin/owner (operator-relayed). An unauthenticated or under-privileged request is rejected (401 at upgrade / authorization failure per the existing policy gate), and no graph state changes.
6. The control plane can **mint a scoped maker token** for a development environment (operator-authed, relayed to the container as the env Owner) and the portal displays it once; the token is **never** logged, echoed, persisted in a DTO, or returned by any list endpoint. The portal's graph create/list/detail operate against the container via the proxy (SP-GRAPH-2's host-side `graphs.json` store is retired).

## Exit Criteria

- A server-side test connects to a running Development tenant, creates a graph, contributes a solution's packages, reconnects, and reads back the graph with the contributed packages in its effective list; a second contribution from a different solution adds to the union; re-contributing from the first solution with a dropped package shrinks the union accordingly.
- Contributing the same package `id@version` with identical bytes succeeds idempotently; with different bytes is rejected Conflict and leaves the manifest unchanged.
- A maker-capability token can `graph/contribute` but is rejected for an admin op and for `graph/create`/`delete`; an admin/owner token can do CRUD; an anonymous connection is rejected at upgrade.
- All graph ops are rejected against a Runtime environment.
- The control plane mints a maker token via the proxy and the portal shows it once; grepping server and control-plane logs for the token value yields nothing. The portal lists/creates graphs against the container.
- No regression in SP-GRAPH-1/2 environment and graph portal tests (adjusted for the proxy rework), the control-plane tests, the existing protocol/server suites, or the `typecheck:tools` gate.

## Constraints

Inherit all Global Constraints from the parent design (OOP, Allman braces, real enums over string-literal unions, no inline string literals — hoist to `private static readonly` PascalCase, PascalCase public members and interfaces, per-repo lexical style, LF-only, tests under `tests/` folders, secrets/tokens never logged/echoed/committed/added to any DTO, nothing pushed until the user asks, fix all review findings including Minors). The engine-layering rule holds (lower layers never import upward). New protocol ops follow the five-step convention and the deny-by-default `PolicyGate` table; the maker capability must be least-privilege (graph-contribute only). The `typecheck:tools` gate must stay green. pragmatic-server style = single quotes, no semicolons, `.js` suffixes; pragmatic-protocol follows its own repo style.

## Review Focus

- A **maker token must not be over-privileged**: it authorizes `graph/contribute` only — explicitly NOT accounts/grants/config/security-model/`application/deploy`/graph-create/graph-delete. The capability table addition is least-privilege, deny-by-default.
- **Package immutability across solutions**: two different solutions contributing the same `id@version` with the same bytes is fine (idempotent union); with different bytes is a Conflict that mutates nothing.
- **Per-solution slice replacement**: re-contributing a solution's slice replaces it (dropped packages leave the union unless another slice holds them) — not an append that leaks stale packages.
- **Dev-only gating**: every graph op, especially `graph/contribute`, is rejected on a Runtime environment, before any store write.
- **Secret hygiene**: the minted maker token is shown once, never logged/echoed, never in a list DTO or persisted record; the env Owner password the control plane uses to relay stays server-side as today.
- **Empty-manifest round-trip**: a newly created graph's effective package list round-trips as an empty array through persist/reconnect, so a first contribution has a well-defined starting point.
- **No partial writes on failure**: a rejected contribution (Conflict, bad auth, non-dev env) leaves no package files and no manifest change behind.
