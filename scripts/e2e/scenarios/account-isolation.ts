import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { generateButton, type Page, type Scenario, typePrompt, uniquePrompt } from '../kit.ts'

/**
 * 同一个浏览器切换账号：B 看不到 A 的作品，A 切回来作品还在。本地缓存按账号隔离。
 * 对应 #1847 首批场景 8。
 */
export const accountIsolation: Scenario = {
  name: 'account-isolation',
  async run({ newSession }) {
    const a = await newSession('iso-a')
    const { page } = a
    const promptA = uniquePrompt('iso-a')
    const promptB = uniquePrompt('iso-b')
    const card = (prompt: string) =>
      page.locator('div.relative.rounded-xl').filter({ hasText: prompt })

    await generate(page, promptA)

    // 同一浏览器里退出 A、注册并登录 B（cookie 由浏览器保管，和真实切换一致）。
    const passwordB = randomBytes(24).toString('base64url')
    const usernameB = `e2e-iso-b-${randomBytes(4).toString('hex')}@example.com`
    assert.equal(await post(page, '/api/auth/logout', {}), 200)
    assert.equal(
      await post(page, '/api/auth/register', { username: usernameB, password: passwordB }),
      201,
    )
    await page.reload()
    await page
      .getByRole('textbox', { name: '描述你的创意' })
      .waitFor({ state: 'visible', timeout: 30_000 })
    // 给本地与云端历史留足时间出现；A 的作品都不该在。
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    assert.equal(await card(promptA).count(), 0, "B does not see A's work")

    await generate(page, promptB)
    assert.equal(await card(promptA).count(), 0, "B still does not see A's work")

    // 切回 A：A 的作品在，B 的不在。
    assert.equal(await post(page, '/api/auth/logout', {}), 200)
    assert.equal(
      await post(page, '/api/auth/login', { username: a.username, password: a.password }),
      200,
    )
    await page.reload()
    await card(promptA).first().waitFor({ state: 'visible', timeout: 30_000 })
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    assert.equal(await card(promptB).count(), 0, "A does not see B's work")
  },
}

async function generate(page: Page, prompt: string) {
  await typePrompt(page, prompt)
  await generateButton(page).click()
  await page
    .locator('div.relative.rounded-xl')
    .filter({ hasText: prompt })
    .locator('img[data-image-id]')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 })
}

function post(page: Page, path: string, body: object): Promise<number> {
  return page.evaluate(
    async ({ path, body }: { path: string; body: object }) =>
      (
        await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'include',
        })
      ).status,
    { path, body },
  )
}
