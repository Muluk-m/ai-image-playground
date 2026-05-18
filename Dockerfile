# syntax=docker/dockerfile:1.6
#
# ai-image-playground — 单镜像 BFF + 静态前端。Entrypoint 把 env 模板化写到
# /app/apps/web/dist/runtime-config.json，前端 boot 时拉到运行时配置。
#
# 用法：
#   docker build -t ai-image-playground .
#   docker run -p 37377:37377 \
#     -e BFF_ENABLED=true \
#     -e OPENAI_API_KEY=sk-... \
#     -v $(pwd)/apps/bff/channels.json:/app/apps/bff/channels.json \
#     ai-image-playground
#
# 纯静态部署不需要这个 Dockerfile — `pnpm build` 后把 apps/web/dist 扔任意
# 静态托管即可（详见仓库根 README.md Tier 1）。

# ─── Stage 1: 安装依赖 ────────────────────────────────────────────────
FROM oven/bun:1 AS deps
WORKDIR /app

# pnpm 通过 corepack 启用，跟项目根 packageManager 字段对齐
RUN apt-get update -qq && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://get.pnpm.io/install.sh | env SHELL=/bin/bash PNPM_VERSION=10.33.3 bash - \
  && ln -s /root/.local/share/pnpm/pnpm /usr/local/bin/pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/bff/package.json ./apps/bff/
COPY apps/admin/package.json ./apps/admin/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install --frozen-lockfile

# ─── Stage 2: 构建前端 ────────────────────────────────────────────────
FROM deps AS web-build
WORKDIR /app
COPY . .
RUN pnpm --filter @image-playground/web build

# ─── Stage 3: 运行时 ────────────────────────────────────────────────
FROM oven/bun:1 AS runtime
WORKDIR /app

# 只把跑 BFF 必需的东西复制过来：bff 源码、packages/shared、web/dist、
# 顶层 lockfile + workspace manifest（让 bun 能解析 workspace 引用）
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/bff/node_modules ./apps/bff/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bff ./apps/bff
COPY packages/shared ./packages/shared
COPY --from=web-build /app/apps/web/dist ./apps/web/dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# BFF 默认接 web/dist，跟 BFF 同进程托管前端
ENV STATIC_DIR=/app/apps/web/dist
ENV PORT=37377
ENV BFF_ENABLED=true

EXPOSE 37377

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "/app/apps/bff/src/index.ts"]

# 长任务 (Gemini 3 Pro Image ~5min) 需要给 BFF 足够 graceful 期限；
# `--stop-timeout` 应 >= 60s 才能让 SHUTDOWN_HARD_TIMEOUT_MS (55s) 顺利 drain。
STOPSIGNAL SIGTERM
