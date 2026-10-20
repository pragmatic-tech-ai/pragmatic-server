# SP-GRAPH-2: Graph as an Admin-Created Additive Container — Spec

**Status:** Draft. Sub-project 2 of the Environments/Graphs/Admin program.
**Date:** 2026-10-20
**Parent design:** `pragmatic-server/docs/superpowers/specs/2026-10-20-environments-graphs-admin-design.md`
**Depends on:** SP-GRAPH-1 (typed environments — a graph is scoped to a Development environment).
**Repo:** pragmatic-server (admin control plane + Mural portal under `admin/`).

## Intent

Make a **graph** a first-class, admin-created entity: an operator creates a graph by name and description inside a Development environment, and its manifest starts empty. This sub-project defines three things the rest of the program leans on: the **graph manifest format** (an additive, versioned list of compiled-package references), the **development-environment graph store** (the dev environment is the system of record for its graphs), and the **admin-portal graph create/list surface**.

This slice does NOT populate the manifest (Plexus solutions contribute packages in SP-GRAPH-3) and does NOT promote anything to a runtime (SP-GRAPH-4). It establishes the durable, named container that contribution grows and promotion reads.

## Model (from the approved design)

- A graph is the durable, named thing; its manifest is an additive, versioned list of compiled package refs that grows over time. A brand-new graph's package list is empty.
- Graphs belong to **Development** environments only. A Development environment is the workshop that holds solutions and graphs; a Runtime environment receives a *promoted* graph (SP-GRAPH-4) and does not hold graph definitions. Graph create/list/delete is therefore scoped to Development-type environments.
- The graph manifest generalizes `PragmaticAppManifest` (name, version, a packages list of id+version refs, optional ui) from per-app to per-graph: a graph manifest carries a name, a description, and a packages list, and respects the same package/version immutability discipline where it reuses that machinery.

## Scope

- A **graph manifest format**: a real type carrying `name`, `description`, and a `packages` list of `{ id, version }` references. A newly created graph has an empty `packages` list. The format is defined here; it is populated additively in SP-GRAPH-3.
- A **graph entity + store** scoped to a Development environment: created graphs are persisted as the development environment's own artifacts (the dev environment is the system of record), keyed by graph name within that environment.
- **Control-plane API** for graphs, riding the existing gated/authenticated routes: create a graph (name, description, in a named Development environment), list the graphs of a development environment, get one graph, delete a graph.
- **Fail-closed creation**: the target environment must exist and be of type Development; creating a graph against a Runtime or unknown environment is rejected with a clear error. A duplicate graph name within the same environment is rejected.
- **Portal surface**: for a selected Development environment, list its graphs and create a new one (name + description); each listed graph shows its name, description, and package count (0 for a new graph).

## Out of Scope

- Contributing/compiling packages into a manifest, the maker-authenticated upload protocol, and the additive merge semantics (SP-GRAPH-3).
- Promotion to a runtime, runtime graph-instance loading, and the per-environment graph endpoint (SP-GRAPH-4).
- Any Plexus-side work, solution placement, or build targets (SP-GRAPH-3/5/6).
- Graph versioning/rollback UX, multi-graph orchestration, package deduplication.
- Standing up a separate package registry: the development environment is the system of record.
- Requiring a running dev-environment container to create or list graphs — graph metadata is managed by the control plane as the development environment's artifacts (the same way the control plane already owns each environment's bundle on disk).

## Functional Requirements

1. The graph manifest is a real type with `name: string`, `description: string`, and `packages: { id: string; version: string }[]`. A graph created in this slice has `packages: []`. (Enums/real types per the global constraints; no string-literal unions.)
2. A graph is created with a name and a description, scoped to a named Development environment, and persisted as that environment's artifact. Reading back a persisted graph yields the same name, description, and (empty) package list.
3. Graph creation is fail-closed: the target environment must exist and be `EnvType.Development`. Creating against a Runtime environment or an unknown environment is rejected with a clear, distinct error (not silently created). A duplicate graph name within the same environment is rejected (mirroring the environment-exists error pattern).
4. The control plane exposes create, list (for one development environment), get, and delete over the existing authenticated/Origin-checked routes. No secret or internal-only field appears in any graph DTO. An unauthenticated graph request stays 401.
5. The portal lists the graphs of a selected Development environment and offers a create form (name + description); the list shows each graph's name, description, and package count. The create form is only offered for Development environments.
6. Delete removes a graph from its environment's store; listing afterward no longer shows it.

## Exit Criteria

- An operator, in the portal, selects a Development environment, creates a graph by name + description, and sees it listed with an empty manifest (0 packages).
- Creating a graph against a Runtime environment (or a non-existent environment) is rejected with a clear error; a duplicate name within the same environment is rejected.
- Control-plane unit tests cover: manifest/graph persisted and read back (round-trip); create rejected for a Runtime/unknown environment; duplicate-name rejected; list scoped to the owning environment; the graph DTO leaks no secret; unauthenticated request → 401.
- No regression in the SP-GRAPH-1 environment lifecycle tests, the control-plane tests, or the `typecheck:tools` gate.

## Constraints

Inherit all Global Constraints from the parent design doc (OOP, Allman, real enums over string-literals, no inline string literals hoisted to `private static readonly` PascalCase, PascalCase public members, single-quote/no-semicolon server style with `.js` suffixes, LF-only, tests under `tests/` folders, secrets never logged/echoed/added to a DTO, nothing pushed until the user asks, fix all review findings including Minors). The portal is Mural; any collapsed ComboBox selection text must key on a `Label` property. The new graph routes ride the existing auth gate and error-to-status mapping; the `typecheck:tools` gate must stay green.

## Review Focus

- Creating a graph against a **Runtime** environment must be rejected, not created — the dev-only scoping is the point, and a runtime holds promoted graphs, not graph definitions.
- Creating a graph against an **unknown/deleted** environment must be rejected with a distinct error, not persisted orphaned.
- A **duplicate graph name** within the same environment must be rejected; the same name in a *different* environment is allowed (graphs are keyed within their owning environment).
- The graph DTO must leak **no secret or internal path** and must ride the existing auth gate (unauthenticated create/list stays 401).
- The manifest `packages` list of a newly created graph must be **empty** and must round-trip through persist/load as an empty list (not undefined/null), so SP-GRAPH-3's additive contribution has a well-defined starting point.
