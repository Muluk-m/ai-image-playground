import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
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

export async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
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
  return { context, page, username } satisfies Session
}

export async function typePrompt(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: '描述你的创意' })
  await box.waitFor({ state: 'visible', timeout: 30_000 })
  await box.click()
  await page.keyboard.type(text)
}

export function generateButton(page: Page) {
  return page.getByRole('button', { name: '生成', exact: true })
}

/** 一条任务出图后卡片里的结果图。 */
export function resultImages(page: Page) {
  return page.locator('img[data-image-id]')
}
