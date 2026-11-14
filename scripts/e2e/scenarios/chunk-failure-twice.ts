import assert from 'node:assert/strict'
import { eventually, type Page, type Scenario } from '../kit.ts'

/**
 * 同一个构建里，分片两次偶发下载失败（网络抖动，与发版无关）：每次都应自动刷新一次并恢复，
 * 而不是第二次起停在失败画面。两次之间页面已经稳定运行了一段时间。
 * 对应 #1846：自动刷新的额度按构建只给一次，刷新成功后也不归还。
 */
export const chunkFailureTwice: Scenario = {
  name: 'chunk-failure-twice',
  async run({ newSession }) {
    const { page } = await newSession('twice')
    let navigations = 0
    let blocked: RegExp | null = null
    page.on('request', (request: any) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        navigations += 1
        // 刷新发出后，新文档的分片请求不再被打断。
        blocked = null
      }
    })
    await page.route('**/assets/*.js', (route: any) => {
      if (blocked?.test(route.request().url())) return route.abort('failed')
      return route.continue()
    })

    const open = async (label: string, chunk: RegExp, expectedNavigations: number) => {
      await entry(page, label).waitFor({ state: 'visible', timeout: 30_000 })
      blocked = chunk
      await entry(page, label).click()
      await eventually(
        `the ${label} page to open after a failed chunk`,
        async () =>
          navigations === expectedNavigations &&
          (await entry(page, label).getAttribute('aria-pressed')) === 'true' &&
          (await page.getByText('页面暂时无法打开').count()) === 0 &&
          (await page.locator('#boot[data-state="error"]').count()) === 0,
        { timeoutMs: 30_000 },
      ).catch(async (error) => {
        const text = await page.locator('body').innerText().catch(() => '')
        throw new Error(
          `${error}; ${navigations} navigation(s), page text: ${text.replace(/\s+/g, ' ').slice(0, 300)}`,
        )
      })
    }

    await open('探索', /ExplorePage-/, 1)
    // 页面稳定运行一阵之后，再来一次偶发失败。
    await new Promise((resolve) => setTimeout(resolve, 35_000))
    await open('资产', /LibraryPage-/, 2)
    assert.equal(navigations, 2, 'exactly one reload per failure')
  },
}

function entry(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true }).first()
}
