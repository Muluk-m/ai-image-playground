import { describe, expect, it } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { projectDocument } from '../../../../features/canvas/lib/projectMedia'

describe('上云的项目文档', () => {
  it('bounds an over-long meta value instead of failing the whole document', () => {
    const doc = new CanvasDoc()
    const mediaId = '0f8b6a4e-2c1d-4e5f-9a7b-3c2d1e0f9a8b'
    doc.addElements(
      [
        {
          id: 'img',
          type: 'image',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          rotation: 0,
          fileId: 'f',
          meta: { prompt: '短', userPrompt: '长'.repeat(12000) },
        },
      ],
      { files: { f: `aip-media:${mediaId}` } },
    )

    const document = projectDocument(doc)

    expect(document).not.toBeNull()
    const image = document!.elements[0] as { meta: Record<string, string> }
    expect(image.meta.userPrompt).toHaveLength(10000)
    expect(image.meta.prompt).toBe('短')
    // 本机画布保留原文。
    const local = doc.getElement('img')
    expect(local?.type === 'image' && local.meta?.userPrompt).toHaveLength(12000)
  })
})
