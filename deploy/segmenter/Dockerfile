# Stateless EdgeTAM segmenter for edit-region proposals. Built in CI next to the application
# images (scripts/build-vps-release.sh); the VPS only pulls it. No secrets, no database.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# onnxruntime-node ships the CPU binaries in the package; skip its optional CUDA download, then
# drop the other platforms' binaries and the browser runtime (node only loads onnxruntime-node;
# `--self-test` in the deploy proves it).
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci --omit=dev --no-audit --no-fund \
  && rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin \
    node_modules/onnxruntime-node/bin/napi-v6/win32 \
    node_modules/onnxruntime-node/bin/napi-v6/linux/arm64 \
    node_modules/onnxruntime-web \
  && npm cache clean --force

FROM node:24-bookworm-slim AS model
WORKDIR /build
COPY fetch-model.mjs ./
# Pinned revision and sha256 per file; runtime never reaches Hugging Face.
RUN node fetch-model.mjs /models

FROM node:24-bookworm-slim
ARG APP_VERSION=unknown
# deploy/segmenter/VERSION; the VPS replaces the running segmenter only when this differs.
ARG SEGMENTER_VERSION=0
LABEL online.muvloom.segmenter.version=$SEGMENTER_VERSION
ENV APP_VERSION=$APP_VERSION \
  SEGMENTER_VERSION=$SEGMENTER_VERSION \
  NODE_ENV=production \
  PORT=8080 \
  SEGMENTER_MODEL_DIR=/models \
  SEGMENTER_DTYPE=fp16 \
  SEGMENTER_THREADS=2 \
  SEGMENTER_IDLE_MS=600000 \
  SEGMENTER_CACHE=3
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=model /models /models
COPY package.json server.mjs ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.mjs"]
