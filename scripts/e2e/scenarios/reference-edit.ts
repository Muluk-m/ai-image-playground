import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
import { solidPng } from '../png.ts'

/**
 * 上传参考图改图并出图：BFF 发给上游的是改图请求（multipart），参考图确实在里面。
 * 对应 #1847 首批场景 2。
 */
export const referenceEdit: Scenario = {
  name: 'reference-edit',
  async run({ mock, newSession }) {
    const { page } = await newSession('edit')
    const reference = solidPng('reference-edit-input', 320, 240)

    const prompt = uniquePrompt('edit')
    await typePrompt(page, prompt)
    await page.locator('input[type="file"][aria-label="添加图片"]').setInputFiles({
      name: 'reference.png',
      mimeType: 'image/png',
      buffer: reference,
    })
    // 参考图进了输入框，没有被判为不可用（不可用时折叠的参考区会带上错误原因，并出现提示）。
    await page.getByRole('button', { name: /^参考素材（1）/ }).waitFor({
      state: 'visible',
      timeout: 15_000,
    })
    await pause(1_500)
    assert.equal(await page.getByRole('alert').count(), 0, 'no reference error is shown')
    assert.equal(await generateButton(page).isDisabled(), false, 'generate stays enabled')
    await generateButton(page).click()

    await resultImages(page).first().waitFor({ state: 'visible', timeout: 60_000 })

    const requests = requestsFor(mock, prompt)
    assert.equal(requests.length, 1, 'one upstream request')
    const [request] = requests
    assert.equal(request?.kind, 'edit', `expected an edit request, got ${request?.path}`)
    const files = request?.files ?? []
    assert.ok(files.length >= 1, 'the reference image reached the upstream')
    for (const file of files) {
      assert.match(file.type, /^image\//)
      assert.ok(file.bytes > 0)
    }
    // 参考图是否原样送达只做提示：浏览器侧可能转码，不当作失败。
    const sent = files.map((file) => file.sha256)
    const original = createHash('sha256').update(reference).digest('hex')
    console.log(`  reference byte-identical upstream: ${sent.includes(original)}`)
    await eventually(
      'the result to stay on the page',
      async () => (await resultImages(page).count()) === 1,
    )
  },
}
