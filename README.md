<div align="center">

<img src="./apps/web/public/pwa-icon.svg" alt="" width="96" height="96" />

# AI Image Playground

A browser-based AI image workbench with an infinite creative canvas — bring your own API key, history and config stay fully local.

[![License](https://img.shields.io/badge/License-MIT-10b981?style=flat-square)](./LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.x-FBF0DF?style=flat-square&logo=bun&logoColor=black)](https://bun.sh/)

English | [中文](./README.zh.md)

[**Try it live · image.nainma.online**](https://image.nainma.online/)

</div>

<p align="center">
  <a href="https://image.nainma.online/" target="_blank">
    <img src="./docs/images/canvas-hero.jpg" alt="Create mode — draw an annotation on an image, describe the change, and iterate right on the infinite canvas" width="900" />
  </a>
</p>

<p align="center"><i>Create mode: circle what you want changed, type the instruction, and iterate — annotate → generate → merge, all on one canvas.</i></p>

## ✨ Features

Two ways to work, one shared history:

### 🎨 Create mode — infinite canvas

- **Annotate to iterate** — select an image, draw circles / arrows / notes on it, describe the change; the model follows your markup and returns a clean image with annotations removed
- **Merge images** — box-select multiple images and they're sent together as references ("put the kitten next to the puppy")
- **Generate in place** — with nothing selected, your prompt is plain text-to-image; results land right on the canvas next to your material
- **Fire-and-forget concurrency** — every generation gets a live placeholder frame; keep working while multiple tasks run in parallel, with n>1 fan-out for variants
- **Refresh-safe** — the canvas persists locally; in backend mode, in-flight generations resume automatically after a page reload
- **Connected to the workbench** — canvas results land in the shared history (favorite / search / reuse), and any workbench image can be sent onto the canvas to keep iterating
- **Keyboard-first** — full shortcut support with a built-in cheat sheet (⌘⏎ to generate, V/H/D/E tool switching, undo/redo…)

### 🛠 Workbench mode

- **Multiple models** — OpenAI, Gemini, custom HTTP endpoints; bring your own API key
- **Reference images + masks** — up to 16 reference images; the OpenAI path includes a visual mask editor
- **Waterfall history** — every generation saved locally with its effective parameters, favoritable and searchable
- **Inspiration library** — hundreds of high-quality prompts you can apply with one click

### ⚙️ Runs anywhere

- **Fast jobs run inline** — browser calls the upstream directly, images in seconds
- **Long jobs supported too** — optional "backend mode" for 30s–5min jobs (e.g. Gemini 3 Pro). Tasks are persisted; refreshing the page won't lose them
- **No key leakage** — in backend mode, API keys stay in the server's env; the browser never sees them
- **Fully local** — history, config, and BYOK keys live in the browser's IndexedDB

<p align="center">
  <a href="https://image.nainma.online/" target="_blank">
    <img src="./docs/images/preview.png" alt="Workbench mode" width="900" />
  </a>
</p>

## 🚀 Run locally

```bash
git clone https://github.com/Muluk-m/ai-image-playground.git
cd ai-image-playground
pnpm install
pnpm dev:web        # starts the frontend at http://localhost:5173
```

Open the settings panel (top-right), drop in an OpenAI or Gemini API key (leave baseUrl as default), and you're ready to generate.

## 📦 Deploy

### Option 1 · Static-only (simplest)

One-click deploy:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Muluk-m/ai-image-playground&project-name=ai-image-playground&repository-name=ai-image-playground)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Muluk-m/ai-image-playground)

The repo ships `vercel.json` and `netlify.toml` preconfigured for the monorepo — both buttons build `apps/web` and serve `apps/web/dist` with no extra setup.

Or any other static host (Cloudflare Pages / GitHub Pages / nginx / S3):

```bash
pnpm install && pnpm build
# upload apps/web/dist/ to your static host
```

Users plug in their own API key in the UI; the browser talks to the upstream directly. **Jobs longer than ~1 minute won't work** (edge timeouts).

### Option 2 · Docker (with backend; long jobs + preset providers)

```bash
docker build -t ai-image-playground .
docker run -p 37377:37377 \
  -e AUTH_ENABLED=false \
  -e OPENAI_API_KEY=sk-... \
  -e GEMINI_API_KEY=... \
  -e DATABASE_URL=/data/image-playground.sqlite \
  -v image-playground-data:/data \
  -v $(pwd)/apps/bff/channels.json:/app/apps/bff/channels.json \
  ai-image-playground
```

Open `http://localhost:37377`. `channels.json` configures the list of preset providers (OpenAI + Gemini by default — operators edit this file to add more).

Full configuration reference (runtime-config / channels.json / env vars) is in [`apps/bff/README.md`](./apps/bff/README.md).

### Reproducible PostgreSQL and MinIO dependencies

Wave 0 provides PostgreSQL and private MinIO as a separate Compose project. Prepare its
environment file outside the repository once, replace every placeholder, then start both
test dependencies with one command:

```bash
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground"
mkdir -p "$config_dir"
cp deploy/infra.env.example "$config_dir/infra.env"
chmod 600 "$config_dir/infra.env"
# Edit "$config_dir/infra.env" before continuing.

pnpm test:deps:up
```

Set `INFRA_ENV_FILE=/absolute/path/to/infra.env` to use another repository-external file.
`pnpm test:deps:up` waits for PostgreSQL and MinIO readiness, then creates every bucket in
`MINIO_BUCKET_NAMES`, removes anonymous access, and installs a 45-day expiry rule. This is
longer than the application's 30-day task retention. Data remains in project-scoped named
volumes after `pnpm test:deps:down`.

The required keys are:

| Key | Purpose |
|---|---|
| `INFRA_NETWORK_NAME` | Stable private Docker network that application projects join |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | PostgreSQL bootstrap database and credentials |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | MinIO bootstrap credentials |
| `MINIO_BUCKET_NAMES` | Comma-separated, unique bucket names, one per deployment |

`INFRA_BIND_ADDRESS` defaults to `127.0.0.1`; the three optional host-port keys are
`POSTGRES_HOST_PORT`, `MINIO_API_HOST_PORT`, and `MINIO_CONSOLE_HOST_PORT`. Keep the bind
address loopback-only unless a host firewall provides an equivalent boundary. Applications
use `postgres:5432` and `http://minio:9000` on the external network contract:

```yaml
networks:
  application-infra:
    external: true
    name: ${INFRA_NETWORK_NAME}
```

Use `pnpm test:deps:status` to inspect service health and `pnpm test:deps:down` to stop the
project without deleting its volumes. The existing macmini PostgreSQL and MinIO installation
has not been inspected because no SSH host is configured. Do not start this project there
until ownership of existing data and the migration path have been verified.

### Two domains: personal + commercial

For two independent Web+BFF deployments, configure the switch per instance:

| Deployment | `AUTH_ENABLED` | Behavior |
|---|---:|---|
| Personal domain | `false` | Existing anonymous workbench; no login screen |
| Commercial domain | `true` | Login required; tasks and browser-local data are isolated per account |

Use separate SQLite volumes for the two instances. Each BFF also needs the provider secrets
named by the `auth.secretRef` fields in its `channels.json` (`OPENAI_API_KEY`, `GEMINI_API_KEY`,
… by default) — a missing secret only warns at startup, and requests to that channel fail
later. The commercial Admin service must share the commercial BFF's SQLite volume on the same
Docker host:

```bash
# Commercial Web+BFF
docker network create image-commercial-net
docker volume create image-commercial-data
docker run -d --name image-commercial --network image-commercial-net -p 37379:37377 \
  -e AUTH_ENABLED=true \
  -e OPENAI_API_KEY=sk-... \
  -e GEMINI_API_KEY=... \
  -e DATABASE_URL=/data/image-playground.sqlite \
  -e CORS_ALLOWED_ORIGINS=https://commercial.example.com \
  -v image-commercial-data:/data \
  ai-image-playground

# Commercial Admin
docker build --target admin-runtime -t ai-image-playground-admin .
docker run -d --name image-commercial-admin --network image-commercial-net -p 37378:37378 \
  -e ADMIN_PASSWORD='replace-with-a-strong-password' \
  -e ADMIN_COOKIE_SECRET='replace-with-at-least-32-random-characters' \
  -e DATABASE_URL=/data/image-playground.sqlite \
  -e BFF_INTERNAL_URL=http://image-commercial:37377 \
  -e CORS_ALLOWED_ORIGINS=https://admin.example.com \
  -v image-commercial-data:/data \
  ai-image-playground-admin
```

Create the first account from the Admin “Users” page. The Admin can create, enable/disable,
reset passwords, and revoke all sessions. Put both sites behind HTTPS and add an additional
access policy (Cloudflare Access, VPN, or an IP allowlist) in front of the Admin domain.

## 🛠 Development

```bash
pnpm install
pnpm dev          # web + bff in parallel
pnpm test         # vitest + bun:test
pnpm typecheck
pnpm lint
```

Stack: React 19 + Vite on the frontend · tldraw for the canvas · Bun + Elysia + SQLite on the backend · pnpm + Turbo monorepo.

## 🙏 Credits

Forked from [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) (MIT), keeping the original UX (reference images + mask editing, waterfall history, inspiration library, quick model picker, effective-parameter comparison). This fork adds native Gemini protocol support, a long-task queue mode, an optional backend, and the infinite-canvas create mode.

Inspiration library prompt data:
- [freestylefly/awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2) (MIT)
- [YouMind-OpenLab/awesome-nano-banana-pro-prompts](https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts) (CC BY 4.0)

## 📄 License

[MIT](./LICENSE)
