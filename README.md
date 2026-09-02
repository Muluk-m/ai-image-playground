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

### Option 2 · Containerized application

The application release is one local image. The same image runs nginx, BFF, worker, and
Admin, and both deployment projects use [`deploy/compose.app.yaml`](./deploy/compose.app.yaml).
nginx serves the Web build and proxies `/api/*`, `/health`, and the unchanged `/v1/*` API
namespace to BFF. BFF does not serve Web assets in this layout.

Prepare the infrastructure and deployment files outside the repository:

```bash
config_root="${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground"
mkdir -p \
  "$config_root/apps/image-playground-internal" \
  "$config_root/apps/image-playground-paid"

cp deploy/infra.env.example "$config_root/infra.env"
cp deploy/app.internal.env.example \
  "$config_root/apps/image-playground-internal/app.env"
cp deploy/app.paid.env.example \
  "$config_root/apps/image-playground-paid/app.env"
cp deploy/migrate.env.example \
  "$config_root/apps/image-playground-internal/migrate.env"
cp deploy/migrate.env.example \
  "$config_root/apps/image-playground-paid/migrate.env"
chmod 600 \
  "$config_root/infra.env" \
  "$config_root/apps/image-playground-internal/app.env" \
  "$config_root/apps/image-playground-internal/migrate.env" \
  "$config_root/apps/image-playground-paid/app.env" \
  "$config_root/apps/image-playground-paid/migrate.env"

# Replace every replace-* value before starting anything.
```

Each deployment uses three PostgreSQL identities: a one-shot schema owner in `migrate.env`,
a DML-only application writer in `app.env`, and an Admin SELECT-only reader in `app.env`.
The two deployments must also use different databases, object-store locations, object-store
credentials, internal service tokens, provider credentials, and CORS origins. Real secrets and operator
configuration remain in these external directories; only safe examples are committed.
`operator-config.json` is optional beside each `app.env`: missing means every capability is off;
a present invalid file prevents BFF startup. The browser obtains its read-only capability list
from the BFF and never evaluates operator settings itself.
Set `accounts:login=true` and `accounts:self-register=true` to expose the registration entry and
`POST /api/auth/register`; self-registration cannot be enabled without login. When the private
billing overlay also enables `billing:credits`, account creation grants welcome credits in the
same database transaction.

Start infrastructure, provision one migrator, one application writer, and one Admin reader for
each deployment, build the release image once, then start each project:

```bash
scripts/infra-compose.sh up

# Set the seven POSTGRES_MIGRATOR_* / POSTGRES_APP_* / POSTGRES_ADMIN_* values in
# infra.env for the internal deployment, provision it, then replace them with the
# paid values and provision again.
scripts/infra-compose.sh provision

scripts/app-compose.sh build-private ai-image-playground:local
scripts/app-compose.sh up image-playground-internal
scripts/app-compose.sh up image-playground-paid
```

`infra-compose.sh` uses
`$XDG_CONFIG_HOME/ai-image-playground/infra.env` by default. Set `INFRA_ENV_FILE` to
override it. `up` waits for PostgreSQL. `provision` idempotently creates one deployment
database, its schema-owner migrator, its DML-only application role, and its Admin SELECT-only
role. Set `POSTGRES_EXTRA_SCHEMAS` when a deployment's migrations create schemas beyond `public`
and `drizzle`, so the Admin role can read them and the daily `pg_dump` succeeds; provision names
any schema it still cannot read before it exits. No Compose file publishes a PostgreSQL port; use
`docker compose exec` to inspect it.

Object storage is any S3-compatible service. Both deployment examples point at Cloudflare R2;
`S3_KEY_PREFIX` confines a deployment to one prefix when its bucket is shared with other
workloads. Each project also runs a `pg-backup` sidecar that uploads a daily `pg_dump` of its
own database to `<S3_KEY_PREFIX>pg/<UTC date>.dump`. Retention belongs to a bucket lifecycle
rule, not to the sidecar.

`app-compose.sh` defaults to
`$XDG_CONFIG_HOME/ai-image-playground/apps/<project>/app.env` and requires a sibling
`migrate.env`. Only the one-shot migration service receives the schema-owner credential.
It starts dependency checks, applies public and present private Drizzle migrations, starts BFF,
worker, Admin, and the backup sidecar, then activates the tunnel only after BFF is healthy. Each Web container writes its own
`/usr/share/nginx/html/runtime-config.json` from its external environment, so both domains
share the same Web build without sharing runtime configuration.

Option 4 below routes the domains through Cloudflare Tunnel and starts no nginx. To front the
projects with an existing reverse proxy instead, connect that proxy container to each project's
`application` network and start the `web` service with
`scripts/app-compose.sh compose <project> up --detach --wait web`. Route the domains to the
stable per-project aliases:

| Target | Upstream |
|---|---|
| Internal Web | `http://image-playground-internal-web:8080` |
| Paid Web | `http://image-playground-paid-web:8080` |
| Internal Admin | `http://image-playground-internal-admin:37378` |
| Paid Admin | `http://image-playground-paid-admin:37378` |

Such a proxy must overwrite `X-Forwarded-For` with one canonical client address rather than
append a caller-supplied chain, and `app.env` must then set `CLIENT_IP_SOURCE=x-forwarded-for`
instead of the default `cf-connecting-ip`. That value drives login and registration rate
limits; multi-value chains fall back to the immediate proxy address.

Protect Admin with Cloudflare Access, a VPN, or an IP allowlist. The committed Compose file
does not publish host ports because the domain proxy owns ingress. If the existing host
proxy is not containerized, an operator-supplied Compose override must bind loopback-only
Web/Admin ports.

For a one-time cutover from the former SQLite deployment:

1. Stop the application.
2. Run `SQLITE_DATABASE_PATH=/absolute/image-playground.sqlite SQLITE_BACKUP_PATH=/absolute/image-playground.readonly.sqlite bun run scripts/prepare-postgres-cutover.ts`. The command refuses the cutover while any task is `queued` or `in_progress`, writes a consistent read-only backup, and does not import history.
3. Start and provision a fresh PostgreSQL database as above.
4. Start the application project. Before ending the maintenance window, run `DATABASE_URL=postgresql://<migrator>@127.0.0.1:5432/deployment_database pnpm db:verify`, then confirm `/health`, login, an empty server-side task history, and one new generation.

If validation fails, stop the new application and restore the previous image/configuration
against the read-only SQLite backup. Do not use the destructive public or private rollback SQL
files on production; `packages/db/drizzle/rollback/` and
`private/apps/bff/billing/rollback/` are only for discarding a new empty deployment.

Inspect or stop projects independently:

```bash
scripts/app-compose.sh status image-playground-internal
scripts/app-compose.sh stop image-playground-internal
scripts/app-compose.sh stop image-playground-paid
scripts/infra-compose.sh down
```

Stopping an application project removes neither the PostgreSQL volume nor the external
infrastructure network. Stop infrastructure only after both application projects are down.

`app-compose.sh rollback` only switches between images that implement the current role-based
Compose contract. It preserves backend-first activation:

```bash
scripts/app-compose.sh rollback image-playground-internal ai-image-playground:previous
scripts/app-compose.sh rollback image-playground-paid ai-image-playground:previous
```

If the compatible previous tag was not retained, build it from its source checkout first. The
first SQLite-to-PostgreSQL cutover is different: restore the former deployment from its previous
source checkout and configuration, with the read-only SQLite backup, instead of using this helper.

### Option 3 · Separate frontend host (static host + API subdomain)

The frontend ships as a plain static bundle on a host such as Cloudflare Pages. The backend
still runs the Option 2 image for BFF / worker / Admin; nginx just stops serving the frontend.

Public BYOK bundle:

```bash
scripts/pages-deploy.sh public ai-image-playground preview-branch
```

Private bundle (the working copy must contain the reviewed `./private` overlay):

```bash
BFF_ENABLED=true BFF_BASE_URL=https://api.example.com \
  scripts/pages-deploy.sh private ai-image-playground-paid main
```

The edition asserts the presence of the overlay; the backend switch is independent of it. A
public bundle may set `BFF_ENABLED=true` and a private one may stay BYOK-only. wrangler reads
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment, which is how two
projects in two Cloudflare accounts are published from one checkout.

`build:static-host` writes `dist/runtime-config.json` after the normal build. Incomplete
configuration fails the build instead of publishing a site that cannot reach its backend.
Caching and SPA fallback come from [`apps/web/public/_headers`](./apps/web/public/_headers)
and [`apps/web/public/_redirects`](./apps/web/public/_redirects), which mirror the matching
rules in [`deploy/nginx.conf`](./deploy/nginx.conf).

`build:static-host` also writes `dist/version.json`, the manifest open tabs poll to notice a
new deployment. Releases are silent by default: running tabs pick the new bundle up on their
next reload. `NOTIFY_UPDATE=true` marks one release as worth interrupting for, and tabs then
show a corner prompt offering a reload. The Option 2 image does not build through
`build:static-host`, so it ships no manifest and never prompts.

`EXTRA_ASSETS_DIR=<dir>` copies that directory into `dist/op/` between the build and the
upload, for per-deployment files that are not in the repository — an operator's payment QR
image, for example. Each file is then served at `/op/<file>` on the frontend origin, so a
same-origin relative URL reaches it. The script fails if the directory is missing rather than
publishing without it. These files are public: anyone who knows the URL can read them.

Without a tunnel, set `APP_INGRESS_MODE=api-only` in the backend `app.env` and start the `web`
service: the same nginx container then proxies only the API and returns 404 for every other
path instead of serving a second frontend. Option 4 replaces that container with cloudflared.
The backend must also meet these conditions:

- `CORS_ALLOWED_ORIGINS` must list the frontend origin exactly. Credentialed requests cannot
  use `*`.
- The frontend and the API must share one registrable domain (for example `app.example.com`
  and `api.example.com`). The session cookie is `Secure; SameSite=Lax` and is not sent across
  registrable domains, so a host-assigned default domain such as `*.pages.dev` requires a
  different cookie policy.
- Mind the submit request body ceiling. Input images and the mask travel base64-inlined in the
  submit JSON: 512 MiB on the client, 600 MB in BFF and nginx. If the API domain sits behind a
  proxy that caps request bodies (Cloudflare's proxy allows 100 MB on Free and Pro), large
  multi-image submits are rejected at the edge.

A paid deployment also needs the private overlay: a static host's Git build cannot read the
private repository, so build locally or in CI and upload the artifact.

### Option 4 · Single VPS + Cloudflare Tunnel + Pages

This is the layout the committed Compose files are written for. One host runs PostgreSQL and
one application project per deployment; each project runs its own cloudflared, so the host
publishes no port and needs no inbound firewall rule. The frontend is a Cloudflare Pages
project per deployment, and object storage is R2.

```text
Pages  image-playground.example.com ─┐
                                     ├─ Cloudflare ─ tunnel ─ VPS ─ bff ─ postgres
API    image-api.example.com ────────┘                             ├─ worker ─ R2
Admin  image-admin.example.com ──────────────────────────────────  └─ admin
```

Prepare the external configuration exactly as in option 2, then add the tunnel files. Create
one tunnel per deployment in its own Cloudflare account and place the credentials beside
`app.env`:

```bash
config_root="${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground"
app_dir="$config_root/apps/image-playground-internal"
mkdir -p "$app_dir/cloudflared"

cloudflared tunnel create image-playground-internal
cp ~/.cloudflared/<tunnel-uuid>.json "$app_dir/cloudflared/credentials.json"
cp deploy/cloudflared/config.yml.example "$app_dir/cloudflared/config.yml"
# Replace the tunnel UUID and both hostnames in that file.

# The cloudflared image runs as uid 65532, so files owned by your account at mode 600 are
# unreadable to it and the container restart-loops.
sudo chown 65532:65532 "$app_dir/cloudflared/config.yml" "$app_dir/cloudflared/credentials.json"
sudo chmod 400 "$app_dir/cloudflared/config.yml" "$app_dir/cloudflared/credentials.json"

# That uid must also be able to reach them. o+x is traverse-only: these directories stay
# unlistable, and nothing above needs o+r.
chmod o+x "$HOME" "$(dirname "$config_root")" "$config_root" "$config_root/apps" "$app_dir"
chmod 711 "$app_dir/cloudflared"
```

A `open /etc/cloudflared/config.yml: permission denied` in the cloudflared log, with the
container restarting, means one of those two steps was skipped.

Copy `deploy/operator-config.internal.example.json` to `$app_dir/operator-config.json` and
adjust it. Then bring the host up:

```bash
scripts/infra-compose.sh up
scripts/infra-compose.sh provision                    # once per deployment database
scripts/app-compose.sh build ai-image-playground:local
scripts/app-compose.sh up image-playground-internal
```

Point the hostnames at the tunnel, from the account that owns them:

```bash
cloudflared tunnel route dns image-playground-internal image-api.example.com
cloudflared tunnel route dns image-playground-internal image-admin.example.com
```

Set the two R2 lifecycle rules on the bucket, where `<prefix>` is this deployment's
`S3_KEY_PREFIX` (empty for a dedicated bucket). Nothing in this repository creates them, and on
a shared bucket a rule without the prefix would expire objects that belong to other workloads:

```bash
wrangler r2 bucket lifecycle list <bucket>
wrangler r2 bucket lifecycle add <bucket> --name pixels \
  --prefix '<prefix>' --expire-days 45
wrangler r2 bucket lifecycle add <bucket> --name pg-dumps \
  --prefix '<prefix>pg/' --expire-days 14
```

The dumps sit inside the pixel prefix, so both rules match them and the shorter one decides.

Publish the frontend and only then move its DNS record to Pages:

```bash
BFF_ENABLED=true BFF_BASE_URL=https://image-api.example.com \
  scripts/pages-deploy.sh public <pages-project> main
```

The frontend and the API must share one registrable domain, as in option 3: the Admin session
cookie is `Secure; SameSite=Lax`.

The submit body ceiling here is the edge's: over 100 MB it is rejected with a 413. The 512 MiB
client and 600 MB BFF limits from option 3 only bind on the same-origin and nginx layouts, where
nothing sits in front.

The committed `protocol: http2` is deliberate. cloudflared defaults to QUIC, which hangs
MB-sized uploads on hosts whose network throttles sustained UDP — measured on Tencent Cloud,
where the client sees an h2 `PROTOCOL_ERROR` or a 524 and BFF never receives the request at all.
Raising `net.core.rmem_max` and `wmem_max` silences quic-go's warning but does not fix it. Try
`protocol: http2` first whenever large uploads hang through a tunnel.

Repeat every step with `image-playground-paid` to run a second, fully separate deployment on
the same host. It gets its own database, R2 location, tunnel, Pages project, and Cloudflare
account; the two share only PostgreSQL's process and the host.

## 🛠 Development

```bash
pnpm install
pnpm dev          # web + bff in parallel
pnpm test         # vitest + bun:test
pnpm typecheck
pnpm lint
```

Stack: React 19 + Vite on the frontend · tldraw for the canvas · Bun + Elysia + PostgreSQL on the backend · pnpm + Turbo monorepo.

When the upstream is a sub2api gateway with async image tasks enabled, set `UPSTREAM_ASYNC_IMAGE_TASKS=true` (or `defaults.asyncTasks` on a direct channel) so the worker submits and polls instead of holding a long connection — a restart then resumes polling rather than paying for the image twice. There is no silent fallback: **turn our declaration off before disabling the switch upstream**, or every submit fails with a 404.

## 🙏 Credits

Forked from [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) (MIT), keeping the original UX (reference images + mask editing, waterfall history, inspiration library, quick model picker, effective-parameter comparison). This fork adds native Gemini protocol support, a long-task queue mode, an optional backend, and the infinite-canvas create mode.

Inspiration library prompt data:
- [freestylefly/awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2) (MIT)
- [YouMind-OpenLab/awesome-nano-banana-pro-prompts](https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts) (CC BY 4.0)

## 📄 License

[MIT](./LICENSE)
