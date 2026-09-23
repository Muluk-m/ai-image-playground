// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

const GREEN = 'data:image/png;base64,GREEN-BACKDROP'
const KEYED = 'data:image/png;base64,KEYED-ALPHA'
const SOURCE = 'data:image/png;base64,SOURCE'

interface ApiCall {
  prompt: string
  params: { n: number; output_format: string; output_compression: number | null }
  inputImageDataUrls: string[]
  maskDataUrl?: string
}

const mocks = vi.hoisted(() => ({
  callImageApi: vi.fn(async (_options: ApiCall) => ({ images: [GREEN] })),
  keyOut: vi.fn(async () => KEYED),
  showToast: vi.fn(),
  params: {
    n: 4,
    output_format: 'webp' as string,
    output_compression: 80 as number | null,
    quality: 'high',
  },
}))

vi.mock('../../../../lib/api', () => ({ callImageApi: mocks.callImageApi }))
vi.mock('../../../../lib/transparentImage', () => ({
  removeKeyedBackgroundFromDataUrl: mocks.keyOut,
}))
vi.mock('../../../../lib/cloudMedia', () => ({ resolveMediaSource: async () => SOURCE }))
vi.mock('../../../../lib/canvasImage', () => ({
  getImageDimensions: async () => ({ width: 1024, height: 768 }),
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
const { submitCanvasCutout } = await import('../../../../features/canvas/lib/canvasImageEdits')

function canvasWithImage() {
  const doc = new CanvasDoc()
  const editor = new CanvasEditor(doc)
  const [imageId] = editor.placeImages([{ dataUrl: SOURCE, x: 40, y: 60, width: 400, height: 300 }])
  const image = doc.getElement(imageId!)
  if (image?.type !== 'image') throw new Error('unreachable')
  return { doc, editor, image }
}

/** 占位框是异步落图的，`submitCanvasCutout` 只等到发起。 */
async function settled() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

afterEach(() => {
  mocks.callImageApi.mockClear()
  mocks.keyOut.mockClear()
  mocks.showToast.mockClear()
  mocks.keyOut.mockImplementation(async () => KEYED)
})

/**
 * 抠图在 gpt-image 上是两段：模型只把背景换成纯色，透明是本地键出来的。
 * 少了后半段，用户拿到的就是一张绿底图——那不是抠图。
 */
describe('submitCanvasCutout', () => {
  it('asks for a flat key color and forces a lossless PNG round trip', async () => {
    const { editor, image } = canvasWithImage()

    expect(await submitCanvasCutout(editor, image)).toBe(true)
    await settled()

    const call = mocks.callImageApi.mock.calls[0]![0]
    expect(call.inputImageDataUrls).toEqual([SOURCE])
    // 整图重画，没有遮罩：gpt-image 的遮罩只管「改框里」，抠图要的是换框外。
    expect(call.maskDataUrl).toBeUndefined()
    expect(call.prompt).toContain('#00FF00')
    expect(call.prompt).toContain('逐像素不变')
    // 有损格式会把键出来的边缘糊成半透明脏边，数量多出来的那几张也没人要。
    expect(call.params.output_format).toBe('png')
    expect(call.params.output_compression).toBeNull()
    expect(call.params.n).toBe(1)
  })

  it('puts the keyed image on the canvas, in place of the source', async () => {
    const { doc, editor, image } = canvasWithImage()

    await submitCanvasCutout(editor, image)
    await settled()

    expect(mocks.keyOut).toHaveBeenCalledWith(GREEN)
    const images = doc.elements.filter((el) => el.type === 'image')
    expect(images).toHaveLength(1)
    const after = images[0]
    // 落在画布上的必须是键过的那张；漏掉这一步用户拿到的是绿底图。
    expect(after?.type === 'image' && doc.files[after.fileId]).toBe(KEYED)
    expect(after?.id).toBe(image.id)
  })

  it('keeps the raw image and says so when the key fails', async () => {
    mocks.keyOut.mockImplementation(async () => {
      throw new Error('no 2d context')
    })
    const { doc, editor, image } = canvasWithImage()

    await submitCanvasCutout(editor, image)
    await settled()

    // 这一次已经花掉了积分：扔掉比给一张还带背景的图更坏，但得说清楚。
    const after = doc.elements.filter((el) => el.type === 'image')[0]
    expect(after?.type === 'image' && doc.files[after.fileId]).toBe(GREEN)
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining('背景'), 'error')
  })
})
