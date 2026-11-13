import assert from 'node:assert/strict'
import {
  generateButton,
  pause,
  requestsFor,
  resultImages,
  type Scenario,
  typePrompt,
  uniquePrompt,
} from '../kit.ts'
import { solidPng } from '../png.ts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 坏参考图被拦截且可重试：文件头是 PNG、正文是垃圾的图，浏览器解不出，前端在选图时就报错并禁用
 * 生成，上游一个请求都收不到；移除坏图、换一张好图后能正常出图。
 * 对应 #1847 首批场景 3（拦截发生在前端，见 apps/web/src/lib/unusableReferences.ts）。
 */
export const brokenReference: Scenario = {
  name: 'broken-reference',
  async run({ mock, newSession }) {
    const { page } = await newSession('broken')
    const input = page.locator('input[type="file"][aria-label="添加图片"]')

    const prompt = uniquePrompt('broken')
    await typePrompt(page, prompt)
    await input.setInputFiles({
      name: 'broken.png',
      mimeType: 'image/png',
      buffer: Buffer.concat([PNG_SIGNATURE, Buffer.from('this is not a real png body')]),
    })

    // 可见的错误（屏幕阅读器播报的 alert，说明第几张、什么原因），并且生成被禁用。
    const alert = page.getByRole('alert').filter({ hasText: /第 1 张图片：/ })
    await alert.first().waitFor({ state: 'attached', timeout: 20_000 })
    assert.equal(await generateButton(page).isDisabled(), true, 'generate is blocked')

    // 等一会儿，确认没有任何东西发到上游，也没有产出任务卡片。
    await pause(2_000)
    assert.equal(requestsFor(mock, prompt).length, 0, 'nothing reached the upstream')
    assert.equal(await resultImages(page).count(), 0)

    // 移除坏图，换一张好图重试。
    await page.getByRole('button', { name: '移除第 1 张图片' }).first().click()
    await alert.first().waitFor({ state: 'detached', timeout: 10_000 })
    const good = solidPng('good-reference', 320, 240)
    await input.setInputFiles({ name: 'good.png', mimeType: 'image/png', buffer: good })
    await page.getByRole('button', { name: /^参考素材（1）/ }).waitFor({
      state: 'visible',
      timeout: 15_000,
    })
    await pause(1_500)
    assert.equal(await alert.count(), 0, 'the good image raises no error')
    assert.equal(await generateButton(page).isDisabled(), false, 'generate is available again')
    await generateButton(page).click()

    await resultImages(page).first().waitFor({ state: 'visible', timeout: 60_000 })
    const requests = requestsFor(mock, prompt)
    assert.equal(requests.length, 1, 'only the retry reached the upstream')
    assert.equal(requests[0]?.kind, 'edit')
    assert.ok((requests[0]?.files.length ?? 0) >= 1, 'the good reference was sent')
  },
}
