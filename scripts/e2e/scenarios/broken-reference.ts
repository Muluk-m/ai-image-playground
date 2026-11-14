import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  eventually,
  generateButton,
  requestsFor,
  resultImages,
  type Scenario,
  type ScenarioContext,
  typePrompt,
  uniquePrompt,
} from '../kit.ts'
import { noisePng, solidPng } from '../png.ts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/**
 * 坏参考图被拦截且可重试：文件头是 PNG、正文是垃圾的图，浏览器解不出，前端在选图时就报错并禁用
 * 生成，上游一个请求都收不到；移除坏图、换一张好图后能正常出图，上游收到的正是那张好图。
 * 对应 #1847 首批场景 3（拦截发生在前端，见 apps/web/src/lib/unusableReferences.ts）。
 */
export const brokenReference: Scenario = {
  name: 'broken-reference',
  run: (ctx) =>
    blockedThenRetried(
      ctx,
      'broken',
      Buffer.concat([PNG_SIGNATURE, Buffer.from('this is not a real png body')]),
    ),
}

/**
 * 文件头完整、正文被截断的 PNG（#1870）：Chrome 能部分解码、onload 照样触发，只靠「浏览器解得出」会放行，
 * 一路发到上游才失败。要求与整张损坏的图一样：选图时拦下、上游零请求、换好图后可重试。
 */
export const truncatedReference: Scenario = {
  name: 'truncated-reference',
  run: (ctx) => {
    const whole = noisePng('truncated-reference', 320, 240)
    return blockedThenRetried(ctx, 'truncated', whole.subarray(0, Math.floor(whole.length * 0.6)))
  },
}

async function blockedThenRetried(
  { mock, newSession }: ScenarioContext,
  label: string,
  broken: Buffer,
) {
  const { page } = await newSession(label)
  const input = page.locator('input[type="file"][aria-label="添加图片"]')
  const prompt = uniquePrompt(label)
  const good = solidPng('good-reference', 320, 240)

  await typePrompt(page, prompt)
  await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: broken })

  // 可见的错误（屏幕阅读器播报的 alert，说明第几张、什么原因），并且生成被禁用。
  const alert = page.getByRole('alert').filter({ hasText: /第 1 张图片：/ })
  await alert.first().waitFor({ state: 'attached', timeout: 20_000 })
  assert.equal(await generateButton(page).isDisabled(), true, 'generate is blocked')
  // 生成被禁用，这时上游不可能有这个场景的请求。
  assert.equal(requestsFor(mock, prompt).length, 0, 'nothing reached the upstream')
  assert.equal(await resultImages(page).count(), 0)

  // 移除坏图，换一张好图重试。
  await page.getByRole('button', { name: '移除第 1 张图片' }).first().click()
  await alert.first().waitFor({ state: 'detached', timeout: 10_000 })
  await input.setInputFiles({ name: 'good.png', mimeType: 'image/png', buffer: good })
  await page.getByRole('button', { name: /^参考素材（1）/ }).waitFor({
    state: 'visible',
    timeout: 15_000,
  })
  // 好图的解码检查完成：生成可用，且没有错误提示。
  await eventually('generate to be enabled', async () => !(await generateButton(page).isDisabled()))
  assert.equal(await alert.count(), 0, 'the good image raises no error')
  await generateButton(page).click()

  await resultImages(page).first().waitFor({ state: 'visible', timeout: 60_000 })
  const requests = requestsFor(mock, prompt)
  assert.equal(requests.length, 1, 'only the retry reached the upstream')
  assert.equal(requests[0]?.kind, 'edit')
  const hashes = (requests[0]?.files ?? []).map((file) => file.sha256)
  assert.deepEqual(
    hashes,
    [sha256(good)],
    'the upstream got the replacement image, not the broken one',
  )
}
