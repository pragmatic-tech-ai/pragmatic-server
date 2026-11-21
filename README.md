# pragmatic-server

> **Archived (2026-11-21).** This repository was split into one repository per container. Nothing is built or
> released from here any more; the platform releases up to `0.1.0-early.5` were cut from this repository and their
> images stay linked to it. New homes (all in `pragmatic-tech-ai`):
>
> | Was here | Now |
> |---|---|
> | `admin/control-plane` (platform console), `admin/portal`, `release-keys/` (verification copy) | `pragmatic-platform-admin` |
> | edge composition, agent channel, desktop discovery (`bin/pragmatic-platform-edged.ts`) | `pragmatic-platform-edge` |
> | tenant admin console, `admin/tenant-portal` | `pragmatic-tenant-admin` |
> | `src/idp`, `idp-login/` | `pragmatic-tenant-idp` |
> | `src/agent` | `pragmatic-hive-agent` |
> | env server and worker, `helm/pragmatic-server`, compose files | `pragmatic-env-server` (also holds the former `todl-identity-engine` and `todl-connectors-host` under `packages/`) |
> | gateway (`src/cluster/gateway-main.ts`, `pragmatic-gatewayd`) | `pragmatic-env-gateway` |
> | in-cluster UI unpacker | `pragmatic-ui-unpack` |
> | `docker/postgres` | `pragmatic-postgres` |
> | release assembly and signing (`release.yml`, `release-keys/`) | `pragmatic-platform-release` |
> | `admin/control-plane/live-loop`, `admin/control-plane/dev`, the cross-container tests | `pragmatic-e2e` |
> | code used by two or more containers | `pragmatic-shared` (`pragmatic-release-toolkit`, `pragmatic-kube`, `pragmatic-platform-link`, `pragmatic-observability`, `pragmatic-tenant-plane`, `pragmatic-env-cluster`, …) |

## Running the gated cloud-boot test against local emulators

`src/environments/tests/cloud-gcp-boot.test.ts` always runs a deterministic cloud-mode boot over in-memory
doubles. A second case boots cloud mode over the real `GcpCloudBackends` wiring (GCS + Secret Manager +
SQL session) with the SDK clients pointed at local emulators. It skips unless all of these are set:

- `PRAGMATIC_TEST_GCP_CLOUD=1`
- `PRAGMATIC_TEST_GCS_ENDPOINT` - fake-gcs-server URL, e.g. `http://localhost:4443`
- `PRAGMATIC_TEST_GCP_SECRET_ENDPOINT` - plaintext-gRPC Secret Manager emulator, e.g. `localhost:9090`
- `PRAGMATIC_TEST_PG_URL` - a local Postgres connection string (there is no Cloud SQL emulator, so a plain pool is used)

Optional: `PRAGMATIC_TEST_GCS_BUCKET` (default `pragmatic-test`) and `PRAGMATIC_TEST_GCP_PROJECT` (default
`test-project`). Start the GCS emulator and bucket with `docker compose -f docker-compose.emulators.yml up -d`
in `pragmatic-shared/packages/pragmatic-realm-gcp`, run a Secret Manager emulator and a local Postgres, then:

    npx tsx --test src/environments/tests/cloud-gcp-boot.test.ts

Each run uses a unique run-id for the GCS prefix, environment ids, secret refs and master-key ref, so a shared
emulator does not collide.
