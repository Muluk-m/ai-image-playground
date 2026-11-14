import assert from 'node:assert/strict'
import {
  generateButton,
  requestsFor,
  resultImages,
  type Scenario,
  typePrompt,
  uniquePrompt,
} from '../kit.ts'

/**
 * 页面读写 document.cookie 被浏览器策略拦截（沙箱 iframe、隐私设置）：刷新后工作台照常打开，
 * 仍是登录态，能提交并出图。会话本身走 HttpOnly cookie，不受影响。
 * 对应 #1847 首批场景 5，逃逸台账 #1414。
 */
export const cookieBlockedSession: Scenario = {
  name: 'cookie-blocked-session',
  async run({ mock, newSession }) {
    const { context, page } = await newSession('blocked')
    // 工作台启动完成后才会记住登录用户；没等它就刷新，记不住也是白搭。
    await page
      .getByRole('textbox', { name: '描述你的创意' })
      .waitFor({ state: 'visible', timeout: 30_000 })
    await context.addInitScript(() => {
      const blocked = () => {
        throw new DOMException('cookie access is blocked', 'SecurityError')
      }
      Object.defineProperty(Document.prototype, 'cookie', {
        configurable: true,
        get: blocked,
        set: blocked,
      })
    })
    await page.reload()

    // 刷新前登录过（localStorage 里记着用户）：拦截 cookie 不该让工作台打不开或掉回访客。
    const prompt = uniquePrompt('blocked')
    await typePrompt(page, prompt)
    await generateButton(page).click()
    await resultImages(page).first().waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(requestsFor(mock, prompt).length, 1)
    assert.equal(await page.getByRole('dialog').count(), 0, 'no login dialog')
  },
}
