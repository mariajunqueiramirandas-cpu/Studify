# syntax=docker/dockerfile:1
# Worker image (pg-boss consumer). Build context: the repository root (docker-compose.yml sets it).
# The worker runs on Bun: pg-boss, pdfjs-dist (legacy build) and @napi-rs/canvas load and work under Bun
# (checked locally; see docs/engineering/deployment.md). Dependencies come from the same pnpm lockfile.


FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/mobile/package.json apps/mobile/
COPY packages/ai/package.json packages/ai/
COPY packages/prompts/package.json packages/prompts/
COPY packages/shared/package.json packages/shared/
COPY packages/speech/package.json packages/speech/
COPY packages/storage/package.json packages/storage/
RUN pnpm install --frozen-lockfile --prod --filter @studify/worker...
COPY . .

FROM oven/bun:1.4-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=bun:bun /repo/node_modules ./node_modules
COPY --from=build --chown=bun:bun /repo/packages ./packages
COPY --from=build --chown=bun:bun /repo/apps/worker ./apps/worker
USER bun
# No port and no health endpoint: the worker is a queue consumer. Dokploy shows its logs.
CMD ["bun", "apps/worker/src/index.ts"]
