# Public website

Read `../web/DESIGN.md` before visual work. Share the workbench's Button, Input, Icon, Overlay,
authentication form and semantic tokens; do not duplicate authentication protocols.

- TanStack Start pre-renders every entry in `src/catalog.ts`. Publish only `dist/client`; no runtime
  SSR or server functions. Public navigation uses ordinary links so direct requests work on Pages.
- `/` and `/en/` are marketing homepages. `/login/` and `/en/login/` share the real workbench login
  form and are noindex. Successful login and an existing authenticated root session go to `/image`.
  Example art/CTA does not enqueue a prompt. Workbench pending submissions keep their existing flow.
- Guide content is in `../web/src/features/guide/content` (groups → pages, `/guide/<group>/<page>/`).
  Never drop a published URL or anchor: map it in `moved`, which pre-renders a noindex redirect page.
  Matching `group/page` keys pair the languages for hreflang. The React renderer and body/FAQ search
  use this same data.
- `PUBLIC_ORIGIN` is a bare deployment origin. Canonical/hreflang/JSON-LD/sitemap require it.
  `SEARCH_INDEXING=false` means noindex, robots Disallow and no sitemap or llms.txt.
- `pnpm --filter @image-playground/web build:static-host` builds the final Pages directory, including
  the workbench and runtime configuration. `build:site` alone is only the website intermediate output.
- `compose.mjs` fails if any pre-render is missing. Production deploys continue through the existing
  PR/main workflow. Never publish `dist/server` or call a separate manual website deployment.
- Pure website catalog/SEO tests use Vitest in `src/__tests__`; shared authentication entry tests live
  in `apps/web/src/__tests__/auth/WebsiteEntry.test.tsx` beside the existing login tests.
