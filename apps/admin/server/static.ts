import { extname, join } from 'node:path'

// 从 apps/bff/src/app.ts 的 serveStatic / serveSpaFallback / cacheControlFor /
// MIME 表 / gzip 探测复制而来，剔除 BFF 专属的 sw.js / inspiration-manifest.json
// 分支（admin 没有 SW 也没有 hero seed）。
// 共用还是分叉的取舍见 openspec/changes/admin-dashboard-ui/design.md。

const COMPRESSIBLE_EXTS = new Set([
  '.html',
  '.js',
  '.css',
  '.json',
  '.svg',
  '.txt',
  '.webmanifest',
  '.map',
])

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const GZIP_MIN_BYTES = 1024

async function gzipBlob(blob: Blob): Promise<ArrayBuffer> {
  const compressed = Bun.gzipSync(new Uint8Array(await blob.arrayBuffer()))
  const output = new ArrayBuffer(compressed.byteLength)
  new Uint8Array(output).set(compressed)
  return output
}

function cacheControlFor(pathname: string): string {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  if (pathname === '/index.html' || pathname === '/manifest.webmanifest') return 'no-cache'
  return 'no-cache'
}

export function isApiPath(pathname: string): boolean {
  // admin 的 API 全部在 /api/ 下；/health 是 server 健康检查
  return pathname.startsWith('/api/') || pathname === '/health'
}

export async function serveStatic(
  staticDir: string,
  pathname: string,
  request: Request,
): Promise<Response | null> {
  if (!staticDir) return null
  // 防止 path traversal：禁止 .. 跳出 staticDir
  if (pathname.includes('..')) return null
  const file = Bun.file(join(staticDir, pathname))
  if (!(await file.exists())) return null

  const ext = extname(pathname).toLowerCase()
  const compressible = COMPRESSIBLE_EXTS.has(ext)
  const acceptEnc = (request.headers.get('accept-encoding') ?? '').toLowerCase()
  const wantsGzip = acceptEnc.includes('gzip')
  const size = file.size

  const baseHeaders: Record<string, string> = {
    'cache-control': cacheControlFor(pathname),
  }
  if (ext in MIME_BY_EXT) baseHeaders['content-type'] = MIME_BY_EXT[ext]!

  if (compressible && wantsGzip && size >= GZIP_MIN_BYTES) {
    return new Response(await gzipBlob(file), {
      headers: {
        ...baseHeaders,
        'content-encoding': 'gzip',
        vary: 'accept-encoding',
      },
    })
  }
  return new Response(file, { headers: baseHeaders })
}

export async function serveSpaFallback(staticDir: string): Promise<Response | null> {
  if (!staticDir) return null
  const indexFile = Bun.file(join(staticDir, 'index.html'))
  if (!(await indexFile.exists())) return null
  return new Response(indexFile, {
    headers: {
      'cache-control': 'no-cache',
      'content-type': 'text/html; charset=utf-8',
    },
  })
}
