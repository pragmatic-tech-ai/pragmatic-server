# DNS TXT Email-Domain Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant prove an email domain with a DNS TXT record. A verified domain that nobody else claims then works in desktop discovery without an operator. A contested domain still needs the operator, and an operator revoke beats verification.

**Architecture:** The control plane is the only DNS resolver. An `ITxtResolver` seam sits over `node:dns/promises` `Resolver.resolveTxt`. `DomainTxtVerifier` turns a lookup into a check result, and `ConsoleDomainApprovals` stores per-tenant, per-domain tokens, verification state and revokes next to the approvals. The one effective-domain rule lives in `ConsoleDomainApprovals`, and `DomainClaims` computes "contested". `PlatformEmailDomains` and `DesktopTenantMatcher` both use the rule. Verify can be triggered in three places. The operator uses the platform portal (`/api/tenants/ID/email-domains/verify`). A control-plane tenant's Owner uses the tenant portal (`/tenant-api/settings/email-domains/verify`). An in-hive tenant's Owner uses the same tenant portal served by its console: the console forwards the request over the agent channel (`POST /agent/hives/:id/console/verify-domain`) and learns tokens and states from the advert answer. A daily re-check marks domains unverified when their record is gone.

**Tech Stack:** TypeScript (Node ESM, `node:test` via `tsx --test`), `node:dns/promises`, Mural `.mu` views, `@pragmatic-tech-ai/todl-runtime` `Observable` / `Signal`.

**Spec:** `docs/superpowers/specs/2026-11-06-in-hive-follow-ups-design.md`, section "G5 DNS TXT domain verification", including the user decision of 2026-11-06.

## Global Constraints

- Another plan (Plan A) may run first in this repo. It moves JSON writers onto `AtomicJsonFile`, adds graph routes and adds a console registration state. Do not depend on it. Line numbers in this plan may have shifted, so read the code at each named symbol before you edit.
- OOP: no module-level functions or variables. Every function is a method or a static member. Module-level `const` is allowed only for true compile-time constants.
- Allman braces: every opening brace goes on its own line, and `else` / `catch` / `finally` each start their own line. Object literals, block-bodied arrows and genuine one-line blocks stay inline.
- PascalCase for public members and interfaces. Plain data-shape properties that mirror JSON wire fields keep camelCase.
- TS string literals go into `private static readonly` PascalCase constants. `.mu` labels stay inline. Use enums rather than sets of strings.
- View models extend `Observable`. Tests live in `tests/` subfolders.
- New files are ASCII with LF line endings, and CRLF files keep CRLF. `agent-channel-host.ts` and `admin/tenant-portal/src/tenant-api-client.ts` are CRLF. `control-plane-host.ts` and `tenant-api/tenant-api-endpoint.ts` contain non-ASCII characters, so keep them byte-for-byte outside your edit.
- No explicit Width/Height in `.mu`.
- Secrets are never logged. A domain token is not a secret, but it is never accepted from a client: every Verify body is `{ domain }` only, and the server always uses its stored token.
- Use editor tools only, and stage explicitly (`git add <paths>`, never `-A`).
- Merge locally and never push.
- Gates (all must pass at the end of every task that touches the area):
  - `cd admin/control-plane && npx tsx --test tests/*.test.ts`
  - `npm run typecheck:tools` (repo root)
  - `npm --prefix admin/portal run typecheck && npm --prefix admin/portal test`
  - `npm --prefix admin/tenant-portal run typecheck && npm --prefix admin/tenant-portal test`
- Fixed values from the spec and this plan:
  - TXT name: `_pragmatic-verification.<domain>`. The value is `pragmatic-domain-verification=<token>`.
  - Token: 32 random bytes as base64url (43 chars, `/^[A-Za-z0-9_-]{43}$/`).
  - Effective rule: a domain is effective when it is claimed AND not revoked AND (approved OR (verified AND NOT contested)). Contested means that another tenant also claims it.
  - The five row state labels are exactly `Approved`, `Verified`, `Verified, contested - needs approval`, `Revoked` and `Pending`. The verification labels are `Verified` and `Not verified`.
- Numbers left to the builder by the spec, decided here:
  - Lookups are throttled per tenant with `AuditThrottle({ maxHits: 10, windowMs: 15 min, lockoutMs: 15 min })`, keyed by tenant id.
  - Resolver: `timeout: 3000`, `tries: 2`, and a hard deadline of 10000 ms that calls `cancel()`.
  - The re-check runs once at start and then every 24 h.

## Review Focus

1. The resolver hangs or times out. The user expects Verify to answer 503 with a plain sentence within about 10 s and to leave the stored state alone. The daily re-check must not unverify a domain because of a failed lookup. Tested in Tasks 1, 4 and 5.
2. A long TXT value split into several character-strings (`[['pragmatic-domain-verification=abc', 'def']]`) is joined before comparing and verifies. Tested in Task 1.
3. Several TXT values at the name (an SPF record, another tenant's token, ours) verify when any one of them is ours exactly. Another tenant's token alone does not verify. Tested in Task 1.
4. A domain given in mixed case or with a trailing dot (`Acme.TEST.`) is normalised before the record name is built and before it is matched against claims. Tested in Tasks 1 and 4.
5. A verified domain that is contested becomes effective, with no operator action, as soon as the other tenant drops its claim. It leaves discovery again when the domain becomes contested once more. Tested in Tasks 3 and 4.

---

### Task 1: TXT record format, resolver seam and verifier

**Files:**
- Create: `admin/control-plane/domain-verification-record.ts`
- Create: `admin/control-plane/txt-resolver.ts`
- Test: `admin/control-plane/tests/domain-verification-record.test.ts`, `admin/control-plane/tests/txt-resolver.test.ts`

**Interfaces:**
- Produces, in `domain-verification-record.ts`:
  - `export enum DomainApprovalState { Approved = 'approved', Verified = 'verified', VerifiedContested = 'verified-contested', Revoked = 'revoked', Pending = 'pending' }`
  - `export type DomainVerificationAnswer = { domain: string; token: string; verified: boolean; state: DomainApprovalState; lastCheckedAt?: string }`
  - `export type DomainVerificationView = DomainVerificationAnswer & { recordName: string; recordValue: string }`
  - `export class DomainVerificationRecord` with these static members:
    - `NamePrefix = '_pragmatic-verification.'` and `ValuePrefix = 'pragmatic-domain-verification='`
    - `TokenPattern = /^[A-Za-z0-9_-]{43}$/`
    - `NewToken(): string`
    - `NameFor(domain: string): string`, which normalises via `EmailDomainPolicy.Normalise`
    - `ValueFor(token: string): string`
    - `Matches(records: readonly (readonly string[])[], token: string): boolean`
    - `ViewOf(answer: DomainVerificationAnswer): DomainVerificationView`
    - `ParseAnswer(value: unknown): DomainVerificationAnswer | undefined`
- Produces, in `txt-resolver.ts`:
  - `export enum TxtLookupStatus { Found = 'found', NoRecord = 'no-record', Failed = 'failed' }`
  - `export type TxtLookup = { status: TxtLookupStatus; records: string[][] }`
  - `export interface ITxtResolver { ResolveTxt(name: string): Promise<TxtLookup> }`. It never throws.
  - `export interface IDnsTxtBackend { resolveTxt(name: string): Promise<string[][]>; cancel(): void }`. The real `Resolver` satisfies it.
  - `export class NodeTxtResolver implements ITxtResolver`, with constructor `(backend: IDnsTxtBackend = new Resolver({ timeout: 3000, tries: 2 }), deadlineMs: number = 10000)`
  - `export enum DomainCheck { Verified = 'verified', Absent = 'absent', Mismatch = 'mismatch', Failed = 'failed' }`
  - `export class DomainTxtVerifier`, with constructor `(resolver: ITxtResolver)` and `Check(domain: string, token: string): Promise<DomainCheck>`

- [ ] **Step 1: Write the failing tests**

`tests/domain-verification-record.test.ts`:
- `NameFor normalises case and one trailing dot`: `NameFor('Acme.TEST.')` returns `'_pragmatic-verification.acme.test'`.
- `ValueFor prefixes the token`: `ValueFor('t')` returns `'pragmatic-domain-verification=t'`.
- `NewToken is 43 base64url chars and differs per call`: the token matches `TokenPattern`, and two calls give different tokens.
- `Matches joins chunks of one record`: `Matches([['pragmatic-domain-verification=ab', 'cd']], 'abcd')` is `true`.
- `Matches any of several records`: `Matches([['v=spf1 -all'], ['pragmatic-domain-verification=other'], ['pragmatic-domain-verification=mine']], 'mine')` is `true`. With only the first two records it is `false`.
- `Matches trims surrounding whitespace but is exact otherwise`: `[[' pragmatic-domain-verification=mine ']]` matches. `[['pragmatic-domain-verification=MINE']]` does not match `'mine'`, and neither does `[['pragmatic-domain-verification=mine2']]`.
- `ParseAnswer accepts a well-formed answer and drops anything else`:
  - A well-formed object with a 43-char token round-trips.
  - Each of these returns `undefined`: a bad token, an unknown state, a non-boolean `verified`, a `lastCheckedAt` that `Date.parse` rejects, a domain that `EmailDomainPolicy.CheckSyntax` refuses, and an array.

`tests/txt-resolver.test.ts`:
- `NodeTxtResolver answers Found with the records`, using a fake backend that resolves `[['a','b']]`.
- `ENODATA and ENOTFOUND read as NoRecord`: the fake rejects with `Object.assign(new Error(), { code: 'ENODATA' })`, and the same for `ENOTFOUND`.
- `ETIMEOUT, ESERVFAIL and unknown errors read as Failed`.
- `a backend that never settles reads as Failed after the deadline and is cancelled`: the fake returns a never-settling promise, and `cancel()` resolves nothing. Use `deadlineMs = 20`. The result is `Failed`, and the fake's `cancel` was called once.
- `DomainTxtVerifier maps Found+match to Verified, Found without match to Mismatch, NoRecord to Absent, Failed to Failed`. Use a fake `ITxtResolver` that records the queried name, and assert that `Check('Acme.TEST.', tok)` queried `'_pragmatic-verification.acme.test'`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd admin/control-plane && npx tsx --test tests/domain-verification-record.test.ts tests/txt-resolver.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Implement both files**

- `NewToken` uses `randomBytes(32).toString('base64url')`.
- `Matches` compares `chunks.join('').trim() === ValueFor(token)` for each record.
- `NodeTxtResolver.ResolveTxt` races `backend.resolveTxt(name)` against a `setTimeout(deadlineMs)`. The timer calls `backend.cancel()` and settles `Failed`, and it is cleared once the race settles.
- Name the no-record error codes as static constants: `NoDataCode = 'ENODATA'` and `NotFoundCode = 'ENOTFOUND'`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/domain-verification-record.ts admin/control-plane/txt-resolver.ts admin/control-plane/tests/domain-verification-record.test.ts admin/control-plane/tests/txt-resolver.test.ts
git commit -m "feat(control-plane): TXT record format, resolver seam and domain verifier"
```

---

### Task 2: Approvals store tokens, verification, revokes and the effective rule; DomainClaims

**Files:**
- Modify: `admin/control-plane/console-domain-approvals.ts` (whole class)
- Create: `admin/control-plane/domain-claims.ts`
- Test: `admin/control-plane/tests/console-domain-approvals.test.ts` (new), `admin/control-plane/tests/domain-claims.test.ts` (new). Also update the two `EffectiveDomains` tests in `admin/control-plane/tests/console-advert-registry.test.ts` (around lines 184-198) to the new signature.

**Interfaces:**
- Consumes `DomainApprovalState` and `DomainVerificationRecord.NewToken` from Task 1.
- Produces, in `console-domain-approvals.ts`:
  - `export type DomainVerificationEntry = { token: string; verified: boolean; lastCheckedAt?: string }`
  - `export type ConsoleDomainApprovalRecord = { id: string; tenantId: string; domains: string[]; revoked?: string[]; verifications?: Record<string, DomainVerificationEntry> }`. A legacy record without the two optional fields reads as empty.
  - `export type DomainStanding = { approved: readonly string[]; revoked: readonly string[]; verified: readonly string[] }`
  - `ConsoleDomainApprovals` methods:
    - `ApprovedFor` stays as it is.
    - `RevokedFor(tenantId): readonly string[]`
    - `VerificationOf(tenantId, domain): DomainVerificationEntry | undefined`
    - `StandingOf(tenantId): DomainStanding`
    - `Approve` / `ApproveAll` also clear those domains from `revoked`.
    - `Revoke(tenantId, domain)` removes the domain from `domains` and ALWAYS adds it to `revoked`. It is idempotent.
    - `EnsureTokens(tenantId, domains: readonly string[]): Promise<void>` does one write when any normalised domain lacks a token, and none otherwise.
    - `RecordCheck(tenantId, domain, verified: boolean, checkedAt: string): Promise<void>` is a no-op when the domain has no token.
    - `VerifiedEntries(): Array<{ tenantId: string; domain: string; token: string }>`, sorted by tenantId, then domain.
    - `ForgetTenant` stays as it is.
    - `static StateOf(standing: DomainStanding, domain: string, contested: boolean): DomainApprovalState`
    - `static EffectiveDomains(claimed: readonly string[], standing: DomainStanding, contested: ReadonlySet<string>): string[]`, which replaces the old two-array signature.
- Produces, in `domain-claims.ts`:
  - `export interface IDomainClaimDirectory { ListTenants(): readonly TenantRecord[]; ListHives(tenantId: string): readonly HiveRecord[] }`
  - `export class DomainClaims` with:
    - `static Collect(directory: IDomainClaimDirectory, adverts: IConsoleAdvertLookup | undefined): DomainClaims`
    - `ClaimedBy(tenantId): readonly string[]`
    - `OthersClaiming(tenantId, domain): string[]`, sorted
    - `ContestedFor(tenantId): ReadonlySet<string>`
  - The claim rule moves here from `PlatformEmailDomains.ClaimedDomainsOf`. An in-hive tenant (`HiveConsoleSpecs.ConsoleHiveOf(hives) !== undefined`) claims its usable advert's `emailDomains` (`ConsoleAdvertRegistry.UsableFor`), and any other tenant claims its record's `emailDomains`. Domains are normalised.

State precedence, which `StateOf` implements exactly:

| Condition, checked in order | State |
|---|---|
| domain in `revoked` | `Revoked` |
| domain in `approved` | `Approved` |
| domain in `verified` and not contested | `Verified` |
| domain in `verified` and contested | `VerifiedContested` |
| otherwise | `Pending` |

`EffectiveDomains` returns the claimed domains (normalised, deduped, sorted) whose `StateOf` is `Approved` or `Verified`.

- [ ] **Step 1: Write the failing tests**

`tests/console-domain-approvals.test.ts`. Each test uses a temp data dir and reloads to prove durability where it writes:
- `EnsureTokens issues one token per domain, normalised, and keeps it`: `EnsureTokens('acme', ['Acme.TEST.'])` gives `VerificationOf('acme','acme.test')?.token` matching `TokenPattern`. A second `EnsureTokens` keeps the same token and does not write: override `WriteText` in a subclass and count the calls.
- `RecordCheck stores verified and lastCheckedAt, and is a no-op without a token`.
- `Revoke stores a revoke even for a domain never approved, and Approve clears it`: `RevokedFor` is `['x.test']`, and after `Approve` it is `[]` while `ApprovedFor` holds the domain.
- `Revoke removes an approval and keeps the token`.
- `a legacy record without revoked or verifications reads as empty`: write `{ approvals: { acme: { id, tenantId, domains: ['a.test'] } } }` to the file, call `Load`, and check that `StandingOf` gives `{ approved: ['a.test'], revoked: [], verified: [] }`.
- `the record is removed only when approved, revoked and verifications are all empty`.
- `StateOf follows the precedence table`: one assertion per table row, plus "revoked beats approved+verified".
- `EffectiveDomains: approved, or verified and uncontested, never revoked`:
  - With claimed `['a.test','b.test','c.test','d.test']` and standing `{ approved: ['a.test'], revoked: ['d.test'], verified: ['b.test','c.test','d.test'] }`, contested `{'c.test'}` gives `['a.test','b.test']`.
  - With contested `{}` it gives `['a.test','b.test','c.test']`.
- `EffectiveDomains ignores an approved or verified domain that is not claimed`.

`tests/domain-claims.test.ts`:
- `a control-plane tenant claims its record domains, normalised`.
- `an in-hive tenant claims its usable advert domains and not its record domains`. Use a fake `IConsoleAdvertLookup` built the way `tests/platform-email-domains.test.ts` builds one.
- `OthersClaiming and ContestedFor see the other tenants' claims`.
- `a domain stops being contested once the other tenant drops it`. Rebuild with the other tenant's record changed: `ContestedFor` is then empty.

In `tests/console-advert-registry.test.ts`, port the two `EffectiveDomains` tests to `EffectiveDomains(claimed, { approved, revoked: [], verified: [] }, new Set())` and keep their assertions.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd admin/control-plane && npx tsx --test tests/console-domain-approvals.test.ts tests/domain-claims.test.ts tests/console-advert-registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Each mutator reads the record, builds the new one and calls `Put` synchronously, with no `await` before `Put`. That keeps every read-modify-stage atomic with respect to other mutators, because `JsonRecordStore.Put` stages before its first await.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: same as Step 2. Expected: PASS. Keep the typecheck green with a temporary bridge:
- Keep the old body as `static EffectiveDomainsLegacy(claimed: readonly string[], approved: readonly string[]): string[]`.
- Switch the two existing callers to it: `desktop-tenant-matcher.ts` `EffectiveDomainsOf` and `platform-email-domains.ts` `ViewOf`.
- Task 3 moves the matcher off it, and Task 4 moves `PlatformEmailDomains` off it and deletes it.

Run: `npm run typecheck:tools`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/console-domain-approvals.ts admin/control-plane/domain-claims.ts admin/control-plane/tests/console-domain-approvals.test.ts admin/control-plane/tests/domain-claims.test.ts admin/control-plane/tests/console-advert-registry.test.ts
git commit -m "feat(control-plane): domain tokens, verification, revokes and the effective rule"
```

---

### Task 3: Discovery uses the effective rule

**Files:**
- Modify: `admin/control-plane/desktop-tenant-matcher.ts`. Change `IDomainApprovalSource` (around line 24), `Match` (around line 69), `MatchAdverts` (around line 83), `MatchRecordDomains` (around line 132) and `EffectiveDomainsOf` (around line 169).
- Test: `admin/control-plane/tests/desktop-tenant-matcher.test.ts`

**Interfaces:**
- Consumes `ConsoleDomainApprovals.EffectiveDomains(claimed, standing, contested)` and `DomainClaims.Collect` / `ContestedFor` from Task 2.
- Produces `export interface IDomainApprovalSource { StandingOf(tenantId: string): DomainStanding }`, which `ConsoleDomainApprovals` satisfies.
- `Match` builds `DomainClaims.Collect(this.directory, this.adverts)` once per call and passes it to `EffectiveDomainsOf(tenantId, claimed, claims)`.
- `IDiscoveryDirectory` already has `ListTenants` and `ListHives`, so it satisfies `IDomainClaimDirectory`.
- Update the class doc comment to the new rule.

- [ ] **Step 1: Write the failing tests** (in the existing describe, reusing the file's fixtures)

- `a verified, uncontested domain matches without an operator approval`.
- `a verified domain another tenant also claims does not match until an operator approves it`.
- `a contested verified domain matches as soon as the other tenant drops its claim`. Match, change the other tenant's record domains in the fake directory, then match again with the same matcher. The first match is empty and the second finds the tenant. This is Review Focus 5.
- `it leaves discovery again when another tenant claims it`, which is the reverse of the test above.
- `a revoked verified domain does not match`.
- `an operator-approved contested domain still matches`, which keeps today's behaviour.
- `an in-hive tenant's verified advert domain matches, pointing at its console`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd admin/control-plane && npx tsx --test tests/desktop-tenant-matcher.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement the matcher change**

The matcher stops using `EffectiveDomainsLegacy`. Update every fake `IDomainApprovalSource` in tests (grep `ApprovedFor(` in `tests/desktop-*.test.ts`) to `StandingOf`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd admin/control-plane && npx tsx --test tests/desktop-*.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/desktop-tenant-matcher.ts admin/control-plane/tests/desktop-tenant-matcher.test.ts
git commit -m "feat(control-plane): discovery honours verified uncontested domains"
```

Also add each other test file you changed by name.

---

### Task 4: PlatformEmailDomains reports states and verifies domains

**Files:**
- Modify: `admin/control-plane/tenant-api/tenant-email-domains.ts`. Change the view type, the interface, and add the new errors.
- Modify: `admin/control-plane/platform-email-domains.ts`. Change the types at the top, the constructor (around line 75), `Report` (around line 89), `For` / `ViewOf`, `Approve` (around line 157), `Revoke` (around line 181), and the claim helpers. The helpers are replaced by `DomainClaims`.
- Modify: `admin/control-plane/console-domain-approvals.ts`: delete `EffectiveDomainsLegacy` from Task 2.
- Test: `admin/control-plane/tests/platform-email-domains.test.ts`

**Interfaces:**
- Consumes everything from Tasks 1 and 2, plus `AuditThrottle` (`audit-throttle.ts`: `CheckAllowed(key)` and `RecordHit(key)`).
- Produces, in `tenant-email-domains.ts`:
  - `TenantEmailDomainsView = { domains: string[]; editable: boolean; inHive: boolean; pending: string[]; verifications: DomainVerificationView[] }`. `verifications` holds one entry per claimed domain that has a token, in `domains` order.
  - `ITenantEmailDomains`:
    - `For(tenantId): Promise<TenantEmailDomainsView>`. It is now async.
    - `Set` stays as it is.
    - `Verify(tenantId: string, domain: string): Promise<TenantEmailDomainsView>`, which throws the errors below.
  - Errors, each carrying one plain sentence:
    - `DomainNotClaimedError`, which maps to 409.
    - `DomainVerifyThrottledError`, which maps to 429.
    - `DomainVerificationUnavailableError`, which maps to 503.
- Produces, in `platform-email-domains.ts`:
  - `EmailDomainApproval = { domain; approved; claimed; sharedWith; state: DomainApprovalState; verified: boolean; lastCheckedAt?: string; recordName?: string; recordValue?: string }`. The record fields are present when a token exists.
  - The constructor gains `private readonly verifier?: DomainTxtVerifier` and `private readonly throttle: AuditThrottle = new AuditThrottle({ maxHits: 10, windowMs: 15 * 60 * 1000, lockoutMs: 15 * 60 * 1000 })`. The numbers are static constants.
  - `Report(tenantId): Promise<TenantEmailDomainsReport | undefined>`. It is now async and calls `EnsureTokens` for the claimed domains first.
  - `For(tenantId): Promise<TenantEmailDomainsView>` also calls `EnsureTokens` for the claimed domains, and `pending` uses the new rule.
  - `VerifyDomain(tenantId: string, domain: string): Promise<DomainVerificationAnswer>`
  - `Verify(tenantId, domain): Promise<TenantEmailDomainsView>` calls `VerifyDomain` and then `For`.
  - `AnswersFor(tenantId: string, domains: readonly string[]): Promise<DomainVerificationAnswer[]>` ensures tokens for `domains` and answers one entry per domain, in order.
  - `Approve` and `Revoke` keep their signatures. Revoke now always records a revoke (Task 2).

`VerifyDomain` runs these steps in order:
1. `KnownTenant`.
2. `EmailDomainPolicy.Normalise`, then `CheckSyntax`. A refusal throws `InvalidEmailDomainError`.
3. The domain must be in `DomainClaims.ClaimedBy(tenantId)`. If it is not, throw `DomainNotClaimedError`: `<domain> is not among this tenant's email domains, so there is nothing to verify.`
4. With no verifier, throw `DomainVerificationUnavailableError`: `DNS verification is not available on this control plane.`
5. `throttle.CheckAllowed(tenantId)`. If it refuses, throw `DomainVerifyThrottledError`: `Too many verification attempts for this tenant. Try again in a few minutes.`
6. `throttle.RecordHit(tenantId)`.
7. `EnsureTokens(tenantId, [domain])`.
8. `verifier.Check(domain, token)`. A `Failed` result throws `DomainVerificationUnavailableError` with `The DNS lookup for <recordName> did not complete. Try again later.` and leaves the store untouched.
9. Otherwise call `RecordCheck(tenantId, domain, check === DomainCheck.Verified, now().toISOString())` and answer with the domain's state. `now` is a constructor parameter defaulting to `() => new Date()`, placed after `throttle`.

- [ ] **Step 1: Write the failing tests** (fake `ITxtResolver` in the test file)

- `Report issues tokens and shows the record for each claimed domain`: `recordName` is `_pragmatic-verification.acme.test`, `recordValue` starts with `pragmatic-domain-verification=`, `verified` is false and `state` is `Pending`.
- `VerifyDomain with a matching record verifies, and the row reads Verified`. `For` then has `pending` without the domain.
- `VerifyDomain normalises Acme.TEST. and queries the lowercase name`. This is Review Focus 4.
- `a verified domain another tenant claims reads VerifiedContested and stays pending; once the other tenant drops it, it reads Verified`. This is Review Focus 5.
- `a revoke keeps a verified domain Revoked until an operator approves it`.
- `a missing record records Not verified with lastCheckedAt, a changed record too`.
- `a failed lookup throws DomainVerificationUnavailableError and leaves verified and lastCheckedAt unchanged`. Verify first, then fail: the stored entry stays as it was. This is Review Focus 1.
- `after 10 lookups for one tenant in the window, the next throws DomainVerifyThrottledError without a lookup, and another tenant is unaffected`. Assert against `AuditThrottle`'s actual lock point.
- `VerifyDomain refuses an unclaimed domain (DomainNotClaimedError) and a malformed one (InvalidEmailDomainError), before any lookup`. The fake resolver records zero calls.
- `without a verifier VerifyDomain throws DomainVerificationUnavailableError`.
- `AnswersFor issues tokens and answers states in the given order`.
- Port the existing `Report` and `For` tests in this file to `await`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd admin/control-plane && npx tsx --test tests/platform-email-domains.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ClaimsOfOthers`, `ClaimedDomainsOf` and `SharedWith` become calls into one `DomainClaims.Collect(this.directory, this.adverts)` per public call. `sharedWith` is `OthersClaiming`. Update `ConsoleEmailDomainStore.For` to `async` (returning `verifications: []` for now) so the interface typechecks; Task 9 fills it. Add a `Verify` that throws `DomainVerificationUnavailableError('Domain verification is not available on this console.')` as a placeholder; Task 9 replaces it. Update `tenant-api-endpoint.ts` to `await store.For(...)`; the endpoint's new route is Task 7. Fix every remaining compile error from the async change (`npm run typecheck:tools`).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd admin/control-plane && npx tsx --test tests/*.test.ts && cd ../.. && npm run typecheck:tools`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/tenant-api/tenant-email-domains.ts admin/control-plane/platform-email-domains.ts admin/control-plane/console-domain-approvals.ts admin/control-plane/console-email-domain-store.ts admin/control-plane/tenant-api/tenant-api-endpoint.ts admin/control-plane/tests/platform-email-domains.test.ts
git commit -m "feat(control-plane): email domain states and DNS verification"
```

Also add each other test file you changed by name.

---

### Task 5: Daily re-check and composition

**Files:**
- Create: `admin/control-plane/domain-verification-rechecker.ts`
- Modify: `admin/control-plane/server.ts`. Change the approvals and `PlatformEmailDomains` composition (around lines 251-283), and close the re-checker on shutdown next to the server's other shutdown hooks (`CloseOnShutdown`, around line 696).
- Test: `admin/control-plane/tests/domain-verification-rechecker.test.ts`

**Interfaces:**
- Consumes `ConsoleDomainApprovals.VerifiedEntries` / `RecordCheck` (Task 2), `DomainTxtVerifier` (Task 1), and `IAdvertTimer` / `IntervalAdvertTimer` from `console-advert-sender.ts` (a generic unref'd interval).
- Produces `export class DomainVerificationRechecker`:
  - Constructor: `(approvals: ConsoleDomainApprovals, verifier: DomainTxtVerifier, timer: IAdvertTimer = new IntervalAdvertTimer(), log: (line: string) => void = line => console.error(line), now: () => Date = () => new Date())`
  - `static readonly IntervalMs = 24 * 60 * 60 * 1000`
  - `Start(): void` runs one `RunOnce` (not awaited, never throws) and then every `IntervalMs`.
  - `Stop(): void`
  - `RunOnce(): Promise<RecheckSummary>`, where `RecheckSummary = { checked: number; unverified: number; failed: number }`.
  - It checks the entries one at a time. `Verified` refreshes `lastCheckedAt`. `Absent` or `Mismatch` records `verified: false` with `lastCheckedAt`. `Failed` changes nothing and counts as failed.
  - It logs one line `[domain-recheck] <unverified> domains no longer verified, <failed> lookups failed` only when either count is non-zero.
  - Overlapping runs are skipped: a tick while a run is in flight does nothing.
  - It bypasses the per-tenant throttle on purpose.
- `server.ts` builds `new PlatformEmailDomains(directory, adverts, approvals, new DomainTxtVerifier(new NodeTxtResolver()))` and starts the re-checker after `approvals.Load()`.

- [ ] **Step 1: Write the failing tests**

- `RunOnce keeps a still-present record verified and refreshes lastCheckedAt`.
- `RunOnce marks a domain whose record is gone or changed unverified, and deletes nothing`. The token and any approval stay.
- `RunOnce leaves a domain verified when its lookup fails`. This is Review Focus 1.
- `RunOnce checks only verified entries`. The fake resolver records the names it was asked for.
- `Start runs once at once and on each tick; a tick during a run is skipped; Stop ends the timer`. Use a manual fake `IAdvertTimer` like the one in `tests/console-advert-sender.test.ts`.
- `the log line carries counts only`. It must not contain the token.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd admin/control-plane && npx tsx --test tests/domain-verification-rechecker.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the re-checker and wire `server.ts`**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd admin/control-plane && npx tsx --test tests/*.test.ts && cd ../.. && npm run typecheck:tools`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/domain-verification-rechecker.ts admin/control-plane/server.ts admin/control-plane/tests/domain-verification-rechecker.test.ts
git commit -m "feat(control-plane): daily DNS re-check of verified email domains"
```

---

### Task 6: Operator verify route

**Files:**
- Modify: `admin/control-plane/control-plane-host.ts`. Change `TenantEmailDomainsPathPattern` (around line 342), the error table (around line 505) and `RouteTenantEmailDomains` (around line 1683).
- Test: `admin/control-plane/tests/control-plane-host-email-domains.test.ts`

**Interfaces:**
- Consumes `PlatformEmailDomains.VerifyDomain` and the async `Report` (Task 4), plus the three errors (Task 4).
- Produces `POST /api/tenants/ID/email-domains/verify` with body `{ domain }`:
  - It answers 200 with the fresh report.
  - The route accepts `verify` as a third action next to `approve` / `revoke`, through a new `VerifySegment = 'verify'`.
  - It is Full-gated and audited like approve. The audit note is `domain: <normalised>`, taken from the answer's `domain`.
  - Errors: `DomainNotClaimedError` 409, `DomainVerifyThrottledError` 429, `DomainVerificationUnavailableError` 503.
  - Any `token` key in the body is ignored.

- [ ] **Step 1: Write the failing tests**

Use the file's existing host fixture, extended with a fake resolver passed to `PlatformEmailDomains`.
- `POST verify with a matching record answers the report with state Verified and audits the domain`.
- `POST verify for an unclaimed domain is 409, for a malformed one 400`.
- `POST verify while the lookup fails is 503 with the sentence and changes nothing`.
- `POST verify past the tenant limit is 429`.
- `a token in the body is ignored`: the stored token is unchanged and the record looked for uses the stored token.
- `a read-only operator gets 403 on verify`. Copy the existing RBAC assertion for approve.
- `GET answers each row's state, recordName and recordValue`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd admin/control-plane && npx tsx --test tests/control-plane-host-email-domains.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

`Report` is now awaited.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd admin/control-plane && npx tsx --test tests/*.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/control-plane-host.ts admin/control-plane/tests/control-plane-host-email-domains.test.ts
git commit -m "feat(control-plane): operator route to verify an email domain"
```

---

### Task 7: Tenant-plane verify route

**Files:**
- Modify: `admin/control-plane/tenant-api/tenant-api-endpoint.ts`. Change `EmailDomainsPath` (around line 75), `Handle` (around line 186), `RouteEmailDomains` (around line 574) and `WriteEmailDomains` (around line 634).
- Test: `admin/control-plane/tests/tenant-api-email-domains.test.ts`

**Interfaces:**
- Consumes `ITenantEmailDomains.Verify` and the three errors (Task 4).
- Produces `POST /tenant-api/settings/email-domains/verify` with body `{ domain }` (`EmailDomainsVerifyPath = EmailDomainsPath + '/verify'`):
  - It requires `SettingsCapability`, so only the Owner may call it; anyone else gets 403.
  - It always uses the session's tenant id, never one from the body.
  - It answers 200 with the view, which `WriteEmailDomains` now writes including `verifications`.
  - Errors: 400 for a missing or non-string `domain` (`'domain (an email domain name) is required'`, a new constant) or an `InvalidEmailDomainError`; 409 for `DomainNotClaimedError` or `EmailDomainsNotEditableError`; 429 for `DomainVerifyThrottledError`; 503 for `DomainVerificationUnavailableError`.
  - Use the same 16 KiB body cap as PUT.
  - The plane's origin (CSRF) check already covers every mutating `/tenant-*` request (`tenant-plane-host.ts`, around line 237).

- [ ] **Step 1: Write the failing tests** (the fake store in the file gains `Verify`)

- `the Owner verifies a domain and gets the view with verifications`.
- `a non-Owner gets 403 and the store is not called`.
- `the session's tenant id is passed, never one from the body`: the body is `{ domain, tenantId: 'other' }`.
- `each store error maps to its status with its sentence (400, 409, 429, 503)`.
- `GET passes verifications through`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd admin/control-plane && npx tsx --test tests/tenant-api-email-domains.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd admin/control-plane && npx tsx --test tests/*.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/tenant-api/tenant-api-endpoint.ts admin/control-plane/tests/tenant-api-email-domains.test.ts
git commit -m "feat(tenant-api): Owner route to verify an email domain"
```

---

### Task 8: Agent channel carries verifications and serves verify-domain

**Files:**
- Modify: `admin/control-plane/console-advert-receiver.ts`. Change the constructor (around line 108), `Receive` (around line 116) and `ConsoleAdvertOutcome` (around line 80), and add `VerifyDomain`.
- Modify: `admin/control-plane/agent-channel-host.ts` (CRLF). Change `RoutePattern` (around line 15), the method table (around lines 28-35), `Route`, `ReceiveConsoleAdvert` and `WriteError`.
- Modify: `admin/control-plane/server.ts`. Change the `ConsoleAdvertReceiver` construction (around line 324) to pass `emailDomains`.
- Test: `admin/control-plane/tests/console-advert-receiver.test.ts`, `admin/control-plane/tests/agent-channel-host.test.ts`

**Interfaces:**
- Consumes `PlatformEmailDomains.AnswersFor` / `VerifyDomain` (Task 4).
- Produces, in `console-advert-receiver.ts`:
  - `export interface IConsoleDomainVerifications { AnswersFor(tenantId: string, domains: readonly string[]): Promise<DomainVerificationAnswer[]>; VerifyDomain(tenantId: string, domain: string): Promise<DomainVerificationAnswer> }`
  - The constructor gains a fifth parameter `domains?: IConsoleDomainVerifications`.
  - `ConsoleAdvertOutcome` gains `domainVerifications?: DomainVerificationAnswer[]`. It is set when `domains` is given, for the accepted domains, after the advert is stored.
  - `VerifyDomain(hiveId: string, body: unknown): Promise<DomainVerificationAnswer>` throws `ConsoleNotEnabledError` when the hive has no console. It throws `InvalidConsoleAdvertError(BadVerifyShape)` for a body that is not `{ domain: string }`, where `BadVerifyShape = 'The verify request must be a JSON object with domain.'`. Without `domains` it throws `DomainVerificationUnavailableError`. Otherwise it calls `domains.VerifyDomain(hive.tenantId, domain)`.
- Produces, in `agent-channel-host.ts`:
  - The segment `VerifyDomainSegment = 'console/verify-domain'` uses POST and is mounted when an advert receiver is given. `RoutePattern` becomes `/^\/agent\/hives\/([^/]+)\/(target|snapshot|adoptable|status|adopt|ledger|console|console\/verify-domain)$/`.
  - The bearer is verified exactly as for every other route.
  - It answers 200 `{ verification: DomainVerificationAnswer }`.
  - The advert answer adds `domainVerifications` when the outcome has it.
  - `WriteError` gains fixed-text mappings, never `err.message`:
    - `InvalidEmailDomainError`: 400 `'Invalid email domain'`
    - `DomainNotClaimedError`: 409 `'Domain is not among the reported email domains'`
    - `DomainVerifyThrottledError`: 429 `'Too many verification attempts'`
    - `DomainVerificationUnavailableError`: 503 `'Domain verification unavailable'`

- [ ] **Step 1: Write the failing tests**

`console-advert-receiver.test.ts`:
- `the outcome carries one verification answer per accepted domain, with tokens`.
- `without a verification source the outcome has no domainVerifications`.
- `VerifyDomain forwards the hive's tenant and the domain only`: the fake records `(tenantId, domain)`, and a `token` in the body never reaches it.
- `VerifyDomain refuses a hive without a console (409 error) and a malformed body`.

`agent-channel-host.test.ts`:
- `POST /agent/hives/h1/console/verify-domain with the hive bearer answers { verification }`.
- `a wrong bearer is 401 and nothing is verified`.
- `GET on verify-domain is 404`.
- `each verification error maps to its fixed text`: one case per status (400, 409, 429, 503), each asserting that the body does not contain the inner message.
- `the advert answer carries domainVerifications`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd admin/control-plane && npx tsx --test tests/console-advert-receiver.test.ts tests/agent-channel-host.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

Keep `agent-channel-host.ts` CRLF: check the file with `file` before you commit.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd admin/control-plane && npx tsx --test tests/*.test.ts && cd ../.. && npm run typecheck:tools`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/console-advert-receiver.ts admin/control-plane/agent-channel-host.ts admin/control-plane/server.ts admin/control-plane/tests/console-advert-receiver.test.ts admin/control-plane/tests/agent-channel-host.test.ts
git commit -m "feat(agent-channel): advert answer carries domain verifications; verify-domain route"
```

---

### Task 9: Console takes verifications and forwards Verify

**Files:**
- Modify: `admin/control-plane/console-advert-contract.ts` (`ConsoleAdvertAnswer`)
- Modify: `admin/control-plane/console-advert-sender.ts`. Change `HttpConsoleAdvertTransport` (`MaxAnswerBytes`, `AnswerOf`, and a new `VerifyDomain`) and `ConsoleAdvertSender.SendOnce`.
- Modify: `admin/control-plane/console-email-domain-store.ts`. Change `For` and `Verify`, and add `AdoptVerifications` and `AttachVerifyChannel`.
- Modify: `admin/control-plane/tenant-admin-server.ts`. Change `AdvertSenderOf` (around line 187) to attach the transport as the store's verify channel.
- Test: `admin/control-plane/tests/console-advert-sender.test.ts`, `admin/control-plane/tests/console-email-domain-store.test.ts`

**Interfaces:**
- Consumes `DomainVerificationRecord.ParseAnswer` / `ViewOf` (Task 1) and the three errors (Task 4).
- Produces:
  - `ConsoleAdvertAnswer = { ownerResetAt?: string; domainVerifications?: DomainVerificationAnswer[] }`. Update its doc comment.
  - `HttpConsoleAdvertTransport`:
    - `MaxAnswerBytes = 32768`. Rewrite the arithmetic in the comment: the refused list is about 5.2 KB, and 20 answers x (253 + 43 + about 110 for keys, state and time) is about 8.1 KB, which comes to roughly 13.4 KB in total.
    - `AnswerOf` keeps `domainVerifications` when it is an array, keeps each entry `ParseAnswer` accepts, and keeps at most `EmailDomainPolicy.MaxDomains` of them.
  - `export interface IConsoleDomainVerifyChannel { VerifyDomain(domain: string): Promise<DomainVerificationAnswer> }`, in `console-email-domain-store.ts`.
  - `HttpConsoleAdvertTransport` implements `IConsoleDomainVerifyChannel`:
    - It POSTs `{ domain }` to `<base>/agent/hives/<id>/console/verify-domain` with the bearer and the same timeout, and reads the body through the existing bounded read.
    - A 200 answer whose `verification` passes `ParseAnswer` returns it.
    - 409 throws `DomainNotClaimedError('The platform does not list <domain> for this console yet. Try again after the console reports its domains.')`.
    - 429 throws `DomainVerifyThrottledError('Too many verification attempts. Try again in a few minutes.')`.
    - Every other status, an unreachable platform, or a malformed 200 throws `DomainVerificationUnavailableError('The platform could not check the domain. Try again later.')`.
    - The sentences are fixed console text, and the domain in them is the console's own normalised value. The server's body text is never used.
  - `ConsoleEmailDomainStore`:
    - `AdoptVerifications(answers: readonly DomainVerificationAnswer[]): void` keeps, in memory only, the answers for domains currently in the list. It replaces what was held before, and `Apply` drops the answers of removed domains.
    - `AttachVerifyChannel(channel: IConsoleDomainVerifyChannel): void`
    - `For(tenantId): Promise<TenantEmailDomainsView>`. For its own tenant, `verifications` holds the views of the adopted answers in list order, and `pending` holds the own domains whose adopted state is neither `Approved` nor `Verified`. Update the doc comment, which said that pending is always empty.
    - `Verify(tenantId, domain)`:
      1. Another tenant throws `EmailDomainsNotEditableError`.
      2. The domain is normalised. One not in the list throws `DomainNotClaimedError(<domain> + ' is not among this console\'s email domains.')`.
      3. With no channel it throws `DomainVerificationUnavailableError('Domain verification is not available on this console.')`.
      4. Otherwise it calls `channel.VerifyDomain(domain)`. An answer for a different domain throws unavailable.
      5. It merges that one answer and answers `For(tenantId)`.
  - `ConsoleAdvertSender.SendOnce`, after a 200 and when not stopped, calls `this.domains.AdoptVerifications(answer.domainVerifications ?? [])` before `Follow`.

- [ ] **Step 1: Write the failing tests**

`console-advert-sender.test.ts`, which uses the file's local HTTP server fixture for the transport:
- `AnswerOf keeps well-formed domainVerifications and drops malformed entries`.
- `an answer of 20 maximal verifications plus 20 refused domains fits MaxAnswerBytes`.
- `VerifyDomain posts only { domain } with the bearer to the verify-domain path`.
- `VerifyDomain maps 409, 429, 503, unreachable and malformed 200 to the fixed sentences`: each error message must not contain the server's body text.
- `the sender hands a 200 answer's verifications to the store`.

`console-email-domain-store.test.ts`:
- `For shows adopted verifications with recordName and recordValue, and pending from their states`.
- `AdoptVerifications ignores answers for domains not in the list; a Set that drops a domain drops its answer`.
- `Verify forwards the normalised domain and merges the answer`: `Verify('acme', 'Acme.TEST.')` passes `'acme.test'` to the channel.
- `Verify refuses another tenant, an unlisted domain, and works without network only when a channel is attached`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd admin/control-plane && npx tsx --test tests/console-advert-sender.test.ts tests/console-email-domain-store.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement and wire `AttachVerifyChannel` in `TenantAdminServer.AdvertSenderOf`**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd admin/control-plane && npx tsx --test tests/*.test.ts && cd ../.. && npm run typecheck:tools`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/control-plane/console-advert-contract.ts admin/control-plane/console-advert-sender.ts admin/control-plane/console-email-domain-store.ts admin/control-plane/tenant-admin-server.ts admin/control-plane/tests/console-advert-sender.test.ts admin/control-plane/tests/console-email-domain-store.test.ts
git commit -m "feat(console): show domain verification records and forward Verify to the platform"
```

---

### Task 10: Platform portal rows

**Files:**
- Modify: `admin/portal/src/portal-types.ts` (`EmailDomainApprovalDto`, around line 241, and a new enum)
- Modify: `admin/portal/src/api-client.ts` (near `RevokeTenantEmailDomain`, around line 184)
- Modify: `admin/portal/src/sections/tenants/tenant-email-domains-view-model.ts` (`EmailDomainApprovalRowViewModel` and `TenantEmailDomainsViewModel`)
- Modify: `admin/portal/src/sections/tenants/tenants.resources.mu` (`EmailDomainApprovalRowTemplate`, around line 238)
- Test: `admin/portal/src/sections/tenants/tests/tenant-email-domains.test.ts`

**Interfaces:**
- Consumes the operator wire from Task 6.
- Produces:
  - `export enum DomainApprovalState` in `portal-types.ts`, with the same values as Task 1.
  - `EmailDomainApprovalDto` gains `state: DomainApprovalState; verified: boolean; lastCheckedAt?: string; recordName?: string; recordValue?: string`.
  - `ControlPlaneClient.VerifyTenantEmailDomain(tenantId: string, domain: string): Promise<TenantEmailDomainsDto>`, with `VerifySegment = 'verify'`.
  - Row VM:
    - `StatusLabel` comes from `state`: `Approved`, `Verified`, `Verified, contested - needs approval`, `Revoked` or `Pending`. An unclaimed approved row keeps `Approved, no longer claimed`.
    - `VerificationLabel` is `Verified` or `Not verified`.
    - `HasRecord`, `RecordName`, `RecordValue`.
    - `LastCheckedText` is `'Last checked ' + PortalDates.DateTimeLabel(iso)`, or `'Not checked yet'`.
    - `CanVerify` = `CanWrite && claimed && HasRecord`.
    - `CanApprove` = `CanWrite && claimed && state in { Pending, VerifiedContested, Revoked }`.
    - `CanRevoke` = `CanWrite && (approved || state === Verified)`.
    - `VerifyCommand`.
  - Block VM:
    - `VerifyDomain(domain: string): Promise<void>` runs through `Act`.
    - After a successful verify whose row is still not verified, `NoticeText` shows `'No matching TXT record was found yet. DNS changes can take a while to appear; try again later.'` until the next action. Add it to `BoundProperties` if it is a new property.

- [ ] **Step 1: Write the failing tests** (the fake client gains `VerifyTenantEmailDomain`)

- `the row labels follow the state`: one assertion per label, plus `Approved, no longer claimed`.
- `a row shows the record to add and the last check`.
- `Approve is offered for Pending, contested and Revoked rows; Revoke for Approved and Verified rows`.
- `Verify calls the client and shows the refreshed row`.
- `a verify that finds no record shows the notice; a 429 or 503 shows the server's sentence in ErrorText`.
- `a read-only operator gets no Verify`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm --prefix admin/portal test`. Expected: FAIL.

- [ ] **Step 3: Implement the types, client and VMs, and update the row template**

In the template, add one more Star column and a second row under the domain cell. The extra column holds `VerificationLabel` and `LastCheckedText`, and the second row holds the record:

```
TXT  <RecordName>  <RecordValue>
```

Style the record with `@Code` and show it only when `HasRecord`. Add a `Verify` Secondary button beside Approve and Revoke. All labels stay inline in the `.mu`, with no explicit Width or Height.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm --prefix admin/portal run typecheck && npm --prefix admin/portal test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/portal/src/portal-types.ts admin/portal/src/api-client.ts admin/portal/src/sections/tenants/tenant-email-domains-view-model.ts admin/portal/src/sections/tenants/tenants.resources.mu admin/portal/src/sections/tenants/tests/tenant-email-domains.test.ts
git commit -m "feat(portal): email domain verification state, record and Verify"
```

Also add any regenerated `.mu.js` file only if it is tracked: run `git status` to check.

---

### Task 11: Tenant portal (control-plane tenant plane and in-hive console)

**Files:**
- Modify: `admin/tenant-portal/src/tenant-types.ts` (`EmailDomainsDto`, around line 24, and a new enum and DTO)
- Modify: `admin/tenant-portal/src/tenant-api-client.ts` (CRLF; near `SetEmailDomains`, around line 141)
- Modify: `admin/tenant-portal/src/sections/settings/email-domains-editor-view-model.ts`
- Modify: `admin/tenant-portal/src/sections/settings/settings.resources.mu` (Email domains tab, around lines 93-110)
- Test: `admin/tenant-portal/src/sections/settings/tests/email-domains-editor.test.ts`, `admin/tenant-portal/src/tests/tenant-api-client.test.ts`

**Interfaces:**
- Consumes the tenant-plane wire from Task 7. The console serves the same wire (Task 9), so this one UI covers both kinds of tenant.
- Produces:
  - In `tenant-types.ts`: `export enum DomainApprovalState` (same values) and `export type DomainVerificationDto = { domain: string; token: string; verified: boolean; state: DomainApprovalState; lastCheckedAt?: string; recordName: string; recordValue: string }`. `EmailDomainsDto` gains `verifications?: DomainVerificationDto[]`, where a missing field reads as `[]`.
  - `TenantApiClient.VerifyEmailDomain(domain: string): Promise<EmailDomainsDto>` POSTs `{ domain }` to `EmailDomainsRoute + '/verify'`.
  - `export class DomainVerificationRowViewModel extends Observable`, in the editor VM file:
    - `Domain`, `StatusLabel` (the five labels), `VerificationLabel` (`Verified` / `Not verified`), `RecordName`, `RecordValue`.
    - `LastCheckedText` is `'Last checked ' + iso.slice(0, 16).replace('T', ' ') + ' UTC'`, or `'Not checked yet'`.
    - `CanVerify`, `VerifyCommand`.
  - `EmailDomainsEditorViewModel`:
    - `Verifications: ObservableCollection<DomainVerificationRowViewModel>`, `HasVerifications`.
    - `VerifyDomain(domain: string): Promise<void>` never throws. A 401 expires the session, and any other error shows its sentence in `ErrorText`.
    - `VerifyNoticeText` uses the same sentence as Task 10's notice.
    - `IsVerifying`.
    - Verify is offered only when the profile's settings capability is held (the Owner). Keep it in a `canVerify` field set by `Apply`, which is independent of `editable`.
    - `ApprovalText` keeps its current rules: it now gets real `pending` from the console too.
    - Add new bound members to `BoundProperties`.

- [ ] **Step 1: Write the failing tests**

`email-domains-editor.test.ts`:
- `Apply builds one verification row per verification with its record and labels`.
- `a dto without verifications shows no rows`.
- `the Owner can Verify; a non-Owner gets no Verify`.
- `VerifyDomain calls the client and rebuilds the rows`.
- `a verify that leaves the row Not verified shows the notice`.
- `a refusal shows its sentence; a 401 expires the session`.
- `LastCheckedText formats 2026-11-06T09:30:12.000Z as 'Last checked 2026-11-06 09:30 UTC'`.

`tenant-api-client.test.ts`:
- `VerifyEmailDomain posts { domain } to /tenant-api/settings/email-domains/verify`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm --prefix admin/tenant-portal test`. Expected: FAIL.

- [ ] **Step 3: Implement the types, client (keep CRLF) and VMs, and update the tab**

Below `ApprovalText`, add a `ListBox` of verification rows using the tenant portal's existing list style; grep `ItemTemplate` in `settings.resources.mu` or the shell resources for the established table style. Each row shows:
- the domain, `StatusLabel` and `VerificationLabel`;
- the caption `Add this TXT record at your DNS provider:`;
- `RecordName` and `RecordValue` in `@Code` style;
- `LastCheckedText`;
- a `Verify` button bound to `VerifyCommand`, visible when `CanVerify` is true.

Show `VerifyNoticeText` under the list. Labels stay inline, with no explicit Width or Height.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm --prefix admin/tenant-portal run typecheck && npm --prefix admin/tenant-portal test`, then the full gate list from Global Constraints. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/tenant-portal/src/tenant-types.ts admin/tenant-portal/src/tenant-api-client.ts admin/tenant-portal/src/sections/settings/email-domains-editor-view-model.ts admin/tenant-portal/src/sections/settings/settings.resources.mu admin/tenant-portal/src/sections/settings/tests/email-domains-editor.test.ts admin/tenant-portal/src/tests/tenant-api-client.test.ts
git commit -m "feat(tenant-portal): show the TXT record and verify email domains"
```
