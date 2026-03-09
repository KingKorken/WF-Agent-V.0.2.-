# --------------------------------------------------------------------------
# Bridge Server — multi-stage Docker build
# Builds only the shared + server workspaces (no Electron, no Vite)
# --------------------------------------------------------------------------

FROM node:20-slim AS builder

WORKDIR /app

# 1. Copy workspace root + lock file
COPY package.json package-lock.json ./

# 2. Copy workspace package.json files (npm needs these to resolve workspaces)
COPY shared/package.json shared/
COPY server/package.json server/
COPY local-agent/package.json local-agent/
COPY dashboard/package.json dashboard/

# 3. Install ALL dependencies (npm workspaces need the full graph to resolve)
RUN npm ci --ignore-scripts

# 4. Copy source for shared + server + local-agent (agent loop orchestration)
COPY shared/ shared/
COPY server/ server/
COPY local-agent/ local-agent/
COPY tsconfig.json ./

# 5. Build shared first, then local-agent, then server
RUN npm run build --workspace=@workflow-agent/shared && \
    npm run build --workspace=@workflow-agent/local-agent && \
    npm run build --workspace=@workflow-agent/server

# --------------------------------------------------------------------------
# Production image — minimal runtime
# --------------------------------------------------------------------------
FROM node:20-slim AS runtime

WORKDIR /app

# Non-root user (P1 security fix)
RUN groupadd --gid 1001 appuser && \
    useradd --uid 1001 --gid appuser --create-home appuser

# Copy workspace root
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY local-agent/package.json local-agent/
COPY dashboard/package.json dashboard/

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled output from builder
COPY --from=builder /app/shared/dist shared/dist
COPY --from=builder /app/server/dist server/dist
COPY --from=builder /app/local-agent/dist local-agent/dist

# Copy shared package files needed at runtime
COPY shared/types.ts shared/types.ts
COPY shared/index.ts shared/index.ts

# Switch to non-root user
USER appuser

# Bridge server port
EXPOSE 8765

# Agent loop modules are now available in the container
# loadAgentModules() will resolve from the default path: local-agent/dist

# Health check via the /health HTTP endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "const h=require('http');h.get('http://localhost:8765/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "server/dist/bridge.js"]
