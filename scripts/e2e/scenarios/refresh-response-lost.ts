import assert from 'node:assert/strict'
import {
  dropCookie,
  eventually,
  fetchStatus,
  generateButton,
  requestsFor,
  resultImages,
  type Scenario,
  SESSION_COOKIE,
  typePrompt,
  uniquePrompt,
} from '../kit.ts'

/**
 * 续期响应丢失：服务端已经提交了这次 refresh 轮换，浏览器没收到响应（断网、页面被关）。
 * 超过 30 秒宽限后回来，同一个请求标识必须还能拿回结果，登录态不丢；
 * 旧实现把「过了宽限再出示旧 refresh」一律当盗用，作废整条会话。
 * 对应 #1847 首批场景 5，逃逸台账 #1719（#1716 是它的前一道降频补丁）。
 */
const GRACE_MS = 30_000

export const refreshResponseLost: Scenario = {
  name: 'refresh-response-lost',
  async run({ mock, newSession }) {
    const { context, page } = await newSession('lost')
    let lose = true
    let lost = 0
    await context.route('**/api/auth/refresh', async (route: any) => {
      if (!lose) return route.continue()
      // 请求照常到服务端并提交轮换，响应在回到浏览器之前被丢弃。
      await route.fetch()
      await route.abort('failed')
      lost += 1
    })

    // 访问凭据过期（refresh 还在）。页面还开着，下一次需要账号的请求会触发静默续期。
    await dropCookie(context, SESSION_COOKIE)
    // route.fetch 与浏览器共用 cookie 存储，Set-Cookie 可能被它悄悄存下；丢响应后按这份快照还原。
    const before = await context.cookies()
    const prompt = uniquePrompt('lost')
    await typePrompt(page, prompt)
    await generateButton(page).click()
    await eventually('a refresh whose response was lost', () => lost >= 1)
    assert.equal(requestsFor(mock, prompt).length, 0, 'nothing reached the upstream')

    // 超过服务端宽限再回来。
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 2_000))
    // 失败处理里的重试此时都已结束；route.fetch 可能存下了 Set-Cookie，按快照还原再恢复网络。
    await context.clearCookies()
    await context.addCookies(before)
    lose = false
    await page.reload()

    const ready = page.getByRole('textbox', { name: '描述你的创意' })
    await ready.waitFor({ state: 'visible', timeout: 30_000 })
    await eventually(
      'the session to be restored',
      async () => (await fetchStatus(page, '/api/auth/me')) === 200,
    )
    assert.equal(await page.getByText('登录状态已失效').count(), 0, 'no session-expired card')

    // 真的还是登录的：能提交并出图。
    const next = uniquePrompt('lost-after')
    await typePrompt(page, next)
    await generateButton(page).click()
    await resultImages(page).first().waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(requestsFor(mock, next).length, 1)
  },
}
