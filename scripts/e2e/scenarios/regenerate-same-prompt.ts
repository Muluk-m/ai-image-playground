import assert from 'node:assert/strict'
import {
  eventually,
  generateButton,
  requestsFor,
  resultImages,
  type Scenario,
  typePrompt,
  uniquePrompt,
} from '../kit.ts'

/**
 * 同一提示词连续生成两次：各自提交、各自出图，不会被当成同一次请求合并，刷新后两张都在。
 * 对应 #1847 首批场景 3。
 */
export const regenerateSamePrompt: Scenario = {
  name: 'regenerate-same-prompt',
  async run({ mock, newSession }) {
    const { page } = await newSession('again')
    const prompt = uniquePrompt('again')
    // 每张卡一张结果图；卡片容器有嵌套，按图计数最直接。
    const results = () => resultImages(page)

    for (const round of [1, 2]) {
      await typePrompt(page, prompt)
      await generateButton(page).click()
      await eventually(
        `result ${round}`,
        async () => (await results().count()) >= round,
        { timeoutMs: 60_000 },
      )
    }
    assert.equal(requestsFor(mock, prompt).length, 2, 'each click reached the upstream')
    assert.equal(await results().count(), 2, 'two results on the page')

    await page.reload()
    await eventually(
      'both results after a reload',
      async () => (await results().count()) >= 2,
      { timeoutMs: 30_000 },
    )
    assert.equal(await results().count(), 2, 'still two results after a reload')
    assert.equal(requestsFor(mock, prompt).length, 2, 'a reload does not resubmit')
  },
}
