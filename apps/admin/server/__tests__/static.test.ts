import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpDir = mkdtempSync(join(tmpdir(), 'admin-static-'))
writeFileSync(join(tmpDir, 'index.html'), '<!doctype html><html><body>admin</body></html>')

// Mimic Vite's hashed JS/CSS output.
mkdirSync(join(tmpDir, 'assets'))
writeFileSync(join(tmpDir, 'assets', 'index-abc123.js'), 'console.log(1);'.repeat(200))

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.BFF_INTERNAL_URL = 'http://127.0.0.1:39999'
process.env.PORT = '0'
process.env.ADMIN_DIST_DIR = tmpDir

// Dynamic import keeps environment setup ahead of Admin configuration capture.
const { app } = await import('../app')

describe('admin static serving', () => {
  it('未匹配的 GET / → 200 + index.html (SPA fallback)', async () => {
    const res = await app.handle(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('admin')
  })

  it('未匹配的 GET /devices → 200 + index.html (SPA fallback)', async () => {
    const res = await app.handle(new Request('http://localhost/devices'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('GET /assets/index-abc123.js → 200 + js + immutable cache', async () => {
    const res = await app.handle(new Request('http://localhost/assets/index-abc123.js'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
  })

  it('gzip 请求返回可解压的静态资源而不是运行时错误文本', async () => {
    const res = await app.handle(
      new Request('http://localhost/assets/index-abc123.js', {
        headers: { 'accept-encoding': 'gzip' },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    const restored = Bun.gunzipSync(await res.arrayBuffer())
    expect(new TextDecoder().decode(restored)).toContain('console.log(1)')
  })

  it('未匹配的 /api/* → 404 JSON（不走 fallback）', async () => {
    const res = await app.handle(new Request('http://localhost/api/nope'))
    expect(res.status).toBe(404)
    // body 不是 html
    const body = await res.text()
    expect(body).not.toContain('admin')
  })

  it('/health 不被静态托管覆盖', async () => {
    const res = await app.handle(new Request('http://localhost/health'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('path traversal 攻击防御：/../etc/passwd 返 fallback 不返实际文件', async () => {
    const res = await app.handle(new Request('http://localhost/../etc/passwd'))
    // 浏览器一般不会发这种路径；但即使到达 server 也不应返 /etc/passwd
    expect(res.headers.get('content-type') ?? '').not.toContain('text/plain')
  })
})
