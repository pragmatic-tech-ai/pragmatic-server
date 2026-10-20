# SP-GRAPH-1: Typed Environments — Spec

**Status:** Draft. Sub-project 1 of the Environments/Graphs/Admin program.
**Date:** 2026-10-20
**Parent design:** `pragmatic-server/docs/superpowers/specs/2026-10-20-environments-graphs-admin-design.md`
**Repo:** pragmatic-server (admin control plane + Mural portal under `admin/`).

## Intent

Make the Development-versus-Runtime distinction a first-class, explicit choice when an environment is created in the admin center, recorded on the environment, and used to provision the tenant with the matching purpose. Everything downstream in the program (graphs are created in Development environments; promotion targets Runtime environments) depends on an environment knowing its own type.

Today an environment's purpose is implied by which template it was created from (the seed env.json carries a numeric purpose). This sub-project separates "what kind of environment is this" from "which template seeded it," so an operator picks the kind directly and the admin center can filter and route by it.

## Scope

- New Environment flow collects an explicit **environment type**: Development or Runtime.
- The type is recorded on the environment's persisted record.
- The created tenant is provisioned with the `TenantPurpose` matching the chosen type (Development or Runtime).
- The admin portal shows each environment's type in the list and detail views, and the create view offers the choice.
- The control-plane API create and list/connect-info DTOs carry the type.
- Pre-existing environment records (created before this change) are treated as Development when read.

## Out of Scope

- Creating graphs, the graph store, contribution, promotion, or any graph concept (later sub-projects).
- Any behavioral difference between the two types beyond the tenant purpose value and its existing server-side gating (no resource, port, or role differences).
- New templates. Type is orthogonal to template; existing templates still work, now with the type chosen explicitly rather than inferred.
- Migration tooling for already-running containers (only the stored record's read-time default is in scope).

## Functional Requirements

1. The create request accepts an environment type with exactly two values, modeled as a real enum (Development, Runtime), not a string-literal union. A missing or unrecognized value is rejected with a clear error (fail-closed), not silently defaulted on the API.
2. The environment record persists the chosen type. Reading a record that predates the field yields Development.
3. On create, the provisioned tenant's numeric purpose is set from the chosen type: Development maps to the Development member, Runtime to the Runtime member of `TenantPurpose`.
4. The control-plane list and connect-info responses include the type; no secrets are added to any DTO.
5. The portal create view lets the operator choose the type (defaulting to Development, the one we start with); the list and detail views display it.
6. The auth gate, Origin checks, and error-to-status mapping behavior are unchanged; the new field rides the existing gated routes.

## Exit Criteria

- An operator creates a Development environment and a Runtime environment from the portal; each comes up as a container whose tenant carries the matching numeric purpose (verifiable in the tenants.json the container reads).
- The portal list distinguishes the two by type.
- Control-plane unit tests cover: type recorded on the record; type drives the provisioned purpose; a pre-field record reads as Development; a bad type value is rejected.
- No regression in the existing environment lifecycle tests or the gated Docker smoke.

## Constraints

Inherit all Global Constraints from the parent design doc (OOP, Allman, enums over string-literals, no inline string literals, PascalCase public members, single-quote/no-semicolon server style, LF-only, tests under tests/ folders, secrets never logged/echoed/committed, nothing pushed until the user asks, fix all review findings including Minors). The type is an enum per the enums-over-string-literals rule. The portal is Mural; a type picker rendered as a ComboBox must give its items a Label (the collapsed-selection text keys on Label/Name/Text, not DisplayMemberPath).

## Review Focus

- A create request with a missing or unknown type value must be rejected, not coerced — the API is fail-closed on type.
- An environment record written before this field must read back as Development, not throw or read as undefined.
- The numeric purpose actually written into the container's tenants.json must match the chosen type (the whole point); a test must assert the numeric value, not just the record field.
- The new DTO field must not leak any secret and must ride the existing auth gate (an unauthenticated create/list stays 401).
