# syntax=docker/dockerfile:1.6

# Public builds use the default false marker and scrub any cached private context.
# Paid builds must pass both `--build-context private-overlay=./private` and
# `--build-arg PRIVATE_OVERLAY_PRESENT=true`.
FROM scratch AS private-overlay

# One release image runs every application role. Compose selects nginx, BFF,
# worker, or Admin with APP_ROLE and command; both deployment projects reuse the
# same immutable image and the web role writes its runtime config at startup.

FROM oven/bun:1 AS deps
WORKDIR /app

# packageManager is the source of truth for pnpm. @pnpm/exe supplies a native
# binary; the installer shim from get.pnpm.io breaks when symlinked into PATH.
ENV BUN_INSTALL=/usr/local
RUN --mount=type=bind,source=package.json,target=/tmp/root-package.json \
  bun install -g \
  "@pnpm/exe@$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' /tmp/root-package.json)"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/bff/package.json ./apps/bff/
COPY apps/admin/package.json ./apps/admin/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install --frozen-lockfile

FROM deps AS web-build
WORKDIR /app
COPY . .
COPY --from=private-overlay / /app/private
ARG PRIVATE_OVERLAY_PRESENT=false
RUN if [ "$PRIVATE_OVERLAY_PRESENT" != "true" ]; then rm -rf /app/private && mkdir /app/private; fi
ENV PRIVATE_WEB_OVERLAY_ENTRY=/app/private/apps/web/index.tsx
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @image-playground/web build

FROM deps AS admin-build
WORKDIR /app
COPY . .
COPY --from=private-overlay / /app/private
ENV PRIVATE_ADMIN_OVERLAY_ENTRY=/app/private/apps/admin/index.tsx
ARG PRIVATE_OVERLAY_PRESENT=false
RUN if [ "$PRIVATE_OVERLAY_PRESENT" != "true" ]; then rm -rf /app/private && mkdir /app/private; fi
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @image-playground/admin build

FROM oven/bun:1 AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install --yes --no-install-recommends nginx \
  && rm -rf /var/lib/apt/lists/* /usr/share/nginx/html/* \
  && rm -f /etc/nginx/sites-enabled/default

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/bff/node_modules ./apps/bff/node_modules
COPY --from=deps /app/apps/admin/node_modules ./apps/admin/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY LICENSE ./
COPY apps/bff ./apps/bff
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/admin/server ./apps/admin/server
COPY apps/admin/contracts.ts ./apps/admin/contracts.ts
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared
COPY --from=admin-build /app/apps/admin/dist ./apps/admin/dist
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
# `private-overlay` is empty in public builds and populated only by the explicit paid build.
COPY --from=web-build /app/private ./private

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/check-dependencies.ts ./scripts/check-dependencies.ts
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV APP_ROLE=bff
ENV PORT=37377
ENV STATIC_DIR=
ENV BFF_ENABLED=true
ENV ADMIN_DIST_DIR=/app/apps/admin/dist

EXPOSE 8080 37377 37378

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "/app/apps/bff/src/index.ts"]

# The worker may drain for 55 seconds after SIGTERM. Compose grants BFF and
# worker 75 seconds before SIGKILL.
STOPSIGNAL SIGTERM
