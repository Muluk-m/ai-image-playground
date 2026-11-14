import assert from 'node:assert/strict'
import {
  eventually,
  generateButton,
  type Page,
  type Scenario,
  typePrompt,
  uniquePrompt,
} from '../kit.ts'

/**
 * 删除作品后刷新：被删的任务不再出现，没删的还在。
 * 对应 #1847 首批场景 4，逃逸台账 #1598（本机跑的平台任务只删了本机记录，刷新后平台那条又露出来）。
 */
export const deleteThenRefresh: Scenario = {
  name: 'delete-then-refresh',
  async run({ newSession }) {
    const { page } = await newSession('delete')
    const doomed = uniquePrompt('delete-me')
    const kept = uniquePrompt('keep-me')
    await generateOne(page, doomed)
    await generateOne(page, kept)

    const card = (prompt: string) =>
      page.locator('div.relative.rounded-xl').filter({ hasText: prompt }).first()

    const deleted = page.waitForResponse(
      (response: any) =>
        response.request().method() === 'DELETE' && /\/api\/generations\//.test(response.url()),
      { timeout: 30_000 },
    )
    const target = card(doomed)
    await target.hover()
    await target.getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('button', { name: '删除记录' }).click()
    await page.getByRole('button', { name: '确认删除' }).click()
    assert.ok((await deleted).ok(), 'the platform record was deleted')
    await eventually(
      'the deleted card to disappear',
      async () => (await card(doomed).count()) === 0,
    )

    // 刷新后平台列表照常拉回来：没删的那张在，删掉的那张不能回来。
    const listed = page.waitForResponse(
      (response: any) =>
        response.request().method() === 'GET' &&
        /\/api\/generations(\?|$)/.test(response.url()) &&
        response.ok(),
      { timeout: 30_000 },
    )
    await page.reload()
    await card(kept).waitFor({ state: 'visible', timeout: 30_000 })
    await listed
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    assert.equal(await card(doomed).count(), 0, 'the deleted task did not come back')
    assert.equal(await card(kept).count(), 1, 'the other task is still there')
  },
}

async function generateOne(page: Page, prompt: string) {
  await typePrompt(page, prompt)
  await generateButton(page).click()
  const card = page.locator('div.relative.rounded-xl').filter({ hasText: prompt }).first()
  await card.locator('img[data-image-id]').first().waitFor({ state: 'visible', timeout: 60_000 })
}
