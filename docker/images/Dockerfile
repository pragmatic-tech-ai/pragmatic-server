# syntax=docker/dockerfile:1
# One image per app (docker/docker-bake.hcl builds all eight). The build context MUST be the parent workspace dir
# (architecture-agent/) holding pragmatic-server and its siblings. Each runtime target copies ONLY the dirs its
# docker/images/closure.json entry lists; docker/images/closure-check.ts keeps closure.json, this file and the code in step.
# Build: docker buildx bake -f pragmatic-server/docker/docker-bake.hcl   (NPMRC_FILE names an .npmrc with read:packages)
FROM node:22@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb AS build
WORKDIR /workspace
# The one native addon (lmdb, reached by the env server) needs a C toolchain; hashing is hash-wasm, no argon2/bcrypt.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy each package, then install+build in dependency order (the graph engine first).
COPY pragmatic-graph/ ./pragmatic-graph/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd pragmatic-graph && npm install --no-audit --no-fund && npm run build
COPY todl-runtime/ ./todl-runtime/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-runtime && npm install --no-audit --no-fund && npm run build
COPY TODL/ ./TODL/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd TODL && npm install --no-audit --no-fund && npm run build
COPY Mural/ ./Mural/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd Mural && npm install --no-audit --no-fund && npm run build
COPY pragmatic-protocol/ ./pragmatic-protocol/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd pragmatic-protocol && npm install --no-audit --no-fund && npm run build
COPY todl-identity/ ./todl-identity/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-identity && npm install --no-audit --no-fund && npm run build
COPY todl-identity-local/ ./todl-identity-local/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-identity-local && npm install --no-audit --no-fund && npm run build
COPY todl-identity-host/ ./todl-identity-host/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-identity-host && npm install --no-audit --no-fund && npm run build
COPY todl-identity-cloud/ ./todl-identity-cloud/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-identity-cloud && npm install --no-audit --no-fund && npm run build
COPY todl-identity-engine/ ./todl-identity-engine/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-identity-engine && npm install --no-audit --no-fund && npm run build
COPY todl-connectors-host/ ./todl-connectors-host/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-connectors-host && npm install --no-audit --no-fund && npm run build
COPY todl-platform-node/ ./todl-platform-node/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-platform-node && npm install --no-audit --no-fund && npm run build
COPY todl-platform-cloud/ ./todl-platform-cloud/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-platform-cloud && npm install --no-audit --no-fund && npm run build
COPY todl-platform-aws/ ./todl-platform-aws/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-platform-aws && npm install --no-audit --no-fund && npm run build
COPY todl-platform-azure/ ./todl-platform-azure/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-platform-azure && npm install --no-audit --no-fund && npm run build
COPY todl-platform-gcp/ ./todl-platform-gcp/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-platform-gcp && npm install --no-audit --no-fund && npm run build
COPY todl-identity-node/ ./todl-identity-node/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd todl-identity-node && npm install --no-audit --no-fund && npm run build
COPY pragmatic-server/ ./pragmatic-server/
# TODL's lock pulls the engine from GitHub Packages; re-point it at the sibling before the server builds so
# the image holds ONE engine (the server itself depends on file:../pragmatic-graph).
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    sh pragmatic-server/docker/link-graph-engine.sh /workspace && cd pragmatic-server && npm install --no-audit --no-fund && npm run build
# closure.json, this file and the code must agree (docker/images/closure-check.ts); checked here on the very tree the images
# are cut from, so no build (CI's or the release's) produces an image with an unchecked closure.
RUN cd pragmatic-server && npx tsx docker/images/closure-check.ts

# The control plane (platform-admin / platform-edge: dist-tenant-admin/admin/control-plane/server.js) and the tenant admin
# run from the tenant-admin compile; ui-unpack has its own compile of only what its entry imports (dist-ui-unpack). tsc
# emits only JavaScript, so the assets those modules read relative to themselves are staged beside them, each set at its
# own path, so that every image copies only the sets its app reads (closure.json `files`):
#   dist-tenant-admin/admin/portal/dist         operator portal SPA (ControlPlaneServer's static root)    platform-admin
#   dist-tenant-admin/admin/tenant-portal/dist  tenant portal SPA (the tenant admin's static root)        tenant-admin
#   dist-tenant-admin/release-keys              release trust keys (default PRAGMATIC_RELEASE_TRUST_DIR,  platform-admin
#                                               two levels above the compiled control plane)
#   dist-tenant-admin/environments/demo/seed,   Demo seed and Northwind sample (BundleBuilder,            platform-admin,
#   dist-tenant-admin/environments/sample-apps  NorthwindApp.Compile), read when an environment is made   tenant-admin
#   dist-tenant-admin/admin/control-plane/templates  environment templates (TemplateCatalog): inside the compiled
#                                               control plane, which every control-plane image copies whole
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd pragmatic-server && npm run build:tenant-admin && npm run build:ui-unpack \
    && cd admin/tenant-portal && npm install --no-audit --no-fund && npm run build \
    && mkdir -p ../../dist-tenant-admin/admin/tenant-portal \
    && cp -r dist ../../dist-tenant-admin/admin/tenant-portal/dist \
    && rm -rf node_modules dist
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd pragmatic-server/admin/portal && npm install --no-audit --no-fund && npm run build \
    && mkdir -p ../../dist-tenant-admin/admin/portal \
    && cp -r dist ../../dist-tenant-admin/admin/portal/dist \
    && rm -rf node_modules dist
RUN cd pragmatic-server \
    && mkdir -p dist-tenant-admin/environments/demo \
    && cp -r environments/demo/seed dist-tenant-admin/environments/demo/seed \
    && cp -r environments/sample-apps dist-tenant-admin/environments/sample-apps \
    && cp -r admin/control-plane/templates dist-tenant-admin/admin/control-plane/templates \
    && cp -r release-keys dist-tenant-admin/release-keys

# IdP sign-in app: the IdP daemon (dist/bin/pragmatic-idpd.js) serves idp-login/dist (the path IdpLoginPage resolves
# relative to its own module) and refuses to start without it. Only the built dist is kept.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd pragmatic-server/idp-login && npm install --no-audit --no-fund && npm run build && rm -rf node_modules

# Drop dev dependencies workspace-wide; prod deps (incl. the native lmdb addon) and the file: sibling links are kept.
# TODL declares esbuild and typescript as devDependencies, yet its html-bundle build system (reached through the
# project-system import) imports both at module load, so they are stashed across TODL's prune and restored.
# The engine is a TODL devDependency (optional peer), so the prune drops TODL's link to it; the link is removed
# first (a plain unlink, so the prune never walks into the sibling) and re-made afterwards.
RUN set -e; mkdir /todl-dev-stash; for pkg in esbuild typescript; do \
      cp -a "/workspace/TODL/node_modules/$pkg" "/todl-dev-stash/$pkg"; \
    done; \
    rm /workspace/TODL/node_modules/@pragmatic-tech-ai/graph; \
    for d in pragmatic-graph todl-runtime TODL pragmatic-protocol todl-identity todl-identity-local \
      todl-identity-host todl-identity-cloud todl-identity-engine todl-connectors-host \
      todl-platform-node todl-platform-cloud todl-platform-aws todl-platform-azure \
      todl-platform-gcp todl-identity-node pragmatic-server; do \
      (cd "/workspace/$d" && npm prune --omit=dev --no-audit --no-fund); \
    done; \
    for pkg in esbuild typescript; do \
      cp -a "/todl-dev-stash/$pkg" "/workspace/TODL/node_modules/$pkg"; \
    done; rm -rf /todl-dev-stash; \
    sh /workspace/pragmatic-server/docker/link-graph-engine.sh /workspace; \
    find /workspace -type f \( -name '*.map' -o -name '*.tsbuildinfo' \) -delete 2>/dev/null || true

# Shared runtime base: the app images below differ only in what they copy and how they start.
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
ENV NODE_ENV=production
# uid and gid are both 10001, so the --chown=10001:10001 copies below never leave files under an orphan group.
RUN groupadd --system --gid 10001 pragmatic && useradd --system --create-home --uid 10001 --gid 10001 pragmatic
WORKDIR /workspace/pragmatic-server

# The provisioning CLIs the admin drives remote targets with (spec D26): kubectl, kind and the docker CLI (client only;
# no daemon runs in or next to admin). Each download is checked against a pinned sha256 for the build's TARGETARCH.
# Upstream checksums: dl.k8s.io/release/<v>/bin/linux/<arch>/kubectl.sha256 and the kind release's
# kind-linux-<arch>.sha256sum. download.docker.com publishes no checksums for the static bundles, so those two are pinned
# from a verified download (2026-11-19).
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS platform-admin-tools
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.37.2
ARG KUBECTL_SHA256_AMD64=c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4
ARG KUBECTL_SHA256_ARM64=fcc16f63186659d9722014b7e02d5fdd2d4e669cb8c0ab66365d7d3b8ba03509
ARG KIND_VERSION=v0.33.0
ARG KIND_SHA256_AMD64=aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d
ARG KIND_SHA256_ARM64=20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2
ARG DOCKER_VERSION=29.10.0
ARG DOCKER_SHA256_AMD64=7c1ebadc65c716cdc6d35fc78759ed0e4317debf43c21dd12f066f2006999def
ARG DOCKER_SHA256_ARM64=6e5159e8b5615e0c0c2954a2a1a2a12bc65f5d9b603595dba24a10cb367408cd
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) K="$KUBECTL_SHA256_AMD64"; I="$KIND_SHA256_AMD64"; D="$DOCKER_SHA256_AMD64"; DA=x86_64 ;; \
      arm64) K="$KUBECTL_SHA256_ARM64"; I="$KIND_SHA256_ARM64"; D="$DOCKER_SHA256_ARM64"; DA=aarch64 ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    mkdir -p /tools && cd /tools; \
    curl -fsSL -o kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl"; \
    echo "$K  kubectl" | sha256sum -c -; \
    curl -fsSL -o kind "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-${TARGETARCH}"; \
    echo "$I  kind" | sha256sum -c -; \
    curl -fsSL -o docker.tgz "https://download.docker.com/linux/static/stable/${DA}/docker-${DOCKER_VERSION}.tgz"; \
    echo "$D  docker.tgz" | sha256sum -c -; \
    tar -xzf docker.tgz docker/docker && mv docker/docker ./docker-cli && rm -rf docker docker.tgz; \
    chmod 0755 kubectl kind docker-cli

# The operator part of the control plane (PRAGMATIC_CONTROL_PLANE_ROLE=admin: everything but the public agent channel),
# with the operator portal, the release trust keys, the internal API for the edge and the provisioning CLIs. Inside its
# container it binds PRAGMATIC_ADMIN_BIND / PRAGMATIC_ADMIN_INTERNAL_BIND; the host publishes both on loopback only.
FROM runtime AS pragmatic-platform-admin
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=platform-admin-tools /tools/kubectl /usr/local/bin/kubectl
COPY --from=platform-admin-tools /tools/kind /usr/local/bin/kind
COPY --from=platform-admin-tools /tools/docker-cli /usr/local/bin/docker
COPY --from=build --chown=10001:10001 /workspace/Mural /workspace/Mural
COPY --from=build --chown=10001:10001 /workspace/TODL /workspace/TODL
COPY --from=build --chown=10001:10001 /workspace/pragmatic-protocol /workspace/pragmatic-protocol
COPY --from=build --chown=10001:10001 /workspace/todl-identity /workspace/todl-identity
COPY --from=build --chown=10001:10001 /workspace/todl-identity-cloud /workspace/todl-identity-cloud
COPY --from=build --chown=10001:10001 /workspace/todl-identity-host /workspace/todl-identity-host
COPY --from=build --chown=10001:10001 /workspace/todl-identity-local /workspace/todl-identity-local
COPY --from=build --chown=10001:10001 /workspace/todl-identity-node /workspace/todl-identity-node
COPY --from=build --chown=10001:10001 /workspace/todl-runtime /workspace/todl-runtime
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/package.json /workspace/pragmatic-server/package.json
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/node_modules /workspace/pragmatic-server/node_modules
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/admin/control-plane /workspace/pragmatic-server/dist-tenant-admin/admin/control-plane
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/environments/seed /workspace/pragmatic-server/dist-tenant-admin/environments/seed
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/src /workspace/pragmatic-server/dist-tenant-admin/src
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/admin/portal /workspace/pragmatic-server/dist-tenant-admin/admin/portal
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/release-keys /workspace/pragmatic-server/dist-tenant-admin/release-keys
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/environments/demo /workspace/pragmatic-server/dist-tenant-admin/environments/demo
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/environments/sample-apps /workspace/pragmatic-server/dist-tenant-admin/environments/sample-apps
ENV PRAGMATIC_CONTROL_PLANE_ROLE=admin
USER 10001
EXPOSE 7000 7001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const r=require('node:http').request({host:'127.0.0.1',port:process.env.PRAGMATIC_ADMIN_PORT||7000,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist-tenant-admin/admin/control-plane/server.js"]

# The keyless public edge (PRAGMATIC_CONTROL_PLANE_ROLE=edge): agent channel + desktop discovery + /healthz on 7100, all
# answered by admin over the internal API. The compiled code alone: no SPA, seed, trust key, data root or tool.
FROM runtime AS pragmatic-platform-edge
COPY --from=build --chown=10001:10001 /workspace/Mural /workspace/Mural
COPY --from=build --chown=10001:10001 /workspace/TODL /workspace/TODL
COPY --from=build --chown=10001:10001 /workspace/pragmatic-protocol /workspace/pragmatic-protocol
COPY --from=build --chown=10001:10001 /workspace/todl-identity /workspace/todl-identity
COPY --from=build --chown=10001:10001 /workspace/todl-identity-cloud /workspace/todl-identity-cloud
COPY --from=build --chown=10001:10001 /workspace/todl-identity-host /workspace/todl-identity-host
COPY --from=build --chown=10001:10001 /workspace/todl-identity-local /workspace/todl-identity-local
COPY --from=build --chown=10001:10001 /workspace/todl-identity-node /workspace/todl-identity-node
COPY --from=build --chown=10001:10001 /workspace/todl-runtime /workspace/todl-runtime
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/package.json /workspace/pragmatic-server/package.json
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/node_modules /workspace/pragmatic-server/node_modules
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/admin/control-plane /workspace/pragmatic-server/dist-tenant-admin/admin/control-plane
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/environments/seed /workspace/pragmatic-server/dist-tenant-admin/environments/seed
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/src /workspace/pragmatic-server/dist-tenant-admin/src
ENV PRAGMATIC_CONTROL_PLANE_ROLE=edge
ENV PRAGMATIC_AGENT_CHANNEL_PORT=7100
ENV PRAGMATIC_AGENT_CHANNEL_BIND=0.0.0.0
USER 10001
EXPOSE 7100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const r=require('node:http').request({host:'127.0.0.1',port:process.env.PRAGMATIC_AGENT_CHANNEL_PORT||7100,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist-tenant-admin/admin/control-plane/server.js"]

# The env server; the worker runs from the same image with: node dist/bin/pragmatic-workerd.js
FROM runtime AS pragmatic-env-server
COPY --from=build --chown=10001:10001 /workspace/Mural /workspace/Mural
COPY --from=build --chown=10001:10001 /workspace/TODL /workspace/TODL
COPY --from=build --chown=10001:10001 /workspace/pragmatic-graph /workspace/pragmatic-graph
COPY --from=build --chown=10001:10001 /workspace/pragmatic-protocol /workspace/pragmatic-protocol
COPY --from=build --chown=10001:10001 /workspace/todl-connectors-host /workspace/todl-connectors-host
COPY --from=build --chown=10001:10001 /workspace/todl-identity /workspace/todl-identity
COPY --from=build --chown=10001:10001 /workspace/todl-identity-cloud /workspace/todl-identity-cloud
COPY --from=build --chown=10001:10001 /workspace/todl-identity-engine /workspace/todl-identity-engine
COPY --from=build --chown=10001:10001 /workspace/todl-identity-host /workspace/todl-identity-host
COPY --from=build --chown=10001:10001 /workspace/todl-identity-local /workspace/todl-identity-local
COPY --from=build --chown=10001:10001 /workspace/todl-identity-node /workspace/todl-identity-node
COPY --from=build --chown=10001:10001 /workspace/todl-platform-aws /workspace/todl-platform-aws
COPY --from=build --chown=10001:10001 /workspace/todl-platform-azure /workspace/todl-platform-azure
COPY --from=build --chown=10001:10001 /workspace/todl-platform-cloud /workspace/todl-platform-cloud
COPY --from=build --chown=10001:10001 /workspace/todl-platform-gcp /workspace/todl-platform-gcp
COPY --from=build --chown=10001:10001 /workspace/todl-platform-node /workspace/todl-platform-node
COPY --from=build --chown=10001:10001 /workspace/todl-runtime /workspace/todl-runtime
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/package.json /workspace/pragmatic-server/package.json
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/node_modules /workspace/pragmatic-server/node_modules
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist /workspace/pragmatic-server/dist
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const r=require('node:http').request({host:'127.0.0.1',port:process.env.PRAGMATIC_PORT||8080,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist/bin/pragmatic-serverd.js"]

FROM runtime AS pragmatic-env-gateway
COPY --from=build --chown=10001:10001 /workspace/pragmatic-protocol /workspace/pragmatic-protocol
COPY --from=build --chown=10001:10001 /workspace/todl-identity /workspace/todl-identity
COPY --from=build --chown=10001:10001 /workspace/todl-runtime /workspace/todl-runtime
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/package.json /workspace/pragmatic-server/package.json
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/node_modules /workspace/pragmatic-server/node_modules
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist /workspace/pragmatic-server/dist
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const r=require('node:http').request({host:'127.0.0.1',port:process.env.PRAGMATIC_PORT||8080,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist/bin/pragmatic-gatewayd.js"]

# The hive agent imports only node built-ins: no node_modules, no siblings.
FROM runtime AS pragmatic-hive-agent
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/package.json /workspace/pragmatic-server/package.json
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist /workspace/pragmatic-server/dist
USER 10001
ENTRYPOINT ["node", "dist/bin/pragmatic-agentd.js"]

FROM runtime AS pragmatic-tenant-admin
COPY --from=build --chown=10001:10001 /workspace/Mural /workspace/Mural
COPY --from=build --chown=10001:10001 /workspace/TODL /workspace/TODL
COPY --from=build --chown=10001:10001 /workspace/pragmatic-protocol /workspace/pragmatic-protocol
COPY --from=build --chown=10001:10001 /workspace/todl-identity /workspace/todl-identity
COPY --from=build --chown=10001:10001 /workspace/todl-identity-cloud /workspace/todl-identity-cloud
COPY --from=build --chown=10001:10001 /workspace/todl-identity-host /workspace/todl-identity-host
COPY --from=build --chown=10001:10001 /workspace/todl-identity-local /workspace/todl-identity-local
COPY --from=build --chown=10001:10001 /workspace/todl-identity-node /workspace/todl-identity-node
COPY --from=build --chown=10001:10001 /workspace/todl-runtime /workspace/todl-runtime
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/package.json /workspace/pragmatic-server/package.json
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/node_modules /workspace/pragmatic-server/node_modules
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/admin/control-plane /workspace/pragmatic-server/dist-tenant-admin/admin/control-plane
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/environments/seed /workspace/pragmatic-server/dist-tenant-admin/environments/seed
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/src /workspace/pragmatic-server/dist-tenant-admin/src
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/admin/tenant-portal /workspace/pragmatic-server/dist-tenant-admin/admin/tenant-portal
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/environments/demo /workspace/pragmatic-server/dist-tenant-admin/environments/demo
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin/environments/sample-apps /workspace/pragmatic-server/dist-tenant-admin/environments/sample-apps
USER 10001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const r=require('node:http').request({host:'127.0.0.1',port:process.env.PRAGMATIC_TENANT_ADMIN_PORT,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js"]

# The tenant IdP; its CA tooling shells out to the openssl CLI. It serves HTTPS only (its certificate is issued for the
# tenant's host, not 127.0.0.1), so the health probe speaks TLS without verifying the peer: it checks liveness, not identity.
FROM runtime AS pragmatic-tenant-idp
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=10001:10001 /workspace/todl-identity /workspace/todl-identity
COPY --from=build --chown=10001:10001 /workspace/todl-identity-host /workspace/todl-identity-host
COPY --from=build --chown=10001:10001 /workspace/todl-identity-local /workspace/todl-identity-local
COPY --from=build --chown=10001:10001 /workspace/todl-identity-node /workspace/todl-identity-node
COPY --from=build --chown=10001:10001 /workspace/todl-runtime /workspace/todl-runtime
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/package.json /workspace/pragmatic-server/package.json
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/node_modules /workspace/pragmatic-server/node_modules
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist /workspace/pragmatic-server/dist
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/idp-login/dist /workspace/pragmatic-server/idp-login/dist
USER 10001
EXPOSE 7100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const r=require('node:https').request({host:'127.0.0.1',port:process.env.PRAGMATIC_IDP_PORT||7100,path:'/healthz',rejectUnauthorized:false},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist/bin/pragmatic-idpd.js"]

# The UI-unpack init container: pulls, verifies and unpacks a signed UI artifact, then exits. Only its own compile
# (dist-ui-unpack: the entry and the few modules it imports), no control plane, SPA or seed.
FROM runtime AS pragmatic-ui-unpack
COPY --from=build --chown=10001:10001 /workspace/todl-runtime /workspace/todl-runtime
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/package.json /workspace/pragmatic-server/package.json
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/node_modules /workspace/pragmatic-server/node_modules
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-ui-unpack /workspace/pragmatic-server/dist-ui-unpack
USER 10001
ENTRYPOINT ["node", "dist-ui-unpack/admin/control-plane/bin/pragmatic-ui-unpack.js"]
