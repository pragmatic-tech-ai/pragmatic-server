# syntax=docker/dockerfile:1
# Build context MUST be the parent workspace dir (architecture-agent/).
# Build:  DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile --secret id=npmrc,src=/path/to/.npmrc -t pragmatic-server ..
FROM node:22 AS builder
WORKDIR /workspace
# Native addons (argon2/bcrypt in identity) need a C toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy each package, then install+build in dependency order.
COPY todl-runtime/ ./todl-runtime/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-runtime && npm install --no-audit --no-fund && npm run build
COPY TODL/ ./TODL/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd TODL && npm install --no-audit --no-fund && npm run build
COPY pragmatic-protocol/ ./pragmatic-protocol/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd pragmatic-protocol && npm install --no-audit --no-fund && npm run build
COPY todl-identity/ ./todl-identity/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-identity && npm install --no-audit --no-fund && npm run build
COPY todl-identity-local/ ./todl-identity-local/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-identity-local && npm install --no-audit --no-fund && npm run build
COPY todl-identity-host/ ./todl-identity-host/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-identity-host && npm install --no-audit --no-fund && npm run build
COPY todl-identity-cloud/ ./todl-identity-cloud/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-identity-cloud && npm install --no-audit --no-fund && npm run build
COPY todl-identity-engine/ ./todl-identity-engine/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-identity-engine && npm install --no-audit --no-fund && npm run build
COPY todl-connectors-host/ ./todl-connectors-host/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-connectors-host && npm install --no-audit --no-fund && npm run build
COPY todl-platform-node/ ./todl-platform-node/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-platform-node && npm install --no-audit --no-fund && npm run build
COPY todl-platform-cloud/ ./todl-platform-cloud/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-platform-cloud && npm install --no-audit --no-fund && npm run build
COPY todl-platform-aws/ ./todl-platform-aws/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-platform-aws && npm install --no-audit --no-fund && npm run build
COPY todl-platform-azure/ ./todl-platform-azure/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-platform-azure && npm install --no-audit --no-fund && npm run build
COPY todl-platform-gcp/ ./todl-platform-gcp/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-platform-gcp && npm install --no-audit --no-fund && npm run build
COPY todl-identity-node/ ./todl-identity-node/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd todl-identity-node && npm install --no-audit --no-fund && npm run build
COPY pragmatic-server/ ./pragmatic-server/
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    cd pragmatic-server && npm install --no-audit --no-fund && npm run build

# Slim the tree that gets baked into the runtime image: the entrypoint runs the
# compiled dist with plain `node`, so dev dependencies (TypeScript, tsx, test tooling)
# are not needed at runtime. Prune them workspace-wide; prod deps (incl. native argon2)
# and the file: sibling links are kept.
RUN set -e; for d in todl-runtime TODL pragmatic-protocol todl-identity todl-identity-local \
      todl-identity-host todl-identity-cloud todl-identity-engine todl-connectors-host \
      todl-platform-node todl-platform-cloud todl-platform-aws todl-platform-azure \
      todl-platform-gcp todl-identity-node pragmatic-server; do \
      (cd "/workspace/$d" && npm prune --omit=dev --no-audit --no-fund); \
    done; \
    find /workspace -type f \( -name '*.map' -o -name '*.tsbuildinfo' \) -delete 2>/dev/null || true

FROM node:22-slim AS runtime
ENV NODE_ENV=production
RUN useradd --system --create-home --uid 10001 pragmatic
WORKDIR /app
COPY --from=builder --chown=pragmatic:pragmatic /workspace /workspace
WORKDIR /workspace/pragmatic-server
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const http=require('node:http');const r=http.request({host:'127.0.0.1',port:process.env.PRAGMATIC_PORT||8080,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist/bin/pragmatic-serverd.js"]
