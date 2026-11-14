import assert from 'node:assert/strict'
import {
  dropCookie,
  eventually,
  fetchStatus,
  type Page,
  SESSION_COOKIE,
  type Scenario,
} from '../kit.ts'

/**
 * 两个标签页同时刷新：登录态不丢，而且访问凭据有效时启动不轮换 refresh（每次打开都轮换，
 * 一次响应没落地就会被服务端当成复用）。访问凭据过期时两个标签页同时恢复，最终都是登录态。
 * 对应 #1847 首批场景 5，逃逸台账 #1716。
 */
export const concurrentTabRefresh: Scenario = {
  name: 'concurrent-tab-refresh',
  async run({ stack, newSession }) {
    const { context, page: first } = await newSession('tabs')
    const second = await context.newPage()
    await second.goto(`${stack.origin}/image`)
    const pages = [first, second]
    await Promise.all(pages.map(ready))

    let refreshes = 0
    context.on('request', (request: any) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/auth/refresh')) {
        refreshes += 1
      }
    })

    // 访问凭据有效：反复同时刷新，不该有任何续期请求，也不丢登录。
    for (let round = 0; round < 3; round += 1) {
      await Promise.all(pages.map((page) => page.reload()))
      await Promise.all(pages.map(ready))
    }
    assert.equal(refreshes, 0, 'booting with a valid session does not rotate the refresh token')
    for (const page of pages) assert.equal(await fetchStatus(page, '/api/auth/me'), 200)

    // 访问凭据过期：两个标签页同时启动，各自发现 401，经跨标签页的锁一起恢复。
    await dropCookie(context, SESSION_COOKIE)
    await Promise.all(pages.map((page) => page.reload()))
    await Promise.all(pages.map(ready))
    await eventually(
      'both tabs to be signed in',
      async () => (await fetchStatus(first, '/api/auth/me')) === 200,
    )
    for (const page of pages) {
      assert.equal(await page.getByText('登录状态已失效').count(), 0, 'no session-expired card')
    }
    assert.ok(refreshes >= 1, 'the expired session was renewed')
    // 恢复之后再同时刷新一次，仍是登录态。
    await Promise.all(pages.map((page) => page.reload()))
    await Promise.all(pages.map(ready))
    for (const page of pages) assert.equal(await fetchStatus(page, '/api/auth/me'), 200)
  },
}

function ready(page: Page) {
  return page
    .getByRole('textbox', { name: '描述你的创意' })
    .waitFor({ state: 'visible', timeout: 30_000 })
}
