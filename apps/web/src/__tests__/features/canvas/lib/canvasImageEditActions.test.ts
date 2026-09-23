// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

const RESULT = 'data:image/png;base64,RESULT'
const SOURCE = 'data:image/png;base64,SOURCE'

interface ApiCall {
  prompt: string
  params: { n: number; size: string; gemini_aspect_ratio?: string }
  inputImageDataUrls: string[]
  maskDataUrl?: string
}

const mocks = vi.hoisted(() => ({
  callImageApi: vi.fn(async (_options: ApiCall) => ({ images: [RESULT] })),
  showToast: vi.fn(),
  params: { n: 3, size: 'auto', output_format: 'png' as string, output_compression: null },
}))

vi.mock('../../../../lib/api', () => ({ callImageApi: mocks.callImageApi }))
vi.mock('../../../../lib/cloudMedia', () => ({ resolveMediaSource: async () => SOURCE }))
vi.mock('../../../../lib/canvasImage', () => ({
  getImageDimensions: async () => ({ width: 720, height: 1280 }),
}))
vi.mock('../../../../lib/apiProfiles', () => ({
  getActiveApiProfile: () => ({ id: 'p', name: 'Mock', source: 'user-byok' }),
  clientProfileToApiProfile: () => ({
    id: 'p',
    name: 'Mock',
    provider: 'openai-compat',
    model: 'gpt-image-2.5-flare',
  }),
}))
vi.mock('../../../../lib/channels/profileSelectors', () => ({
  getModelCapabilities: () => null,
  modelSupportsEdit: () => true,
  modelSupportsNativeMask: () => true,
  NO_EDIT_SUPPORT_MESSAGE: '当前模型不支持参考图',
}))
vi.mock('../../../../lib/channels/publicChannels', () => ({ getPublicChannels: () => [] }))
vi.mock('../../../../lib/privateOverlay', () => ({
  getPrivateSubmissionGuard: () => ({ blocked: false }),
  notifyPrivateSubmissionAccepted: vi.fn(),
  notifyPrivateSubmissionError: vi.fn(),
  notifyPrivateSubmissionSettled: vi.fn(),
}))
vi.mock('../../../../lib/clientCapabilities', () => ({ isClientCapabilityEnabled: () => false }))
vi.mock('../../../../store', () => ({
  useStore: {
    getState: () => ({ showToast: mocks.showToast, settings: {}, params: mocks.params }),
  },
  addCompletedCanvasTask: vi.fn(),
}))

// 动态 import：被测模块在顶层就读这些依赖，静态 import 会抢在 vi.mock 注册之前求值。
const { submitCanvasImageEdit, submitCanvasResize } = await import(
  '../../../../features/canvas/lib/canvasImageEdits'
)

function canvasWithImage() {
  const doc = new CanvasDoc()
  const editor = new CanvasEditor(doc)
  const [imageId] = editor.placeImages([{ dataUrl: SOURCE, x: 40, y: 60, width: 400, height: 300 }])
  const image = doc.getElement(imageId!)
  if (image?.type !== 'image') throw new Error('unreachable')
  return { doc, editor, image }
}

async function settled() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

afterEach(() => {
  mocks.callImageApi.mockClear()
  mocks.showToast.mockClear()
})

describe('submitCanvasImageEdit', () => {
  it('sends the whole image with no mask and replaces it in place', async () => {
    const { doc, editor, image } = canvasWithImage()

    expect(await submitCanvasImageEdit(editor, image, '  把背景换成浅木色  ')).toBe(true)
    await settled()

    const call = mocks.callImageApi.mock.calls[0]![0]
    expect(call.inputImageDataUrls).toEqual([SOURCE])
    // 整图编辑没有涂抹区域；带上遮罩就变成局部重绘了。
    expect(call.maskDataUrl).toBeUndefined()
    expect(call.prompt).toBe('把背景换成浅木色')
    expect(call.params.n).toBe(1)
    const images = doc.elements.filter((el) => el.type === 'image')
    expect(images).toHaveLength(1)
    const after = images[0]
    expect(after?.id).toBe(image.id)
    expect(after?.type === 'image' && doc.files[after.fileId]).toBe(RESULT)
  })

  it('refuses an empty instruction instead of sending a blank edit', async () => {
    const { editor, image } = canvasWithImage()

    expect(await submitCanvasImageEdit(editor, image, '   ')).toBe(false)
    await settled()

    expect(mocks.callImageApi).not.toHaveBeenCalled()
  })
})

describe('submitCanvasResize', () => {
  it('asks for the picked ratio on both protocols and keeps the original', async () => {
    const { doc, editor, image } = canvasWithImage()

    expect(await submitCanvasResize(editor, image, '9:16')).toBe(true)
    await settled()

    const call = mocks.callImageApi.mock.calls[0]![0]
    expect(call.prompt).toContain('9:16')
    // OpenAI 认 size 字符串，Gemini 认比例本身：少给一个就有一条路按原比例出图。
    expect(call.params.size).toBe('720x1280')
    expect(call.params.gemini_aspect_ratio).toBe('9:16')
    // 换画幅是另一版素材，落在旁边：就地替换会把原图吃掉。
    const images = doc.elements.filter((el) => el.type === 'image')
    expect(images).toHaveLength(2)
    expect(images.some((el) => el.id === image.id)).toBe(true)
  })
})
