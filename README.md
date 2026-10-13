# pragmatic-server

## Running the gated cloud-boot test against local emulators

`src/tenancy/tests/cloud-gcp-boot.test.ts` always runs a deterministic cloud-mode boot over in-memory
doubles. A second case boots cloud mode over the real `GcpCloudBackends` wiring (GCS + Secret Manager +
SQL session) with the SDK clients pointed at local emulators. It skips unless all of these are set:

- `PRAGMATIC_TEST_GCP_CLOUD=1`
- `PRAGMATIC_TEST_GCS_ENDPOINT` - fake-gcs-server URL, e.g. `http://localhost:4443`
- `PRAGMATIC_TEST_GCP_SECRET_ENDPOINT` - plaintext-gRPC Secret Manager emulator, e.g. `localhost:9090`
- `PRAGMATIC_TEST_PG_URL` - a local Postgres connection string (there is no Cloud SQL emulator, so a plain pool is used)

Optional: `PRAGMATIC_TEST_GCS_BUCKET` (default `pragmatic-test`) and `PRAGMATIC_TEST_GCP_PROJECT` (default
`test-project`). Start the GCS emulator and bucket with `docker compose -f docker-compose.emulators.yml up -d`
in `todl-platform-gcp`, run a Secret Manager emulator and a local Postgres, then:

    npx tsx --test src/tenancy/tests/cloud-gcp-boot.test.ts

Each run uses a unique run-id for the GCS prefix, tenant ids, secret refs and master-key ref, so a shared
emulator does not collide.
