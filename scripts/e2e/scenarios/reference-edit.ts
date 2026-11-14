import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  eventually,
  generateButton,
  requestsFor,
  resultImages,
  type Scenario,
  typePrompt,
  uniquePrompt,
} from '../kit.ts'
import { solidPng } from '../png.ts'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/**
 * 上传参考图改图并出图：BFF 发给上游的是改图请求（multipart），里面带的正是本次上传的那张参考图
 * （PNG 不会被转码，逐字节一致；BFF 构造改图请求时直接取原始字节，见 upstream/openai.ts）。
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
    // 参考图进了输入框，并且前端的解码检查已经完成、判为可用：生成按钮可点，也没有错误提示。
    await page.getByRole('button', { name: /^参考素材（1）/ }).waitFor({
      state: 'visible',
      timeout: 15_000,
    })
    await eventually(
      'generate to be enabled',
      async () => !(await generateButton(page).isDisabled()),
    )
    assert.equal(await page.getByRole('alert').count(), 0, 'no reference error is shown')
    await generateButton(page).click()

    await resultImages(page).first().waitFor({ state: 'visible', timeout: 60_000 })

    const requests = requestsFor(mock, prompt)
    assert.equal(requests.length, 1, 'one upstream request')
    const [request] = requests
    assert.equal(request?.kind, 'edit', `expected an edit request, got ${request?.path}`)
    const files = request?.files ?? []
    assert.equal(files.length, 1, 'exactly the one reference image was sent')
    assert.match(files[0]?.type ?? '', /^image\/png$/)
    assert.equal(files[0]?.sha256, sha256(reference), 'the upstream got the uploaded reference')
    assert.equal(await resultImages(page).count(), 1)
  },
}
