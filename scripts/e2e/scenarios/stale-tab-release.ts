import assert from 'node:assert/strict'
import { eventually, type Page, publishNewRelease, type Scenario } from '../kit.ts'

/**
 * 发版后旧标签页：页面已打开，之后的发布删掉了它还没加载的分片。点进另一个页面时应该自动刷新一次，
 * 最终看到目标页面，而不是停在「页面暂时无法打开」，也不能循环刷新。
 * 对应 #1847 首批场景 6、#1846（逃逸台账第 8 项）。
 *
 * 每个标签页点一个入口，覆盖各个懒加载页面：分片带自己的 CSS 时，缺失会先以
 * `Unable to preload CSS` 报错，恢复走的是另一条路径。
 */
export const staleTabRelease: Scenario = {
  name: 'stale-tab-release',
  async run({ stack, newSession }) {
    // 注册接口有频率限制：同一个账号开多个标签页。
    const session = await newSession('stale')
    const entries = [
      { label: 'explore', entry: '探索' },
      { label: 'library', entry: '资产' },
      { label: 'tools', entry: '工具箱' },
      { label: 'pricing', path: '/pricing' },
      { label: 'changelog', path: '/changelog' },
      { label: 'connect', path: '/connect' },
    ]
    const tabs = []
    for (const [index, item] of entries.entries()) {
      const page = index === 0 ? session.page : await session.context.newPage()
      if (index > 0) await page.goto(`${stack.origin}/image`)
      tabs.push({ ...item, page })
    }
    const navigations = new Map<string, number>()
    for (const { label, entry, page } of tabs) {
      await ready(page, entry).waitFor({ state: 'visible', timeout: 30_000 })
      // 只数主文档的导航：自动刷新每发生一次就多一次。
      navigations.set(label, 0)
      page.on('request', (request: any) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          navigations.set(label, (navigations.get(label) ?? 0) + 1)
        }
      })
    }

    const renamed = publishNewRelease(stack.webRoot)
    assert.ok(renamed.length > 10, 'the release swapped the hashed assets')

    // 目标页的分片在旧标签页里还没加载过，它们的地址已经 404。
    for (const { label, entry, path, page } of tabs) {
      if (entry) await entryButton(page, entry).click()
      else await openPath(page, path)
      // 最终停在目标页，而不是加载失败的卡片。
      await eventually(
        `the ${label} page to open`,
        async () => {
          const failed =
            (await page.getByText('页面暂时无法打开').count()) +
            (await page.getByText('无法打开工作台').count())
          const bootError = await page.locator('#boot[data-state="error"]').count()
          const arrived = entry
            ? (await entryButton(page, entry).getAttribute('aria-pressed')) === 'true'
            : new URL(page.url()).pathname.replace(/\/$/, '') === path
          return failed === 0 && bootError === 0 && arrived && (navigations.get(label) ?? 0) >= 1
        },
        { timeoutMs: 30_000 },
      )
      assert.equal(navigations.get(label), 1, `the ${label} tab reloaded exactly once`)
    }

    // 稳定后不会继续刷新。
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    for (const { label, page } of tabs) {
      assert.equal(navigations.get(label), 1, `the ${label} tab did not reload again`)
      assert.equal(new URL(page.url()).searchParams.has('__aip_reload'), false)
    }
  },
}

function entryButton(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true }).first()
}

/** 旧标签页里的工作台已经起来了：侧栏入口可见。 */
function ready(page: Page, entry?: string) {
  return entryButton(page, entry ?? '探索')
}

/** 站内换页：和应用自己的 navigate 一样，改地址后通知 popstate 监听者。 */
async function openPath(page: Page, path: string | undefined) {
  await page.evaluate((target: string) => {
    window.history.pushState(null, '', target)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}
