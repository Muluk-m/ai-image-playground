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
const media = vi.hoisted(() => ({
  resolve: vi.fn(async () => 'data:image/png;base64,ORIGINAL'),
  prepare: vi.fn(async () => ({
    dataUrl: 'data:image/png;base64,WORKING',
    width: 512,
    height: 512,
  })),
  mask: vi.fn(async () => 'data:image/png;base64,MASK'),
}))

vi.mock('../../../../features/agent/panelLayout', () => ({ agentPanelPresent: () => true }))
vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: { getState: () => agent },
}))
vi.mock('../../../../lib/cloudMedia', () => ({ resolveMediaSource: media.resolve }))
vi.mock('../../../../lib/maskPreprocess', () => ({ prepareMaskTargetDataUrl: media.prepare }))
vi.mock('../../../../features/canvas/lib/inpaintMask', () => ({ exportMaskDataUrl: media.mask }))

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
    )
  })

  it('区域编辑把与工作图同尺寸的遮罩作为第一张引用交给 Agent', async () => {
    const strokes = [{ tool: 'brush' as const, points: [{ x: 10, y: 10 }], width: 8 }]
    const sent = await sendImageEditToAgent(editor(), image, '请修改 [image 1] 的选区', {
      strokes,
      referenceDataUrl: 'data:image/png;base64,REFERENCE',
    })
    expect(sent).toBe(true)
    expect(media.mask).toHaveBeenCalledWith(image, { width: 512, height: 512 }, strokes)
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
    )
  })
})
