import assert from 'node:assert/strict'
import { eventually, type Scenario } from '../kit.ts'

/**
 * 画布里的嵌套懒加载（CanvasMode 里的节点画布 NodeCanvas）分片下载失败：只自动刷新一次、最终打开画布，
 * 不停在失败卡片。对应 #1846 / #1872 的一致性修复：画布内三个嵌套 lazy 也走 lazyWithReload。
 *
 * 如实说明：这条场景在修复前也通过（启动守卫对 `Failed to fetch dynamically imported module` 本身会先刷新一次），
 * 它是回归保护，不能证明修复前有可见故障。NodeTextEditor / NodeImageEditor 要在画布里有文本 / 图片节点并进入
 * 编辑后才会加载，本栈没有对应夹具，由 chunkLoad 的单元测试覆盖 lazyWithReload 本身。
 */
const NODE_CANVAS_CHUNK = /\/assets\/NodeCanvas-[^/]+\.js(?:\?|$)/

export const canvasNestedChunk: Scenario = {
  name: 'canvas-nested-chunk',
  async run({ newSession }) {
    const { page } = await newSession('canvaschunk')
    let navigations = 0
    let blocking = false
    let aborted = 0
    page.on('request', (request: any) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        navigations += 1
        // 刷新后的新文档不再被打断。
        blocking = false
      }
    })
    await page.route('**/assets/*.js', (route: any) => {
      if (blocking && NODE_CANVAS_CHUNK.test(route.request().url())) {
        aborted += 1
        return route.abort('failed')
      }
      return route.continue()
    })

    const create = page.getByRole('button', { name: '新建画布', exact: true }).first()
    await create.waitFor({ state: 'visible', timeout: 30_000 })
    blocking = true
    await create.click()
    await eventually(
      'the node canvas to open after its chunk failed once',
      async () =>
        navigations === 1 &&
        aborted > 0 &&
        (await page.getByText('页面暂时无法打开').count()) === 0 &&
        (await page.locator('#boot[data-state="error"]').count()) === 0,
      { timeoutMs: 30_000 },
    ).catch(async (error) => {
      const text = await page
        .locator('body')
        .innerText()
        .catch(() => '')
      throw new Error(
        `${error}; ${navigations} navigation(s), ${aborted} chunk request(s) aborted, page text: ${text.replace(/\s+/g, ' ').slice(0, 300)}`,
      )
    })
    await page.locator('.react-flow').first().waitFor({ state: 'attached', timeout: 20_000 })
    assert.ok(aborted > 0, 'the NodeCanvas chunk request was actually intercepted')
    assert.equal(navigations, 1, 'exactly one reload')
  },
}
