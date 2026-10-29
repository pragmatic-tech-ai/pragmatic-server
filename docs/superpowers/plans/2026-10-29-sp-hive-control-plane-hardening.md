# SP-HIVE Control-Plane Hardening (SH-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close nine SP-HIVE-2/3/4 hardening follow-ups in the control plane and the in-hive pull agent.

**Architecture:** Nine small, independent fixes grouped into three cohesive tasks by area; each item ships with a focused test. No behaviour an operator sees changes; each removes a latent foot-gun or a dead/duplicated declaration.

**Spec:** `docs/superpowers/specs/2026-10-29-sp-hive-control-plane-hardening-design.md` (per-item acceptance + rulings live there — read it).

## Global Constraints

- ASCII + LF. PRESERVE existing non-ASCII bytes EXACTLY: `k8s-manifest-builder.ts` = 15, `control-plane-host.ts` = 6; all other touched files = 0. Byte-scan each touched file on the way out (`python -c "b=open(r'F','rb').read();print(sum(c>127 for c in b),b.count(13),b.count(10))"`).
- OOP + Allman braces; no inline string literals (hoist to `private static readonly`); enums over string unions; PascalCase public members.
- Gates: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` + `npm run typecheck:tools`; agent (`src/agent`) `npm test`. Run the gate(s) relevant to the files a task touched; run all three before finish.
- Merge locally (ff-only); **NEVER push.** Stage only source/test files by explicit path; never `git add -A`; never stage docs.

## Review Focus

- Redaction change must never EXPOSE a secret it used to redact (item 6).
- DbSecretRef sanitation must never collide two distinct refs into one k8s name (item 7).
- Dropping `PullPolicy` / documenting `agentTokenRef` must not change any rendered manifest or stored record (items 2, 8).
- The dataRoot fix must make the key-store path independent of cwd (item 4).

---

### Task 1: Registry + orchestrator wiring (items 1, 2, 3, 4)

**Files:** `admin/control-plane/effective-registry.ts`, `admin/control-plane/k8s-manifest-builder.ts`, the `class DockerEnv` file (locate it), `admin/control-plane/hive-orchestrator-factory.ts`, `admin/control-plane/server.ts`; tests under `admin/control-plane/tests/`.

- [ ] **Item 1** — `EffectiveRegistry.For` trims exactly one trailing `/` from the resolved endpoint. Failing test first (endpoint `ghcr.io/org/` → `ImageRef('img')` has one separator), then implement, then green.
- [ ] **Item 2** — DROP the `PullPolicy` getter + `DefaultPullPolicy` constant + its unit test; add a one-line comment that pull policy is rendered by `K8sManifestBuilder`.
- [ ] **Item 3** — expose ONE shared health-path constant from `DockerEnv`; `K8sManifestBuilder` references it (scope: that pair only). If disproportionate, note in report.
- [ ] **Item 4** — `server.ts` passes the absolute `dataRoot` to `new HiveOrchestratorFactory(dataRoot)`; the factory default resolves via `resolve()`. Test: factory default is absolute.
- [ ] **Verify** control-plane gate + typecheck:tools; byte-scan (k8s-manifest-builder.ts stays `15 0 N`). **Commit** (explicit paths).

### Task 2: Exec timeout + redaction + secret-name sanitation (items 5, 6, 7)

**Files:** `admin/control-plane/kubectl.ts`, `admin/control-plane/control-plane-host.ts`, `admin/control-plane/environment-service.ts` and/or `admin/control-plane/k8s-manifest-builder.ts`; tests under `admin/control-plane/tests/`.

- [ ] **Item 5** — `NodeExecFile` timeout becomes a constructor option (default 300000 unchanged). Test: a custom timeout is honoured.
- [ ] **Item 6** — broaden `KubectlError` redaction to cover `Bearer <tok>`, JSON `"password":"x"`, quoted values with spaces; stop over-redacting long names/paths; test each case incl. the fallback branch. PRESERVE the file's 6 non-ASCII bytes.
- [ ] **Item 7** — sanitise the NAME portion of a `DbSecretRef` to RFC-1123 where rendered into `secretKeyRef.name`, keeping store-path+key intact for value lookup. Test: a slash-bearing ref renders an RFC-1123-valid name; two distinct refs never collide. PRESERVE `k8s-manifest-builder.ts`'s 15 non-ASCII bytes.
- [ ] **Verify** control-plane gate + typecheck:tools; byte-scan (control-plane-host.ts `6 0 N`, k8s-manifest-builder.ts `15 0 N`). **Commit** (explicit paths).

### Task 3: agentTokenRef doc+test + agent body-read timeout (items 8, 9)

**Files:** `admin/control-plane/platform-records.ts`, `admin/control-plane/tenant-admin-bootstrap.ts` (test target), `src/agent/rollout-agent.ts`; tests under `admin/control-plane/tests/` and `src/agent/tests/`.

- [ ] **Item 8** — doc comment on `HiveRecord.agentTokenRef` (populated only by the provisioned path when it creates the agent-token Secret); test asserting `tenant-admin-bootstrap` writes it. No change to `RegisterHive`.
- [ ] **Item 9** — add a body-read timeout (abort/deadline) to the pull agent's fetch in `rollout-agent.ts`. Test: a slow/never-ending body is aborted within the deadline.
- [ ] **Verify** control-plane gate (for item 8) + agent `npm test` (for item 9) + typecheck:tools; byte-scan touched files `0 0 N`. **Commit** (explicit paths).

## Final verification (whole branch)

- `npx tsx --test admin/control-plane/tests/*.test.ts` — all pass.
- `npm test` (`tsx --test src/**/*.test.ts`) — all pass.
- `npm run typecheck:tools` — exit 0.
- Byte-scan every touched file: `0 0 N`, except `k8s-manifest-builder.ts` `15 0 N` and `control-plane-host.ts` `6 0 N`.
