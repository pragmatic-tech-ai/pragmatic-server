# In-hive follow-ups: design

Status: user decisions recorded 2026-11-06; awaiting approval of the full document. Repos: pragmatic-server (control plane, tenant console, environment server, both portals) and Plexus. Merge locally, never push.

## Why

The in-hive desktop sign-in work (Plans 1-3, merged 2026-11-05) left seven follow-ups. The user asked for all of them to be built rather than filed. Two are product gaps found by the live smoke (an in-hive tenant cannot create a graph; a missing graph reads as "internal error"); three harden what shipped (a retired console keeps serving, long relay calls, domain ownership); one restores reach that the in-hive switch removed (#22); two are code health.

## Goals

1. G1 Graphs for in-hive environments: an in-hive tenant can list, create and delete graphs of its Development environments from its console; every graph failure reaches the caller as a typed error with a plain sentence.
2. G2 A console the platform refuses stops serving desktop sign-in, targets and the relay.
3. G3 Long relay calls through the console's Ingress are not cut by proxy idle timeouts.
4. G4 An in-hive tenant's environments managed by the control plane are reachable from Plexus again.
5. G5 An email domain can be proven by a DNS TXT record.
6. G6 Every JSON store in admin/control-plane writes through one atomic, serialised writer.
7. G7 Every Plexus e2e spec typechecks, and the e2e typecheck covers the whole folder.

## Non-goals

- No graph promotion or runtime graph loading from the console (control-plane operator path only, unchanged).
- No graph creation from Plexus.
- No change to the tenant console's web sign-in when refused (G2 is desktop-only).
- No DNS verification for anything but email domains.

## Anti-goals

- A transient platform outage must never end anyone's desktop session (G2).
- No secret, token or admin password in a log, an error sentence or the renderer.
- No new inbound route on the console's public Ingress for platform-to-console calls.

## G1 Graphs for in-hive environments

### Typed graph errors (environment server)

`src/host/server-connection-handler.ts` maps graph errors to `ResponseError`s with stable codes instead of the generic -32603 `internal error`. One mapper class (`GraphErrorCodes`, in `src/host/graphs`) owns the table:

| Error | Code | Message (unchanged text) |
|---|---|---|
| GraphNotFoundError | -32040 | `Graph not found: <name>` |
| GraphExistsError | -32041 | `Graph already exists: <name>` |
| GraphNameInvalidError | -32042 | `Invalid graph name: <name>` |
| GraphPackageConflictError | -32043 | existing text |
| GraphPackageSegmentError | -32044 | existing text |
| GraphPackageMissingError | -32045 | existing text |

`NoEnvironmentGraphError` keeps its current mapping. The codes live in pragmatic-protocol's shared error-code module if one exists, else in the server and duplicated by value in clients (builder's call; one constant per code either way).

The control plane's `GraphService.Classify` switches from message-text matching to the codes. `AdminProxyError` (and `WsAdminConnection`) gain the JSON-RPC code so it survives classification. No text fallback (my call): an un-upgraded environment server sends `-32603 internal error` for every graph failure, so text matching could never fire; such servers keep their generic error until the image is updated.

Plexus: `RelayConnector.Call` maps the graph codes to sentences: not found -> `The graph <graph> no longer exists in <environment>. Create it again in the tenant console.`; conflict -> `A package version is already in <graph> with different content.`; others -> the server's message. (Exact copy is the builder's, kept plain.)

### Console graph routes

`TenantApiEndpoint` gains, for a Development environment owned by the session's tenant (`OwnedEnv` guard; same origin/session checks as every `/tenant-api/*` mutation):

- `GET /tenant-api/environments/NAME/graphs` -> `[{ name, description, createdAt, packageCount }]`
- `POST /tenant-api/environments/NAME/graphs` `{ name, description }` -> 201
- `DELETE /tenant-api/environments/NAME/graphs/GRAPH` -> 204

`TenantApiEndpoint` is shared by the in-hive console and the platform's own tenant plane, so both get the routes (my call: one surface, and control-plane tenants gain the same Graphs tab). Each composition passes a `GraphService` over its own `EnvironmentService`: the console's `WithAdmin` works in a pod via `InClusterEnvironmentReach`; the platform's works as today. Where no reach exists (a console outside a pod) the routes answer 503 with a sentence. Status mapping follows the control plane's table (409 exists, 404 not found, 400 invalid name or not a Development environment).

Gate (my call): the `envs` capability, for reads and writes - graph delete removes contributed packages, so it must not be open to every tenant member the way environment create is today.

Audit (my call): graph create and delete are recorded in a new `AuditRegistry` file in the data root (`tenant-graph-audit.json`), actor, environment, graph, outcome; no portal view in this work.

### Tenant portal

The environment detail page gains a `Graphs` tab (Development environments only): a list (name, description, packages, created), a `New graph` dialog (name, description, with the name rule shown), and `Delete` with a confirmation naming the graph. Errors show the route's sentence. View models extend Observable; `.mu` labels inline.

### Plexus

The contribute target dialog already says so when an environment has no graphs (`ContributeTargetDialog.NoGraphs`); only check that its sentence points at the tenant console.

## G2 A refused console stops serving the desktop

`ConsoleAdvertSender` distinguishes answers: 200 accepted; 401 (hive token deregistered, e.g. a forced hive delete) and 409 (console not enabled for the hive) are refusals; anything else (400, 5xx, unreachable, timeout) is transient.

A new `ConsoleRegistration` state object (console side) holds `Registered | Refused` and raises a signal on change. It becomes Refused after **two consecutive refusals on timer ticks** (my call: change-triggered sends - accounts or domains changed - can fire seconds apart, so they do not count toward the threshold, though a 200 from any send restores Registered), and Registered again on the first 200. Transient answers never change it. The state persists in the data root so a restarted console keeps it (and starts Registered when no file exists).

While Refused:
- `/desktop/*` answers 503 `{ error: 'console-not-registered', message: 'This console is no longer registered with the platform. Ask your administrator.' }` (except `/desktop/console`, which keeps answering so Plexus can tell it is a console).
- relay upgrades are refused with 503; open relays are closed (close code 4003).
- desktop sessions are NOT revoked (anti-goal: a mistaken refusal must be recoverable); they simply cannot be used. On returning to Registered everything works again.

Plexus maps all three signals to a new `AccountErrorKind.ConsoleRetired` with a FIXED sentence (my call, keeping AccountError's rule that it never carries a server's text): the 503 `console-not-registered` body on any `/desktop/*` call, the 503 on a relay upgrade (`RelayConnector.Refusal` reads the body for this one case), and close code 4003 on an open relay.

The gate is one place: `TenantPlaneHost` (`RouteDesktop` and the relay branch of `RouteUpgrade`) asks the registration state before dispatching.

## G3 Relay through the console Ingress

nginx's proxy timeouts measure the gap between two reads or writes, and the relay already pings the client every 30 s in both directions, so a long call should not be cut. No cut has been observed. My call: prove it rather than change it. The final live check holds a relay call open for 150 s through the console Ingress; if it survives, G3 is closed with that evidence and no manifest change. Only if it is cut do we add `proxy-read-timeout` / `proxy-send-timeout` = 3600 to the console Ingress alone (a console-only switch, since `TerminatingIngress` is shared with the environment-server Ingress; annotations emitted for every TLS source including none).

## G4 Control-plane environments of an in-hive tenant (#22)

Today discovery sends an in-hive tenant to its console, whose targets and relay only know environments the console created; environments the control plane manages for that tenant (on other hives) became unreachable from Plexus.

**Decision (user, 2026-11-06): a second session.** Plexus signs in at the platform as well, only for a tenant that has platform-managed environments, and shows both sets together.

- Discovery: each tenant entry whose tenant is in-hive gains `platformEnvironments: true` when the control-plane registry holds at least one environment of that tenant (absent otherwise). Discovery already answers only for a matched email, so this adds one bit.
- Plexus sign-in: after a successful console sign-in for such a tenant, the account dialog offers one more step, `Also sign in for your platform environments`, which runs the same browser sign-in at the discovery answer's `tenantPlaneUrl` (my call: an explicit step, never a second browser tab opened unasked). The user can skip it; the account panel keeps offering it.
- Session store: the stored session gains an optional `Platform` part (its own address, token, expiry), encrypted like the main one. Legacy blobs read as no platform part.
- Targets: Plexus lists the console's and the platform's targets together. Each target carries a `Source` (enum `Console | Platform`) and an id unique across both; the renderer shows the platform ones with a `(platform)` suffix when a name occurs in both. Contribute, publish and graph listing go to the session of the target's source. Addresses and tokens never cross IPC (the renderer sees name, status, source, id).
- Lifecycle: sign-out ends both sessions at their own addresses; a 401 from one source clears only that part (and the panel offers the platform step again); an Owner reset on the console does not touch the platform part, and vice versa.

## G5 DNS TXT domain verification

Each email domain (control-plane tenants and in-hive console-reported alike) can be verified:

- The control plane issues a per-tenant, per-domain token (random, stored with the approvals).
- The record: TXT at `_pragmatic-verification.<domain>` with value `pragmatic-domain-verification=<token>`.
- The control plane is the only resolver (one network vantage, one rate limit): `node:dns` `Resolver.resolveTxt` behind an `ITxtResolver` seam (tests use a fake). Lookups are rate-limited per tenant.
- Who presses Verify: the operator in the platform portal; the Owner of a control-plane tenant in the tenant portal; the Owner of an in-hive tenant in its console, whose button calls a new agent-channel route `POST /agent/hives/:id/console/verify-domain { domain }` (hive bearer, like the advert). The advert answer carries each reported domain's token and verification state so the console can show the record to add (my call).
- A daily re-check marks a domain unverified when its record is gone (it does not delete anything).
- Portal rows show `Verified` / `Not verified`, the record to add, and the last check time.

**Decision (user, 2026-11-06): a verified record approves the domain unless it is contested.**

- A domain is effective in discovery when it is claimed by the tenant AND (approved by an operator, OR verified and not contested), AND not revoked.
- Contested = another tenant also claims it (the existing "also claimed by" set). A contested domain needs the operator even when verified.
- Revoke beats verification: an operator revoke is stored and keeps a verified domain out until an operator approves it again.
- A failed daily re-check (record gone or changed) makes the domain unverified, which removes the automatic approval (an explicit operator approval stands).
- The portal row states which rule applies: `Approved`, `Verified`, `Verified, contested - needs approval`, `Revoked`, `Pending`.

## G6 One atomic JSON writer

`AtomicJsonFile` (temp file + rename, unlink on failure) gains options for file mode and fsync. Every JSON writer in admin/control-plane uses it, serialised through `SerialRuns` or the store's existing chain:

- `JsonRecordStore.WriteText` (all 15 subclasses inherit it)
- `ConsoleEmailDomainStore.Write`
- `SealedSecretStore.Persist` (mode + fsync kept)
- `FileSignatureStore.persist` (per-file queue kept)
- `TenantSessionStore.write`; its legacy-migration write moves inside the mutation chain
- `EnvironmentRegistry.persist` and `IdpRegistry.persist` (both gain serialisation; today they have none)
- `EnvironmentIdMigrator` (one-off script)

Behaviour is otherwise identical; existing store tests stay green, plus a concurrency test for the two registries that had no serialisation.

## G7 Plexus e2e typecheck

Fix the 15 errors in the ten older specs (13 unused declarations, one possible null, one cast), widen `tsconfig.e2e.json` to `e2e/**/*.ts`, and keep `typecheck:e2e` in `typecheck`.

## Constraints

Workspace rules apply (OOP, Allman braces, PascalCase public members, literals hoisted, enums over string sets, VMs extend Observable, tests in `tests/`, new files ASCII + LF, secrets never logged, editor tools only). Layering: plexus-core never imports the app. Each goal ships with tests in its owning repo; G1 and G2 get one live check on docker-desktop at the end (console graph create from the tenant portal, Plexus contribute to it; a refused console answering 503).

## Left to the builder

Exact sentences beyond those fixed above; the error-code module location; the DNS rate-limit numbers; portal layout details.

## Questions (answered 2026-11-06)

Answers: G4 = second session (option A); G5 = approves unless contested (option A with the contested rule). Kept below for the record.

1. G4 - which approach? (A) Plexus keeps a second session at the platform when the tenant also has platform-managed environments, and lists both sets together (a second browser sign-in, only for such tenants); (B) discovery offers the tenant twice ("Acme - console", "Acme - platform") and each session sees one set; (C) the console fetches the platform-managed list over its agent channel and shows them, but calls to them still go through the platform (needs the second session anyway).
2. G5 - what does a verified TXT record do? (A) it approves the domain by itself (the operator can still revoke); (B) it is required before an operator can approve; (C) it is shown to the operator as evidence only. Note for (A): two tenants can claim the same domain and each publish its own token; under (A) both would be approved, so (A) needs a rule for contested domains (e.g. a contested domain still needs the operator).
