# syntax=docker/dockerfile:1.6
#
# Single-VPS image for bff / worker / admin (APP_ROLE). Public web is Cloudflare Pages.
#
#   docker compose up -d --build
#   # or: docker build -t ai-image-playground .

FROM oven/bun:1 AS deps
WORKDIR /app

RUN apt-get update -qq && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://get.pnpm.io/install.sh | env SHELL=/bin/bash PNPM_VERSION=10.33.3 bash - \
  && ln -s /root/.local/share/pnpm/pnpm /usr/local/bin/pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/bff/package.json ./apps/bff/
COPY apps/admin/package.json ./apps/admin/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/

RUN pnpm install --frozen-lockfile

FROM deps AS admin-build
WORKDIR /app
COPY . .
RUN pnpm --filter @image-playground/admin build

FROM oven/bun:1 AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/bff/node_modules ./apps/bff/node_modules
COPY --from=deps /app/apps/admin/node_modules ./apps/admin/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bff ./apps/bff
COPY apps/admin/server ./apps/admin/server
COPY apps/admin/package.json ./apps/admin/package.json
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY --from=admin-build /app/apps/admin/dist ./apps/admin/dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Public web is on Cloudflare. Leave STATIC_DIR empty so BFF does not serve apps/web.
ENV STATIC_DIR=
ENV ADMIN_DIST_DIR=/app/apps/admin/dist
ENV PORT=37377
ENV APP_ROLE=bff

EXPOSE 37377 37378 37379

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "/app/apps/bff/src/index.ts"]

# Long jobs (Gemini image ~5min) need a drain window; `--stop-timeout` should be >= 60s
# so SHUTDOWN_HARD_TIMEOUT_MS (55s) can finish.
STOPSIGNAL SIGTERM
