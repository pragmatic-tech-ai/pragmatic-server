# syntax=docker/dockerfile:1
# pragmatic-postgres: the official Postgres 17 image plus a reconcile on every start that creates one database and one
# role per application from a mounted applications file, each role's password from a mounted secret file
# (docker/README.md, "pragmatic-postgres image"). Built per arch (linux/amd64, linux/arm64) by docker/docker-bake.hcl.
#
# The base is pinned by its multi-arch index digest (17.12 on Debian trixie); bump tag and digest together.
FROM postgres:17.12-trixie@sha256:b60e90042aa6b8dbecd58e224b3e36114dbf8ad754465264c2476ad58a86e45c

# The official image's postgres user; numeric below so Kubernetes' runAsNonRoot can check it without a passwd lookup.
RUN [ "$(id -u postgres):$(id -g postgres)" = "999:999" ]

COPY --chmod=0755 pragmatic-postgres-entrypoint.sh pragmatic-postgres-reconcile.sh /usr/local/bin/

# Paths only: every password is a mounted file, never an environment value. initdb's own default trusts loopback TCP;
# here every TCP connection (loopback too) needs its password and the socket admits only the matching OS user.
ENV POSTGRES_INITDB_ARGS="--auth-host=scram-sha-256 --auth-local=peer" \
    POSTGRES_PASSWORD_FILE=/run/secrets/pragmatic-postgres/superuser \
    PRAGMATIC_POSTGRES_APPLICATIONS=/etc/pragmatic-postgres/applications.conf \
    PRAGMATIC_POSTGRES_SECRETS_DIR=/run/secrets/pragmatic-postgres/applications

USER 999:999

# TCP on loopback: the socket-only server of the start-up reconcile never reads as healthy.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 CMD ["pg_isready", "--host=127.0.0.1", "--quiet"]

ENTRYPOINT ["pragmatic-postgres-entrypoint.sh"]
CMD ["postgres"]
