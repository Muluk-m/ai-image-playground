import type { Plugin } from 'vite'
import { pageList, pageMeta } from './src/catalog'

export function seoFiles(origin: string, indexing: boolean): Record<string, string> {
  const pages = pageList.filter((page) => page.kind !== 'login' && page.kind !== 'moved')
  const escape = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
  const files: Record<string, string> = {
    'site-pages.json': JSON.stringify(pageList),
    'robots.txt': indexing
      ? `User-agent: *\nAllow: /\nDisallow: /workbench\n${origin ? `Sitemap: ${origin}/sitemap.xml\n` : ''}`
      : 'User-agent: *\nDisallow: /\n',
  }
  if (indexing && origin) {
    files['sitemap.xml'] =
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((page) => `<url><loc>${escape(origin + page.path)}</loc></url>`).join('')}</urlset>\n`
  }
  if (indexing)
    files['llms.txt'] =
      `# Muvloom\n\nAI image, video and canvas creation.\n\n${pages.map((page) => `- [${pageMeta(page).title}](${origin}${page.path}): ${pageMeta(page).description}`).join('\n')}\n`
  return files
}
export function seoPlugin(origin: string, indexing: boolean): Plugin {
  return {
    name: 'website-seo',
    applyToEnvironment: (environment) => environment.name === 'client',
    generateBundle() {
      for (const [fileName, source] of Object.entries(seoFiles(origin, indexing)))
        this.emitFile({ type: 'asset', fileName, source })
    },
  }
}
