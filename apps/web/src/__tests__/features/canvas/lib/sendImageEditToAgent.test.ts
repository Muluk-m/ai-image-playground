// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const agent = vi.hoisted(() => ({
  send: vi.fn(async (_text: string, _references: unknown, accepted?: () => void) => {
    accepted?.()
    return undefined
  }),
  setOpen: vi.fn(),
  setTab: vi.fn(),
  historyLoading: false,
  historyFailed: false,
}))
const capability = vi.hoisted(() => ({ maskSupported: true }))
const media = vi.hoisted(() => ({
  load: vi.fn(async () => ({ naturalWidth: 1024, naturalHeight: 1024 })),
  resolve: vi.fn(async () => 'data:image/png;base64,ORIGINAL'),
  prepare: vi.fn(async () => ({
    dataUrl: 'data:image/png;base64,WORKING',
    width: 1024,
    height: 1024,
  })),
  mask: vi.fn(async () => 'data:image/png;base64,MASK'),
  fit: vi.fn((width: number, height: number) => ({ width, height })),
  crop: vi.fn(async () => 'data:image/png;base64,CROPPED'),
  outpaint: vi.fn(async () => ({
    source: 'data:image/png;base64,EXPANDED',
    mask: 'data:image/png;base64,OUTPAINT_MASK',
    width: 1536,
    height: 1536,
  })),
  rectSize: vi.fn(() => ({ width: 1536, height: 1536 })),
}))

vi.mock('../../../../features/agent/panelLayout', () => ({ agentPanelPresent: () => true }))
vi.mock('../../../../lib/channels/profileSelectors', () => ({
  modelSupportsNativeMask: () => capability.maskSupported,
}))
vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: { getState: () => agent },
}))
vi.mock('../../../../lib/cloudMedia', () => ({ resolveMediaSource: media.resolve }))
vi.mock('../../../../lib/canvasImage', () => ({ loadImage: media.load }))
vi.mock('../../../../lib/maskPreprocess', () => ({
  prepareMaskTargetDataUrl: media.prepare,
  calculateMaskWorkingSize: media.fit,
}))
vi.mock('../../../../features/canvas/lib/inpaintMask', () => ({ exportMaskDataUrl: media.mask }))
vi.mock('../../../../features/canvas/lib/imageRectEdit', () => ({
  cropBitmap: media.crop,
  buildOutpaintInputs: media.outpaint,
  rectPixelSize: media.rectSize,
}))

import { CanvasDoc, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { sendImageEditToAgent } from '../../../../features/canvas/lib/sendImageEditToAgent'

const image: ImageEl = {
  id: 'image-1',
  type: 'image',
  fileId: 'file-1',
  x: 0,
  y: 0,
  width: 512,
  height: 512,
  rotation: 0,
}

function editor() {
  const doc = new CanvasDoc()
  doc.addElements([image], { files: { 'file-1': 'aip-media:source' } })
  return new CanvasEditor(doc)
}

beforeEach(() => {
  vi.clearAllMocks()
  agent.historyLoading = false
  agent.historyFailed = false
  capability.maskSupported = true
  media.prepare.mockResolvedValue({
    dataUrl: 'data:image/png;base64,WORKING',
    width: 1024,
    height: 1024,
  })
})

describe('画布单图快捷编辑经 Agent 对话发送', () => {
  it('整图要求带原图进入图片 Agent，并打开对话', async () => {
    const sent = await sendImageEditToAgent(editor(), image, '请裁切 [image 1]')
    expect(sent).toBe(true)
    expect(agent.setOpen).toHaveBeenCalledWith(true)
    expect(agent.setTab).toHaveBeenCalledWith('chat')
    expect(agent.send).toHaveBeenCalledWith(
      '请裁切 [image 1]',
      [{ imageId: 'image-1', dataUrl: 'aip-media:source' }],
      expect.any(Function),
      'image',
      undefined,
      undefined,
      expect.any(String),
    )
  })

  it('区域编辑把与工作图同尺寸的遮罩作为第一张引用交给 Agent', async () => {
    const strokes = [{ tool: 'brush' as const, points: [{ x: 10, y: 10 }], width: 8 }]
    const sent = await sendImageEditToAgent(editor(), image, '请修改 [image 1] 的选区', {
      strokes,
      referenceDataUrl: 'data:image/png;base64,REFERENCE',
    })
    expect(sent).toBe(true)
    expect(media.mask).toHaveBeenCalledWith(image, { width: 1024, height: 1024 }, strokes)
    expect(agent.send).toHaveBeenCalledWith(
      '请修改 [image 1] 的选区',
      [
        {
          imageId: 'image-1',
          dataUrl: 'data:image/png;base64,WORKING',
          maskDataUrl: 'data:image/png;base64,MASK',
        },
        { imageId: expect.any(String), dataUrl: 'data:image/png;base64,REFERENCE' },
      ],
      expect.any(Function),
      'image',
      undefined,
      undefined,
      expect.any(String),
    )
  })

  it('裁切把画框对应的真实像素作为 Agent 的第一张输入', async () => {
    const rect = { x: 20, y: 30, w: 300, h: 240 }
    expect(
      await sendImageEditToAgent(editor(), image, '请裁切', { frame: { mode: 'crop', rect } }),
    ).toBe(true)
    expect(media.crop).toHaveBeenCalledWith('data:image/png;base64,ORIGINAL', rect, image, {
      width: 1024,
      height: 1024,
    })
    expect(agent.send).toHaveBeenCalledWith(
      '请裁切',
      [{ imageId: 'image-1', dataUrl: 'data:image/png;base64,CROPPED' }],
      expect.any(Function),
      'image',
      undefined,
      undefined,
      expect.any(String),
    )
  })

  it('扩图把带空白和遮罩的画框送进 Agent', async () => {
    const rect = { x: -50, y: -40, w: 612, h: 592 }
    expect(
      await sendImageEditToAgent(editor(), image, '请扩图', { frame: { mode: 'outpaint', rect } }),
    ).toBe(true)
    expect(media.outpaint).toHaveBeenCalledWith('data:image/png;base64,ORIGINAL', rect, image, {
      width: 1024,
      height: 1024,
    })
    expect(agent.send).toHaveBeenCalledWith(
      '请扩图',
      [
        {
          imageId: 'image-1',
          dataUrl: 'data:image/png;base64,EXPANDED',
          maskDataUrl: 'data:image/png;base64,OUTPAINT_MASK',
        },
      ],
      expect.any(Function),
      'image',
      undefined,
      undefined,
      expect.any(String),
    )
  })

  it('Agent 受理后立即收起，不等待整轮生成结束', async () => {
    agent.send.mockImplementationOnce(async (_text, _references, accepted) => {
      accepted?.()
      return await new Promise<undefined>(() => {})
    })
    expect(await sendImageEditToAgent(editor(), image, '请编辑')).toBe(true)
  })

  it('遮罩工作图过小时在发送前拒绝', async () => {
    media.prepare.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,SMALL',
      width: 512,
      height: 512,
    })
    expect(
      await sendImageEditToAgent(editor(), image, '请编辑', {
        strokes: [{ tool: 'brush', points: [{ x: 10, y: 10 }], width: 8 }],
      }),
    ).toBe(false)
    expect(agent.send).not.toHaveBeenCalled()
  })

  it('当前模型不支持原生遮罩时不会把区域操作交给 Agent', async () => {
    capability.maskSupported = false
    expect(
      await sendImageEditToAgent(editor(), image, '请扩图', {
        frame: { mode: 'outpaint', rect: { x: -40, y: 0, w: 552, h: 512 } },
      }),
    ).toBe(false)
    expect(agent.send).not.toHaveBeenCalled()
  })

  it('扩图后的工作图超限时不提交到 Agent', async () => {
    media.outpaint.mockResolvedValueOnce({
      source: 'data:image/png;base64,TOO_LARGE',
      mask: 'data:image/png;base64,MASK',
      width: 4000,
      height: 4000,
    })
    expect(
      await sendImageEditToAgent(editor(), image, '请扩图', {
        frame: { mode: 'outpaint', rect: { x: -40, y: 0, w: 552, h: 512 } },
      }),
    ).toBe(false)
    expect(agent.send).not.toHaveBeenCalled()
  })

  it('扩图框超限时不创建大画布', async () => {
    media.rectSize.mockReturnValueOnce({ width: 4000, height: 4000 })
    media.rectSize.mockReturnValueOnce({ width: 4000, height: 4000 })
    expect(
      await sendImageEditToAgent(editor(), image, '请扩图', {
        frame: { mode: 'outpaint', rect: { x: -40, y: 0, w: 552, h: 512 } },
      }),
    ).toBe(false)
    expect(media.outpaint).not.toHaveBeenCalled()
    expect(agent.send).not.toHaveBeenCalled()
  })
})

it('forwards stable region numbers with their mask and normalized coordinates', async () => {
  const regions = [{ number: 2, x: 0.2, y: 0.3, width: 0.2, height: 0.1 }]
  const sent = await sendImageEditToAgent(editor(), image, '将@区域2改成红色', {
    strokes: [{ tool: 'brush', width: 20, points: [{ x: 100, y: 100 }] }],
    regions,
  })
  expect(sent).toBe(true)
  expect(agent.send.mock.calls[0]?.[0]).toBe('将@区域2改成红色')
  expect(agent.send.mock.calls[0]?.[1]).toEqual([
    expect.objectContaining({ regions, maskDataUrl: 'data:image/png;base64,MASK' }),
  ])
})
