# ADR 0025: Static marketing website and shared authentication entry

Status: accepted, 2026-10-16

The user approved prototype A: a green original comic character, a centered cinematic cover,
a scroll-driven frame transition and staggered storyboard panels. B/C are retired. Copy stays short.
The audience is general creators first; both Chinese and English have independently indexable URLs.

## Decision

Add `apps/website` with TanStack Start 1.x and its Vite 8 toolchain. Pre-render every public route at
build time; publish only `dist/client`. Keep the workbench on its existing Vite 6 runtime. Web's
build combines the two outputs, retaining the old SPA entry as `workbench.html`. Explicit Pages
rewrites send app/project/pricing/legal routes there. Missing pages and assets remain 404.
The BFF and nginx static hosts follow the same route split. Production still uses existing Pages
projects and the main deployment workflow, with no new SSR service.

The website owns `/`, `/en/`, `/login/`, `/en/login/`, bilingual creation pages and existing
`/guide/**` addresses. Guide source content and anchors survive; React components replace the old
HTML-template renderer. SEO uses per-page metadata, canonical/hreflang, visible FAQ/procedure
structured data, robots, sitemap and llms.txt. Internal/test builds disable indexing. Authentication
and workbench URLs are not indexable marketing pages.

Anonymous visitors see the website. Start buttons open the shared login form, without accepting or
submitting a sample prompt. Successful authentication goes to `/image`; authenticated visitors to
the website root also go there. Existing workbench login dialogs retain pending-submission recovery,
registration, verification and OAuth behavior. The dedicated login page and modal share this form.

## Validation

Build fails on a missing prerender. Existing release verification checks the identity of both static
pages and rewritten app entries, plus lazy scripts/styles. Browser release smoke covers marketing,
login opening, guides and the existing workbench/project paths. Focus trapping, reduced motion and
narrow layouts are checked on the actual built pages. Production delivery requires existing PR CI,
main deployment and live acceptance; a local preview alone is not release evidence.
