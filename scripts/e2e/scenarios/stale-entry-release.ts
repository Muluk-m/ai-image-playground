import assert from 'node:assert/strict'
import { eventually, type Page, publishNewRelease, type Scenario } from '../kit.ts'

/**
 * 先加载旧构建的 HTML，再发版：旧入口（index）已经跑起来，工作台本体（AuthGate 里懒加载的 App 分片）
 * 在入口之后才请求，此时已被新版本换掉而 404。对应 #1813（发版后旧标签缺分片）。
 *
 * 两个场景都在「页面第一次请求 App 分片」的瞬间发版：先发版、再让该 JS 请求答 404（只拦 JS：CSS 缺失由 route-css-missing 覆盖），不靠计时。
 * - `stale-entry-release`：自动刷新额度没用过，应刷新一次拿到新 HTML 并进入工作台；
 * - `stale-entry-budget-spent`：这个构建的额度已用掉（边缘缓存让刷新又拿到旧 HTML 的情形），不能再刷新，
 *   也不能让整棵树卸成白屏：工作台外要留一张「页面暂时无法打开」卡片，不循环刷新。
 */
/** 只拦 JS：CSS 缺失已有 route-css-missing 覆盖，这里要确定走的是 AuthGate 懒加载 App 模块失败这条路径。 */
const APP_CHUNK = /\/assets\/App-[^/]+\.js(?:\?|$)/
const BUILD_META = /<meta name="aip-html-build" content="([^"]*)"/
/** apps/web/src/boot/constants.ts 的 PRELOAD_RELOAD_STORAGE_KEY。 */
const RELOAD_BUDGET_KEY = 'aip.preload-reload-at'

export const staleEntryRelease: Scenario = {
  name: 'stale-entry-release',
  async run({ stack, newSession }) {
    const session = await newSession('staleentry')
    const probe = await openStalePage(stack, session.context)
    await eventually(
      'the workbench to open after one reload',
      async () =>
        probe.navigations() === 1 &&
        (await probe.page.getByRole('textbox', { name: '描述你的创意' }).count()) > 0 &&
        (await probe.page.getByText('页面暂时无法打开').count()) === 0 &&
        (await probe.page.locator('#boot[data-state="error"]').count()) === 0,
      { timeoutMs: 40_000 },
    ).catch((error) => probe.fail(error))
    assert.ok(probe.intercepted() > 0, 'the App chunk request was held across the release')
    // 稳定后不再刷新。
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    assert.equal(probe.navigations(), 1, 'exactly one reload')
  },
}

export const staleEntryBudgetSpent: Scenario = {
  name: 'stale-entry-budget-spent',
  async run({ stack, newSession }) {
    const session = await newSession('stalebudget')
    const build = await currentBuild(stack.origin, session.context)
    const probe = await openStalePage(stack, session.context, build)
    await eventually(
      'the load-failed card in place of the workbench',
      async () =>
        probe.intercepted() > 0 && (await probe.page.getByText('页面暂时无法打开').count()) > 0,
      { timeoutMs: 45_000 },
    ).catch((error) => probe.fail(error))
    // 额度用完：没有再自动刷新。
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    assert.equal(probe.navigations(), 0, 'no automatic reload once the budget is spent')
  },
}

async function currentBuild(origin: string, context: any): Promise<string> {
  const html = await (await context.request.get(`${origin}/image`)).text()
  const build = BUILD_META.exec(html)?.[1]
  assert.ok(build, 'the workbench HTML carries the build identity')
  return build
}

/**
 * 新开一个标签页加载旧 HTML；它第一次请求 App 分片时先发版、再答 404。
 * 传入 spentBuild 时先把该构建的自动刷新额度标为已用。
 */
async function openStalePage(
  stack: { origin: string; webRoot: string },
  context: any,
  spentBuild?: string,
) {
  const page: Page = await context.newPage()
  let navigations = 0
  let intercepted = 0
  let published = false
  page.on('request', (request: any) => {
    // 只数自动刷新发出的导航（带 __aip_reload），首次 goto 不算。
    if (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      request.url().includes('__aip_reload=')
    ) {
      navigations += 1
    }
  })
  if (spentBuild) {
    await page.addInitScript(
      ({ key, build }: { key: string; build: string }) => {
        try {
          sessionStorage.setItem(key, `${Date.now()}|${build}`)
        } catch {}
      },
      { key: RELOAD_BUDGET_KEY, build: spentBuild },
    )
  }
  await page.route(APP_CHUNK, (route: any) => {
    // 自动刷新之后加载的是新版本的分片，正常放行。
    if (navigations > 0) return route.continue()
    intercepted += 1
    if (!published) {
      published = true
      publishNewRelease(stack.webRoot)
    }
    // 发版后这些文件在服务器上已不存在。直接答 404，不走浏览器 HTTP 缓存里可能还留着的旧文件
    // （同一个上下文的其他页面加载过同名分片，immutable 缓存会让请求照样成功）。
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
  })
  await page.goto(`${stack.origin}/image`)
  return {
    page,
    navigations: () => navigations,
    intercepted: () => intercepted,
    async fail(error: unknown): Promise<never> {
      const text = await page
        .locator('body')
        .innerText()
        .catch(() => '')
      const dom = await page
        .evaluate(() => {
          const boot = document.getElementById('boot')
          const root = document.getElementById('root')
          return `boot=${boot?.dataset.state ?? 'gone'} rootChildren=${root?.childElementCount ?? -1}`
        })
        .catch(() => '')
      throw new Error(
        `${error}; ${navigations} reload(s), ${intercepted} App chunk request(s), page text: ${text.replace(/\s+/g, ' ').slice(0, 300)}; ${dom}`,
      )
    },
  }
}
