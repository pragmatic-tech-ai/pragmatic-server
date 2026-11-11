# Platform security architecture — design

**Status:** design — brainstormed with the owner 2026-11-11; awaiting owner approval of this document
**Scope:** cross-repo — `todl` (system aspect, package security declarations), `pragmatic-graph`
(enforcement over engine storage), `todl-identity*` (IdP sync, team membership, per-user source
tokens), `pragmatic-server` + `admin/tenant-portal` (environment security setup), Plexus (authoring).
**Supersedes:** the tier-2 parts of the PP-security program (SP-1..SP-5b) and the admin-authored
designers that edit them — see §8.

## 1. Intent and why

Access logic leaked into app data. The tenant security model points at app fields
(`ownership: FromField`), app policy files filter on app data shape (`principal.id in
entity.owners`), and an app's own concepts are governed by its own policy alone. As a result "what
can Alice see" depended on the shape of the nodes, not on the permissions Alice holds — and
questions like "does an edge to a project Alice can't see reveal it?" had no principled answer.

The owner's rules, verbatim where possible:

- "The question what Alice can see shouldn't depend on the nodes, it should depend on the
  permissions Alice has. The shape of app data shouldn't influence access logic."
- An edge to a target Alice can't see does not reveal or grant the target — "certainly no".
- "Apps can not shape or rename ANY security related fields. Apps can implement their own access
  and filtering based on the shape of the data they work with, but that's exclusively for app's
  engineers to decide." — i.e. **tier 1** (platform security over system-managed fields) is the
  platform's; **tier 2** (app-level filtering over app data) the platform does not touch at all.
- Our applications ARE data-design artifacts, so security design belongs in the same artifact
  (the TODL package) rather than in a separate Dataverse-like layer — but organisation facts
  (people, groups, BUs, assignments) come from the identity provider and the environment, as in
  Power Platform.

## 2. Goals, non-goals, anti-goals

**Goals**
- One security model, in four layers with one owner each (§3).
- Access to engine-stored records decided only by: the caller's roles + depth, the record's
  system security fields, explicit shares, and field profiles.
- Identity and group membership sourced from the IdP; BUs and role assignment set per environment.
- Package installs/upgrades carry their security design with them as defaults; environments
  override those defaults as settings, without a redeploy (owner: "package can override" — the PP
  "access is a setting" rule holds).
- Field-level security in the first version (owner: "I need it").

**Non-goals**
- Any platform enforcement over external (connector) data (§6).
- Tier-2 / attribute policies over app data. Apps may filter in their own code.
- Roles created from scratch by an environment admin (as PP "new/copy role") — environments override
  package-shipped roles in v1 but do not author new ones. *(My call; revisit on a real case.)*
- Hierarchy security (manager / position hierarchies), which PP offers beside roles. Not needed by
  the v1 cases.
- BUs derived from the IdP (BUs stay platform-side, as in Dataverse).

**Anti-goals** (would be a failure even if it works)
- Any security decision reading an app-declared field.
- An app being able to rename, shadow, retype or write a system security field directly.
- A secured field or a hidden record being inferable through a filter, sort, aggregate, edge or
  count.
- One user's connector work executed with another user's connection or token.

## 3. The four layers

| Layer | Owns | Where it's edited |
|---|---|---|
| 1. Identity provider | users, groups, account enabled/disabled | Entra (cloud) / local IdP (dev); read-only to us |
| 2. Environment | BU tree, user→BU placement, teams (IdP-group links + manual members), role and profile assignment, **overrides** of package-shipped role privileges and profiles | tenant-admin |
| 3. Platform | the base roles (System Administrator, Basic User, …); the system ownership aspect and its fields | platform code |
| 4. TODL package | which concepts are owned; the package's own roles; its privilege contributions to base roles; secured fields; field profiles — all as defaults | Plexus, deployed into the environment |

App data feeds none of these.

## 4. The model

### 4.1 Identity and teams (layers 1–2)
- Users and group membership sync from the IdP. A user disabled or deleted in the IdP loses all
  access, including through manual team memberships (the IdP is authoritative on whether the
  identity exists).
- A **team** is an environment object. Its membership = members of its linked IdP groups (synced,
  never editable in the platform) ∪ identities an admin added manually. Each membership row records
  its origin (`synced` | `manual`). Sync never touches manual rows; tenant-admin can remove only
  manual rows. A user removed from the IdP group keeps a manual membership.
- Teams can own records (as in Dataverse owner teams).
- The existing `MembershipResolver` (claims/groups → home BU + teams, explicit override wins) is the
  starting point; it changes from "config maps claims" to "teams link IdP groups + manual rows".

### 4.2 Business units (layer 2)
- A single-rooted BU tree per environment, created and edited in tenant-admin.
- Each user has one home BU, assigned in tenant-admin (not derived from the IdP). A team has an
  owning BU.

### 4.3 Roles (layers 3 and 4 define, layer 2 overrides and assigns)
Modelled on Dynamics 365 over Dataverse: platform roles always present, apps ship their own roles
(as Sales ships Salesperson / Sales Manager), admins adjust per environment.

- **Base roles** are platform-defined and present in every environment. Indicatively System
  Administrator, Basic User, Reader (exact set: builder's call; System Administrator is fixed — it
  bypasses record and field checks within its environment).
- **Package roles:** a package may define its own roles (e.g. `projects` ships Project Member and
  Project Manager). Role names are package-qualified, so two packages' roles never collide.
- A role = for each concept, for each privilege action, an access depth: None / User / BU /
  BU+children / Org. Actions: create, read, write, delete, append, appendTo, assign, share, and
  invoke (method execution — the existing method gate becomes this privilege).
- **Package scope:** a package states privileges — in its own roles and as contributions to base
  roles — for its **own concepts only**, never for a dependency's concepts (a dependent package must
  not widen access to another package's data). It never assigns roles. *(Builder-check ruling, my
  call.)*
- **Environment overrides** (layer 2, a setting, no redeploy): an admin may change any depth in any
  base or package role, including adding privileges on concepts from other packages (e.g. give
  Project Manager read on `hr.Employee`). Overrides are stored per (role, concept, action).
- **Effective role** = package/platform defaults, with environment overrides applied on top.
- **Upgrade:** a deploy replaces the package's defaults and keeps the environment's overrides. New
  concepts and new roles arrive with the package's defaults. An override whose concept was removed
  is dropped; a role the package no longer ships is removed with its assignments. tenant-admin shows
  both in the deploy diff. *(My call.)*
- Role assignment (to users and teams, in tenant-admin) is layer 2.
- A concept (owned or organisation-owned) no effective role covers is accessible to System
  Administrator only.
- **Bootstrap:** the principal who creates an environment is assigned System Administrator in it.
  Deploying packages into an environment is a tenant-admin RBAC permission (existing deploy
  authorisation), not an environment role. *(My call.)*

### 4.4 Ownership (layer 3 aspect, declared in layer 4)
- A concept opts into ownership by taking a platform system aspect (working name
  `todl.system.Owned`) — the TODL type model is one parent concept + aspects, so this is a normal
  aspect, but its fields are platform-defined.
- Fields: `owner` (user or team) and `owningBusinessUnit`. Names, types and semantics are fixed.
  The compiler rejects any package that redeclares, renames, shadows or retypes them, or writes them
  in a mutation.
- The engine sets them on create (owner = creating principal; owning BU = owner's home BU, or the
  team's BU) and changes them only through **assign** (which requires the assign privilege).
- Concepts without the aspect are **organisation-owned**: roles grant them at Org depth or None
  only.
- **Upgrade adding the aspect to a concept with live records:** existing records are backfilled with
  owner = the environment's system principal (§5.1) and owning BU = the root BU, until assigned.
  *(My call.)*
- The per-concept "owner comes from field X" rule (`OwnershipSourceKind.FromField`) is removed.

### 4.5 Sharing
- Kept: `todl.system.ShareGrant` nodes grant a principal/team specific actions on one record.
  Sharing requires the share privilege at a depth that covers the record. Shares are revoked on
  record delete (existing SEC-E behaviour).

### 4.6 Field security (layer 4 design, layer 2 assignment)
- A package marks fields **secured** (a flag on the field; the platform enforces it).
- A package defines **field profiles**: name + per secured field {read, update, create}. Profiles
  reference only fields of the package's own concepts. They are defaults: environments override
  them (layer 2) the same way as role privileges, and an upgrade replaces defaults while keeping
  overrides.
- tenant-admin assigns profiles to users and teams. System Administrator sees all fields.
- Without a read grant a secured field behaves as **nonexistent** for the caller everywhere — not
  only in projection but also in `WHERE`, `ORDER BY`, aggregates, `exists`-style checks and Cypher
  property access (reads as absent/null; must not be distinguishable from "really null" by
  filtering). Writing without update (or create, on create) is rejected.

## 5. Enforcement (engine-stored concepts only)

- A record is visible iff: a role the caller holds (directly or via a team) grants read at a depth
  covering the record's `owner`/`owningBusinessUnit` (User = caller or caller's team owns it; BU =
  owning BU is caller's BU; BU+children = owning BU in caller's subtree; Org = any), OR a share
  grants it, OR the caller is System Administrator.
- Hidden records are invisible everywhere: matches, traversals, counts, aggregates. An edge to a
  hidden target is not traversable and does not reveal the target's existence or properties
  (owner: "certainly no").
- **Edges carry no privileges of their own** (as Dataverse relationships): an edge is visible iff
  both endpoints are visible to the caller, applied on every traversal hop. Creating or removing an
  edge requires append on the source record and appendTo on the target. Edge concepts cannot take
  the ownership aspect and need no contributions. *(Builder-check ruling, my call.)*
- Writes check the corresponding action/depth before execution.
- **Uniqueness stays global** (integrity over secrecy): a unique-key or version conflict against a
  hidden record fails with a generic error that carries no values or record ids. That leaks the one
  bit "something conflicts", as Dataverse duplicate keys do. Secured fields cannot be declared
  unique or used as identity keys (compiler rejects). *(My call.)*
- Depth/share filters are pushed down into engine storage queries where possible (existing
  access-scope push-down seam in the engine).
- No decision reads an app-declared field.

### 5.1 Acting principal
- Every operation runs as a principal: the signed-in user, or for work no user started (connector
  populate jobs, scheduled flows, background work, identity resolution, agents) a per-environment
  **system principal** owned by the root BU, holding System Administrator. Records such work
  creates are owned by the system principal until assigned.
- Method bodies run **as the caller** — invoke is a gate, never an elevation. *(My call.)*
- Scope: enforcement applies to runtime environments (application data). Plexus authoring data in
  dev-edit tenants is governed by the existing identity RBAC, not by this model. *(My call.)*

## 6. External (connector) data — outside the model

Owner: "connector access is totally its own thing, we have no influence over that. The engineer who
builds a particular application should know how to access the data and ensure appropriate
security."

- A connector connection authenticates either with **dedicated credentials** (connection string /
  service account) or with the **caller's identity** (IdP token exchanged for a source token,
  e.g. Azure SQL with Entra). Choosing and combining these is the app engineer's responsibility.
- External concepts get no system fields, no role gating, no row filtering, no field security from
  the platform.
- Platform obligations (not policy, just not undermining the engineer's setup):
  - each user's connector calls run on that user's connection/token — never pooled, cached,
    batched or compensated across users (engine wave-2 cross-row batching and compensation must
    respect this);
  - the identity layer offers per-user source-token acquisition (on-behalf-of in the cloud, a local
    equivalent in dev) so the caller's-identity mode is possible.

## 7. Where things happen

- **The graph comes with the environment.** Creating an environment (tenant-admin) creates its
  graph, empty, with the base roles present. No separate "create a graph" step.
- **tenant-admin** owns layer 2 for every environment, including developers' dev environments
  (owner: fine for devs to use tenant-admin for security setup in dev).
- **Plexus** owns layer 4: authors concepts, ownership, contributions, secured fields and profiles
  in TODL; connects to an environment and deploys packages into it (the environment catalog = union
  of deployed packages, §11.1 of the graph consolidation design).
- Promotion dev → test → prod carries layer 4 only. Layer 2 is per environment and is never
  promoted.

## 8. What changes in existing code and plans

**Retired (tier 2 / app-data-driven):**
- attribute policies: `access-policy.json`, model policy declarations, AND-composition/deny-wins;
- `PolicyScopeCompiler.FromRules`;
- `OwnershipSourceKind.FromField` and the per-concept ownership rules in `ISecurityModelConfig`;
- "app-private concept governance" (2026-10-26 spec: an app's own concepts governed by its policy
  alone);
- the Q5 plan `pragmatic-graph/docs/superpowers/plans/2026-11-10-policy-membership-by-kind.md`;
- admin authoring of roles from scratch and of which fields are secured in tenant-admin.

**Repurposed:** the tenant-admin privilege-matrix and field-profile editors (B1-3, B1-4, TA-9)
become **override editors** over package defaults — each cell shows the default, the override if
any, and resets to default.

**Kept, rebased onto the system aspect:** depth evaluation (`BusinessUnitHierarchy`), sharing,
assign, the method gate (as the invoke privilege), shares revoked on delete.

**Changed:**
- `ISecurityModelConfig` (environment setting) shrinks to: BU tree, user→BU, teams (IdP links +
  manual rows), role assignments, profile assignments.
- The TODL compiler/package format gains: the ownership aspect, role contributions, secured flags,
  field profiles; catalog composition unions them per environment.
- The engine enforces §5 and §4.6 over engine storage, including the "nonexistent field" rule in
  Cypher.
- M2.3 (`2026-11-10-runtime-graph-on-engine.md`): its policy tasks become "enforce tier 1 on
  engine-stored concepts"; connectors are excluded from enforcement. Its "deny wins / two policies"
  answer (Q2) and the §11.1 "ungoverned concepts policy-only bypass" no longer apply.

## 9. User cases

### 9.1 HR app — BU visibility, secured salary, manual team member
- Package `hr`: `Employee` takes the ownership aspect; contributes Basic User read Employee at BU,
  write at User; Reader read at BU. Marks `Employee.Salary` and `Employee.NationalId` secured;
  defines profile `Compensation` {Salary: read, update}.
- tenant-admin: BUs `Contoso` → `Sales`, `HR`. Team `HR` links Entra group `hr-staff`; Dana (a
  contractor not in that group) is added to `HR` manually. Profile `Compensation` → team `HR`.
- Outcomes: a Sales manager with Basic User sees Sales employees, not HR employees; sees no Salary;
  `MATCH (e:Employee) WHERE e.Salary > 100000 RETURN e.Name` returns nothing for them (the field is
  nonexistent to them), identical to a query on an absent field. Dana sees and updates Salary.
  Dana is removed from `hr-staff` in Entra → still in `HR` (manual row). Dana disabled in Entra →
  no access at all.
- Implication: field-nonexistence must apply inside the Cypher planner, not only at projection.

### 9.2 Projects app — depth, sharing, hidden edges
- Package `projects`: `Project` and `Task` owned. It ships roles Project Member (read/write Project
  and Task at User) and Project Manager (read Project and Task at BU+children, write at BU).
  tenant-admin assigns Project Manager to team `Managers` (linked to an Entra group) and Project
  Member to everyone else. In one environment the admin overrides Project Manager read to BU only —
  a setting, no redeploy; the next `projects` upgrade keeps that override.
- Alice owns project P1 in Sales; Bob in Marketing owns P2; Bob shares P2 with Alice (read).
  Alice sees P1 and P2. Task T3 (owned by Carol, Engineering) has an edge to P1: Alice cannot see
  T3; from P1, traversing incoming edges does not reveal T3 or count it. Carol can see T3 but
  traversing T3→P1 yields nothing unless Carol can see P1.
- Implication: traversal and counting must apply visibility on both endpoints.

### 9.3 CRM-backed app — connectors outside the model
- Package `sales` declares `Account` bound to a CRM connector in caller's-identity mode, and
  `PriceList` bound to a Postgres connector with a dedicated read-only account.
- Alice queries accounts → the connector runs with Alice's exchanged token; the CRM returns what
  Alice may see there. Two users querying concurrently never share a connection, token or batch.
  Everyone using the app sees the same price list; that's the engineer's design.
- A package-local `Opportunity` concept stored in the engine, linked to `Account`, is fully
  governed by §5; the link to an external `Account` the CRM won't return for Alice simply
  dangles (existing dangling cross-model target behaviour).
- Implication: identity layer needs per-user source-token acquisition; wave-2 batching/
  compensation keyed per user.

### 9.4 Package upgrade adds an owned concept and a secured field, users live
- `hr` v2 adds owned concept `Review` and secured `Employee.Bonus`, adds `Bonus: read` to
  `Compensation`, and contributes Basic User read Review at User.
- On deploy the contribution and profiles are replaced atomically with the catalog. Existing
  `HR` → `Compensation` assignment now also covers Bonus. Existing `Review` records: none.
- Implication: catalog swap and security-contribution swap must be one step; in-flight queries
  finish under the old model (they hold a catalog version).
- Existing environment overrides survive the upgrade. Removing a secured flag in an upgrade widens
  access immediately — the flag is design, owned by layer 4; tenant-admin shows the deploy diff
  (defaults changed, overrides dropped, roles removed) — UX is the builder's call.

### 9.5 Developer's dev environment
- Developer creates environment `dev-ana` in tenant-admin (graph comes with it), creates BUs `A`,
  `B`, test users via the local IdP, teams, assigns Basic User; deploys `hr` from Plexus; signs in as
  a test user to check what's visible. Promoting `hr` to `test` carries only the package.
- Implication: the local IdP must support groups (to exercise IdP-linked teams) and test users.

## 10. Owner answers (2026-11-11)

1. Depth variation (managers vs members): solved the PP way — packages ship their own roles (§4.3);
   hierarchy security deferred.
2. Settings vs recompilation: "package can override" — packages ship defaults, environments override
   them as settings without a redeploy (§4.3, §4.6).

## 11. Left to the builder
- Exact base role names beyond System Administrator; exact TODL syntax for the aspect,
  contributions, secured flags and profiles.
- IdP sync mechanics (push vs poll, frequency), and the local-IdP group model.
- tenant-admin UX for the override editors and the deploy-time diff.
- Migration of existing environments' security-model settings (drop retired sections; seed role
  assignments) and of existing packages (add contributions; until redeployed with contributions a
  concept is System-Administrator-only — research platform, no compatibility shim).
