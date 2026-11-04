# In-hive Console Advert, Discovery and Email Domains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The in-hive tenant console reports its public address, its account-email fingerprints and its email domains to the control plane over the agent channel; the control plane stores the latest report per tenant, shows "reported" in the portal, lets tenants declare email domains (operator for control-plane tenants, Owner in either console), and desktop discovery answers each email with every matching tenant and that tenant's console address.

**Architecture:** Three shared pieces (`EmailDomainPolicy`, `ConsoleFingerprint` + the advert body contract, `HiveConsoleSpecs.ConsoleHiveOf`) are used by both processes built from `admin/control-plane`. Control plane: a `ConsoleAdvertRegistry` (JsonRecordStore keyed by tenant) fed by a `ConsoleAdvertReceiver` behind a new agent-channel route; a `DesktopTenantMatcher` unions fingerprint, domain and `TenantAccountIndex` matches for `DesktopDiscoveryEndpoint`; a `PlatformEmailDomains` service backs the operator routes and the control-plane tenant plane. Console: a `ConsoleEmailDomainStore` (data-root file, `Changed` signal) and a `ConsoleAdvertSender` (start, every 5 minutes, and on every account or domain change) composed by `TenantAdminServer`. Portals: an email-domain block on the platform admin tenant page, the "reported" state on the hive console panel, and an Email domains tab in the tenant console settings.

**Tech Stack:** TypeScript (node >= 22.5, ESM), node:crypto (HMAC-SHA256), node:http/fetch, `Signal` from `@pragmatic-tech-ai/todl-runtime`, node:test via tsx, Mural `.mu` + TS view models (admin/portal, admin/tenant-portal), Playwright (smoke only).

**Spec:** docs/superpowers/specs/2026-11-04-in-hive-desktop-sign-in-design.md (this is Plan 2 of 3. Plan 1 = docs/superpowers/plans/2026-11-04-in-hive-console-install-and-env-management.md, executed and merged BEFORE this plan; its Produces blocks are treated as existing code. Plan 3 = desktop API/relay on the console and Plexus.)

## Global Constraints

- OOP only: every function is a method (instance or static) on a class; no module-level functions, no module-level mutable state (module-level `const` only for true compile-time constants, plus type/enum declarations).
- Allman braces for class/interface/enum/method/constructor/getter/setter bodies and all control-flow blocks; `else`/`catch`/`finally` on their own line. Object literals, block-bodied arrows and genuine one-line blocks stay inline.
- PascalCase for every interface and every public method/property; private members and JSON-mirroring data fields (`emailDomains`, `consoleUrl`, `reportedAt`, ...) keep camelCase. `Signal`'s own `subscribe`/`emit` are library names and stay as they are.
- No inline string literals in TS method bodies: user-facing text and reused literals are `private static readonly` PascalCase constants (`.mu` labels stay inline). Fixed value sets are enums, never string unions.
- New view models extend `Observable` (from `@pragmatic-tech-ai/todl-runtime`), never `MuralBase`. No explicit `Width`/`Height` in `.mu`.
- Tests live in `tests/` subfolders (`admin/control-plane/tests/*.test.ts`, `admin/portal/src/sections/**/tests/*.test.ts`, `admin/tenant-portal/src/sections/**/tests/*.test.ts`).
- New files ASCII + LF. Existing files keep their line endings: `admin/control-plane/agent-channel-host.ts` and `admin/tenant-portal/src/tenant-api-client.ts` are CRLF and stay CRLF; every other file this plan touches is LF (check with `git ls-files --eol <path>` before editing).
- Emails, fingerprints, the fingerprint key, the agent token, passwords and session ids are never logged, printed, put in error messages, audit notes or status text. Advert/route error bodies are fixed sentences that never echo submitted values (except a refused email domain, which the submitter typed and which is not secret).
- Layering: nothing under `src/` imports `admin/`; console-side code in `admin/control-plane` never imports `PlatformDirectory`, `ControlPlaneHost` or `server.ts` (types it needs come through `ITenantDirectory` and the files created here).
- Stage by explicit path (`git add <file> <file>`), never `git add -A`/`.`. Another agent edits `admin/control-plane/audit-record.ts`, `admin/control-plane/json-record-store.ts` and `admin/control-plane/tests/audit-batching.test.ts`: never stage, revert or reformat them (this plan only subclasses `JsonRecordStore`, it does not edit it).
- Each commit message ends with `Co-Authored-By: <implementer model name> <noreply@anthropic.com>` naming the model that wrote the change. Merge locally; NEVER push.
- Gates (all green before each commit that touches the area):
  - control plane: `cd admin/control-plane && npx tsx --test tests/*.test.ts`
  - repo root: `npm run typecheck:tools` (control plane, portal, tenant-portal, idp-login), `npm run build:tenant-admin` (the console build), `npm test`
  - platform admin portal: `npm --prefix admin/portal run typecheck` and `npm --prefix admin/portal test`
  - tenant console portal: `npm --prefix admin/tenant-portal run typecheck` and `npm --prefix admin/tenant-portal test`
- Values pinned by this plan: advert route `POST /agent/hives/:hive/console`; advert interval `300000` ms; stale after `86400000` ms (still returned); at most `10000` fingerprints, each `^[0-9a-f]{64}$`; consoleUrl at most `2048` characters; at most `20` email domains per tenant; email-domain request body cap `16384` bytes; control-plane store file `console-adverts.json` (root key `adverts`); console store file `<dataRoot>/email-domains.json`; fingerprint = lowercase hex `HMAC-SHA256(key, TenantAccountIndex.Normalise(email))` with the Plan 1 32-byte key; operator route `/api/tenants/:id/email-domains`; tenant route `/tenant-api/settings/email-domains`; portal re-poll after deployed `15000` ms.

## Review Focus

1. A hive that advertises a console address other than the one the operator configured (misconfiguration or a compromised hive trying to send people elsewhere): the advert is refused with 400 and the previous advert stays untouched (Task 2 test `refuses another host, http, a path, a query, a port or user info and keeps the previous advert`).
2. An email typed with capitals or surrounding spaces in Plexus must still match the fingerprint the console computed from the stored Owner email (Task 1 test `Of is HMAC-SHA256 of the normalised email`, Task 5 test `an advert fingerprint match points at the advertised console` using `'  Ann@Acme.TEST '`).
3. The operator removes the in-hive console (or deletes the hive): discovery must stop sending people to the dead in-hive address and fall back to the control-plane tenant plane (Task 4 tests `removing the console forgets its advert`, `hive delete forgets its advert`; Task 5 test `an advert whose hive no longer runs the console is ignored`).
4. The control plane restarts after the console was installed: the hive page must still show "reported" from the stored advert instead of an empty or 404 status (Task 4 test `after a restart the advert alone answers reported`).
5. The Owner edits email domains while the control plane is unreachable: the edit is saved locally, the Owner sees success, nothing secret is logged, and the next 5-minute tick carries it (Task 7 test `a failed send is logged by name only and retried on the next tick`).

---

## File Structure

Control plane and console (`admin/control-plane/`):
- Create `email-domain-policy.ts` - `InvalidEmailDomainError`, `EmailDomainPolicy` (shared).
- Create `console-advert-contract.ts` - `ConsoleAdvertBody`, `ConsoleAdvertLimits`, `ConsoleFingerprint` (shared).
- Create `console-advert-registry.ts` - `ConsoleAdvertRecord`, `IConsoleAdvertLookup`, `ConsoleAdvertRegistry` (control plane).
- Create `console-advert-receiver.ts` - `InvalidConsoleAdvertError`, `ConsoleNotEnabledError`, `ConsoleAdvertOutcome`, `ConsoleAdvertReceiver` (control plane).
- Create `desktop-tenant-matcher.ts` - `IDiscoveryDirectory`, `IFingerprintKeySource`, `DiscoveryMatch`, `DiscoveredTenant`, `DesktopTenantMatcher` (control plane).
- Create `tenant-api/tenant-email-domains.ts` - `TenantEmailDomainsView`, `ITenantEmailDomains`, `EmailDomainsNotEditableError` (shared seam).
- Create `platform-email-domains.ts` - `EmailDomainSource`, `TenantEmailDomainsReport`, `PlatformEmailDomains` (control plane).
- Create `console-email-domain-store.ts` - `ConsoleEmailDomainStore` (console).
- Create `console-advert-sender.ts` - `IConsoleAccountSource`, `SeededConsoleAccounts`, `IConsoleAdvertTransport`, `ConsoleAdvertUnavailableError`, `HttpConsoleAdvertTransport`, `IAdvertTimer`, `IntervalAdvertTimer`, `ConsoleAdvertSender` (console).
- Modify `platform-records.ts` (`TenantRecord.emailDomains`), `platform-directory.ts` (`SetTenantEmailDomains`), `hive-console-spec.ts` (`ConsoleHiveOf`), `agent-channel-host.ts` (route), `desktop-discovery-endpoint.ts`, `tenant-console-installer.ts` (reported state), `control-plane-host.ts` (forgetting, operator routes), `tenant-api/tenant-api-endpoint.ts` (tenant routes), `server.ts` (wiring, `BuildTenantPlane`/`ComposeTenantPlane` param), `tenant-admin-server.ts` (console composition), `in-hive-console-smoke.ts` (Plan 1 smoke, extended).

Platform admin portal (`admin/portal/src/`):
- Modify `portal-types.ts`, `api-client.ts`, `sections/tenants/tenant-detail-page-view-model.ts`, `sections/tenants/tenants.resources.mu`, `sections/hives/hive-console-view-model.ts`.
- Create `sections/tenants/tenant-email-domains-view-model.ts`, `sections/tenants/tests/tenant-email-domains.test.ts`.

Tenant console portal (`admin/tenant-portal/src/`):
- Modify `tenant-types.ts`, `tenant-api-client.ts` (CRLF), `shell/tests/tenant-test-fixtures.ts`, `sections/settings/settings-page-view-model.ts`, `sections/settings/settings.resources.mu`, `sections/settings/tests/settings-page-view-model.test.ts`.
- Create `sections/settings/email-domains-editor-view-model.ts`, `sections/settings/tests/email-domains-editor.test.ts`.

---

### Task 1: Shared primitives - email-domain policy, fingerprint contract, tenant domains, console hive lookup

**Files:**
- Create: `admin/control-plane/email-domain-policy.ts`, `admin/control-plane/console-advert-contract.ts`
- Modify: `admin/control-plane/platform-records.ts` (`TenantRecord`), `admin/control-plane/platform-directory.ts`, `admin/control-plane/hive-console-spec.ts` (Plan 1)
- Test: `admin/control-plane/tests/email-domain-policy.test.ts`, `tests/console-advert-contract.test.ts`, `tests/platform-directory.test.ts`, `tests/hive-console-spec.test.ts`

**Interfaces:**
- Consumes: `TenantAccountIndex.Normalise` (`tenant-account-index.ts`); `HiveRecord.console?: HiveConsoleSpec`, `HiveConsoleSpecs` (Plan 1 Task 11); `UnknownTenantError` (`platform-directory.ts`).
- Produces:
  ```ts
  // email-domain-policy.ts
  export class InvalidEmailDomainError extends Error   // 400; message is one plain sentence
  export class EmailDomainPolicy
  {
      public static readonly MaxDomains = 20
      /** trim, lowercase, drop one trailing '.' */
      public static Normalise(raw: string): string
      /** undefined when acceptable, else the refusal sentence naming the (normalised) domain. */
      public static Check(domain: string): string | undefined
      /** Array of strings -> normalised, deduped, sorted; throws InvalidEmailDomainError (not a list / > MaxDomains / first refused domain). */
      public static Parse(value: unknown): string[]
      /** Splits already-string values into accepted (normalised, deduped, sorted) and refused (normalised, in input order). */
      public static Filter(values: readonly string[]): { accepted: string[]; refused: string[] }
      /** Normalised part after the last '@'; undefined when there is no '@' or nothing after it. */
      public static DomainOf(email: string): string | undefined
  }
  // console-advert-contract.ts
  export type ConsoleAdvertBody = { consoleUrl: string; fingerprints: string[]; emailDomains: string[] }
  export class ConsoleAdvertLimits
  {
      public static readonly MaxFingerprints = 10000
      public static readonly MaxUrlLength = 2048
      public static readonly FingerprintPattern = /^[0-9a-f]{64}$/
      public static readonly KeyBytes = 32
  }
  export class ConsoleFingerprint
  {
      /** Lowercase hex HMAC-SHA256(key, TenantAccountIndex.Normalise(email)). */
      public static Of(key: Buffer, email: string): string
      /** The key file's bytes when it holds exactly 32; otherwise (missing, unreadable, wrong length) undefined. */
      public static ReadKeyFile(path: string): Buffer | undefined
  }
  // platform-records.ts, TenantRecord gains:
  /** Declared email domains (lowercase, EmailDomainPolicy-valid). Used for control-plane tenants only; an in-hive tenant's domains come from its console advert. */
  emailDomains?: string[]
  // platform-directory.ts
  /** Parse via EmailDomainPolicy; an empty list removes the field. UnknownTenantError for an unknown id. */
  public async SetTenantEmailDomains(tenantId: string, domains: unknown): Promise<TenantRecord>
  // hive-console-spec.ts (HiveConsoleSpecs)
  /** The hive (of one tenant's hives) that runs the in-hive console, if any (Plan 1 allows at most one). */
  public static ConsoleHiveOf(hives: readonly HiveRecord[]): HiveRecord | undefined
  ```
  Check rules, in order: matches `^[a-z0-9.-]+$`; length <= 253; at least two labels; every label 1-63 chars matching `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`; last label not all digits; not a public mail domain. Sentences: `'<d> is not a valid domain name.'`, `'<d> is a public mail domain: anyone can have an address there, so it cannot point to one tenant.'`, `'List at most 20 email domains.'`, `'Email domains must be a list of domain names.'`.
  Public mail domains: exact set `gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, msn.com, yahoo.com, ymail.com, rocketmail.com, aol.com, icloud.com, me.com, mac.com, proton.me, protonmail.com, pm.me, gmx.com, gmx.net, gmx.de, web.de, mail.com, zoho.com, yandex.com, yandex.ru, mail.ru, qq.com, 163.com, 126.com, fastmail.com, hey.com, tutanota.com, tuta.io`; plus any domain whose FIRST label is one of `gmail, googlemail, hotmail, outlook, yahoo, ymail, aol, gmx, yandex, protonmail` and whose remaining labels are one or two labels of at most 3 characters each (catches `hotmail.co.uk`, `yahoo.fr`; allows `outlook.acme.com`).

- [ ] **Step 1: Write the failing tests:**
  - email-domain-policy: `Normalise trims, lower-cases and drops a trailing dot` (`' Acme.TEST. '` -> `'acme.test'`); `accepts ordinary company domains` (`'acme.com'`, `'eu.acme.co.uk'`, `'xn--bcher-kva.example'` -> `Check` undefined); `refuses malformed names` (`'acme'`, `'acme..com'`, `'-acme.com'`, `'acme-.com'`, `'*.acme.com'`, `'acme.com/x'`, `'10.0.0.1'`, `'a'.repeat(64) + '.com'`, `'b\u00fccher.example'` -> each a sentence ending `'is not a valid domain name.'`); `refuses public mail domains` (`'gmail.com'`, `'Outlook.com'`, `'hotmail.co.uk'`, `'yahoo.fr'`, `'proton.me'` refused with the public-mail sentence; `'outlook.acme.com'` accepted); `Parse dedupes and sorts` (`['b.test','A.test','a.test']` -> `['a.test','b.test']`); `Parse refuses more than 20 domains` (21 distinct); `Parse names the first bad domain` (`['acme.test','gmail.com']` -> message contains `'gmail.com'` and `'public mail domain'`); `Parse refuses a non-list` (`'acme.test'`, `[1]`); `Filter splits accepted from refused` (`['acme.test','gmail.com','bad..x','ACME.test']` -> `{ accepted: ['acme.test'], refused: ['gmail.com','bad..x'] }`); `DomainOf takes the part after the last @` (`' Ann@Acme.Test '` -> `'acme.test'`, `'a@b@c.test'` -> `'c.test'`, `'no-at'` and `'a@'` -> undefined).
  - console-advert-contract: `Of is HMAC-SHA256 of the normalised email` (key `randomBytes(32)`; `Of(key, '  Ann@ACME.test ') === createHmac('sha256', key).update('ann@acme.test').digest('hex')` and matches `FingerprintPattern`); `different keys give different fingerprints`; `ReadKeyFile accepts exactly 32 bytes` (32 -> equal bytes; 31, 33 and a missing path -> undefined).
  - platform-directory: `SetTenantEmailDomains stores normalised domains and survives a reload`; `an empty list removes the field` (`emailDomains === undefined`); `an invalid domain is InvalidEmailDomainError and changes nothing`; `an unknown tenant is UnknownTenantError`.
  - hive-console-spec: `ConsoleHiveOf finds the hive running the console` (two hives, one with `console`) and answers undefined when none has it.
- [ ] **Step 2: Run** `cd admin/control-plane && npx tsx --test tests/email-domain-policy.test.ts tests/console-advert-contract.test.ts tests/platform-directory.test.ts tests/hive-console-spec.test.ts` - Expected: FAIL (modules/methods missing).
- [ ] **Step 3: Implement** as specified (the deny list and brand labels are `private static readonly ReadonlySet<string>` on `EmailDomainPolicy`).
- [ ] **Step 4: Run** the control-plane gate and `npm run typecheck:tools` - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): email-domain policy, console fingerprints and tenant email domains`.

### Task 2: Control-plane advert store and receiver

**Files:**
- Create: `admin/control-plane/console-advert-registry.ts`, `admin/control-plane/console-advert-receiver.ts`
- Test: `admin/control-plane/tests/console-advert-registry.test.ts`, `tests/console-advert-receiver.test.ts`

**Interfaces:**
- Consumes: Task 1 (`EmailDomainPolicy.Filter`, `ConsoleAdvertLimits`); `JsonRecordStore` (subclass only); `HiveConsoleSpecs.HostOf` (Plan 1).
- Produces:
  ```ts
  // console-advert-registry.ts
  export type ConsoleAdvertRecord = { id: string /* = tenantId */; tenantId: string; hiveId: string; consoleUrl: string; fingerprints: string[]; emailDomains: string[]; firstReportedAt: string; reportedAt: string }
  export interface IConsoleAdvertLookup
  {
      ForTenant(tenantId: string): ConsoleAdvertRecord | undefined
      /** Live records, not cloned: callers must not mutate them (discovery reads every advert per request). */
      All(): readonly Readonly<ConsoleAdvertRecord>[]
      HasFingerprint(tenantId: string, fingerprint: string): boolean
  }
  export class ConsoleAdvertRegistry extends JsonRecordStore<ConsoleAdvertRecord> implements IConsoleAdvertLookup
  {
      public static readonly FileName = 'console-adverts.json'
      public static readonly StaleAfterMs = 24 * 60 * 60 * 1000
      public constructor(filePath: string)                  // root key 'adverts'
      public override async Load(): Promise<void>           // super.Load() then rebuild the per-tenant fingerprint Sets
      /** Replaces the tenant's advert; keeps firstReportedAt when the previous advert came from the same hive, else firstReportedAt = reportedAt. */
      public async Report(advert: Omit<ConsoleAdvertRecord, 'id' | 'firstReportedAt'>): Promise<ConsoleAdvertRecord>
      public async ForgetHive(hiveId: string): Promise<void>
      public async ForgetTenant(tenantId: string): Promise<void>
      public static IsStale(record: Readonly<ConsoleAdvertRecord>, now: Date): boolean   // now - reportedAt > StaleAfterMs
  }
  // console-advert-receiver.ts
  export class InvalidConsoleAdvertError extends Error   // 400
  export class ConsoleNotEnabledError extends Error      // 409: 'The tenant console is not enabled for this hive.'
  export type ConsoleAdvertOutcome = { record: ConsoleAdvertRecord; refusedEmailDomains: string[] }
  export interface IConsoleAdvertDirectory { GetHive(id: string): HiveRecord | undefined }
  export class ConsoleAdvertReceiver
  {
      public constructor(directory: IConsoleAdvertDirectory, store: ConsoleAdvertRegistry, now: () => Date = () => new Date())
      public async Receive(hiveId: string, body: unknown): Promise<ConsoleAdvertOutcome>
  }
  ```
  `Receive` order: hive unknown or `hive.console === undefined` -> `ConsoleNotEnabledError`; body not a plain object with exactly-typed `consoleUrl: string`, `fingerprints: string[]`, `emailDomains: string[]` -> `InvalidConsoleAdvertError('The console advert must be a JSON object with consoleUrl, fingerprints and emailDomains.')`. URL rule: length <= 2048; `new URL` parses; protocol `https:`; `username`, `password`, `port`, `search`, `hash` all empty; `pathname === '/'`; `hostname === HiveConsoleSpecs.HostOf(hive.console, hive.tenantId).toLowerCase()`; else `'consoleUrl must be the https address of this hive console, with no path, query or port.'`; stored as `'https://' + hostname`. Fingerprints: count <= 10000 and each matches `FingerprintPattern`, else `'fingerprints must be a list of at most 10000 SHA-256 hex digests.'`; stored deduped and sorted. Email domains: count <= 20 else `'emailDomains must be a list of at most 20 domain names.'`; then `EmailDomainPolicy.Filter` - accepted stored, refused returned. Then `store.Report({ tenantId: hive.tenantId, hiveId, consoleUrl, fingerprints, emailDomains, reportedAt: now().toISOString() })`.

- [ ] **Step 1: Write the failing tests:**
  - registry: `Report replaces the tenant advert and keeps the first report time` (two reports from `h1` -> `List().length === 1`, fingerprints are the second's, `firstReportedAt` is the first's `reportedAt`); `a report from another hive restarts the first report time`; `HasFingerprint answers from the latest advert only` (fingerprint of report 1 absent after report 2); `the advert and its fingerprints survive a reload`; `ForgetHive drops only that hive's advert`; `ForgetTenant drops the tenant's advert`; `IsStale only after more than 24 hours` (exactly 24 h -> false, 24 h + 1 ms -> true).
  - receiver (directory fake with hive `{ id: 'h1', tenantId: 'acme', console: { baseDomain: 'localtest.me', tls: { source: 'development' } } }`, expected host `console-acme.localtest.me`):
    - `stores a valid advert with the host lower-cased` (`'https://Console-Acme.localtest.me/'` -> stored `'https://console-acme.localtest.me'`, tenant `acme`, hive `h1`).
    - `refuses a hive without the console enabled` -> `ConsoleNotEnabledError`, `List()` empty.
    - `refuses another host, http, a path, a query, a port or user info and keeps the previous advert` - table of `'https://evil.test'`, `'http://console-acme.localtest.me'`, `'https://console-acme.localtest.me/x'`, `'https://console-acme.localtest.me/?a=1'`, `'https://console-acme.localtest.me:8443'`, `'https://u:p@console-acme.localtest.me'`, `'https://' + 'a'.repeat(2050)` -> each `InvalidConsoleAdvertError`; a previously stored advert is unchanged (same `reportedAt`).
    - `refuses malformed or too many fingerprints` (63 hex chars, uppercase hex, 10001 entries); `dedupes fingerprints`.
    - `drops refused email domains and reports them` (`['acme.test','gmail.com','bad..x']` -> stored `['acme.test']`, `refusedEmailDomains` `['gmail.com','bad..x']`); `refuses more than 20 email domains`.
    - `error messages never carry submitted values` (message of the bad-host case contains neither `'evil.test'` nor any fingerprint).
- [ ] **Step 2: Run** `npx tsx --test tests/console-advert-registry.test.ts tests/console-advert-receiver.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement.** The registry keeps `private readonly fingerprintSets = new Map<string, ReadonlySet<string>>()` rebuilt in `Load` and updated in `Report`/`Forget*`; `All()` returns `[...this.Values()]` (no clone).
- [ ] **Step 4: Run** gate - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): console advert store and receiver`.

### Task 3: Agent-channel route POST /agent/hives/:hive/console

**Files:**
- Modify: `admin/control-plane/agent-channel-host.ts` (CRLF - keep CRLF)
- Modify: `admin/control-plane/server.ts` (registry construction, load, receiver wiring)
- Test: `admin/control-plane/tests/agent-channel-host.test.ts`

**Interfaces:**
- Consumes: `ConsoleAdvertReceiver`, `InvalidConsoleAdvertError`, `ConsoleNotEnabledError`, `ConsoleAdvertRegistry` (Task 2); `PlatformDirectory.SetHiveConsole` (Plan 1, used by the test fixture).
- Produces:
  ```ts
  // AgentChannelHost ctor
  public constructor(private readonly deployments: PlatformDeploymentRegistry, private readonly adverts?: ConsoleAdvertReceiver)
  // server.ts
  public static readonly ConsoleAdvertsFile = ConsoleAdvertRegistry.FileName   // on ControlPlaneServer
  // `const adverts = new ConsoleAdvertRegistry(join(dataRoot, ControlPlaneServer.ConsoleAdvertsFile))` joins the existing Promise.all(... .Load()) list
  // `new AgentChannelHost(deployments, new ConsoleAdvertReceiver(directory, adverts))`
  ```
  Route: segment `console` added to `RoutePattern` and `SegmentMethods` (`POST`); same bearer check (`deployments.VerifyAgentToken`) BEFORE the body is read; body read with the existing 1 MiB cap; `JSON.parse` failure -> 400 with the receiver's "must be a JSON object" sentence; `adverts === undefined` -> 404 (route not mounted); success -> 200 `{ refusedEmailDomains: string[] }`. `WriteError` maps `InvalidConsoleAdvertError` -> 400 `{ error: err.message }`, `ConsoleNotEnabledError` -> 409 `{ error: err.message }`; everything else unchanged (unknown error still logs only its name). Update the class doc comment (seven routes).

- [ ] **Step 1: Write the failing tests** (extend the existing harness; build the host with `new AgentChannelHost(deployments, new ConsoleAdvertReceiver(directory, adverts))` and give hive `local1` a console spec via `SetHiveConsole`):
  - `accepts a console advert from the hive bearer and answers the refused domains` -> 200, body `{ refusedEmailDomains: ['gmail.com'] }`, `adverts.ForTenant('t1').consoleUrl === 'https://console-t1.localtest.me'`.
  - `rejects a console advert with a missing or wrong bearer: 401, nothing stored`.
  - `answers 409 for a hive without the console` (clear the spec first).
  - `answers 400 with the fixed sentence for an invalid advert` (bad host; body error equals the receiver sentence) and `for a malformed JSON body`.
  - `answers 404 for GET on the console route`; `answers 404 when no advert receiver is configured` (host built with one ctor arg, valid bearer).
- [ ] **Step 2: Run** `npx tsx --test tests/agent-channel-host.test.ts` - Expected: FAIL (404 for the new route).
- [ ] **Step 3: Implement** the route and the server wiring.
- [ ] **Step 4: Run** gate, `npm run typecheck:tools`, `npm run build:tenant-admin` - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): agent-channel route for the in-hive console advert`.

### Task 4: "Reported" install state and forgetting adverts

**Files:**
- Modify: `admin/control-plane/tenant-console-installer.ts` (Plan 1)
- Modify: `admin/control-plane/control-plane-host.ts` (ctor param, console removal, hive delete, tenant delete)
- Modify: `admin/control-plane/server.ts` (pass `adverts` to the installer and the host)
- Test: `admin/control-plane/tests/tenant-console-installer.test.ts`, `tests/control-plane-host-hive-console.test.ts` (both Plan 1 files)

**Interfaces:**
- Consumes: `IConsoleAdvertLookup`, `ConsoleAdvertRegistry` (Task 2); Plan 1 `TenantConsoleInstaller`, `ConsoleInstallState`, `ConsoleInstallStatus`, `IInstallClock`, `DELETE /api/hives/ID/console`, `DeleteHiveEverywhere`.
- Produces:
  ```ts
  export enum ConsoleInstallState { Installing = 'installing', Deployed = 'deployed', Failed = 'failed', Reported = 'reported' }
  export type ConsoleInstallStatus = { /* Plan 1 fields */ ...; reportedAt?: string; stale?: boolean }
  // TenantConsoleInstaller ctor gains a last optional param after clock:
  adverts?: IConsoleAdvertLookup
  // ControlPlaneHost ctor gains a new last optional param after Plan 1's consoleInstaller:
  private readonly adverts?: ConsoleAdvertRegistry
  ```
  `StatusFor(hiveId)`: let `base` = the in-memory status (Plan 1) and `advert = adverts?.ForTenant(hive.tenantId)` counted only when `advert.hiveId === hiveId` and the hive still has `console`. If `base?.state` is `Installing` or `Failed` -> `base` unchanged. Else if `advert` -> `{ ...(base ?? { step: ConsoleInstallStep.SeedingOwner, startedAt: advert.firstReportedAt, finishedAt: advert.firstReportedAt }), state: Reported, consoleUrl: advert.consoleUrl, reportedAt: advert.reportedAt, stale: ConsoleAdvertRegistry.IsStale(advert, new Date(clock.Now())) }`. Else `base` (undefined -> the GET route's existing 404).
  Forgetting: `DELETE /api/hives/ID/console` calls `adverts?.ForgetHive(id)` after `SetHiveConsole(id, undefined)`; `DeleteHiveEverywhere` calls `adverts?.ForgetHive(id)` after `directory.DeleteHive(id)`; the tenant branch of `DeletePlatform` calls `adverts?.ForgetTenant(id)` after `directory.DeleteTenant(id)`. `PUT /api/hives/ID/console` (host change) does NOT forget: the running console keeps its last advert until a reinstall reports the new host.

- [ ] **Step 1: Write the failing tests:**
  - installer (fake lookup; immediate clock): `a deployed install becomes reported on the first advert` (state `'reported'`, `consoleUrl`/`reportedAt` from the advert, `stale === false`); `after a restart the advert alone answers reported` (fresh installer, no run -> `startedAt === finishedAt === firstReportedAt`); `an advert older than a day is reported stale`; `installing is not overridden by an advert`; `a failed reinstall stays failed even with an old advert`; `an advert from another hive of the tenant does not count` (advert `hiveId: 'h2'`, status for `h1` stays `deployed`).
  - host: `removing the console forgets its advert`; `hive delete forgets its advert`; `tenant delete forgets any advert`; `GET console-install answers reported from the advert` (200, `state === 'reported'`).
- [ ] **Step 2: Run** the two files - Expected: FAIL.
- [ ] **Step 3: Implement**; wire `adverts` in `server.ts` (the Task 3 registry instance).
- [ ] **Step 4: Run** gate + `npm run typecheck:tools` - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): console install reports from the console advert`.

### Task 5: Discovery - union of fingerprint, domain and index matches with per-tenant console URLs

**Files:**
- Create: `admin/control-plane/desktop-tenant-matcher.ts`
- Modify: `admin/control-plane/desktop-discovery-endpoint.ts`, `admin/control-plane/server.ts` (discovery construction; hoist Plan 1's `ConsoleFingerprintKeys` instance so discovery and the installer share it, opening the sealed store before discovery is built)
- Test: `admin/control-plane/tests/desktop-tenant-matcher.test.ts`, `tests/desktop-discovery-endpoint.test.ts`

**Interfaces:**
- Consumes: `TenantAccountIndex` (`TenantsFor`, `Normalise`); `IConsoleAdvertLookup`, `ConsoleAdvertRecord` (Task 2); `ConsoleFingerprint.Of`, `EmailDomainPolicy.DomainOf`, `HiveConsoleSpecs.ConsoleHiveOf` (Task 1); `ConsoleFingerprintKeys.Get` (Plan 1, satisfies `IFingerprintKeySource`).
- Produces:
  ```ts
  export interface IDiscoveryDirectory extends ITenantDirectory { ListTenants(): readonly TenantRecord[] }   // PlatformDirectory satisfies it
  export interface IFingerprintKeySource { Get(hiveId: string): Promise<Buffer | undefined> }
  export enum DiscoveryMatch { Account = 'account', Domain = 'domain' }
  export type DiscoveredTenant = { tenant: TenantRecord; consoleUrl: string; match: DiscoveryMatch }
  export class DesktopTenantMatcher
  {
      public constructor(index: TenantAccountIndex, directory: IDiscoveryDirectory, adverts?: IConsoleAdvertLookup, keys?: IFingerprintKeySource)
      /** One entry per tenant, Account before Domain, then displayName (localeCompare). */
      public async Match(email: string, tenantPlaneUrl: string): Promise<readonly DiscoveredTenant[]>
  }
  // DesktopDiscoveryEndpoint ctor
  public constructor(index: TenantAccountIndex, directory: IDiscoveryDirectory, tenantPlaneUrl: string | undefined, throttle: AuditThrottle, adverts?: IConsoleAdvertLookup, keys?: IFingerprintKeySource)
  // 200 body: { tenants: { id: string; displayName: string; consoleUrl: string }[]; tenantPlaneUrl: string }
  ```
  Match algorithm (the decisions, not the code): `domain = EmailDomainPolicy.DomainOf(email)`. A tenant is in-hive when `ConsoleHiveOf(directory.ListHives(t.id))` is defined; its usable advert is `adverts.ForTenant(t.id)` only when `advert.hiveId === consoleHive.id`. (1) For each usable advert: `key = await keys.Get(advert.hiveId)`; key defined and `adverts.HasFingerprint(tenantId, ConsoleFingerprint.Of(key, email))` -> Account; `domain` in `advert.emailDomains` -> Domain. (2) For each id in `index.TenantsFor(email)`: skip when the tenant is in-hive without a usable advert; else Account. (3) For each `directory.ListTenants()` that is NOT in-hive with `domain` in `emailDomains` -> Domain (an in-hive tenant's record `emailDomains` are ignored). Merge per tenant keeping Account over Domain; drop ids the directory does not know. `consoleUrl` = usable advert's `consoleUrl` for in-hive tenants, else `tenantPlaneUrl`. Stale adverts are used as is. Domains match exactly (no parent-domain matching). Endpoint: Origin refusal, throttle, 400/404/503 and their order unchanged; `tenantPlaneUrl` undefined is still 503 before any matching.

- [ ] **Step 1: Write the failing tests:**
  - matcher (in-memory fakes; tenant plane `'http://127.0.0.1:7002'`; in-hive tenant `acme` with hive `h1` running the console at `https://console-acme.localtest.me`, key K):
    - `a control-plane tenant found by the index points at the tenant plane`.
    - `an in-hive tenant is left out until its first advert` (index has Owner `ann@acme.test`, no advert -> `[]`).
    - `an advert fingerprint match points at the advertised console` (advert fingerprints `[Of(K,'ann@acme.test')]`, query `'  Ann@Acme.TEST '` -> `[{ tenant.id: 'acme', consoleUrl: 'https://console-acme.localtest.me', match: 'account' }]`).
    - `an index match of an in-hive tenant with an advert uses the advertised console`.
    - `a domain on a control-plane tenant record matches; the same domain on an in-hive record does not`.
    - `an advert domain matches an in-hive tenant`.
    - `a tenant matched by fingerprint and domain appears once, as an account match`.
    - `two tenants claiming one domain are both returned`.
    - `a subdomain does not match its parent domain` (`'a@eu.acme.test'` vs `acme.test`).
    - `an advert whose hive no longer runs the console is ignored` (console cleared; index match -> tenant plane URL; fingerprint-only -> `[]`).
    - `a stale advert is still used`.
    - `a missing fingerprint key skips that advert's fingerprints but not its domains`.
  - endpoint: update `answers 200 with the tenants and the tenant plane url` (each entry gains `consoleUrl === DiscoveryFixture.Url`; `FakeDirectory` gains `ListTenants`); add `orders account matches before domain matches, then by display name`; add `returns the in-hive console url for an advertised tenant` (top-level `tenantPlaneUrl` still the configured URL). Existing 400/403/404/429/503 tests stay unchanged and green.
- [ ] **Step 2: Run** `npx tsx --test tests/desktop-tenant-matcher.test.ts tests/desktop-discovery-endpoint.test.ts tests/desktop-discovery-compose.test.ts` - Expected: FAIL.
- [ ] **Step 3: Implement** the matcher, make the endpoint delegate to it, wire `adverts` + the shared `ConsoleFingerprintKeys` in `server.ts`.
- [ ] **Step 4: Run** gate + `npm run typecheck:tools` - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): discovery unions advert, domain and index matches with per-tenant console urls`.

### Task 6: Email-domain seam, control-plane tenant routes and operator routes

**Files:**
- Create: `admin/control-plane/tenant-api/tenant-email-domains.ts`, `admin/control-plane/platform-email-domains.ts`
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts` (ctor param, routes, body-cap param on the private `ReadBody`)
- Modify: `admin/control-plane/server.ts` (`BuildTenantPlane` and `ComposeTenantPlane` gain a last optional `emailDomains?: ITenantEmailDomains`; one `PlatformEmailDomains` instance shared with the host)
- Modify: `admin/control-plane/control-plane-host.ts` (ctor param after `adverts`, operator routes, error table)
- Test: `admin/control-plane/tests/platform-email-domains.test.ts`, `tests/tenant-api-email-domains.test.ts`, `tests/control-plane-host-email-domains.test.ts`

**Interfaces:**
- Consumes: Task 1 (`EmailDomainPolicy`, `InvalidEmailDomainError`, `SetTenantEmailDomains`, `ConsoleHiveOf`); `IConsoleAdvertLookup` (Task 2); `TenantAdminCapabilities` / the endpoint's `RequireCapability(res, session, 'settings')`.
- Produces:
  ```ts
  // tenant-api/tenant-email-domains.ts
  export type TenantEmailDomainsView = { domains: string[]; editable: boolean }
  export class EmailDomainsNotEditableError extends Error   // 409
  export interface ITenantEmailDomains
  {
      /** editable = whether this store may change the tenant's domains (the caller's role is checked by the endpoint). */
      For(tenantId: string): TenantEmailDomainsView
      /** Throws InvalidEmailDomainError (400) or EmailDomainsNotEditableError (409). */
      Set(tenantId: string, domains: unknown): Promise<TenantEmailDomainsView>
  }
  // platform-email-domains.ts
  export enum EmailDomainSource { Tenant = 'tenant', Console = 'console' }
  export type TenantEmailDomainsReport = { tenantId: string; domains: string[]; source: EmailDomainSource; editable: boolean; reportedAt?: string; sharedWith: string[] }
  export class PlatformEmailDomains implements ITenantEmailDomains
  {
      public constructor(directory: PlatformDirectory, adverts: IConsoleAdvertLookup | undefined)
      public IsInHive(tenantId: string): boolean
      public Report(tenantId: string): TenantEmailDomainsReport | undefined   // undefined for an unknown tenant
      // For/Set as ITenantEmailDomains
  }
  ```
  Rules: in-hive tenant -> domains = its usable advert's `emailDomains` (or `[]`), `source: Console`, `editable: false`, `reportedAt` = advert's; `Set` -> `EmailDomainsNotEditableError("This tenant's console runs in its hive; its email domains are set there by the tenant Owner.")`. Control-plane tenant -> record `emailDomains ?? []`, `source: Tenant`, `editable: true`; `Set` -> `directory.SetTenantEmailDomains`. `sharedWith` = sorted ids of OTHER tenants whose effective domains intersect this tenant's. Unknown tenant: `For` -> `{ domains: [], editable: false }`; `Set` -> `UnknownTenantError`.
  Tenant routes (only when the ctor's `emailDomains` is defined; otherwise these paths are not routes): `GET /tenant-api/settings/email-domains` -> 200 `{ domains, editable: view.editable && caps.settings }`; `PUT` same path: `RequireCapability(..., 'settings')` (403 `forbidden`), body read with a 16384-byte cap, not an object or `domains` missing -> 400 `{ error: 'domains (array of domain names) is required' }`, `InvalidEmailDomainError` -> 400 `{ error: message }`, `EmailDomainsNotEditableError` -> 409 `{ error: message }`, success -> 200 view (same shape as GET). The tenant id is only ever `session.tenantId`.
  Operator routes: `GET /api/tenants/ID/email-domains` -> 200 `TenantEmailDomainsReport` or 404; `PUT` (Full-gated by the central gate) body `{ domains }` -> 200 report; 400 / 404 / 409 as above (add `InvalidEmailDomainError` -> 400 and `EmailDomainsNotEditableError` -> 409 to the existing error table).

- [ ] **Step 1: Write the failing tests:**
  - platform-email-domains: `a control-plane tenant reports its record domains as editable`; `an in-hive tenant reports its advert domains read-only with the report time`; `an in-hive tenant without an advert reports none`; `Set refuses an in-hive tenant with the plain sentence`; `sharedWith names other tenants claiming the same domain` (control-plane `beta` and in-hive `acme` both claim `shared.test` -> `Report('beta').sharedWith` deepEquals `['acme']`).
  - tenant-api-email-domains (endpoint over fakes, Owner and non-Owner sessions): `the Owner reads and sets the domains` (PUT `['Acme.test']` -> 200 `{ domains: ['acme.test'], editable: true }`); `a non-Owner reads them as not editable and gets 403 on PUT`; `a public mail domain is 400 with the sentence`; `a not-editable store is 409`; `a body without domains is 400`; `without an email-domain store the paths are not routes`.
  - control-plane-host-email-domains (compose like `control-plane-host-agent-install.test.ts`): `GET reports a control-plane tenant`; `PUT stores domains and answers the report`; `PUT on an in-hive tenant is 409`; `PUT with gmail.com is 400 naming it`; `an unknown tenant is 404`; `a read-only operator gets 403`.
- [ ] **Step 2: Run** the three files - Expected: FAIL.
- [ ] **Step 3: Implement**; `ComposeTenantPlane` callers pass the shared `PlatformEmailDomains`.
- [ ] **Step 4: Run** gate, `npm run typecheck:tools`, `npm run build:tenant-admin` - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): tenant email domains for operators and control-plane tenant owners`.

### Task 7: Console side - email-domain store, advert sender and composition

**Files:**
- Create: `admin/control-plane/console-email-domain-store.ts`, `admin/control-plane/console-advert-sender.ts`
- Modify: `admin/control-plane/tenant-admin-server.ts`
- Test: `admin/control-plane/tests/console-email-domain-store.test.ts`, `tests/console-advert-sender.test.ts`, `tests/tenant-admin-server.test.ts`

**Interfaces:**
- Consumes: `ITenantEmailDomains`, `TenantEmailDomainsView`, `EmailDomainsNotEditableError` (Task 6); `EmailDomainPolicy`, `ConsoleAdvertBody`, `ConsoleFingerprint` (Task 1); `Signal`, `IDisposable` (`@pragmatic-tech-ai/todl-runtime`); `TenantAdminEnv.RolloutUrl/RolloutToken/RolloutHiveId/FingerprintKeyFile`, `TenantAdminConfig.consoleHost` (Plan 1); `ControlPlaneServer.BuildTenantPlane` `emailDomains` param (Task 6).
- Produces:
  ```ts
  // console-email-domain-store.ts
  export class ConsoleEmailDomainStore implements ITenantEmailDomains
  {
      public static readonly FileName = 'email-domains.json'          // { "domains": string[] }
      public readonly Changed: Signal<readonly string[]>
      /** File absent -> seed domains (EmailDomainPolicy.Filter, refused seed entries dropped); never writes on open. */
      public static async Open(filePath: string, tenantId: string, seedDomains: readonly string[] | undefined): Promise<ConsoleEmailDomainStore>
      public get Domains(): readonly string[]
      // For: own tenant -> { domains, editable: true }; any other id -> { domains: [], editable: false }
      // Set: other tenant -> EmailDomainsNotEditableError; Parse; write <file>.tmp then rename; emit Changed only when the list changed
  }
  // console-advert-sender.ts
  export interface IConsoleAccountSource { Emails(): readonly string[]; readonly Changed: Signal<void> }
  /** The console's sign-in accounts: today only the seeded Owner (TenantRecord.ownerEmail). Any future account create/delete/email-change path in the console MUST emit Changed. */
  export class SeededConsoleAccounts implements IConsoleAccountSource { public constructor(tenant: TenantRecord) }
  export interface IConsoleAdvertTransport { Send(body: ConsoleAdvertBody): Promise<void> }
  export class ConsoleAdvertUnavailableError extends Error
  export class HttpConsoleAdvertTransport implements IConsoleAdvertTransport   // ctor(baseUrl: string, bearerToken: string, hiveId: string); POST <baseUrl>/agent/hives/<encodeURIComponent(hiveId)>/console
  export interface IAdvertTimer { Every(intervalMs: number, tick: () => void): IDisposable }
  export class IntervalAdvertTimer implements IAdvertTimer                      // setInterval(...).unref()
  export class ConsoleAdvertSender
  {
      public static readonly IntervalMs = 5 * 60 * 1000
      public constructor(transport: IConsoleAdvertTransport, accounts: IConsoleAccountSource, domains: ConsoleEmailDomainStore, fingerprintKey: Buffer, consoleUrl: string, timer: IAdvertTimer = new IntervalAdvertTimer(), log: (line: string) => void = line => console.error(line))
      /** Sends once (awaited, never throws), then every IntervalMs and on accounts.Changed / domains.Changed. */
      public Start(): Promise<void>
      public Stop(): void
      /** At most one send in flight; changes during a send queue exactly one more. Never throws. */
      public SendNow(): Promise<void>
      /** { consoleUrl, fingerprints: sorted unique ConsoleFingerprint.Of(key, e) of accounts.Emails(), emailDomains: domains.Domains } */
      public Body(): ConsoleAdvertBody
  }
  // tenant-admin-server.ts
  TenantAdminConfig gains: readonly fingerprintKeyFile: string | undefined
  TenantAdminComposition gains: readonly emailDomains: ConsoleEmailDomainStore; readonly advert: ConsoleAdvertSender | undefined
  /** undefined (and one log line naming the missing setting's env var, never a value) unless consoleHost, a 32-byte key file and RolloutUrl/RolloutToken/RolloutHiveId are all present. consoleUrl = 'https://' + consoleHost. */
  public static AdvertSenderOf(env: NodeJS.ProcessEnv, cfg: TenantAdminConfig, tenant: TenantRecord, domains: ConsoleEmailDomainStore, log?: (line: string) => void): ConsoleAdvertSender | undefined
  ```
  Transport errors are fixed sentences: `'The platform agent channel is unreachable'`, `'The platform agent channel answered HTTP <status>'` (body drained, never read into the message). Sender failure log line: `'[console-advert] send failed: ' + err.name`. `Compose`: `emailDomains = await ConsoleEmailDomainStore.Open(join(dataRoot, ConsoleEmailDomainStore.FileName), tenant.id, tenant.emailDomains)`, passed to `BuildTenantPlane` as `emailDomains`; `advert = AdvertSenderOf(...)`. `Run()`: after `Listen`, `await composition.advert?.Start()`.

- [ ] **Step 1: Write the failing tests:**
  - store: `opens with the seed domains when no file exists, without writing` (no file on disk afterwards); `Set persists, survives reopen and wins over the seed`; `Set emits Changed once and not for an identical list`; `Set refuses another tenant` (`EmailDomainsNotEditableError`); `Set refuses a public mail domain and changes nothing`.
  - sender (fake transport recording bodies, fake timer with `Tick()`, fake account source):
    - `Start sends at once, then every five minutes` (registered interval `=== 300000`; `Tick()` -> 2 sends).
    - `the body carries the console URL, the Owner fingerprint and the domains` (`{ consoleUrl: 'https://console-acme.localtest.me', fingerprints: [Of(K,'owner@acme.test')], emailDomains: ['acme.test'] }`).
    - `the Owner fingerprint is of the trimmed, lower-cased email` (seed ownerEmail `' Owner@Acme.Test '`).
    - `a domain change is sent immediately`; `an account change is sent immediately`.
    - `changes during a send are coalesced into one more send` (transport held; three changes -> exactly 2 sends after release).
    - `a failed send is logged by name only and retried on the next tick` (transport throws `new Error('token tok-123 owner@acme.test')`; log lines contain `'send failed'` but neither `'tok-123'` nor `'owner@acme.test'`; the triggering `store.Set` resolved; next `Tick()` sends).
    - `Stop ends the timer and the subscriptions` (timer disposable disposed; `Set` after `Stop` sends nothing).
  - transport (local `node:http` server): `posts the advert with the bearer` (path `/agent/hives/acme-hive/console`, `POST`, `authorization === 'Bearer tok'`, JSON body); `a 409 is ConsoleAdvertUnavailableError without the token`; `an unreachable channel is the fixed sentence`.
  - server: `ReadConfig reads the fingerprint key file`; `AdvertSenderOf needs the console host, the fingerprint key and the agent channel` (each missing -> undefined; the log line names the env var and contains no value); `a key file of the wrong length turns the advert off`; `Compose opens the email domains from the seed when no file exists` (`composition.emailDomains.Domains` deepEquals `['acme.test']`).
- [ ] **Step 2: Run** the three files - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** gate, `npm run typecheck:tools`, `npm run build:tenant-admin` - Expected: PASS.
- [ ] **Step 5: Commit** `feat(control-plane): in-hive console sends its advert and keeps its email domains`.

### Task 8: Platform admin portal - tenant email domains and the "reported" console state

**Files:**
- Modify: `admin/portal/src/portal-types.ts`, `admin/portal/src/api-client.ts`
- Create: `admin/portal/src/sections/tenants/tenant-email-domains-view-model.ts`
- Modify: `admin/portal/src/sections/tenants/tenant-detail-page-view-model.ts` (owns and loads `EmailDomains`), `admin/portal/src/sections/tenants/tenants.resources.mu` (an "Email domains" block on the tenant detail page + `DataTemplate [ DataType = TenantEmailDomainsViewModel ]`)
- Modify: `admin/portal/src/sections/hives/hive-console-view-model.ts` (Plan 1)
- Test: `admin/portal/src/sections/tenants/tests/tenant-email-domains.test.ts`, `admin/portal/src/sections/hives/tests/hive-console.test.ts` (Plan 1 file)

**Interfaces:**
- Consumes: the operator routes of Task 6, the status shape of Task 4.
- Produces:
  ```ts
  // portal-types.ts
  export enum EmailDomainSource { Tenant = 'tenant', Console = 'console' }
  export type TenantEmailDomainsDto = { tenantId: string; domains: string[]; source: EmailDomainSource; editable: boolean; reportedAt?: string; sharedWith: string[] }
  // ConsoleInstallState gains Reported = 'reported'; ConsoleInstallStatusDto gains reportedAt?: string; stale?: boolean
  // api-client.ts (ControlPlaneClient)
  public async GetTenantEmailDomains(tenantId: string): Promise<TenantEmailDomainsDto>
  public async SetTenantEmailDomains(tenantId: string, domains: readonly string[]): Promise<TenantEmailDomainsDto>
  // tenant-email-domains-view-model.ts
  export class TenantEmailDomainsViewModel extends Observable   // ctor(session: PortalSessionService, tenantId: string)
  // HiveConsoleViewModel gains: public static readonly ReportPollIntervalMs = 15000
  ```
  VM surface (bound names): `DomainsText` (two-way; comma-joined `', '`), `DomainsLabel` (joined, or `'None declared.'`), `IsEditable` (`report.editable && session.CanMutate`), `IsReadOnly`, `SourceText` (console source: `'Reported by the tenant console in its hive on <PortalDates.DateTimeLabel(reportedAt)>. The tenant Owner changes them there.'`; tenant source: `''`), `SharedWithText` (`'Also claimed by: a, b'` or `''`), `ErrorText`, `SavedText` (`'Saved.'`), `SaveCommand` (enabled when `IsEditable`, not saving, and the parsed list differs from the loaded one), `Load(): Promise<void>`. Text parsing: split on `/[\s,;]+/`, drop empties (the server normalises and validates). Hive console VM: after `Deployed`, keep polling every `ReportPollIntervalMs` until `Reported`; `StatusText` for reported `'Reported by the console at <PortalDates.DateTimeLabel(reportedAt)>.'`, stale `'Last reported at <...>, more than a day ago.'`; all step rows done when reported.

- [ ] **Step 1: Write the failing tests:**
  - tenant-email-domains (fakes as in `tests/tenant-owner-reset.test.ts`): `a control-plane tenant edits its domains` (load `['acme.test','acme.example']` -> `DomainsText === 'acme.test, acme.example'`; text `'acme.test,  beta.test'` -> Save -> `SetTenantEmailDomains('t1', ['acme.test','beta.test'])`, then `SavedText === 'Saved.'`); `an in-hive tenant shows the reported domains read-only` (`IsEditable === false`, `SaveCommand.CanExecute() === false`, `SourceText` contains `'in its hive'`); `a 400 shows the server sentence`; `a read-only operator cannot save`; `a shared domain is called out` (`SharedWithText === 'Also claimed by: beta'`); `the tenant page loads the email domains with the tenant`.
  - hive-console: `after deployed it keeps polling every 15 seconds until reported` (scheduler delays `[2000, ..., 15000]`; final `StatusText` starts `'Reported by the console at'`); `a stale report says so`; `opening the page of an already reported console schedules no poll`.
- [ ] **Step 2: Run** `npm --prefix admin/portal test` - Expected: FAIL.
- [ ] **Step 3: Implement** types, client, VMs and the `.mu` block (labels inline: "Email domains", "People whose email address is on one of these domains are sent to this tenant's console when they sign in from Plexus.", "Separate domains with commas.", "Save"; no Width/Height).
- [ ] **Step 4: Run** `npm --prefix admin/portal run typecheck`, `npm --prefix admin/portal test`, `npm run typecheck:tools` - Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): tenant email domains and the reported console state`.

### Task 9: Tenant console settings - Email domains tab

**Files:**
- Modify: `admin/tenant-portal/src/tenant-types.ts`, `admin/tenant-portal/src/tenant-api-client.ts` (CRLF - keep CRLF), `admin/tenant-portal/src/shell/tests/tenant-test-fixtures.ts`
- Create: `admin/tenant-portal/src/sections/settings/email-domains-editor-view-model.ts`
- Modify: `admin/tenant-portal/src/sections/settings/settings-page-view-model.ts`, `admin/tenant-portal/src/sections/settings/settings.resources.mu`
- Test: `admin/tenant-portal/src/sections/settings/tests/email-domains-editor.test.ts`, `tests/settings-page-view-model.test.ts`

**Interfaces:**
- Consumes: the tenant routes of Task 6 (served by both the control-plane tenant plane and the in-hive console, Task 7).
- Produces:
  ```ts
  // tenant-types.ts
  export type EmailDomainsDto = { domains: string[]; editable: boolean }
  // TenantApiClient
  public async GetEmailDomains(): Promise<EmailDomainsDto>
  public async SetEmailDomains(domains: readonly string[]): Promise<EmailDomainsDto>
  // FakeTenantApi gains: EmailDomains: EmailDomainsDto; GetEmailDomains/SetEmailDomains recording Calls
  // settings-page-view-model.ts
  export enum SettingsTab { Hive, Profile, IdentityProvider, EmailDomains }
  public get EmailDomains(): EmailDomainsEditorViewModel; public get IsEmailDomainsTab(): boolean
  // email-domains-editor-view-model.ts
  export class EmailDomainsEditorViewModel extends Observable   // ctor(session: TenantSessionService)
  ```
  Editor surface: `DomainsText` (two-way, `', '`-joined), `IsEditable` (server `editable`), `ReadOnlyText` (when not editable: `'Only the tenant Owner can change the email domains.'` if the profile's `capabilities.settings` is false, else `"This tenant's email domains are set in its in-hive console."`), `ErrorText`, `SavedText` (`'Saved.'`), `SaveCommand` (enabled when editable, not saving, list changed), `Apply(dto, canChangeSettings)`. Same text parsing as Task 8. The page loads `GetEmailDomains` alongside `Profile` and `ListHives` and passes `profile.capabilities.settings`. Tab label `'Email domains'`; page subtitle becomes `'How your tenant is set up.'` (the other tabs keep their read-only captions).

- [ ] **Step 1: Write the failing tests:**
  - editor: `the Owner saves the domains` (`'acme.test, beta.test'` -> `SetEmailDomains(['acme.test','beta.test'])`, `SavedText === 'Saved.'`, `DomainsText` reflects the server's normalised reply); `a server refusal shows its sentence` (TenantApiError 400 with `'gmail.com is a public mail domain...'`); `a non-Owner sees the domains read-only with the Owner sentence`; `a not-editable store shows the in-hive sentence`; `Save is disabled until the list changes`.
  - settings page (update): `has the four tabs` (`['Hive & domain', 'Tenant profile', 'Identity provider', 'Email domains']`); `loads the profile, the hives and the email domains` (Calls `['Profile', 'ListHives', 'GetEmailDomains']`).
- [ ] **Step 2: Run** `npm --prefix admin/tenant-portal test` - Expected: FAIL.
- [ ] **Step 3: Implement** types, client, fixture, VMs and the tab content in `settings.resources.mu` (a `TextBox` bound two-way to `DomainsText`, enabled by `IsEditable`; Save `Button` on `SaveCommand`; captions inline: "People whose email address is on one of these domains are sent to this console when they sign in from Plexus. Public mail domains such as gmail.com cannot be used.", "Separate domains with commas.").
- [ ] **Step 4: Run** `npm --prefix admin/tenant-portal run typecheck`, `npm --prefix admin/tenant-portal test`, `npm run typecheck:tools` - Expected: PASS.
- [ ] **Step 5: Commit** `feat(tenant-portal): Owner edits the tenant email domains in settings`.

### Task 10: Live smoke - advert arrives and discovery answers with the in-hive console

**Files:**
- Modify: `admin/control-plane/in-hive-console-smoke.ts` (Plan 1 Task 15)

**Interfaces:**
- Consumes: `POST /api/desktop/discover`; `GET /api/hives/ID/console-install` (Task 4); `GET`/`PUT /api/tenants/ID/email-domains` (Task 6); `PUT /tenant-api/settings/email-domains` (Task 6, served by the console, Task 7).

  Invocation and prerequisites are Plan 1's, unchanged (rebuilt `pragmatic-server:dev` image with this branch, control plane restarted from this checkout, docker-desktop, hive `default-pragmatic-hive` / tenant `pragmatic-default`, port 443 free, openssl, Playwright Chromium). Discovery is called with node `http.request` (no Origin header) at most four times per run (throttle: 10 per minute per address). The Owner email is read from `GET /api/tenants/pragmatic-default` and never printed.

  New labelled steps (numbering relative to Plan 1's):
  - 3b. After the console setting is saved and before the install: `discover(ownerEmail)` -> 404, or 200 whose tenants do NOT include `pragmatic-default` (an in-hive tenant without an advert is left out).
  - 4b. After `deployed`: poll `GET .../console-install` every 5 s up to 3 min until `state === 'reported'`; `consoleUrl === 'https://console-pragmatic-default.<baseDomain>'`, `stale === false`.
  - 4c. `discover(ownerEmail)` -> 200; the `pragmatic-default` entry has `consoleUrl === 'https://console-pragmatic-default.<baseDomain>'`; top-level `tenantPlaneUrl` is a string different from that console URL.
  - 7b. After the browser sign-in, in the page context: `fetch('/tenant-api/settings/email-domains', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domains: ['smoke-ihc.test'] }) })` -> 200 `{ domains: ['smoke-ihc.test'], editable: true }`.
  - 7c. Poll `GET /api/tenants/pragmatic-default/email-domains` every 2 s up to 60 s until `domains` includes `'smoke-ihc.test'` with `source === 'console'` and `editable === false`; then `PUT` on the same route -> 409.
  - 7d. `discover('someone@smoke-ihc.test')` -> 200 with the `pragmatic-default` entry's `consoleUrl` equal to the in-hive console URL.
  - Teardown additions (best-effort, reported): in the page, PUT `{ domains: [] }` when 7b ran; after Plan 1's `DELETE /api/hives/default-pragmatic-hive/console`, `discover(ownerEmail)` -> the `pragmatic-default` entry (if present) has `consoleUrl === tenantPlaneUrl` (the advert was forgotten).

- [ ] **Step 1: Extend the smoke** (same class, constants hoisted, Allman braces).
- [ ] **Step 2: Typecheck** `npm run typecheck:tools` - Expected: PASS.
- [ ] **Step 3: Run the smoke** with Plan 1's invocation - Expected: every step PASS, exit code 0; captured output contains neither the operator password's first 6 characters nor the Owner email.
- [ ] **Step 4: Fix** any product bug the smoke finds in the owning task's files (with a regression test there), re-run the gates and the smoke.
- [ ] **Step 5: Commit** `test(control-plane): live smoke for the console advert and discovery` (smoke file plus any fixes, staged by path).

---

## Self-review

**Spec coverage.** Advert route `POST /agent/hives/:hive/console`, same bearer, `{ consoleUrl, fingerprints, emailDomains }`, validated + capped - Tasks 2, 3. Console posts at start, every 5 minutes and immediately on account/domain change - Task 7 (account changes: the seam `IConsoleAccountSource.Changed`; see ruling 1). Fingerprint = HMAC-SHA256 of the trim+lowercase email with the Plan 1 per-hive key - Tasks 1, 7, 5. Store keyed per tenant, recording hive and reportedAt, replacing - Task 2. Install state "reported" shown in the portal - Tasks 4, 8. `TenantRecord.emailDomains` with validation and public-mail deny list - Task 1. Operator editing for control-plane tenants, read-only from the advert for in-hive tenants - Tasks 6, 8. Owner editing in the tenant console (in-hive: advert; control-plane: record) - Tasks 6, 7, 9. Discovery: union and per-tenant dedup, in-hive excluded until the first advert, per-tenant `consoleUrl`, top-level `tenantPlaneUrl` unchanged, stale adverts still returned, throttling/Origin/status codes unchanged - Task 5. Live smoke extending Plan 1's - Task 10. Plexus and the console's `/desktop/*` are Plan 3.

**Step scan.** Every code step names its file, signatures and pinned values; no TBD. The only bodies given are the URL rule, the matching order and the status merge, which signatures do not determine.

**Type consistency.** `ConsoleAdvertRecord`/`IConsoleAdvertLookup` (Task 2) are used unchanged by Tasks 4, 5, 6; `ITenantEmailDomains`/`TenantEmailDomainsView` (Task 6) by Tasks 7, 9; `ConsoleAdvertBody`/`ConsoleFingerprint` (Task 1) by Tasks 2, 5, 7; `ConsoleInstallState.Reported` and `reportedAt`/`stale` identical in Tasks 4 and 8; `EmailDomainSource` values identical in Tasks 6 and 8; route paths identical in Tasks 6, 8, 9, 10.

**Review Focus.** Each line names its test in the owning task (2, 1+5, 4+5, 4, 7).

**Proportion.** Code blocks are interfaces only; ten tasks for a spec section of similar breadth to Plan 1's fifteen.

## Produced interfaces for Plan 3

- Discovery 200 body: `{ tenants: { id: string; displayName: string; consoleUrl: string }[]; tenantPlaneUrl: string }` (`consoleUrl` is the in-hive console origin `https://<console host>` or the control-plane tenant plane URL).
- Console composition: `TenantAdminComposition.emailDomains: ConsoleEmailDomainStore`, `TenantAdminComposition.advert: ConsoleAdvertSender | undefined`; `ControlPlaneServer.BuildTenantPlane(..., emailDomains?: ITenantEmailDomains)` is the last parameter (Plan 3 appends after it or passes `withDesktop`/`relay` positionally as today).
- `IConsoleAccountSource.Changed`: any account path Plan 3 adds to the console must emit it.
