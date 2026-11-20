# pragmatic-server container image

The image builds the whole sibling workspace from source (hermetic, multi-stage). The build context must be the parent workspace directory (`architecture-agent/`), which holds all sibling packages.

## Build

From the parent workspace directory:

    DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=/path/to/.npmrc -t pragmatic-server .

### Private registry

Several `@pragmatic-tech-ai/*` dependencies (for example mural) are hosted on GitHub Packages (npm.pkg.github.com) and need a token with `read:packages`. Create a scoped `.npmrc` OUTSIDE the repo and never commit it:

    @pragmatic-tech-ai:registry=https://npm.pkg.github.com
    //npm.pkg.github.com/:_authToken=<your PACKAGES_TOKEN>

The token is supplied by reference at build time as a BuildKit secret (`--secret id=npmrc,...`), mounted only during each `npm install` step. It is never baked into an image layer, and `**/.npmrc` is excluded from the build context. CI passes the token from the `PACKAGES_TOKEN` secret (wired in the CI task). Without the secret the build still starts but fails at the first package that needs a private dependency.

BuildKit reads `pragmatic-server/docker/Dockerfile.dockerignore`, which excludes `node_modules`, `dist`, VCS metadata and logs so the context is source plus manifests.

## Run

Required environment:

- `PRAGMATIC_BASE_DIR`: base directory for environment data (mount a volume here).
- A master-key reference: either a key file path or the name of a base64 environment variable (by reference, never the key value itself).
- `PRAGMATIC_ENVIRONMENT_ID` for single-environment mode, or `PRAGMATIC_ENVIRONMENTS_FILE` pointing at a mounted environments file.

Startup aborts with a sanitized message if required configuration is missing. `/readyz` stays false until startup completes; `/healthz` backs the image HEALTHCHECK.

The server listens on port 8080 (override with `PRAGMATIC_PORT`) and runs as the non-root user `pragmatic` (uid 10001).

## Secrets

No secret is baked into the image. Master keys, OIDC client secrets and bootstrap admin passwords are supplied at run time by reference (mounted files or environment variables).

# pragmatic-postgres image

`docker/postgres/Dockerfile` (bake target `pragmatic-postgres`, released as `ghcr.io/pragmatic-tech-ai/pragmatic-postgres`,
linux/amd64 + linux/arm64): the official Postgres 17 image, pinned by digest, plus a reconcile that runs on every start.
One instance per hive (and one on the platform host); one database and one role per application.

Mounts:

- `/etc/pragmatic-postgres/applications.conf` (`PRAGMATIC_POSTGRES_APPLICATIONS`): one application per line,
  `<application> <database> <role>`, `#` comments. Names: application `[a-z][a-z0-9-]*`, database and role
  `[a-z_][a-z0-9_]*` (at most 63 characters); `postgres`, `template0/1`, `public` and `pg_*` are reserved, and so is
  the superuser's name. No application, database or role may appear twice.
- `/run/secrets/pragmatic-postgres/applications/<application>` (`PRAGMATIC_POSTGRES_SECRETS_DIR`): each role's
  password, one file per application (trailing line breaks ignored).
- `/run/secrets/pragmatic-postgres/superuser` (`POSTGRES_PASSWORD_FILE`): the superuser `postgres`'s password.
- `/var/lib/postgresql/data`: the data volume.

Every start: the configuration is validated in full (a fault refuses the start, exit 1, nothing changed); the server
is started socket-only; each listed role is created if missing, made a plain login (no superuser, createdb, createrole,
replication, bypassrls) and given its file's password; each database is created if missing, owned by its role
(an existing one owned by another role refuses the start), closed to `PUBLIC` and open to its role; `PUBLIC` loses
`CONNECT` on `postgres` and `template1`; the superuser's password follows its file. Then the real server starts. An
application removed from the file keeps its database and role. Passwords reach the server only by file (read with
`pg_read_file` inside the container) — never argv, environment values or logs. Every TCP connection, loopback too,
needs its password (scram-sha-256); the socket admits only the matching OS user (peer).

Run it non-root with a read-only root filesystem:

    docker run -d --read-only --tmpfs /var/run/postgresql --tmpfs /tmp \
        -v pg-data:/var/lib/postgresql/data \
        -v /path/to/etc:/etc/pragmatic-postgres:ro -v /path/to/secrets:/run/secrets/pragmatic-postgres:ro \
        ghcr.io/pragmatic-tech-ai/pragmatic-postgres:<version>

The files must be readable by uid 999. The health check is `pg_isready` on loopback TCP, so the start-up reconcile
(socket only) never reads as healthy. Tests: `bash docker/postgres/tests/reconcile.test.sh` (no database) and
`bash docker/postgres/tests/image.test.sh <image>` (a docker host; CI runs both arches).
