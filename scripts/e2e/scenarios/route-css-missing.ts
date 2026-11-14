import assert from 'node:assert/strict'
import { eventually, type Scenario } from '../kit.ts'

/**
 * 路由分片本身下载成功，但它的样式表 404（发版删了旧 CSS、边缘缓存缺文件）：Vite 报
 * `Unable to preload CSS for ...`。页面已渲染后启动守卫把这类错误交给应用，应用必须走同一套
 * 有界恢复——只自动刷新一次、最终打开目标页，而不是停在手动「重新加载」卡片。
 * 对应 #1846 遗留：App.tsx 的路由懒加载曾用原生 React.lazy。
 */
export const routeCssMissing: Scenario = {
  name: 'route-css-missing',
  async run({ newSession }) {
    const { page } = await newSession('routecss')
    let navigations = 0
    let blocking = false
    let blockedCss = 0
    page.on('request', (request: any) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        navigations += 1
        // 刷新后的新文档不再被打断。
        blocking = false
      }
    })
    // 只有点击后才加载的路由样式表会命中；首屏已经装好的样式表不会再发请求。
    await page.route('**/assets/*.css', (route: any) => {
      if (!blocking) return route.continue()
      blockedCss += 1
      return route.fulfill({ status: 404, body: 'not found' })
    })

    // 画布路由的分片（CanvasMode）自带样式表：点「新建画布」才会去取它。
    const create = page.getByRole('button', { name: '新建画布', exact: true }).first()
    await create.waitFor({ state: 'visible', timeout: 30_000 })
    blocking = true
    await create.click()
    await eventually(
      'the canvas route to open after its stylesheet failed once',
      async () =>
        navigations === 1 &&
        blockedCss > 0 &&
        (await page.getByText('页面暂时无法打开').count()) === 0 &&
        (await page.locator('#boot[data-state="error"]').count()) === 0,
      { timeoutMs: 30_000 },
    ).catch(async (error) => {
      const text = await page
        .locator('body')
        .innerText()
        .catch(() => '')
      throw new Error(
        `${error}; ${navigations} navigation(s), ${blockedCss} stylesheet(s) blocked, page text: ${text.replace(/\s+/g, ' ').slice(0, 300)}`,
      )
    })
    // 恢复后画布真的打开了（不是回到空白或失败卡片）。
    await page.locator('.react-flow').first().waitFor({ state: 'attached', timeout: 20_000 })
    assert.ok(blockedCss > 0, 'the route stylesheet request was actually intercepted')
    assert.equal(navigations, 1, 'exactly one reload')
  },
}
