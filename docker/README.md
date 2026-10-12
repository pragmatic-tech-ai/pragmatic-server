# pragmatic-server container image

The image builds the whole sibling workspace from source (hermetic, multi-stage). The build context must be the parent workspace directory (`architecture-agent/`), which holds all sibling packages.

## Build

From the parent workspace directory:

    DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile -t pragmatic-server .

BuildKit reads `pragmatic-server/docker/Dockerfile.dockerignore`, which excludes `node_modules`, `dist`, VCS metadata and logs so the context is source plus manifests.

## Run

Required environment:

- `PRAGMATIC_BASE_DIR`: base directory for tenant data (mount a volume here).
- A master-key reference: either a key file path or the name of a base64 environment variable (by reference, never the key value itself).
- `PRAGMATIC_TENANT_ID` for single-tenant mode, or `PRAGMATIC_TENANTS_FILE` pointing at a mounted tenants file.

Startup aborts with a sanitized message if required configuration is missing. `/readyz` stays false until startup completes; `/healthz` backs the image HEALTHCHECK.

The server listens on port 8080 (override with `PRAGMATIC_PORT`) and runs as the non-root user `pragmatic` (uid 10001).

## Secrets

No secret is baked into the image. Master keys, OIDC client secrets and bootstrap admin passwords are supplied at run time by reference (mounted files or environment variables).
