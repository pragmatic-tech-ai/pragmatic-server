# syntax=docker/dockerfile:1
# Build context MUST be the parent workspace dir (architecture-agent/).
# Build:  DOCKER_BUILDKIT=1 docker build -f pragmatic-server/docker/Dockerfile -t pragmatic-server ..
FROM node:22 AS builder
WORKDIR /workspace
# Native addons (argon2/bcrypt in identity) need a C toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy each package, then install+build in dependency order.
COPY todl-runtime/ ./todl-runtime/
RUN cd todl-runtime && npm install --no-audit --no-fund && npm run build
COPY TODL/ ./TODL/
RUN cd TODL && npm install --no-audit --no-fund && npm run build
COPY pragmatic-protocol/ ./pragmatic-protocol/
RUN cd pragmatic-protocol && npm install --no-audit --no-fund && npm run build
COPY todl-identity/ ./todl-identity/
RUN cd todl-identity && npm install --no-audit --no-fund && npm run build
COPY todl-identity-local/ ./todl-identity-local/
RUN cd todl-identity-local && npm install --no-audit --no-fund && npm run build
COPY todl-identity-host/ ./todl-identity-host/
RUN cd todl-identity-host && npm install --no-audit --no-fund && npm run build
COPY todl-identity-cloud/ ./todl-identity-cloud/
RUN cd todl-identity-cloud && npm install --no-audit --no-fund && npm run build
COPY todl-identity-engine/ ./todl-identity-engine/
RUN cd todl-identity-engine && npm install --no-audit --no-fund && npm run build
COPY todl-connectors-host/ ./todl-connectors-host/
RUN cd todl-connectors-host && npm install --no-audit --no-fund && npm run build
COPY todl-platform-node/ ./todl-platform-node/
RUN cd todl-platform-node && npm install --no-audit --no-fund && npm run build
COPY todl-platform-cloud/ ./todl-platform-cloud/
RUN cd todl-platform-cloud && npm install --no-audit --no-fund && npm run build
COPY todl-identity-node/ ./todl-identity-node/
RUN cd todl-identity-node && npm install --no-audit --no-fund && npm run build
COPY pragmatic-server/ ./pragmatic-server/
RUN cd pragmatic-server && npm install --no-audit --no-fund && npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
RUN useradd --system --create-home --uid 10001 pragmatic
WORKDIR /app
COPY --from=builder --chown=pragmatic:pragmatic /workspace /workspace
WORKDIR /workspace/pragmatic-server
USER pragmatic
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const http=require('node:http');const r=http.request({host:'127.0.0.1',port:process.env.PRAGMATIC_PORT||8080,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist/bin/pragmatic-serverd.js"]
