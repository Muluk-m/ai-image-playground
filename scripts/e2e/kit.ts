import { createHash, randomBytes, randomInt } from 'node:crypto'
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join } from 'node:path'
import type { MockUpstream, RecordedRequest } from './mock-upstream.ts'
import type { Stack } from './stack.ts'

/**
 * 场景共用的工具。Playwright 只作库使用（版本由 scripts/pages-browser-smoke.sh 固定、装在仓库外），
 * 所以断言用 node:assert 加下面的轮询，不用 @playwright/test 的 expect。
 */

// Playwright 装在工作区之外、没有本地类型，这里统一按 any 处理。
export type Page = any
export type BrowserContext = any
export type Browser = any

export function loadPlaywright(): { chromium: { launch(options?: object): Promise<Browser> } } {
  const runtime = process.env.PAGES_SMOKE_RUNTIME_DIR
  const require = createRequire(runtime ? join(runtime, 'noop.js') : import.meta.url)
  return require('playwright')
}

export interface ScenarioContext {
  readonly browser: Browser
  readonly stack: Stack
  readonly mock: MockUpstream
  readonly outDir: string
  newSession(label: string): Promise<Session>
}

export interface Session {
  readonly context: BrowserContext
  readonly page: Page
  readonly username: string
  readonly password: string
}

export interface Scenario {
  readonly name: string
  run(ctx: ScenarioContext): Promise<void>
}

export async function eventually<T>(
  what: string,
  probe: () => T | Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value as NonNullable<T>
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 200))
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`)
}

/** 每个场景的提示词都带一个随机后缀：断言只看自己提示词的上游请求，别的场景留下的不会混进来。 */
export function uniquePrompt(label: string): string {
  return `scenario ${label} ${randomBytes(4).toString('hex')}`
}

/** mock 收到的、提示词等于 prompt 的图片请求。 */
export function requestsFor(mock: MockUpstream, prompt: string): readonly RecordedRequest[] {
  return mock.imageRequests().filter((request) => request.prompt === prompt)
}

/**
 * 新建浏览器上下文并用真实的注册接口开一个测试账号：请求在页面里发（浏览器自己收 Set-Cookie），
 * 之后整页重载进入工作台。鉴权逻辑没有被绕过。
 */
export async function openSession(ctx: Omit<ScenarioContext, 'newSession'>, label: string) {
  const context = await ctx.browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  })
  // 栈按 X-Forwarded-For 区分来源：每个会话一个，注册限流不会累计到整套场景上。
  // 只加在发往栈自己的 API 请求上，不动第三方请求（字体 CDN 会因这个头被 CORS 拦掉）。
  const sourceAddress = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`
  await context.route(`${ctx.stack.origin}/api/**`, (route: any) =>
    route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': sourceAddress } }),
  )
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()
  // 每次运行随机生成，不在仓库里放任何口令字面量。
  const password = randomBytes(24).toString('base64url')
  const username = `e2e-${label}-${randomBytes(4).toString('hex')}@example.com`
  await page.goto(`${ctx.stack.origin}/image`)
  const registered = await page.evaluate(
    async ({ username, password }: { username: string; password: string }) => {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      })
      return { status: response.status, body: await response.text() }
    },
    { username, password },
  )
  if (registered.status !== 201) {
    throw new Error(`register failed (${registered.status}): ${registered.body}`)
  }
  await page.goto(`${ctx.stack.origin}/image`)
  const me = await page.evaluate(async () => (await fetch('/api/auth/me')).status)
  if (me !== 200) throw new Error(`session cookie was not kept (/api/auth/me answered ${me})`)
  return { context, page, username, password } satisfies Session
}

export async function typePrompt(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: '描述你的创意' })
  await box.waitFor({ state: 'visible', timeout: 30_000 })
  await box.click()
  // 上一次的提示词可能还留在输入框里：先全选，输入即替换。
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(text)
}

export function generateButton(page: Page) {
  return page.getByRole('button', { name: '生成', exact: true })
}

/** 一条任务出图后卡片里的结果图。 */
export function resultImages(page: Page) {
  return page.locator('img[data-image-id]')
}

/**
 * 模拟一次发版：旧哈希的 js/css 不再保留，页面与脚本改指向新文件名（内容不变，名字加后缀）。
 * 已打开的旧标签页里还引用着旧文件名，尚未加载的分片会 404；新打开的页面一切正常。
 * 返回被换掉的文件名（assets 下的基名）。
 */
export function publishNewRelease(webRoot: string): string[] {
  const assetsDir = join(webRoot, 'assets')
  const renamed = new Map<string, string>()
  for (const name of readdirSync(assetsDir)) {
    const ext = extname(name)
    if (ext !== '.js' && ext !== '.css') continue
    renamed.set(name, `${name.slice(0, -ext.length)}r${ext}`)
  }
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?<![\\w.-])(${[...renamed.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join('|')})(?![\\w-])`,
    'g',
  )
  const rewrite = (file: string) => {
    const text = readFileSync(file, 'utf8')
    const next = text.replace(pattern, (name) => renamed.get(name) ?? name)
    if (next !== text) writeFileSync(file, next)
  }
  for (const name of readdirSync(webRoot)) {
    if (!name.endsWith('.html')) continue
    const file = join(webRoot, name)
    rewrite(file)
    // 页面内的构建标识（启动守卫按它计「每个构建自动刷新一次」的额度）随内容变，和真实发版一致。
    const html = readFileSync(file, 'utf8')
    const identity = createHash('sha256').update(html).digest('hex')
    writeFileSync(
      file,
      html.replace(/(<meta name="aip-html-build" content=")[^"]*/, `$1${identity}`),
    )
  }
  for (const name of renamed.keys()) rewrite(join(assetsDir, name))
  for (const [from, to] of renamed) renameSync(join(assetsDir, from), join(assetsDir, to))
  return [...renamed.keys()]
}

/** 在页面里按同源发请求（带 cookie），返回状态码。 */
export function fetchStatus(page: Page, path: string, init?: object): Promise<number> {
  return page.evaluate(
    async ({ path, init }: { path: string; init?: object }) =>
      (await fetch(path, { credentials: 'include', ...init })).status,
    { path, init },
  )
}

/** 删掉上下文里指定名字的 cookie，其余原样保留（模拟某个凭据过期）。 */
export async function dropCookie(context: BrowserContext, name: string): Promise<void> {
  const all = await context.cookies()
  if (!all.some((cookie: { name: string }) => cookie.name === name)) {
    throw new Error(`cookie ${name} is not set`)
  }
  await context.clearCookies()
  await context.addCookies(all.filter((cookie: { name: string }) => cookie.name !== name))
}

export const SESSION_COOKIE = 'image_playground_session'
export const REFRESH_COOKIE = 'image_playground_refresh'
