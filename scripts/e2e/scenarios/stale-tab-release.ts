import assert from 'node:assert/strict'
import { eventually, publishNewRelease, type Scenario } from '../kit.ts'

/**
 * 发版后旧标签页：页面已打开，之后的发布删掉了它还没加载的分片。点进另一个页面时应该自动刷新一次，
 * 最终看到目标页面，而不是停在「页面暂时无法打开」，也不能循环刷新。
 * 对应 #1847 首批场景 6、#1846（逃逸台账第 8 项）。
 */
export const staleTabRelease: Scenario = {
  name: 'stale-tab-release',
  async run({ stack, newSession }) {
    const { page } = await newSession('stale')
    const explore = page.getByRole('button', { name: '探索', exact: true })
    await explore.first().waitFor({ state: 'visible', timeout: 30_000 })

    const renamed = publishNewRelease(stack.webRoot)
    assert.ok(renamed.length > 10, 'the release swapped the hashed assets')

    // 只数主文档的导航：自动刷新每发生一次就多一次。
    let navigations = 0
    page.on('request', (request: any) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations += 1
    })

    // 探索页的分片在这个旧标签页里还没加载过，它的地址已经 404。
    await explore.first().click()

    // 最终看到探索页，没有停在加载失败的卡片上。
    await eventually(
      'the explore page to open',
      async () => {
        const failure = await page.getByText('页面暂时无法打开').count()
        const heading = await page.getByRole('heading', { name: '探索', exact: true }).count()
        return failure === 0 && heading > 0
      },
      { timeoutMs: 45_000 },
    )
    assert.equal(navigations, 1, 'the stale tab reloaded exactly once')

    // 稳定后不会继续刷新。
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    assert.equal(navigations, 1, 'no further reloads')
    assert.equal(new URL(page.url()).searchParams.has('__aip_reload'), false)
  },
}
