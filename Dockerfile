# syntax=docker/dockerfile:1.6

# One release image runs every application role. Compose selects nginx, BFF,
# worker, or Admin with APP_ROLE and command; both deployment projects reuse the
# same immutable image and the web role writes its runtime config at startup.
# The admin proxy during rollout also starts this image with `--entrypoint nginx`.

# Match CI's Node 24 toolchain: Bun's node fallback can make pnpm skip
# engine-constrained optional packages such as Rolldown's native bindings.
FROM --platform=$BUILDPLATFORM oven/bun:1-slim AS bun-toolchain
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS pnpm-base
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# packageManager remains the source of truth for pnpm, now running on real Node.
RUN --mount=type=bind,source=package.json,target=/tmp/root-package.json \
  npm install --global \
  "pnpm@$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' /tmp/root-package.json)"

# Workspace install. All modules (including capability-gated billing and OAuth) live in this tree.
FROM pnpm-base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/website/package.json ./apps/website/
COPY apps/bff/package.json ./apps/bff/
COPY apps/admin/package.json ./apps/admin/
COPY packages/db/package.json ./packages/db/
COPY packages/node-kit/package.json ./packages/node-kit/
COPY packages/read-models/package.json ./packages/read-models/
COPY packages/shared/package.json ./packages/shared/

# Compile with the builder's native CPU (Bun/JSC cannot reliably run under QEMU).
# Also install the target optional binaries, especially sharp, for the runtime image.
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) cpu=x64 ;; arm64) cpu=arm64 ;; *) exit 1 ;; esac \
  && printf '\nsupportedArchitectures:\n  os: [linux]\n  cpu: [current, %s]\n  libc: [glibc]\n' "$cpu" >> pnpm-workspace.yaml \
  && pnpm install --frozen-lockfile

FROM --platform=$BUILDPLATFORM golang:1.23-bookworm AS cli-dist
WORKDIR /src/cli-go
COPY cli-go/go.mod cli-go/go.sum ./
RUN go mod download
COPY cli-go ./
RUN set -eu; \
  ver="$(sed -n 's/^const BundleVersion = "\([^"]*\)".*/\1/p' internal/skill/install.go)"; \
  test -n "$ver"; \
  mkdir -p "/out/v$ver"; \
  for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do \
    goos="${target%/*}"; goarch="${target#*/}"; ext=""; \
    [ "$goos" = windows ] && ext=".exe"; \
    tmp="/out/v$ver/.tmp_${goos}_${goarch}"; \
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath \
      -ldflags "-s -w -X github.com/Muluk-m/ai-image-playground/cli-go/internal/cli.Version=$ver" \
      -o "$tmp" ./cmd/muvloom; \
    h="$(sha256sum "$tmp" | cut -c1-12)"; \
    mv "$tmp" "/out/v$ver/muvloom_${goos}_${goarch}-${h}${ext}"; \
  done; \
  test "$(find "/out/v$ver" -maxdepth 1 -type f -name 'muvloom_*' | wc -l | tr -d ' ')" = "5"
FROM deps AS web-build
WORKDIR /app
COPY . .
COPY --from=deps /app/pnpm-workspace.yaml ./
RUN pnpm install --offline --frozen-lockfile
COPY --from=cli-dist /out /app/apps/web/public/cli/bin
# Product release baked into Settings. Empty falls back to the root package.json version.
ARG APP_RELEASE=
ENV APP_RELEASE=$APP_RELEASE
RUN pnpm --filter @image-playground/web build

FROM deps AS admin-build
WORKDIR /app
COPY . .
COPY --from=deps /app/pnpm-workspace.yaml ./
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @image-playground/admin build

# Production tree for the processes this image actually runs. Frontend packages
# stay in the build stages above; pnpm deploy --prod does not copy them.
FROM deps AS runtime-deps
WORKDIR /app
COPY apps/bff ./apps/bff
COPY apps/admin/server ./apps/admin/server
COPY apps/admin/contracts.ts ./apps/admin/contracts.ts
COPY packages/db ./packages/db
COPY packages/node-kit ./packages/node-kit
COPY packages/read-models ./packages/read-models
COPY packages/shared ./packages/shared
# pnpm 10 refuses to deploy a workspace unless dependencies are injected, so the
# output is a real copy instead of a symlink back into this stage. The setting
# stays in this stage: the build installs above keep the normal workspace links.
# Elysia peers typescript and drizzle-orm peers bun-types; both are type-only
# and optional. They are removed after deploy. sharp's optional native binaries
# stay, so this is not a global --no-optional install.
RUN printf '\ninjectWorkspacePackages: true\n' >> pnpm-workspace.yaml \
  && pnpm --filter @image-playground/bff --prod deploy /out/bff \
  && pnpm --filter @image-playground/admin --prod deploy /out/admin \
  && find /out \( -type d -o -type l \) \( \
       -name typescript -o -name bun-types -o -path '*/node_modules/@types/bun' \
     \) -print0 | xargs -0r rm -rf \
  && for path in \
       /out/bff/src/index.ts \
       /out/bff/channels.json \
       /out/bff/skills \
       /out/bff/node_modules/sharp \
       /out/bff/node_modules/@image-playground/db/drizzle/meta/_journal.json \
       /out/bff/node_modules/@image-playground/db/drizzle-billing/meta/_journal.json \
       /out/bff/node_modules/@image-playground/read-models/src/index.ts \
       /out/admin/server/index.ts \
       /out/admin/contracts.ts \
       /out/admin/node_modules/@image-playground/read-models/src/index.ts; do \
       test -e "$path" || { echo "missing $path" >&2; exit 1; }; \
     done \
  && for root in /out/bff /out/admin; do \
       [ -d "$root" ] || continue; \
       find "$root" -type l > /tmp/deploy-links; \
       while IFS= read -r link; do \
         target=$(readlink -f "$link") || { echo "dangling symlink $link" >&2; exit 1; }; \
         case "$target" in \
           "$root"/*) ;; \
           *) echo "symlink escapes $root: $link -> $target" >&2; exit 1 ;; \
         esac; \
       done < /tmp/deploy-links; \
     done \
  && find /out -path '*/node_modules/*' -type d \( \
       -name workerd -o -name miniflare -o -name wrangler -o -name drizzle-kit \
       -o -name lucide-react -o -name date-fns -o -name date-fns-jalali \
       -o -name '@biomejs' -o -name turbo -o -name typescript \
     \) > /tmp/banned-packages \
  && if [ -s /tmp/banned-packages ]; then \
       echo "dev or frontend packages in the runtime deploy:" >&2; \
       cat /tmp/banned-packages >&2; \
       exit 1; \
     fi \
  && echo "sharp-libvips:" \
  && find /out -path '*/node_modules/.pnpm/*' -prune -name '*sharp-libvips*' -printf '%f\n' | sort -u \
  && echo "esbuild:" \
  && find /out -path '*/node_modules/.pnpm/*' -prune -name 'esbuild@*' -printf '%f\n' | sort -u \
  && libvips=$(find /out -path '*/node_modules/.pnpm/*' -prune -name '*sharp-libvips*' -printf '%f\n' | sed 's/.*@//' | sort -u | grep -c . || true) \
  && esbuilds=$(find /out -path '*/node_modules/.pnpm/*' -prune -name 'esbuild@*' -printf '%f\n' | sed 's/.*@//' | sort -u | grep -c . || true) \
  && [ "$libvips" -le 1 ] && [ "$esbuilds" -le 1 ]

# viewVideo only demuxes a local mp4/matroska/avi and writes a scaled JPEG.
# Debian's ffmpeg package pulls the full codec library stack (~hundreds of MB).
# FFmpeg's own libraries are linked statically. AV1 still needs dav1d, which
# Debian ships only as a shared library, so that one .so is copied into the runtime.
FROM debian:trixie-slim AS ffmpeg-build
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential ca-certificates curl nasm pkg-config xz-utils zlib1g-dev libdav1d-dev \
  && rm -rf /var/lib/apt/lists/*
ARG FFMPEG_VERSION=8.0
ARG FFMPEG_SHA256=b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e
WORKDIR /src
RUN curl -fsSL -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
  && tar -xf ffmpeg.tar.xz
WORKDIR /src/ffmpeg-${FFMPEG_VERSION}
RUN ./configure \
    --prefix=/opt/ffmpeg \
    --disable-shared \
    --enable-static \
    --disable-debug \
    --disable-doc \
    --disable-ffplay \
    --disable-gpl \
    --disable-nonfree \
    --enable-small \
    --enable-libdav1d \
    --extra-cflags=-Os \
    --disable-encoders \
    --enable-encoder=mjpeg \
    --disable-muxers \
    --enable-muxer=mjpeg \
    --enable-muxer=image2 \
    --disable-devices \
    --disable-protocols \
    --enable-protocol=file \
    --enable-protocol=pipe \
    --enable-protocol=crypto \
  && make -j2 \
  && make install \
  && strip /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe \
  && mkdir -p /opt/ffmpeg/lib \
  && cp -a /usr/lib/x86_64-linux-gnu/libdav1d.so.7 /usr/lib/x86_64-linux-gnu/libdav1d.so.7.0.0 /opt/ffmpeg/lib/ \
  && ldd /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe \
  && unexpected=$(ldd /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe | awk '/=>/ {print $1}' | grep -Ev '^(libdav1d\.so\.7|libz\.so\.1|libm\.so\.6|libc\.so\.6|libdl\.so\.2|libpthread\.so\.0|ld-linux-x86-64\.so\.2)$' || true) \
  && if [ -n "$unexpected" ]; then echo "$unexpected" >&2; exit 1; fi \
  && ls -lh /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /opt/ffmpeg/lib

FROM oven/bun:1-slim AS runtime
WORKDIR /app

# nginx serves the web role and the rollout admin proxy (`--entrypoint nginx`).
# ca-certificates keeps Bun's outbound HTTPS working on the slim base.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates nginx \
  && rm -rf /var/lib/apt/lists/* /usr/share/nginx/html/* /usr/share/doc /usr/share/man \
  && rm -f /etc/nginx/sites-enabled/default

COPY --from=ffmpeg-build /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
COPY --from=ffmpeg-build /usr/lib/x86_64-linux-gnu/libdav1d.so.7.0.0 /usr/local/lib/libdav1d.so.7.0.0
RUN ln -s libdav1d.so.7.0.0 /usr/local/lib/libdav1d.so.7 \
  && echo /usr/local/lib > /etc/ld.so.conf.d/dav1d.conf \
  && ldconfig

COPY --from=runtime-deps /out/bff ./apps/bff
COPY --from=runtime-deps /out/admin ./apps/admin

COPY --from=admin-build /app/apps/admin/dist ./apps/admin/dist
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html

COPY package.json LICENSE ./
# Both ingress shapes ship in the image; the entrypoint installs the one APP_INGRESS_MODE selects.
COPY deploy/nginx.conf deploy/nginx.api-only.conf deploy/nginx.proxy.conf ./deploy/
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/check-dependencies.ts ./scripts/check-dependencies.ts
COPY scripts/release-router.ts ./scripts/release-router.ts
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && nginx -v \
  && ffmpeg -version \
  && ffprobe -version \
  && test -e /etc/ssl/certs/ca-certificates.crt

LABEL app.execution-protocol="1"
ENV APP_ROLE=bff
ENV PORT=37377
ENV STATIC_DIR=
ENV BFF_ENABLED=true
ENV ADMIN_DIST_DIR=/app/apps/admin/dist

# The commits this image was built from. Services report it in their heartbeat so the operations
# board can show what is actually running. Declared last: it changes every build, and nothing
# after it is worth caching.
ARG APP_VERSION=unknown
ENV APP_VERSION=$APP_VERSION
ARG APP_RELEASE=unknown
ENV APP_RELEASE=$APP_RELEASE

EXPOSE 8080 37377 37378 37379

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "/app/apps/bff/src/index.ts"]

# The worker may drain for 55 seconds after SIGTERM. Compose grants BFF and
# worker 75 seconds before SIGKILL.
STOPSIGNAL SIGTERM
