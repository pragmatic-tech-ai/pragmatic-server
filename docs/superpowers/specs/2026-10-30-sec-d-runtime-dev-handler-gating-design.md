# SEC-D: Runtime tenants must not expose dev-only RPC handlers (don't-register)

**Status:** design — FORK RESOLVED 2026-10-30: mechanism = **don't-register**
(dev-only handler groups are not registered on a runtime tenant; calling one
yields JSON-RPC method-not-found); scope = **conservative slice**
(unambiguously dev-only groups only this spec; mixed groups filed as a
follow-up). **Program:** suite security-hardening (post-batch follow-on).

## Problem

`ServerConnectionHandler` registers every handler group unconditionally in its
constructor (`RegisterLanguageHandlers`, `RegisterSolutionHandlers`,
`RegisterModelHandlers`, `RegisterConnectorHandlers`, `RegisterCypherHandlers`,
`RegisterApplicationHandlers`, `RegisterGraphHandlers`, `RegisterAppDataHandlers`,
`RegisterDataSharingHandlers`, `RegisterDataAssignmentHandlers`, and
`RegisterAdminHandlers` when an admin is present). Purpose-guarding is sparse
and ad-hoc — only a handful of methods consult `this.purpose`
(`TenantPurpose.Development` vs `Runtime`). As a result a **runtime** tenant —
which serves deployed apps to end users — exposes the full **development**
authoring RPC surface: the language service (LSP: completions, hover,
definition, references, rename, symbols, diagnostics, formatting, …) and
solution authoring (`OpenSolution`, `ActiveSolution`). No runtime app needs
these; they are pure attack surface on the runtime workload.

## Goal

A runtime tenant does not register the unambiguously dev-only handler groups,
so those methods are simply not present (JSON-RPC method-not-found). A
development tenant keeps them. No runtime app-serving behavior changes.

## Scope

### IN

- Gate the two **unambiguously dev-only** handler-group registrations behind a
  development-purpose check in the `ServerConnectionHandler` constructor:
  - `RegisterLanguageHandlers()` (the LSP surface).
  - `RegisterSolutionHandlers()` (`OpenSolution`, `ActiveSolution`, and the
    diagnostics-publish notification plumbing they own).
  Both register only when `this.purpose === TenantPurpose.Development`. Add a
  small private predicate (e.g. `IsDevelopment()`) rather than repeating the
  comparison, consistent with the existing per-method checks.
- Mechanism is **don't-register** (fork choice): on a runtime tenant these
  methods are never wired onto the `MessageConnection`, so a call returns the
  transport's standard method-not-found — the handler code is unreachable, the
  smallest attack surface.

### OUT (fork choice + rulings)

- **Mixed-purpose groups** — `RegisterModelHandlers` (`ModelView`/`Resources`),
  `RegisterCypherHandlers` (`Query` read vs `Execute` mutate),
  `RegisterConnectorHandlers` (dev config/test vs runtime read/write), and the
  **authoring** subset of `RegisterGraphHandlers` (`Create`/`Delete`/
  `Contribute`/`Export`, as distinct from the already-runtime-guarded
  `Load`/`Loaded`). **Ruling:** classifying these needs product input (each has
  a plausible runtime use; gating one a runtime app legitimately needs would
  break app serving). Filed as a follow-up Feature. Cost if wrong: these dev
  surfaces remain exposed on runtime for now — unchanged from today, so no
  regression; this spec strictly reduces surface.
- **Reverse direction (runtime-only groups off a development tenant).**
  **Ruling:** out of this slice. Much of it is already de-facto guarded —
  `RuntimeAttachArgs` supplies the deploy/app/graph providers only for a
  runtime tenant, so those handlers already fail without a provider on dev — and
  the item's intent is the runtime-exposes-dev risk. Filed with the mixed-group
  follow-up. Cost if wrong: a dev tenant may accept a runtime-only call that
  then no-ops/errs on a missing provider (today's behavior). Low.
- **Reject-when-called mechanism** (keep handlers registered, throw
  `NotDevelopment`). Not chosen (fork = don't-register).

## Approach (the how that is decided)

- In the constructor, replace the unconditional `this.RegisterLanguageHandlers()`
  and `this.RegisterSolutionHandlers()` with registration guarded by
  `this.IsDevelopment()`. Leave all other `Register*` calls unchanged.
- `IsDevelopment(): boolean` returns `this.purpose === TenantPurpose.Development`.
- No change to `Attach`/constructor signatures, no new ctor params. `purpose`
  already flows in (default `TenantPurpose.Development`, so existing default-
  constructed handlers and dev tests are unaffected).
- No secret/token handling involved; no audit change; no layering change
  (entirely within `ServerConnectionHandler`, host layer).

## Constraints (Global)

- ASCII + LF. `src/host/server-connection-handler.ts` is LF / 0 non-ASCII at
  base — preserve. New test file LF / ASCII. Byte-scan base + each touched file
  on the way out. Never `sed -i`.
- OOP + Allman braces; no inline string literals (none new here); enums over
  string unions (`TenantPurpose` is already an enum); PascalCase public members;
  no module-level state.
- Gate: realm `npm test` (`tsx --test "src/**/*.test.ts"`) +
  `npm run typecheck:tools`.
- Merge locally (ff-only); **NEVER push.** Stage source/test by explicit path;
  never `git add -A`; never docs.

## Review focus

- **Dev-only gone on runtime:** a `TenantPurpose.Runtime` handler does not
  respond to any `LanguageProtocol.*` or `SolutionProtocol.*` request — the
  connection returns method-not-found, and the handler/service code is not
  invoked.
- **Dev unchanged:** a `TenantPurpose.Development` handler still serves the full
  language + solution surface exactly as before.
- **No runtime-serving regression:** gating the two groups off runtime does not
  break the runtime app-serving paths (Application/Graph Load/AppData/sharing/
  assignment) — the runtime path never depends on an opened solution or the
  language service (confirm: `PolicyGate`'s `ActiveSolution` scope callback
  tolerating an absent active solution on runtime is correct).
- **No new surface / smallest footprint:** only the two registration calls are
  gated; no other handler group's availability changes.
- **EOL:** touched source keeps LF / 0 non-ASCII; new test LF / ASCII.
