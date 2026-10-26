# SP-HIVE-3 — In-cluster env-server boot config & secret injection (design)

**Status:** approved for planning (AFK autonomous run; merge locally, never push).
**Project item:** `PVTI_lADOE0Zc984Biu4ozhDclS4` (Kind=Feature).
**Spun off from:** P2 in-cluster-env-create (`2026-10-25-in-cluster-env-create-plan.md`), which delivered orchestration only — the served pod gets `PRAGMATIC_PORT` and nothing else.

## Intent & why

An in-cluster environment created by the tenant admin must boot its `pragmatic-server:dev`
pod as a **correctly-configured tenant**, exactly as a Docker environment does — same
`ServerConfigLoader` contract, same secret-by-name discipline. Today it cannot: the stock
`EnvironmentWorkload.env` carries only `PRAGMATIC_PORT`, and `ServerConfigLoader` refuses to
start without a base dir, a tenant source, and a master key. The gated `k8s-hive-smoke`
works around this by injecting a throwaway base dir, a bare `PRAGMATIC_ENVIRONMENT_ID`, and a
**plaintext master key env var** — explicitly "LOCAL-SMOKE-ONLY" and insecure. SP-HIVE-3
removes the workaround by injecting the real boot config and secrets the way k8s intends:
config as a ConfigMap, secrets as k8s Secrets, state on a volume.

## The Docker parity contract (source of truth)

`environments/seed/docker.ts` boots the server with these env vars (the contract
`ServerConfigLoader` reads in `src/config/server-config-loader.ts`):

| Env var | Meaning | k8s projection |
|---|---|---|
| `PRAGMATIC_BASE_DIR` | writable data root | mounted volume (PVC) at a fixed path |
| `PRAGMATIC_TENANTS_FILE` | tenants.json (purpose, bootstrap admin, connections) | **ConfigMap** (non-secret) mounted file |
| `PRAGMATIC_MASTER_KEY_FILE` | master.key (32 raw bytes) | **Secret** mounted file |
| `PRAGMATIC_PROVISIONED_SECRETS_FILE` | provisioned-secrets.json (admin pw, db pw by ref→value) | **Secret** mounted file |
| `PRAGMATIC_DEPLOYMENT_MODE` | `local` | plain env |
| `PRAGMATIC_PORT` | server port | plain env (already present) |

The bundle that holds these files is produced by `BundleBuilder.Generate` (reused as-is).

## Decisions (mine, as the builder — AFK)

- **Bundle is the durable source of truth.** `InClusterEnvironmentRuntime.Prepare` generates a
  host bundle via `BundleBuilder.Generate` under the control-plane data root, exactly as the
  Docker runtime does. `BundleBuilder.WriteMasterKey` is create-if-absent, so a re-Apply / pod
  restart reuses the same master key and admin password (durability without a new store). The
  control-plane keeps the bundle; k8s receives **projections** of it. This mirrors P4, where the
  IdP seed source generates secrets control-plane-side and projects them as k8s Secrets.
- **Secret-safety mirrors P4's `IdpSecretSet`.** A new `EnvServerSecretSet` holds the master key +
  provisioned-secrets bytes in `#private` fields, redacts `toJSON`/`toString`, and exits values
  ONLY through `RenderManifest()` into k8s `Secret` objects. Values never enter a DTO, a log, an
  error, the `EnvironmentWorkload`, or any non-Secret manifest. The tenants.json ConfigMap is
  non-secret and rendered plainly.
- **One applied List.** The in-cluster apply builds a single v1 List = the existing workload
  manifests (Namespace, Deployment, Service, optional DB) + the tenants ConfigMap + the Secret
  objects, and `kubectl apply`s it. k8s resolves volume/mount ordering by retrying the pod until
  the ConfigMap/Secret exist, so no multi-phase apply is needed. The `EnvironmentWorkload` DTO still
  carries **names only**; the renderer wires `valueFrom`/volumes by name; the secret-set contributes
  the Secret objects.
- **Base dir on a PVC**, matching the DB/IdP `volumeClaimTemplates`/PVC pattern, so a pod restart
  keeps the server's data root. Mount paths are fixed constants (`/pragmatic/data`, `/pragmatic/config`,
  `/pragmatic/secrets`).
- **DB password consistency.** When the env has a database, the single bundle-generated DB password
  is the one value projected into BOTH the postgres Secret (`<ref>` key `password`, already consumed
  by `DatabaseStatefulSet`) and the server's provisioned-secrets.json, so the server and postgres
  agree. SP-HIVE-3 is what finally CREATES that DB-password Secret (today nothing does).
- **Scope = boot-to-tenant, not full seed.** In scope: tenants.json, master key, provisioned secrets,
  base dir — enough for the pod to boot as its configured tenant and bootstrap + authenticate its
  admin. OUT of scope (filed follow-up): projecting the heavy seed tree (security-model.json,
  users.json, packages, applications) — binary/large, exceeds a ConfigMap, and wants an init-container
  or image bake. A dev-blank tenant needs no such seed; a demo-contoso runtime's seed projection is
  SP-HIVE-3b.

## Non-goals / anti-goals

- No change to the Docker runtime path (it must stay byte-identical; parity is the goal, not a rewrite).
- No plaintext secret env var ever (the `k8s-hive-smoke` workaround is deleted, not generalized).
- No new secret store: the bundle + k8s Secrets are the two stores, as today.
- No heavy-seed projection (SP-HIVE-3b).

## Component shape (for the plan)

- `environment-workload.ts` — `EnvironmentWorkload` gains name-only refs the renderer needs
  (tenants ConfigMap name, master-key Secret name, provisioned-secrets Secret name, base-dir mount).
  No values.
- `env-server-seed.ts` (NEW) — `EnvServerSeedSource` reads a bundle dir and yields: the tenants
  ConfigMap manifest (plain) and an `EnvServerSecretSet` (master key + provisioned-secrets + db pw).
  `EnvServerSecretSet` = `#private` bytes, redacted `toJSON`/`toString`, `RenderManifest()` → Secret
  objects. Models on P4 `in-cluster-idp-seed.ts`.
- `k8s-manifest-builder.ts` — `ServerDeployment` gains env (`PRAGMATIC_BASE_DIR`,
  `PRAGMATIC_TENANTS_FILE`, `PRAGMATIC_MASTER_KEY_FILE`, `PRAGMATIC_PROVISIONED_SECRETS_FILE`,
  `PRAGMATIC_DEPLOYMENT_MODE`), the three volume mounts, the volumes (ConfigMap, two Secrets) and a
  base-dir PVC. Pure; names only.
- `in-cluster-environment-runtime.ts` — `Prepare` generates the bundle; `BringUp` assembles the
  combined List (workload + ConfigMap + secret-set manifests) and applies it. No stderr/secret in errors.
- `environment-runtime.ts` / resolver — unchanged seam; in-cluster runtime now does real Prepare work.

## Verification

- **Unit (in `tsx --test`, no cluster):** manifest rendering is pure — assert the ServerDeployment
  carries exactly the five env vars + three mounts + volumes by name; assert `EnvServerSecretSet`
  redacts `toJSON`/`toString` and that only `RenderManifest()` surfaces bytes; assert the combined
  List contains the ConfigMap + Secret objects with names matching the Deployment's refs; assert the
  DB-password value is identical in the postgres Secret and provisioned-secrets.json; assert the
  Docker render path is unchanged (no new env on `PublishesHostPort()`=true).
- **Gated live smoke (`k8s-hive-smoke` promoted, docker-desktop):** replace the throwaway `BootEnv`
  with the real injection; drive Apply → WaitHealthy → the pod reaches Ready purely from the injected
  ConfigMap/Secrets (no plaintext key), serve `/healthz`, and authenticate the bootstrapped admin over
  the tenant WS using the provisioned admin password read back from the bundle; Teardown removes the
  namespace. Re-Apply reuses the same master key (durability).
- control-plane unit suite green; `tsc` tools+tenant-admin+build+portal clean.

## Review focus (likely-to-bite, pin each in a task test)

1. A re-Apply must NOT rotate the master key or admin password (idempotent projection from the
   create-if-absent bundle) — else restart loses all encrypted data and admin login breaks.
2. Secret bytes must never appear in a thrown error, a log line, the workload DTO, the record, or a
   non-Secret manifest (same bar P4 passed) — test the redaction + error paths.
3. The DB-password value projected to postgres and to provisioned-secrets.json must be the SAME value.
4. The Docker (host-port) path must be byte-identical — the new injection is in-cluster-only, keyed
   off `PublishesHostPort()`.
5. A ConfigMap/Secret name collision across two environments in one hive namespace-per-env must not
   occur — names are environment-scoped (namespace is per-env, so names can be stable within it).
