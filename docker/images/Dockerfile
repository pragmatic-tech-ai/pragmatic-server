# syntax=docker/dockerfile:1
# One image per app (docker/docker-bake.hcl builds all eight). The build context MUST be the parent workspace dir
# (architecture-agent/) holding pragmatic-server and its siblings. Each runtime target copies ONLY the dirs its
# docker/images/closure.json entry lists; docker/images/closure-check.ts keeps closure.json, this file and the code in step.
# Build: docker buildx bake -f pragmatic-server/docker/docker-bake.hcl   (NPMRC_FILE names an .npmrc with read:packages)
FROM node:22@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb AS build
WORKDIR /workspace
# Native addons (argon2/bcrypt in identity) need a C toolchain.
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

# The control plane (platform-admin / platform-edge: dist-tenant-admin/admin/control-plane/server.js), the tenant admin and
# ui-unpack all run from the tenant-admin compile. It emits only JavaScript, so the assets those modules read relative to
# themselves are placed beside them here: the operator portal (admin/portal/dist) and the tenant portal
# (admin/tenant-portal/dist) SPAs, the environment templates (TemplateCatalog), the Demo seed and the Northwind sample
# (BundleBuilder / NorthwindApp.Compile).
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd pragmatic-server && npm run build:tenant-admin \
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
    && mkdir -p dist-tenant-admin/environments \
    && cp -r environments/demo environments/dev environments/sample-apps dist-tenant-admin/environments/ \
    && cp -r admin/control-plane/templates dist-tenant-admin/admin/control-plane/templates

# IdP sign-in app: the IdP daemon (dist/bin/pragmatic-idpd.js) serves idp-login/dist (the path IdpLoginPage resolves
# relative to its own module) and refuses to start without it. Only the built dist is kept.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd pragmatic-server/idp-login && npm install --no-audit --no-fund && npm run build && rm -rf node_modules

# Drop dev dependencies workspace-wide; prod deps (incl. native argon2) and the file: sibling links are kept.
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

FROM runtime AS pragmatic-platform-admin
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
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin /workspace/pragmatic-server/dist-tenant-admin
USER 10001
EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const r=require('node:http').request({host:'127.0.0.1',port:process.env.PRAGMATIC_ADMIN_PORT||7000,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist-tenant-admin/admin/control-plane/server.js"]

# The same control plane, started as the agent-channel listener only (PRAGMATIC_CONTROL_PLANE_ROLE=edge).
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
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin /workspace/pragmatic-server/dist-tenant-admin
ENV PRAGMATIC_CONTROL_PLANE_ROLE=edge
USER 10001
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
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin /workspace/pragmatic-server/dist-tenant-admin
USER 10001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const r=require('node:http').request({host:'127.0.0.1',port:process.env.PRAGMATIC_TENANT_ADMIN_PORT,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist-tenant-admin/admin/control-plane/bin/pragmatic-tenant-admind.js"]

# The tenant IdP; its CA tooling shells out to the openssl CLI.
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
  CMD node -e "const r=require('node:http').request({host:'127.0.0.1',port:process.env.PRAGMATIC_IDP_PORT||7100,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist/bin/pragmatic-idpd.js"]

# The UI-unpack init container: pulls, verifies and unpacks a signed UI artifact, then exits.
FROM runtime AS pragmatic-ui-unpack
COPY --from=build --chown=10001:10001 /workspace/todl-runtime /workspace/todl-runtime
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/package.json /workspace/pragmatic-server/package.json
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/node_modules /workspace/pragmatic-server/node_modules
COPY --from=build --chown=10001:10001 /workspace/pragmatic-server/dist-tenant-admin /workspace/pragmatic-server/dist-tenant-admin
USER 10001
ENTRYPOINT ["node", "dist-tenant-admin/admin/control-plane/bin/pragmatic-ui-unpack.js"]
