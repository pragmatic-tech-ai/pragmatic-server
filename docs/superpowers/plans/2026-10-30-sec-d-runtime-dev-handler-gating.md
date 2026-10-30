# SEC-D: Runtime dev-handler gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A runtime tenant does not register the unambiguously dev-only handler groups (Language/LSP and Solution authoring), so those RPCs are method-not-found on runtime; development tenants keep them unchanged.

**Architecture:** Gate the two `Register*Handlers()` calls in the `ServerConnectionHandler` constructor behind a new private `IsDevelopment()` predicate (`this.purpose === TenantPurpose.Development`). Don't-register mechanism (fork choice). No signature/param changes — `purpose` already flows in.

**Spec:** `docs/superpowers/specs/2026-10-30-sec-d-runtime-dev-handler-gating-design.md` (fork + rulings — read it).

## Global Constraints

- ASCII + LF. `src/host/server-connection-handler.ts` is LF / 0 non-ASCII at base — preserve. New test LF / ASCII. Byte-scan base + each touched file. Never `sed -i`.
- OOP + Allman braces; no inline string literals (none new); PascalCase public members; `TenantPurpose` enum already exists; no module-level state.
- Gate: realm `npm test` (`tsx --test "src/**/*.test.ts"`) + `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path; never `git add -A`; never docs.

## Review Focus

- A `TenantPurpose.Runtime` handler returns method-not-found for every `LanguageProtocol.*` and `SolutionProtocol.*` request (handler/service code not invoked).
- A `TenantPurpose.Development` handler still serves the full language + solution surface unchanged.
- Runtime app-serving paths (Application / Graph Load / AppData / DataSharing / DataAssignment) are unaffected; the runtime path does not depend on an opened solution or the language service.
- Only the two registration calls are gated; no other group's availability changes.
- EOL: source LF / 0 non-ASCII; new test LF / ASCII.

---

### Task 1: Gate Language + Solution handler registration to development tenants

**Files:** `src/host/server-connection-handler.ts` (LF), `src/host/tests/server-connection-handler-purpose-gating.test.ts` (NEW, LF/ASCII — mirror the handler construction used by `src/host/tests/server-connection-handler-drain.test.ts`).

**Interfaces:**
- Consumes: `this.purpose: TenantPurpose` (already a field); `TenantPurpose.Development` / `.Runtime`; `LanguageProtocol`, `SolutionProtocol` (already imported).
- Produces: `private IsDevelopment(): boolean`; the constructor registers `RegisterLanguageHandlers()` and `RegisterSolutionHandlers()` only when development.

- [ ] Failing tests (mirror the drain test's harness; construct one handler with `purpose: TenantPurpose.Runtime` and one with `TenantPurpose.Development`): (a) on the **runtime** handler, sending a representative `LanguageProtocol.*` request (e.g. `DocumentSymbols` or `CompletionsAt`) is rejected with JSON-RPC method-not-found (`ErrorCodes.MethodNotFound` / code `-32601`); (b) on the runtime handler, a `SolutionProtocol.OpenSolution` (or `ActiveSolution`) request is likewise method-not-found; (c) on the **development** handler, the same Language and Solution requests are handled (not method-not-found) — resolve or fail on their own merits, not on missing registration; (d) a representative shared/runtime request still works on the runtime handler (e.g. an `AdminProtocol`/app request the existing harness can drive, OR simply that a non-gated method is registered) — i.e. the gating is scoped to the two groups only.
- [ ] Implement: add `private IsDevelopment(): boolean { return this.purpose === TenantPurpose.Development }`. In the constructor, change the unconditional `this.RegisterLanguageHandlers()` and `this.RegisterSolutionHandlers()` to run only `if (this.IsDevelopment())` (Allman; a single guarded block around both calls is fine). Leave every other `Register*` call unchanged. No new strings, no signature changes.
- [ ] Verify: `npm test` passes (watch for any runtime-purpose test that previously leaned on Language/Solution being present — if one breaks, it reveals a real runtime→dev coupling to investigate, not to paper over); `npm run typecheck:tools` exits 0; byte-scan both files (source LF/0 non-ASCII; new test LF/0 non-ASCII). Commit by explicit path.

## Final verification (whole branch)

- `npm test` — all pass.
- `npm run typecheck:tools` — exit 0.
- Byte-scan touched files: LF, 0 non-ASCII.
