# syntax=docker/dockerfile:1
# API image (Bun + Hono). Build context: the repository root (docker-compose.yml sets it).
# Stage 1 installs production dependencies with pnpm (node-linker=hoisted, see .npmrc). Stage 2 builds the
# React link site (apps/site, Vite). Stage 3 runs the server on Bun with the built site copied to /app/site.


FROM node:22-slim AS manifests
RUN corepack enable
WORKDIR /repo
# Manifests first, so the dependency layers are reused until a package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/server-tasks/package.json packages/server-tasks/
COPY apps/mobile/package.json apps/mobile/
COPY apps/site/package.json apps/site/
COPY packages/ai/package.json packages/ai/
COPY packages/prompts/package.json packages/prompts/
COPY packages/shared/package.json packages/shared/
COPY packages/speech/package.json packages/speech/

FROM manifests AS build
RUN pnpm install --frozen-lockfile --prod --filter @studify/api...
COPY . .

FROM manifests AS site
RUN pnpm install --frozen-lockfile --filter @studify/site
COPY tsconfig.base.json ./
COPY apps/site apps/site
RUN pnpm --filter @studify/site build

FROM oven/bun:1.4-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    SITE_DIR=/app/site
WORKDIR /app
COPY --from=build --chown=bun:bun /repo/node_modules ./node_modules
COPY --from=build --chown=bun:bun /repo/packages ./packages
COPY --from=build --chown=bun:bun /repo/apps/api ./apps/api
COPY --from=site --chown=bun:bun /repo/apps/site/dist ./site
USER bun
EXPOSE 3000
# No curl in the image: Bun's fetch checks the health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "apps/api/src/server.ts"]
