# Graphs for In-Hive Environments, Refused Console, Atomic JSON Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-repo part of in-hive follow-ups G1, G2 and G6. Graph failures leave the environment server with typed codes and reach every caller classified. The tenant console and the platform's tenant plane can list, create and delete graphs of a tenant's Development environments, and the tenant portal shows them in a Graphs tab. A console that the platform refuses stops serving the desktop surface and the relay. Every JSON store in `admin/control-plane` writes through one atomic, serialised writer.

**Architecture:** The environment server maps its six graph errors to JSON-RPC codes -32040..-32045 in one place (`GraphErrorCodes`, used by `ServerConnectionHandler.Dispatch`). The control plane keeps a by-value copy of the codes. `AdminProxyError` carries the code and `GraphService.Classify` switches on it. `TenantApiEndpoint` gains the `/tenant-api/environments/NAME/graphs` routes over a `TenantGraphAccess` (graph service or none, plus its audit), which both compositions build. `ConsoleRegistration` (console side) turns the advert answers into Registered / Refused. `TenantPlaneHost` is the only gate that reads it, and it closes open relays with 4003. `AtomicJsonFile` gains `mode` / `fsync` options, and every writer moves onto it.

**Tech Stack:** TypeScript (Node ESM, `node:test` via `tsx --test`), `vscode-jsonrpc` `ResponseError` (re-exported by `@pragmatic-tech-ai/pragmatic-protocol`), `ws`, Mural `.mu` views, `@pragmatic-tech-ai/todl-runtime` `Observable` / `Signal`.

**Spec:** `docs/superpowers/specs/2026-11-06-in-hive-follow-ups-design.md`, sections G1 (server side), G2 (server side), G3 and G6.

**Scope notes:**
- **G3 needs no code in this plan.** Plan C's final live check holds a relay call open for 150 s through the console Ingress, and that check is the evidence. No Ingress annotation is added here.
- **Out of scope:** everything in Plexus; discovery's `platformEnvironments` flag (Plan C); DNS TXT verification (Plan B).

## Global Constraints

- Plan B may have landed first in this repo, so line numbers can have shifted. Read the code at each named symbol before you edit.
- OOP: no module-level functions or variables. Every function is a method or a static member. Module-level `const` is allowed only for true compile-time constants (and type / enum declarations).
- Allman braces: every opening brace goes on its own line, and `else` / `catch` / `finally` each start their own line. Object literals, block-bodied arrows and genuine one-line blocks stay inline.
- PascalCase for public members and interfaces. Plain data-shape properties that mirror JSON wire fields keep camelCase.
- TS string literals go into `private static readonly` PascalCase constants (`public static readonly` when another class needs them). `.mu` labels stay inline. Use enums rather than sets of strings.
- View models extend `Observable`. Tests live in `tests/` subfolders.
- New files are ASCII with LF line endings, and CRLF files keep CRLF. These touched files are CRLF: `admin/control-plane/tenant-auth/tenant-session.ts`, `admin/control-plane/tests/tenant-session.test.ts` and `admin/tenant-portal/src/tenant-api-client.ts`. These contain non-ASCII bytes, so keep them byte-for-byte outside your edit: `admin/control-plane/tenant-api/tenant-api-endpoint.ts`, `admin/control-plane/tenant-plane-host.ts`, `admin/control-plane/tenant-auth/tenant-plane.ts` and `admin/control-plane/tests/tenant-plane-host.test.ts`.
- No explicit Width/Height in `.mu`.
- Never log secrets. A logged failure carries the error's name or a fixed sentence, never a body, token, password or email.
- Edit with the editor tools only (no `sed -i`). Stage by explicit path (`git add <paths>`, never `-A`). Regenerated `*.mu.js` files are tracked: stage them with their `.mu`.
- Every commit message ends with `Co-Authored-By: <model> <noreply@anthropic.com>`. Merge locally and never push.
- Gates. Run the ones for the areas a task touches at the end of that task:
  - control plane: `cd admin/control-plane && npx tsx --test tests/*.test.ts`
  - repo root: `npm run typecheck:tools`
  - repo root, when `src/` is touched: `npm test`
  - tenant portal: `npm --prefix admin/tenant-portal run typecheck && npm --prefix admin/tenant-portal test`
- **Fixed values that Plan C consumes. Keep them verbatim.**
  - Graph error codes: `GraphNotFoundError` -32040, `GraphExistsError` -32041, `GraphNameInvalidError` -32042, `GraphPackageConflictError` -32043, `GraphPackageSegmentError` -32044, `GraphPackageMissingError` -32045. Each keeps its existing message text.
  - Refused-console body (HTTP 503): `{ error: 'console-not-registered', message: 'This console is no longer registered with the platform. Ask your administrator.' }`
  - Close code for a relay that was open when the console became Refused: `4003`.
  - Graph routes:
    - `GET /tenant-api/environments/NAME/graphs` answers 200 with `[{ name, description, createdAt, packageCount }]`.
    - `POST /tenant-api/environments/NAME/graphs` with body `{ name, description }` answers 201 with the created `{ name, description, createdAt, packageCount }`.
    - `DELETE /tenant-api/environments/NAME/graphs/GRAPH` answers 204.
    - Errors are `{ error: <sentence> }`, mapped as follows:
      - 404 `Not found`: environment unknown or foreign.
      - 403 `forbidden`: no `envs` capability.
      - 400 `Graphs exist only in Development environments.`
      - 503 `This console cannot reach its environments, so graphs are unavailable here.`: no reach.
      - 400 `name (non-empty string) is required; description must be a string`
      - 409 `A graph with that name already exists in this environment.`
      - 404 `That graph does not exist in this environment.`
      - 400 `Use lowercase letters, digits and hyphens, starting with a letter or digit.`: invalid graph name.
      - 503 `The environment could not be reached. Check that it is running.`: connect failure.
      - 500 `The graph operation failed.`: anything else.

## Review Focus

1. **A graph name that contains a connection word.** A missing graph named `closed-deals` arrives as `Graph not found: closed-deals`, and `AdminProxy.Classify` would read that as a Connect failure ("closed"). It must still read as Not Found (404, `GraphNotFoundError`), not 503, because the code is checked before any text rule. Tested in Task 2.
2. **A transient answer between two timer refusals.** A 5xx, unreachable or timeout answer on a timer tick between two timer refusals must leave the console Registered: the streak resets. A change-triggered refusal between two timer refusals neither counts nor resets the streak. Tested in Task 6.
3. **A bad registration file.** A missing, empty or malformed `console-registration.json` opens Registered, so a bad file never locks the desktop out. Tested in Task 6.
4. **A malformed graph segment in a DELETE path.** A malformed or encoded segment (`%E0%A4%A`, or `a%2Fb`, which decodes to a name with `/`) answers 404 or the service's own refusal. It never reaches another route and never causes a 500. Tested in Task 3.
5. **Refused, then Registered again.** The same desktop bearer works with no new sign-in, because sessions are untouched, and a new relay is admitted. Tested in Task 7.

---

### Task 1: Typed graph error codes on the environment server

**Files:**
- Create: `src/host/graphs/graph-error-codes.ts`
- Modify: `src/host/server-connection-handler.ts` (`Dispatch`'s `fail`, around line 333; the reserved-code comment at line 102)
- Test: `src/host/graphs/tests/graph-error-codes.test.ts` (new), `src/host/tests/server-connection-handler.graphs.test.ts`

**Interfaces:**
- Produces, in `graph-error-codes.ts`:
  - `export enum GraphErrorCode { NotFound = -32040, Exists = -32041, NameInvalid = -32042, PackageConflict = -32043, PackageSegment = -32044, PackageMissing = -32045 }`
  - `export class GraphErrorCodes`, with:
    - `public static CodeOf(error: unknown): GraphErrorCode | undefined`: maps `GraphNotFoundError`, `GraphExistsError` and `GraphNameInvalidError` (from `dev-graph-service.ts`), `GraphPackageConflictError` and `GraphPackageSegmentError` (from `graph-package-ingest.ts`), and `GraphPackageMissingError` (from `graph-package-reader.ts`). Anything else, including `NoEnvironmentGraphError`, is `undefined`.
    - `public static ToResponseError(error: unknown): ResponseError | undefined`: `new ResponseError(code, error.message)`, so the message is unchanged.

- [ ] **Step 1: Write the failing tests**

In `graph-error-codes.test.ts`:
- `test('each graph error maps to its code and keeps its message')`: for each of the six error instances, assert `GraphErrorCodes.CodeOf(e) === <code>`. Assert that `ToResponseError(e)` has `.code === <code>` and `.message === e.message`. For example, `new GraphNotFoundError('sales')` gives -32040 and `'Graph not found: sales'`. Build the missing-package error from `{ id: 'p', version: '1.0.0' }`.
- `test('a non-graph error has no code')`: `new Error('x')`, `new NoEnvironmentGraphError()` and `'text'` all give `undefined` from both methods.

In `server-connection-handler.graphs.test.ts`, give `FakeGraphService` a `public Failure: Error | undefined` that every method throws when set. Then:
- `test('graph failures answer their typed code with the unchanged message')`:
  - with `Failure = new GraphNotFoundError(GraphFixture.GraphName)`, `client.GetGraph(...)` rejects with code -32040 and message `Graph not found: sales`;
  - `GraphExistsError` on `CreateGraph` gives -32041;
  - `GraphNameInvalidError` gives -32042;
  - `GraphPackageConflictError` on `ContributeGraph` gives -32043;
  - `GraphPackageSegmentError` gives -32044;
  - `GraphPackageMissingError` on `ExportGraph` gives -32045.
- `test('a non-graph failure still answers -32603 internal error')`: with `Failure = new Error('secret detail')`, the code is `ErrorCodes.InternalError` and the message is `internal error`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/host/graphs/tests/graph-error-codes.test.ts src/host/tests/server-connection-handler.graphs.test.ts`
Expected: FAIL. The module is missing, and the coded cases get -32603.

- [ ] **Step 3: Implement `GraphErrorCodes` and hook it into `Dispatch`**

In `fail`, change only the fallback: `throw error instanceof ResponseError ? error : (GraphErrorCodes.ToResponseError(error) ?? new ResponseError(ErrorCodes.InternalError, ServerConnectionHandler.GenericInternalMessage))`. The sync `catch` path already goes through `fail`. Extend the reserved-code comment next to `RevokedCode` to say that -32040..-32045 are the graph codes (`GraphErrorCode`). Leave `NoEnvironmentGraphError`'s mapping (around line 823) unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command, then `npm test`.
Expected: PASS. The `dispatch-error-scrub` tests stay green.

- [ ] **Step 5: Commit**

```bash
git add src/host/graphs/graph-error-codes.ts src/host/server-connection-handler.ts src/host/graphs/tests/graph-error-codes.test.ts src/host/tests/server-connection-handler.graphs.test.ts
git commit -m "feat(env-server): typed JSON-RPC codes -32040..-32045 for graph errors"
```

---

### Task 2: The control plane carries and classifies the graph code

**Files:**
- Create: `admin/control-plane/graph-error-code.ts`
- Modify: `admin/control-plane/admin-proxy.ts` (`AdminProxyError` around line 24; `AdminProxy.Classify` at lines 269-295), `admin/control-plane/graph-service.ts` (`Classify` at lines 126-150, and its three text constants)
- Test: `admin/control-plane/tests/graph-error-code.test.ts` (new), `admin/control-plane/tests/admin-proxy.test.ts`, `admin/control-plane/tests/graph-service.test.ts`

**Interfaces:**
- Consumes: Task 1's `GraphErrorCode` (`src/host/graphs/graph-error-codes.ts`). Only the parity test imports it; production control-plane code does not, because the console image must not pull in server modules.
- Produces:
  - In `graph-error-code.ts`: `export enum GraphErrorCode`, with the same members and values as Task 1. Its comment says it is a by-value copy of `src/host/graphs/graph-error-codes.ts`.
  - Also in `graph-error-code.ts`: `export class GraphWireCodes { public static Includes(code: number | undefined): code is GraphErrorCode }`.
  - `AdminProxyError` gains:
    - `public readonly Code: number | undefined`;
    - a constructor `(kind: AdminProxyErrorKind, message?: string, isTransport: boolean = false, code?: number)`.
  - `WsAdminConnection` is unchanged (ruling): `sendRequest` already rejects with a `ResponseError` whose numeric `code` survives, and `AdminProxy.With` hands it to `Classify`.

- [ ] **Step 1: Write the failing tests**

In `graph-error-code.test.ts`:
- `test('the control plane copy matches the environment server codes')`: deep-equal the entries of the two enums.

In `admin-proxy.test.ts`, using the existing `FakeConnector`, make a connection method reject with a `ResponseError`:
- `test('a graph code reaches AdminProxyError.Code as Protocol, whatever its text')`: `new ResponseError(-32040, 'Graph not found: closed-deals')` gives `Kind === AdminProxyErrorKind.Protocol` and `Code === -32040`.
- `test('a non-graph ResponseError keeps the text rules and its code')`: `new ResponseError(-32602, 'invalid params: x')` gives `Kind === Invalid` and `Code === -32602`.
- `test('an error without a code has Code undefined')`: `new Error('socket hang up')` gives `Kind === Connect` and `Code === undefined`.

In `graph-service.test.ts`, replace the text-based tests ('container errors are classified back into graph errors', 'the classifier recognises the real container error messages', 'an invalid name that embeds a sentinel phrase...', 'a non-Protocol proxy error is never reclassified...') with:
- `test('graph codes are classified back into graph errors')`:
  - `new AdminProxyError(Protocol, 'anything', false, -32041)` on Create gives `GraphExistsError`;
  - -32040 on Get and on Delete gives `GraphNotFoundError`;
  - -32042 on Create gives `GraphNameInvalidError`;
  - -32040 on Promote's export gives `GraphNotFoundError`.
- `test('a Protocol error without a graph code passes through even when its text says not found')`: `new AdminProxyError(Protocol, 'Graph not found: g1')` rejects as that same `AdminProxyError`. This is the no-text-fallback rule.
- `test('package codes pass through as the AdminProxyError with its Code')`: -32043 on Promote rejects as an `AdminProxyError` with `Code === -32043`.
- Keep 'a connection failure surfaces as the AdminProxyError' and 'an unrecognised container error passes through unchanged'.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd admin/control-plane && npx tsx --test tests/graph-error-code.test.ts tests/admin-proxy.test.ts tests/graph-service.test.ts`
Expected: FAIL. `graph-error-code.js` is missing, `Code` is undefined, and coded errors are not classified.

- [ ] **Step 3: Implement**

`AdminProxy.Classify`:
1. Read `code` (a number on the thrown object, else `undefined`) through a `private static CodeOf(err: unknown): number | undefined`.
2. If `GraphWireCodes.Includes(code)`, return `new AdminProxyError(Protocol, message, false, code)` before any text rule.
3. Otherwise apply the existing text rules unchanged, passing `code` into each `AdminProxyError` they build.

`GraphService.Classify` switches on `err instanceof AdminProxyError ? err.Code : undefined`. It maps `NameInvalid`, `Exists` and `NotFound` to the three control-plane errors and rethrows everything else. Delete `ExistsText`, `NotFoundText` and `InvalidNameText`, and the comment that ties them to the server's messages. Leave the error table in `control-plane-host.ts` (lines 449-453) unchanged: it already maps the three control-plane graph errors.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command, then the full control-plane gate and `npm run typecheck:tools`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/graph-error-code.ts admin/control-plane/admin-proxy.ts admin/control-plane/graph-service.ts admin/control-plane/tests/graph-error-code.test.ts admin/control-plane/tests/admin-proxy.test.ts admin/control-plane/tests/graph-service.test.ts
git commit -m "feat(control-plane): AdminProxyError carries the JSON-RPC code; GraphService classifies graph errors by code"
```

---

### Task 3: Graph routes on TenantApiEndpoint

**Files:**
- Create: `admin/control-plane/tenant-api/tenant-graph-access.ts`
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts` (constructor; `Handle` at line 183; a new `RouteGraphs` next to `RouteEnvCredential`). This file has non-ASCII bytes.
- Test: `admin/control-plane/tests/tenant-api-graphs.test.ts` (new)

**Interfaces:**
- Consumes:
  - `IGraphService` and `GraphDto` (`control-plane-host.ts`);
  - `GraphExistsError`, `GraphNotFoundError` and `GraphNameInvalidError` (`graph-service.ts`);
  - `EnvironmentNotDevelopmentError` and `EnvironmentNotFoundError` (`environment-service.ts`);
  - `AdminProxyError` and `AdminProxyErrorKind`;
  - `AuditRegistry` (`audit-record.ts`).
- Produces, in `tenant-graph-access.ts`, `export class TenantGraphAccess`:
  - `public constructor(graphs: IGraphService | undefined, audit: AuditRegistry)`
  - `public get Service(): IGraphService | undefined`: undefined means this composition cannot reach its environments.
  - `public async Record(session: TenantSession, method: string, path: string, status: number, environment: string, graph: string): Promise<void>`: best effort, and never throws. A failure is logged by error name only. It appends:
    - `actor`: `session.tenantId + '/' + (session.email ?? session.principalId)`;
    - `method`, `path`, `status`, and `at` (ISO);
    - `note`: `'environment=' + environment + ' graph=' + graph`.
    - Each field is clipped to 128 characters.
  - `public static StatusOf(err: unknown): number` and `public static MessageOf(err: unknown): string`: the error half of the table in Global Constraints. Anything unmatched is 500 with `The graph operation failed.`.
  - `public static readonly` constants for every sentence in that table: `NotDevelopmentMessage`, `UnreachableMessage`, `FieldsMessage`, `ExistsMessage`, `NotFoundMessage`, `NameInvalidMessage`, `ConnectMessage` and `FailedMessage`.
- `TenantApiEndpoint`'s constructor gains a last optional parameter, `private readonly graphs?: TenantGraphAccess`. Without it, the graph paths answer 404 exactly as today.

- [ ] **Step 1: Write the failing tests**

`tenant-api-graphs.test.ts` (copy the `ResRecorder` request/response shape from `tenant-api-mutate.test.ts`). It needs:
- a `FakeGraphs implements IGraphService` that records calls and has a `Throw: Error | undefined`;
- an environment service stub whose `List()` holds `dev1` (Development, tenant `t1`), `rt1` (Runtime, `t1`) and `other` (Development, tenant `t2`);
- a real `AuditRegistry` in a temp dir;
- session `{ tenantId: 't1', principalId: 'p1', email: 'o@acme.test' }`.

Tests:
- `it('lists the graphs of an owned Development environment')`: `GET /tenant-api/environments/dev1/graphs` answers 200 with exactly the fake's `GraphDto[]`. Nothing is audited.
- `it('creates a graph (201) and audits it')`: `POST` with `{"name":"sales","description":"d"}` answers 201 with the DTO, and the fake saw `('dev1','sales','d')`. The audit holds `actor 't1/o@acme.test'`, `method 'POST'`, `path '/tenant-api/environments/dev1/graphs'`, `status 201` and `note 'environment=dev1 graph=sales'`. A body without `description` creates with `''`.
- `it('deletes a graph (204) and audits it')`: `DELETE /tenant-api/environments/dev1/graphs/sales` answers 204 with an empty body. The audit holds `status 204` and `note 'environment=dev1 graph=sales'`.
- `it('answers 404 for an unknown or foreign environment without calling the service or auditing')`: `other` and `nope` answer 404 `Not found`. The fake has no calls and the audit is empty.
- `it('needs the envs capability for reads and writes')`: with `mock.method(TenantAdminCapabilities, 'For', ...)` returning `envs: false`, GET, POST and DELETE each answer 403 `{ error: 'forbidden' }`, and nothing is called. The POST and DELETE are audited with 403.
- `it('answers 400 for a Runtime environment')`: `rt1` answers 400 with `TenantGraphAccess.NotDevelopmentMessage`, and nothing is called.
- `it('answers 503 with the sentence when there is no reach')`: built with `new TenantGraphAccess(undefined, audit)`, all three routes answer 503 with `UnreachableMessage`.
- `it('rejects a bad body with 400 before any call')`: invalid JSON, `{}`, `{"name":""}` and `{"name":"a","description":7}` answer 400. Invalid JSON gives the existing `BadJsonMessage`; the others give `FieldsMessage`. Nothing is called.
- `it('maps service failures to the fixed statuses and sentences')`:
  - `GraphExistsError` gives 409 `ExistsMessage`;
  - `GraphNotFoundError` gives 404 `NotFoundMessage`;
  - `GraphNameInvalidError` gives 400 `NameInvalidMessage`;
  - `new AdminProxyError(Connect)` gives 503 `ConnectMessage`;
  - `new Error('secret host 10.0.0.1')` gives 500 `FailedMessage`, and the body does not contain `10.0.0.1`.
  - The failed POST and DELETE are audited with their status.
- `it('a malformed or encoded graph segment never reaches another route')` (Review Focus 4):
  - `DELETE .../graphs/%E0%A4%A` answers 404, and nothing is called;
  - `DELETE .../graphs/a%2Fb` calls `Delete('dev1','a/b')` (the service decides) and never matches another route;
  - `DELETE .../graphs/a/b` answers 404.
- `it('other method and path shapes answer 404')`: `PUT .../graphs`, `GET .../graphs/sales` and `POST .../graphs/sales` answer 404.
- `it('a failing audit write never changes the answer')`: with the audit's `Append` mocked to reject, POST still answers 201.
- `it('an endpoint without graph access answers 404 on the graph paths')`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd admin/control-plane && npx tsx --test tests/tenant-api-graphs.test.ts`
Expected: FAIL. `tenant-graph-access.js` is missing.

- [ ] **Step 3: Implement `TenantGraphAccess` and `TenantApiEndpoint.RouteGraphs`**

Use the pattern `^/tenant-api/environments/([^/]+)/graphs(?:/([^/]+))?$`, built from the existing `Prefix` and `EnvironmentsSegment` plus a new `GraphsSegment = 'graphs'`.

In `Handle`, test it before `AdminPathPattern` and only when `this.graphs !== undefined`. Its method is `private async RouteGraphs(req, res, method, m, path, session, graphs): Promise<boolean>`. The order is fixed:
1. Check ownership with `OwnedEnv` (404). No audit.
2. Resolve the shape: GET or POST without a graph, DELETE with one, anything else 404. Decode the graph segment with `Decode`; a malformed segment is 404 without an audit.
3. Check the capability with `RequireCapability(res, session, EnvsCapability)` (403).
4. Check for a Development environment (`rec.type === EnvType.Development`), else 400.
5. Check reach: `graphs.Service === undefined` is 503.
6. POST only: read the body with `ReadObject`; validate it (400).
7. Call the service. Write success as 200 / 201 / 204 and failure with `StatusOf` / `MessageOf`.

Every POST or DELETE that passed steps 1-2 is recorded once, with its final status, through `graphs.Record`, awaited after the answer is written. For a POST whose body has no usable name, use `''` as the graph in the note. Log an unexpected 500 by error name only.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command, then the full control-plane gate and `npm run typecheck:tools`.
Expected: PASS. The existing tenant-api tests are unchanged.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/tenant-api/tenant-graph-access.ts admin/control-plane/tenant-api/tenant-api-endpoint.ts admin/control-plane/tests/tenant-api-graphs.test.ts
git commit -m "feat(tenant-api): list, create and delete graphs of a tenant's Development environments, envs-gated and audited"
```

---

### Task 4: Wire the graph routes into both compositions

**Files:**
- Modify: `admin/control-plane/server.ts` (`ComposeTenantPlane` around line 369; `BuildTenantPlane` at lines 405-444; the main composition around lines 237-287)
- Modify: `admin/control-plane/tenant-admin-server.ts` (`Compose` at lines 272-319; the `TenantAdminComposition` type)
- Test: `admin/control-plane/tests/tenant-plane-compose.test.ts`, `admin/control-plane/tests/tenant-admin-server.test.ts`

**Interfaces:**
- Consumes: Task 3's `TenantGraphAccess`.
- Produces:
  - `ControlPlaneServer.TenantGraphAuditFile = 'tenant-graph-audit.json'` (public static readonly).
  - `ComposeTenantPlane(...)` and `BuildTenantPlane(...)` each gain a last optional parameter, `graphs?: TenantGraphAccess`. `BuildTenantPlane` passes it as `TenantApiEndpoint`'s new last argument.
  - `TenantAdminComposition` gains `readonly graphAudit: AuditRegistry`.

- [ ] **Step 1: Write the failing tests**

In `tenant-plane-compose.test.ts`:
- `it('BuildTenantPlane with graph access routes the graph paths; without it they stay 404')`: call `plane.api.Handle` for GET `/tenant-api/environments/dev1/graphs`, with a stub service that owns `dev1` (Development) and a fake `IGraphService`. With access it answers 200; without access it answers 404.

In `tenant-admin-server.test.ts` (a composition with no service account, so reach is undefined), seed `registry.json` in the data root with a Development `dev1` owned by the seed tenant, then:
- `it('a console outside a pod answers 503 on the graph routes and audits to tenant-graph-audit.json')`:
  - GET answers 503 with `TenantGraphAccess.UnreachableMessage`;
  - a POST answers 503;
  - `join(dataRoot, 'tenant-graph-audit.json')` then holds one entry with `status 503`;
  - `composition.graphAudit` is that registry.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd admin/control-plane && npx tsx --test tests/tenant-plane-compose.test.ts tests/tenant-admin-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the wiring**

`server.ts`:
1. Create `const graphAudit = new AuditRegistry(join(dataRoot, ControlPlaneServer.TenantGraphAuditFile))` and add it to the `Promise.all` of loads.
2. Pass `new TenantGraphAccess(graphService, graphAudit)` through `ComposeTenantPlane` to `BuildTenantPlane`.
3. Update `tenant-login-e2e-smoke.ts` only if it no longer typechecks; the parameter is optional.

`tenant-admin-server.ts`:
1. Hoist `const proxy = new AdminProxy(new WsAdminConnector())` and use it in the `EnvironmentService` constructor.
2. Load `graphAudit` the same way.
3. Build `new TenantGraphAccess(reach === undefined ? undefined : new GraphService(registry, proxy, service), graphAudit)` and pass it to `BuildTenantPlane`.
4. Return `graphAudit` in the composition.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command, then the full control-plane gate and `npm run typecheck:tools`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/server.ts admin/control-plane/tenant-admin-server.ts admin/control-plane/tests/tenant-plane-compose.test.ts admin/control-plane/tests/tenant-admin-server.test.ts
git commit -m "feat(tenant-plane): serve the graph routes on the platform's tenant plane and the in-hive console"
```

---

### Task 5: Graphs tab in the tenant portal

**Files:**
- Create: `admin/tenant-portal/src/sections/environments/graphs-tab-view-model.ts` (`GraphRowViewModel` and `GraphsTabViewModel`)
- Create: `admin/tenant-portal/src/sections/environments/create-graph-dialog-view-model.ts`
- Modify:
  - `admin/tenant-portal/src/tenant-types.ts`
  - `admin/tenant-portal/src/tenant-api-client.ts` (CRLF; `EnvironmentsRoute` at line 71)
  - `admin/tenant-portal/src/shell/tests/tenant-test-fixtures.ts` (`FakeTenantApi`)
  - `admin/tenant-portal/src/sections/environments/environment-detail-page-view-model.ts` (tabs enum at lines 18-22, constructor, `SelectTab`, `Apply`)
  - `admin/tenant-portal/src/sections/environments/environments.resources.mu` (imports; the detail template around line 154; tab panels around lines 220-305; new templates), plus its regenerated `environments.resources.mu.js`
- Test: `admin/tenant-portal/src/sections/environments/tests/graphs-tab.test.ts` (new)

**Interfaces:**
- Consumes: Task 3's routes and sentences (the client shows the server's `error` text).
- Produces:
  - In `tenant-types.ts`:
    - `export type GraphDto = { name: string; description: string; createdAt: string; packageCount: number }`
    - `export type CreateGraphParams = { name: string; description: string }`
  - In `TenantApiClient`:
    - `ListGraphs(environment: string): Promise<GraphDto[]>`
    - `CreateGraph(environment: string, params: CreateGraphParams): Promise<GraphDto>`
    - `DeleteGraph(environment: string, graph: string): Promise<void>`
    - Paths: `EnvironmentsRoute + '/' + encodeURIComponent(env) + '/graphs'` and `.../graphs/` + `encodeURIComponent(graph)`.
  - `FakeTenantApi` gains `Graphs = new Map<string, GraphDto[]>()` and the same three methods. They record calls through its existing `Enter` / `FailOn` mechanism. `CreateGraph` appends the graph with `packageCount: 0`, and `DeleteGraph` removes it.
  - `GraphRowViewModel extends Observable`:
    - constructor `(dto: GraphDto, deleteCommand: RelayCommand)`;
    - getters `Name`, `Description`, `PackagesText` (`'1 package'` / `'N packages'`), `CreatedText` (`UtcText.DateTime`) and `DeleteCommand`.
  - `GraphsTabViewModel extends EnvironmentScopedPageViewModel` (from `../users-access/environment-scoped-page-view-model.js`):
    - constructor `(session: TenantSessionService, section: EnvironmentsSectionService)`;
    - `Rows: ObservableCollection<GraphRowViewModel>`;
    - `NewGraphCommand: RelayCommand`;
    - `PageCapability` is `AdminCapability.Environments`;
    - `LoadFor(environment)` lists the graphs and returns `rows.Count > 0`.
  - `CreateGraphDialogViewModel extends TenantDialogViewModel<GraphDto>`:
    - constructor `(session, dialogs, environment: string, existingNames: readonly string[])`;
    - `Name`, `Description` and `NameErrorText` (Name raises `NameErrorText`);
    - `public static readonly Title = 'New graph'`, `FormatMessage = 'Use lowercase letters, digits and hyphens, starting with a letter or digit.'`, `DuplicateMessage = 'A graph with this name exists in this environment.'` and `FailureMessage = 'Could not create the graph. Please try again.'`;
    - `NamePattern = /^[a-z0-9][a-z0-9-]*$/`, which mirrors the server's `DevGraphService.GraphNamePattern`.
  - `EnvironmentDetailTab` gains `Graphs` (last, so it is index 3). The detail page gains `GraphsTabLabel = 'Graphs'`, `GraphsTab: GraphsTabViewModel` and `IsGraphsTab: boolean`.

- [ ] **Step 1: Write the failing tests**

`graphs-tab.test.ts`, on `SectionsFixture` and `FakeTenantApi` (as `environments-section.test.ts` does):
- `it('shows a Graphs tab only for a Development environment')`: a Development environment's `TabLabels` ends with `'Graphs'`, and `GraphsTab.Environment` is its name. A Runtime environment's labels are the three existing ones. Selecting `'Graphs'` gives `IsGraphsTab === true`.
- `it('lists the graphs with packages and created time, and is Empty without any')`: rows show `PackagesText` `'1 package'` and `'3 packages'`, and `CreatedText` equals `UtcText.DateTime(createdAt)`. No graphs gives `IsEmpty`.
- `it("shows the route's sentence when graphs cannot be listed")`: with `FailOn.set('ListGraphs', new TenantApiError(503, 'This console cannot reach its environments, so graphs are unavailable here.'))`, the tab is `IsError` and `ErrorText` is exactly that sentence.
- `it('creates a graph: the name rule, a 409 as the duplicate message, then the list reloads')`:
  - `'Bad'` gives `FormatMessage` and Create disabled;
  - an existing name gives `DuplicateMessage`;
  - a server 409 shows `DuplicateMessage` and the dialog stays open;
  - a success calls `CreateGraph('dev1', { name, description })` and the tab reloads, showing the new row.
- `it('deletes a graph only after the confirm, then reloads')`: a cancelled confirm calls nothing. A confirmed one calls `DeleteGraph('dev1','sales')` and the row is gone. The confirm's title names the graph: `'Delete graph sales?'`.
- `it('disables New graph and Delete without the Environments permission')`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix admin/tenant-portal test`
Expected: FAIL on the new file.

- [ ] **Step 3: Implement the client, types, fake, view models and `.mu`**

Graphs tab:
- **New graph:** `OpenCreate(section.Dialogs, d => new CreateGraphDialogViewModel(...), CreateGraphDialogViewModel.Title, () => this.Refresh())`.
- **Delete:** `Confirm(section.Dialogs, {...})`, with:
  - `Capability: AdminCapability.Environments`;
  - `Title: 'Delete graph {graph}?'`;
  - `Message: 'Deleting {graph} removes it from {environment}, with every package contributed to it.'`;
  - `Consequences: ['Plexus can no longer contribute to it.', 'This cannot be undone.']`;
  - `ConfirmLabel: 'Delete graph'`;
  - `Action: () => client.DeleteGraph(env, graph)`;
  - `OnConfirmed: () => this.Refresh()`.
- Rows use `RowMutatingCommand(AdminCapability.Environments, ...)`, and `ClearRowCommands()` runs before each rebuild (as `TokensTabViewModel` does).

Dialog errors (`SubmitCore`, as in `CreateEnvironmentDialogViewModel`): a 401 passes through, a 409 gives `DuplicateMessage`, any other `TenantApiError` gives its message, and no answer gives `FailureMessage`.

Detail page:
- In `Apply`, when `dto.type === EnvType.Development`, ensure the `'Graphs'` label is present and call `void this.graphsTab.UseEnvironment(this.name)`.
- Otherwise remove the label, and select Application if Graphs was selected.
- `SelectTab` also raises `IsGraphsTab`.

`.mu`:
- Under the Access panel: `ContentControl [ Content = $GraphsTab, Visibility = $IsGraphsTab << ToVisibility ]`.
- A `DataTemplate [ DataType = GraphsTabViewModel ]` modelled on the `TokensTabViewModel` template:
  - a caption `"Graphs hold what Plexus contributes to this environment."`;
  - Loading, Empty (`"No graphs in this environment yet."`), Error (`"Could not load the graphs."` plus `$ErrorText`) and Denied states;
  - a `"New graph"` button;
  - a table with Name, Description, Packages, Created and a Delete button per row, set as the ListBox's `ItemTemplate` (rows are Observables), keyed `GraphRowTemplate`.
- A `DataTemplate [ DataType = CreateGraphDialogViewModel ]` with:
  - Name (`TextBox`, placeholder `"e.g. sales"`), then the rule `"Lowercase letters, digits and hyphens, starting with a letter or digit."` and `$NameErrorText`;
  - Description (`TextBox`);
  - `$ErrorText`;
  - Cancel / `"Create graph"`.
- Add the three imports at the top. Do not set explicit Width or Height. Then run `npm --prefix admin/tenant-portal run compile:mu`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix admin/tenant-portal run typecheck && npm --prefix admin/tenant-portal test`, then `npm run typecheck:tools`.
Expected: PASS. The existing environments-section tests stay green: the three tabs are unchanged for Runtime.

- [ ] **Step 5: Commit**

```bash
git add admin/tenant-portal/src/tenant-types.ts admin/tenant-portal/src/tenant-api-client.ts admin/tenant-portal/src/shell/tests/tenant-test-fixtures.ts admin/tenant-portal/src/sections/environments/graphs-tab-view-model.ts admin/tenant-portal/src/sections/environments/create-graph-dialog-view-model.ts admin/tenant-portal/src/sections/environments/environment-detail-page-view-model.ts admin/tenant-portal/src/sections/environments/environments.resources.mu admin/tenant-portal/src/sections/environments/environments.resources.mu.js admin/tenant-portal/src/sections/environments/tests/graphs-tab.test.ts
git commit -m "feat(tenant-portal): Graphs tab on Development environments - list, New graph, Delete"
```

---

### Task 6: ConsoleRegistration and refusal-aware advert sends

**Files:**
- Create: `admin/control-plane/console-registration.ts`
- Modify: `admin/control-plane/console-advert-sender.ts` (`HttpConsoleAdvertTransport.Send` at lines 114-138; `ConsoleAdvertSender` constructor at lines 238-243, `Start` at line 233, `SendNow`, `Drain`, `SendOnce` at lines 330-352)
- Test: `admin/control-plane/tests/console-registration.test.ts` (new), `admin/control-plane/tests/console-advert-sender.test.ts`

**Interfaces:**
- Produces, in `console-registration.ts`:
  - `export enum ConsoleRegistrationState { Registered = 'registered', Refused = 'refused' }`
  - `export enum AdvertOutcome { Accepted, Refused, Transient }`
  - `export enum AdvertTrigger { Start, Timer, Change }`
  - `export class ConsoleRegistration`, with:
    - `public static readonly FileName = 'console-registration.json'`
    - `public static readonly RefusalThreshold = 2`
    - `public static readonly RefusedError = 'console-not-registered'`
    - `public static readonly RefusedMessage = 'This console is no longer registered with the platform. Ask your administrator.'`
    - `public static readonly RefusedBody: Readonly<{ error: string; message: string }>`: `{ error: RefusedError, message: RefusedMessage }`
    - `public readonly Changed = new Signal<ConsoleRegistrationState>()`: emits only when the state actually changes.
    - `public static async Open(path: string): Promise<ConsoleRegistration>`: a missing, empty, unreadable or malformed file opens Registered.
    - `public get State(): ConsoleRegistrationState` and `public get IsRefused(): boolean`
    - `public async Observe(outcome: AdvertOutcome, trigger: AdvertTrigger): Promise<void>`: never rejects.
  - The persisted shape is `{ "state": "registered" | "refused" }`, written with `AtomicJsonFile.Write` through a `SerialRuns`. A failed write leaves the in-memory state and is retried on the next change.
- Produces, in `console-advert-sender.ts`:
  - `export class ConsoleAdvertRefusedError extends ConsoleAdvertUnavailableError { public readonly Status: number }`. It keeps the existing message (`'The platform agent channel answered HTTP ' + status`), so the existing log line and tests hold.
  - `ConsoleAdvertSender`'s constructor gains a last optional parameter, `registration?: ConsoleRegistration`.
  - `public SendNow(trigger: AdvertTrigger = AdvertTrigger.Change): Promise<void>`

**Rules (rulings on the spec):**
- `Observe` applies the outcome by trigger:
  - **Accepted**, any trigger: Registered, streak = 0.
  - **Refused**, Timer trigger: streak + 1. At 2 the state becomes Refused.
  - **Transient**, Timer trigger: streak = 0, and the state is unchanged.
  - Start or Change trigger, Refused or Transient outcome: nothing changes.
- The streak is not persisted: a restarted console starts its count at 0 but keeps its state.
- **The transport:** 401 and 409 throw `ConsoleAdvertRefusedError`. Every other non-2xx throws `ConsoleAdvertUnavailableError` as today.
- **The sender:**
  - `Start` sends with `AdvertTrigger.Start`, the timer with `AdvertTrigger.Timer`, and `accounts.Changed` / `domains.Changed` with `AdvertTrigger.Change`.
  - A queued send counts as Timer if any request merged into it was Timer.
  - `SendOnce(trigger)` observes Accepted, Refused (`ConsoleAdvertRefusedError`) or Transient (any other failure), unless the sender is stopped.

- [ ] **Step 1: Write the failing tests**

`console-registration.test.ts` (temp dir):
- `it('opens Registered with no file, an empty file or a malformed one')` (Review Focus 3).
- `it('two consecutive timer refusals make it Refused, signalled once and persisted')`: after one refusal it is still Registered. After the second, `State === Refused`, `Changed` has emitted `[Refused]`, and a reopened instance is Refused.
- `it('a transient timer answer between two timer refusals resets the streak')`: Refused, Transient, Refused (all Timer) leaves it Registered (Review Focus 2).
- `it('Start and Change refusals neither count nor break a streak')`:
  - Refused(Timer), Refused(Change), Refused(Timer) gives Refused;
  - Refused(Change) x3 leaves it Registered;
  - Refused(Start) x3 leaves it Registered.
- `it('any accepted answer restores Registered, signalled and persisted')`: from Refused, Accepted(Change) gives Registered, `Changed` emits `Registered`, and a reopened instance is Registered.
- `it('RefusedBody is the fixed body')`: deep-equal `{ error: 'console-not-registered', message: 'This console is no longer registered with the platform. Ask your administrator.' }`.

`console-advert-sender.test.ts`:
- `it('401 and 409 are refusals; 400 and 500 are not')` (HttpConsoleAdvertTransport, against the existing local server): 401 and 409 reject `instanceof ConsoleAdvertRefusedError` with `Status`. 400 and 500 reject as `ConsoleAdvertUnavailableError` and not as `ConsoleAdvertRefusedError`.
- `it('two refused timer ticks make the registration Refused; refused change sends do not')`: `RecordingTransport.failWith = new ConsoleAdvertRefusedError(...)`, plus a real `ConsoleRegistration`. Start, then two `domains` changes, leave it Registered. Then `timer.Tick()` twice (awaiting `Idle()`) gives Refused.
- `it('a 200 from any send restores Registered')`.
- `it('a timer tick queued behind a change send counts as a timer send')`: hold the transport, change, tick, tick, release. The two queued requests merge into one Timer send, so the streak after release is 1, not 0.
- `it('no outcome is observed after Stop')`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd admin/control-plane && npx tsx --test tests/console-registration.test.ts tests/console-advert-sender.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `ConsoleRegistration`, the refused error, and the triggered sender**

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command, then the full control-plane gate and `npm run typecheck:tools`.
Expected: PASS. The existing sender tests are unchanged, because `SendNow()` defaults to Change.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/console-registration.ts admin/control-plane/console-advert-sender.ts admin/control-plane/tests/console-registration.test.ts admin/control-plane/tests/console-advert-sender.test.ts
git commit -m "feat(console): ConsoleRegistration - two refused timer adverts mark the console Refused, any 200 restores it"
```

---

### Task 7: The refused-console gate on the desktop surface and the relay

**Files:**
- Modify:
  - `admin/control-plane/tenant-plane-host.ts` (non-ASCII; constructor, `Handle` at lines 173-189, `RouteDesktop` at line 213, `RouteUpgrade` at lines 266-283, `Close`)
  - `admin/control-plane/tenant-auth/desktop-relay.ts` (`RelayPipe` constants around line 581; `DesktopRelay.WriteRefusal` around line 514; a new `CloseAll`)
  - `admin/control-plane/tenant-auth/desktop-endpoint.ts` (`ConsolePath` at line 56 becomes public)
  - `admin/control-plane/tenant-admin-server.ts` (`Compose`, `AdvertSenderOf` at line 187, `TenantAdminComposition`)
- Test: `admin/control-plane/tests/tenant-plane-host.test.ts`, `admin/control-plane/tests/desktop-relay.test.ts`, `admin/control-plane/tests/tenant-admin-server.test.ts`

**Interfaces:**
- Consumes: Task 6's `ConsoleRegistration`, `ConsoleRegistrationState` and `RefusedBody`.
- Produces:
  - `RelayPipe.ConsoleRetired = 4003` (public static readonly).
  - `DesktopRelay.CloseAll(code: number): number`: closes every open pipe with `code` and returns how many.
  - `DesktopRelay.WriteRefusal(socket: Duplex, status: number, body?: object): void` becomes `public static`. The default body is today's `{ error: Messages.get(status) }`.
  - `DesktopEndpoint.ConsolePath` becomes `public static readonly`.
  - `TenantPlaneHost`'s constructor gains a last optional parameter, `registration?: ConsoleRegistration`. When it is absent (the platform's tenant plane), the host never refuses.
  - `TenantAdminServer.AdvertSenderOf(...)` gains a last optional parameter, `registration?: ConsoleRegistration`, passed to the sender.
  - `TenantAdminComposition` gains `readonly registration: ConsoleRegistration`.

**Behaviour:**
- **`RouteDesktop`:** while `registration?.IsRefused` and `path !== DesktopEndpoint.ConsolePath`, `req.resume()` and answer 503 with `ConsoleRegistration.RefusedBody`.
- **`RouteUpgrade` relay branch:** while refused, `DesktopRelay.WriteRefusal(socket, 503, ConsoleRegistration.RefusedBody)` before the relay is consulted. This refusal is not audited (it happens before the relay).
- **On a change:** the host subscribes to `registration.Changed` in its constructor. On `Refused` it calls `this.relay?.CloseAll(RelayPipe.ConsoleRetired)`. It disposes the subscription in `Close`.
- **Sessions:** no session store is touched.

- [ ] **Step 1: Write the failing tests**

`tenant-plane-host.test.ts` (on `DesktopHostKit`): give `WithHost` a `registration?` argument, and give `StubRelay` a `public readonly closedWith: number[]` and a `CloseAll(code)` that records the code. Tests:
- `it('a refused console answers 503 console-not-registered on /desktop/* but still answers /desktop/console')`:
  - `GET /desktop/targets` answers 503, with a JSON body deep-equal to `RefusedBody`;
  - a sign-in begin path answers 503;
  - with a console plane (`consoleTenantId` set), `GET /desktop/console` answers 200.
- `it('a refused console refuses the relay upgrade with 503 and the body; the relay is never asked')`: the raw upgrade response starts with `HTTP/1.1 503`, its body equals `RefusedBody`, and `StubRelay.urls` is empty.
- `it('becoming Refused closes the open relays with 4003')`: after two refused timer observations, `closedWith` deep-equals `[4003]`. A later Accepted closes nothing more.
- `it('sessions survive a refusal: Registered again, the same bearer works')` (Review Focus 5): issue a Desktop session through `Store.Issue(..., TenantSessionKind.Desktop)`.
  - While Refused, `/desktop/targets` with the bearer answers 503.
  - After `Observe(Accepted, Change)`, the same bearer answers 200, and a relay upgrade reaches the stub (418).
- `it('without a registration the host never refuses')`.

`desktop-relay.test.ts`:
- `it('CloseAll closes every open relay with the given code and releases each lease once')`: use the same harness as the `CloseSession` test. The client sees close code 4003, and the count returned is 1.

`tenant-admin-server.test.ts`:
- `it('Compose opens the console registration from the data root and passes it to the host')`: write `{"state":"refused"}` to `console-registration.json` in the data root before `Compose`. Then `composition.registration.IsRefused === true`, and `GET /desktop/targets` on the listening host answers 503.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd admin/control-plane && npx tsx --test tests/tenant-plane-host.test.ts tests/desktop-relay.test.ts tests/tenant-admin-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the gate, `CloseAll`, the public refusal writer and the console wiring**

In `Compose`:
1. `const registration = await ConsoleRegistration.Open(join(dataRoot, ConsoleRegistration.FileName))`.
2. Pass it to `new TenantPlaneHost(..., monitor, registration)` and to `AdvertSenderOf(..., follower, registration)`.
3. Return it in the composition.

`server.ts` (platform) passes no registration.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the Step 2 command, then the full control-plane gate and `npm run typecheck:tools`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/tenant-plane-host.ts admin/control-plane/tenant-auth/desktop-relay.ts admin/control-plane/tenant-auth/desktop-endpoint.ts admin/control-plane/tenant-admin-server.ts admin/control-plane/tests/tenant-plane-host.test.ts admin/control-plane/tests/desktop-relay.test.ts admin/control-plane/tests/tenant-admin-server.test.ts
git commit -m "feat(console): a refused console answers 503 on /desktop/* and the relay, and closes open relays with 4003"
```

---

### Task 8: AtomicJsonFile options, and the writers that only move onto it

**Files:**
- Modify:
  - `admin/control-plane/atomic-json-file.ts`
  - `admin/control-plane/json-record-store.ts` (`WriteText` at lines 131-146)
  - `admin/control-plane/console-email-domain-store.ts` (`Write` at lines 124-138)
  - `admin/control-plane/sealed-secret-store.ts` (`Enqueue` and `Persist` at lines 172-197)
  - `admin/control-plane/signature-store.ts` (`persist` at lines 159-169)
  - `admin/control-plane/migrate-environment-id.ts` (lines 54-58)
- Test: `admin/control-plane/tests/atomic-json-file.test.ts`

**Interfaces:**
- Produces:
  - `export type AtomicWriteOptions = { readonly mode?: number; readonly fsync?: boolean }`
  - `AtomicJsonFile.Write(path: string, value: unknown, indent?: number, options?: AtomicWriteOptions): Promise<void>`: existing callers are unchanged.
  - `AtomicJsonFile.WriteText(path: string, text: string, options?: AtomicWriteOptions): Promise<void>`. `Write` serialises the value, then delegates to it.
- `WriteText` writes in this order:
  1. mkdir the parent;
  2. open `<path>.<uuid>.tmp` with `open(temp, 'w', mode)` (mode omitted means the platform default);
  3. write the UTF-8 text;
  4. `handle.sync()` only when `fsync`;
  5. close;
  6. rename over `path`.
- Any failure after the temp file was opened unlinks it and rethrows.

- [ ] **Step 1: Write the failing tests**

In `atomic-json-file.test.ts`:
- `it('WriteText writes the text as given')`.
- `it('fsync: true syncs the temp file before the rename; omitted, it does not')`: get the `FileHandle` prototype from a throwaway `open()` and `mock.method(proto, 'sync')`. `fsync: true` calls it once; no options calls it 0 times. Both leave no temp file.
- `it('mode sets the file mode', { skip: process.platform === 'win32' })`: `{ mode: 0o600 }` gives `statSync(path).mode & 0o777 === 0o600`.
- `it('a failed write after open removes its temp file')`: mock the handle prototype's `writeFile` to reject. The call rejects and the directory holds no `.tmp`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd admin/control-plane && npx tsx --test tests/atomic-json-file.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the options, then move the five writers**

- `JsonRecordStore.WriteText(text)` stays the protected, overridable hook (tests override it), and its body becomes `AtomicJsonFile.WriteText(this.filePath, text)`. Its batching chain is kept.
- `ConsoleEmailDomainStore.Write` becomes `AtomicJsonFile.Write(this.filePath, { domains }, JsonIndent)`. Its `writes` chain is kept.
- `SealedSecretStore`:
  - `Persist` becomes `AtomicJsonFile.Write(this.filePath, body, JsonIndent, { mode: SealedSecretStore.FileMode, fsync: true })`;
  - `Enqueue` and `chain` are replaced by a `private readonly writes = new SerialRuns()`.
- `FileSignatureStore.persist` becomes `AtomicJsonFile.Write(...)`. Its per-file static queue is kept.
- `EnvironmentIdMigrator` becomes `AtomicJsonFile.Write(path, parsed, JsonIndent)`.
- Remove the now-unused imports and constants (`randomUUID`, `TempSuffix`, `mkdir`, `rename`, `unlink`, `writeFile`) from each file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the full control-plane gate, then `npm run typecheck:tools`.
Expected: PASS. In particular, `sealed-secret-store`, `signature-store`, `console-email-domain-store`, `migrate-environment-id`, `audit-batching` and the `held-audit` users stay green.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/atomic-json-file.ts admin/control-plane/json-record-store.ts admin/control-plane/console-email-domain-store.ts admin/control-plane/sealed-secret-store.ts admin/control-plane/signature-store.ts admin/control-plane/migrate-environment-id.ts admin/control-plane/tests/atomic-json-file.test.ts
git commit -m "refactor(control-plane): AtomicJsonFile gains mode and fsync; record, domain, sealed, signature and migrator writers use it"
```

---

### Task 9: Serialise the registries and the session store's migration write

**Files:**
- Modify:
  - `admin/control-plane/environment-registry.ts` (`persist` at lines 84-91)
  - `admin/control-plane/idp-registry.ts` (`persist` at lines 66-73)
  - `admin/control-plane/tenant-auth/tenant-session.ts` (CRLF; `Mutate` at line 276; `ensureLoaded` at line 366; `load`'s migration write at line 422; `write` at lines 431-448)
- Test: `admin/control-plane/tests/environment-registry.test.ts`, `admin/control-plane/tests/idp-registry.test.ts`, `admin/control-plane/tests/tenant-session.test.ts` (CRLF)

**Interfaces:**
- Consumes: Task 8's `AtomicJsonFile.Write(path, value, indent, options)` and `SerialRuns`.
- Produces:
  - `EnvironmentRegistry` and `IdpRegistry` each gain `private readonly writes = new SerialRuns()` and `protected WriteFile(body: object): Promise<void>`, which defaults to `AtomicJsonFile.Write(this.filePath, body, JsonIndent)`. It is overridable so tests can hold a write.
  - `persist()` becomes `this.writes.Run(() => this.WriteFile(this.Body()))`. The body is snapshotted when the run starts, so a later write always carries every earlier change.
  - `TenantSessionStore`:
    - `write` becomes `AtomicJsonFile.Write(this.filePath, body, JsonIndent, { mode: TenantSessionStore.FileMode })`;
    - `mutationChain` becomes `private readonly mutations = new SerialRuns()`;
    - a read's first load runs on that chain (`this.mutations.Run(() => this.load())`), so the legacy-migration write inside `load` is always serialised and awaited;
    - `Mutate`'s run loads in place (it is already on the chain), so it never waits on itself.

- [ ] **Step 1: Write the failing tests**

- `environment-registry.test.ts`, `test('concurrent Puts are written one at a time and the file ends with every record')`: a subclass overrides `WriteFile` to hold its first call until released. Start `Put(a)` and `Put(b)` without awaiting. Assert that only one `WriteFile` has started. Release it, and await both. A reopened registry lists `a` and `b`, and `WriteFile` ran twice, in order.
- `idp-registry.test.ts`, `test('concurrent Put and Delete are serialised and the file ends in the last state')`: the same shape. Put x, then Put y and Delete x concurrently; reopened, it lists only y.
- `tenant-session.test.ts`, `test('a legacy file migrated while an Issue runs keeps both the migrated session and the new one')`:
  - Write the legacy raw-token file, as in the existing migration test.
  - Start `store.Validate('raw-token-...')` and `store.Issue(Tenant, 'p2')` together.
  - Await both. The file is in `sha256` format and holds no raw token.
  - A reopened store validates both the raw token and the issued one.
  - The existing 'migrates a raw-token file on load' test stays green unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd admin/control-plane && npx tsx --test tests/environment-registry.test.ts tests/idp-registry.test.ts tests/tenant-session.test.ts`
Expected: FAIL. The registries start both writes at once, and the session race can lose the issued session.

- [ ] **Step 3: Implement the three changes**

Keep CRLF in `tenant-session.ts` and its test. Remove the now-unused fs and crypto imports and the `TempSuffix` constants.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the full control-plane gate, `npm run typecheck:tools`, `npm test`, and `npm --prefix admin/tenant-portal run typecheck && npm --prefix admin/tenant-portal test`. This is the last task, so run every gate.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/environment-registry.ts admin/control-plane/idp-registry.ts admin/control-plane/tenant-auth/tenant-session.ts admin/control-plane/tests/environment-registry.test.ts admin/control-plane/tests/idp-registry.test.ts admin/control-plane/tests/tenant-session.test.ts
git commit -m "fix(control-plane): serialise EnvironmentRegistry and IdpRegistry writes; the session store's legacy migration runs on its mutation chain"
```
