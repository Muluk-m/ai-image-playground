import { describe, expect, it } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { projectDocument, projectScene } from '../../../../features/canvas/lib/projectMedia'

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

describe('云端项目的失败占位', () => {
  const generationId = '70cf33ea-d548-4a2b-ab0b-4a10e2e444fb'
  const reservation = {
    id: `agent_${generationId}_0`,
    type: 'generation' as const,
    generationId,
    position: 0,
    x: 24,
    y: 0,
    width: 360,
    height: 360,
  }

  it('restores a failed reservation as a failed agent placeholder with its error code', () => {
    const scene = projectScene(
      { version: 1, elements: [{ ...reservation, errorCode: 'timeout' }] },
      new Map(),
      'conversation-1',
    )

    expect(scene.elements).toMatchObject([
      {
        id: reservation.id,
        type: 'placeholder',
        status: 'error',
        meta: {
          agent: true,
          agentErrorCode: 'timeout',
          agentConversationId: 'conversation-1',
          cloudGeneration: { id: generationId, position: 0 },
        },
      },
    ])
  })

  it('keeps a running reservation loading and writes both back unchanged', () => {
    const remote = {
      version: 1 as const,
      elements: [
        reservation,
        {
          ...reservation,
          id: `agent_${generationId}_1`,
          position: 1,
          errorCode: 'no_output' as const,
        },
      ],
    }
    const doc = new CanvasDoc()
    const scene = projectScene(remote)
    doc.restore(scene.elements, scene.files)

    expect(doc.elements.map((one) => one.type === 'placeholder' && one.status)).toEqual([
      'loading',
      'error',
    ])
    expect(projectDocument(doc)).toEqual(remote)
  })
})
