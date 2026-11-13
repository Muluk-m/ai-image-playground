import assert from 'node:assert/strict'
import {
  eventually,
  generateButton,
  pause,
  requestsFor,
  resultImages,
  type Scenario,
  typePrompt,
  uniquePrompt,
} from '../kit.ts'

/**
 * 生成中刷新页面：任务还在、结果最终出现，而且不会因为恢复而再向上游提交一次（也就不会重复扣费）。
 * 对应 #1847 首批场景 1，逃逸台账里「刷新恢复」一类。
 */
export const refreshWhileGenerating: Scenario = {
  name: 'refresh-while-generating',
  async run({ mock, newSession }) {
    // 上游慢一点，留出足够的时间在「生成中」刷新。
    mock.configure({ delayMs: 8_000 })
    const { page } = await newSession('refresh')

    const prompt = uniquePrompt('refresh')
    await typePrompt(page, prompt)
    await generateButton(page).click()

    // 任务已交给上游，但上游还没回。
    await eventually(
      'the upstream to receive the request',
      () => requestsFor(mock, prompt).length >= 1,
    )
    assert.equal(requestsFor(mock, prompt).length, 1)
    assert.equal(await resultImages(page).count(), 0, 'no result before the upstream answers')

    await page.reload()

    // 刷新后任务卡片还在，并且还在进行中。
    const inProgress = page.getByText(/生成中|排队中|恢复连接中|结果确认中/).first()
    await inProgress.waitFor({ state: 'visible', timeout: 30_000 })

    // 结果最终出现。
    await resultImages(page).first().waitFor({ state: 'visible', timeout: 60_000 })

    // 恢复不重复提交：等一小会儿，让任何多余的提交有机会发生。
    await pause(3_000)
    assert.equal(requestsFor(mock, prompt).length, 1, 'the upstream was asked exactly once')
    assert.equal(await resultImages(page).count(), 1, 'exactly one result on the page')
  },
}
