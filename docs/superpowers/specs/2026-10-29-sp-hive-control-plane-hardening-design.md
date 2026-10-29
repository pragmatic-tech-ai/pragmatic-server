# SP-HIVE control-plane hardening minors (SH-A)

**Status:** design — 2026-10-29.
**Program:** SP-HIVE 100% burn-down, batch SH-A. Closes nine SP-HIVE-2/3/4
follow-up hardening items filed from earlier whole-branch reviews.

## Intent and why

The SP-HIVE-2/3/4 reviews filed a cluster of small, independent hardening
follow-ups against the control plane and the in-hive pull agent. None changes
behaviour an operator sees today; each removes a latent foot-gun (cwd-relative
key store, double-slash image refs, unbounded body read, unsanitised k8s secret
names) or a dead/duplicated declaration. They are batched into one branch
because each is a few lines with its own focused test.

## Items (each with acceptance)

1. **EffectiveRegistry.ImageRef trailing-slash** (`effective-registry.ts`): an
   attach endpoint with a trailing `/` (`ghcr.io/org/`) yields `ghcr.io/org//img`.
   Trim exactly one trailing `/` from the resolved endpoint in `For` (so
   `ImageRef` composes a single separator). Test: endpoint with and without a
   trailing slash both yield one separator.
2. **EffectiveRegistry.PullPolicy wire-or-drop** (`effective-registry.ts`): the
   `PullPolicy` getter is modelled + unit-tested but never consumed;
   `K8sManifestBuilder` independently hardcodes `imagePullPolicy: IfNotPresent`.
   **Ruling: DROP** the getter, its `DefaultPullPolicy` constant, and its unit
   test, leaving a one-line comment on the class that pull policy is rendered by
   `K8sManifestBuilder` (threading the getter through the builder's seven render
   sites is disproportionate for a value that already coincides). If a future
   spec needs per-registry pull policy, it re-introduces a wired one.
3. **healthz dedupe**: `K8sManifestBuilder` redeclares `'/healthz'` because the
   `DockerEnv` health-path constant is private. Expose ONE shared health-path
   constant (locate `class DockerEnv`; make its health-path constant accessible
   or hoist it to a shared module) and have `K8sManifestBuilder` reference it.
   Scope to the `K8sManifestBuilder`↔`DockerEnv` pair only — do NOT rewrite the
   `/healthz` literals in the smoke files. If the location makes this
   disproportionate, flag it in the report for adjudication.
4. **HiveOrchestratorFactory default dataRoot is cwd-relative**: `server.ts:171`
   builds `new HiveOrchestratorFactory()` with no dataRoot, so the signature/key
   store paths are cwd-relative. **Ruling:** pass the already-absolute
   `dataRoot` (computed at `server.ts:151`) — `new HiveOrchestratorFactory(dataRoot)`
   — AND resolve the factory's own default via `resolve()` so even the default
   is deterministic. Test: the factory default resolves to an absolute path.
5. **kubectl rollout-status timeout configurable** (`kubectl.ts`): `NodeExecFile`
   uses a fixed `300000` ms timeout. Make it a constructor option
   (default unchanged at 300000) so rollout-status waits can be tuned. Test:
   a custom timeout is honoured (inject/observe).
6. **KubectlError redaction hardening** (`control-plane-host.ts`): the redaction
   heuristic misses short unlabelled secrets (`Bearer abc123`), JSON-quoted
   `"password":"x"`, and quoted values with spaces, and over-redacts long
   resource names/paths; the fallback branch is untested. Broaden the redaction
   and add tests for each missed case. **Preserve the file's existing 6
   non-ASCII bytes exactly.**
7. **DbSecretRef slash-bearing names** (`environment-service.ts` /
   `k8s-manifest-builder.ts`): a `passwordRef` like `<tenant>/appdb/password`
   conflates secret-name with store-path+key; placed into `secretKeyRef.name`
   it is invalid (RFC-1123 forbids `/`). Sanitise the NAME portion to RFC-1123
   (lowercase alphanumeric + `-`) where it is rendered into `secretKeyRef.name`,
   keeping the store-path+key intact for value lookup. Test: a slash-bearing ref
   renders an RFC-1123-valid name. **Preserve `k8s-manifest-builder.ts`'s 15
   non-ASCII bytes exactly.**
8. **agentTokenRef wire-or-drop** (`platform-records.ts` + bootstrap): the
   `HiveRecord.agentTokenRef` field is written by the provisioned path
   (`tenant-admin-bootstrap.ts:204`, when provisioning creates the token Secret)
   but not by the plain `RegisterHive` path (which has no Secret name).
   **Ruling: KEEP + document** — add a doc comment on the field stating it is
   populated only when the provisioned path creates the agent-token Secret, and
   add a test asserting bootstrap writes it. Do NOT make `RegisterHive` fabricate
   a ref name it does not have.
9. **agent fetch body-read timeout** (`src/agent/rollout-agent.ts`): the in-hive
   pull agent bounds the fetch header timeout but not the response-body read; a
   stalled body can hang the loop. Add a body-read timeout (abort/deadline).
   Test: a slow/never-ending body is aborted within the deadline.

## Constraints (Global)

- New/modified `.ts`: ASCII, LF. Every touched file is LF at base. PRESERVE the
  existing non-ASCII bytes exactly: `k8s-manifest-builder.ts` = 15,
  `control-plane-host.ts` = 6; all other touched files = 0. Byte-scan each on
  the way out.
- OOP + Allman braces; no inline string literals (hoist to
  `private static readonly`); enums over string unions; PascalCase public
  members; no module-level free functions/state.
- Gates: control-plane `npx tsx --test admin/control-plane/tests/*.test.ts` +
  `npm run typecheck:tools`; the agent change (`src/agent`) is gated by
  `npm test` (`tsx --test src/**/*.test.ts`). Run the relevant gate(s) for the
  files touched; run all three before finish.
- Merge locally (ff-only); **NEVER push.**

## Review focus

- **Fail-closed preserved:** none of these loosens a security check — the
  redaction change must never *expose* a secret it used to redact; the DbSecretRef
  sanitation must not collide two distinct refs into one k8s name.
- **No behaviour drift:** dropping `PullPolicy` and documenting `agentTokenRef`
  must not change rendered manifests or stored records.
- **Determinism:** the dataRoot fix must make the key-store path independent of
  cwd.
- **Non-ASCII byte counts** unchanged on the two files that carry them.
