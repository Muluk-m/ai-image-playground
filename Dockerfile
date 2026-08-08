# syntax=docker/dockerfile:1.6
#
# ai-image-playground — 单镜像 BFF + 静态前端。Entrypoint 把 env 模板化写到
# /app/apps/web/dist/runtime-config.json，前端 boot 时拉到运行时配置。
#
# 用法：
#   docker build -t ai-image-playground .
#   docker run -p 37377:37377 \
#     -e BFF_ENABLED=true \
#     -e AUTH_ENABLED=false \
#     -e OPENAI_API_KEY=sk-... \
#     -e AGNES_API_KEY=sk-... \
#     -v $(pwd)/apps/bff/channels.json:/app/apps/bff/channels.json \
#     ai-image-playground
#
# 纯静态部署不需要这个 Dockerfile — `pnpm build` 后把 apps/web/dist 扔任意
# 静态托管即可（详见仓库根 README.md Tier 1）。

# ─── Stage 1: 安装依赖 ────────────────────────────────────────────────
FROM oven/bun:1 AS deps
WORKDIR /app

# pnpm 版本从根 package.json 的 packageManager 字段现取，避免在这里再写死一份。
#
# 用 @pnpm/exe（内含原生 binary）而不是 get.pnpm.io 安装脚本：后者装出来的是个靠
# `dirname "$0"` 自定位同级 .tools/pnpm-exe/<ver>/pnpm 的 shim，只要 symlink 进
# PATH，$0 就变成链接路径、shim 去错目录找 binary 并报 not found。
# base image 里没有 curl 也没有 corepack，bun 是唯一现成的安装器。
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

# ─── Stage 2: 构建前端 ────────────────────────────────────────────────
FROM deps AS web-build
WORKDIR /app
COPY . .
RUN pnpm --filter @image-playground/web build

# ─── Stage 3: 构建 Admin ────────────────────────────────────────────
FROM deps AS admin-build
WORKDIR /app
COPY . .
RUN pnpm --filter @image-playground/admin build

# ─── Stage 4: Admin 运行时（显式 --target admin-runtime）────────────
FROM oven/bun:1 AS admin-runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/admin/node_modules ./apps/admin/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# MIT 产物随镜像分发，许可证要跟着走
COPY LICENSE ./
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/admin/server ./apps/admin/server
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared
COPY --from=admin-build /app/apps/admin/dist ./apps/admin/dist

ENV PORT=37378
ENV ADMIN_DIST_DIR=/app/apps/admin/dist

EXPOSE 37378

CMD ["bun", "run", "/app/apps/admin/server/index.ts"]

# ─── Stage 5: Web + BFF 运行时（默认最终 target）────────────────────
FROM oven/bun:1 AS runtime
WORKDIR /app

# 只把跑 BFF 必需的东西复制过来：bff 源码、packages/db/shared、web/dist、
# 顶层 lockfile + workspace manifest（让 bun 能解析 workspace 引用）
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/bff/node_modules ./apps/bff/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# MIT 产物随镜像分发，许可证要跟着走
COPY LICENSE ./
COPY apps/bff ./apps/bff
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared
COPY --from=web-build /app/apps/web/dist ./apps/web/dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# BFF 默认接 web/dist，跟 BFF 同进程托管前端
ENV STATIC_DIR=/app/apps/web/dist
ENV PORT=37377
ENV BFF_ENABLED=true
ENV AUTH_ENABLED=false

EXPOSE 37377

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "/app/apps/bff/src/index.ts"]

# 长任务 (Gemini 3 Pro Image ~5min) 需要给 BFF 足够 graceful 期限；
# `--stop-timeout` 应 >= 60s 才能让 SHUTDOWN_HARD_TIMEOUT_MS (55s) 顺利 drain。
STOPSIGNAL SIGTERM
