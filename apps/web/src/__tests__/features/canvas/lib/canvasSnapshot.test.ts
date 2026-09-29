import { describe, expect, it } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { liveCanvasSnapshot } from '../../../../features/canvas/lib/canvasSnapshot'

describe('liveCanvasSnapshot', () => {
  it('lists every image on the open canvas, including one that has no cloud media id', () => {
    const doc = new CanvasDoc()
    doc.restore(
      [
        {
          id: 'local',
          type: 'image',
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          rotation: 0,
          fileId: 'file-local',
          name: '海报.png',
          meta: { userPrompt: '一张海报' },
        },
        {
          id: 'cloud',
          type: 'image',
          x: 200,
          y: 0,
          width: 100,
          height: 80,
          rotation: 0,
          fileId: 'cloud-11111111-2222-4333-8444-555555555555',
        },
      ],
      {
        'cloud-11111111-2222-4333-8444-555555555555':
          'aip-media:11111111-2222-4333-8444-555555555555',
      },
    )

    const snapshot = liveCanvasSnapshot(doc)
    expect(snapshot?.elements).toHaveLength(2)
    expect(snapshot?.elements[0]).toMatchObject({
      id: 'local',
      name: '海报.png',
      prompt: '一张海报',
    })
    expect(snapshot?.elements[0]).not.toHaveProperty('mediaId')
    expect(snapshot?.elements[1]).toMatchObject({
      id: 'cloud',
      mediaId: '11111111-2222-4333-8444-555555555555',
    })
    expect(liveCanvasSnapshot(new CanvasDoc())).toEqual({ elements: [] })
    expect(liveCanvasSnapshot(undefined)).toBeUndefined()
  })

  it('uses a matching uploaded binding and the rotated image footprint', () => {
    const doc = new CanvasDoc()
    doc.restore(
      [
        {
          id: 'turned',
          type: 'image',
          x: 100,
          y: 100,
          width: 80,
          height: 40,
          rotation: 90,
          fileId: 'local-file',
        },
      ],
      { 'local-file': 'data:image/png;base64,AA==' },
    )
    const image = liveCanvasSnapshot(doc, () => '11111111-2222-4333-8444-555555555555')?.elements[0]
    expect(image).toMatchObject({ id: 'turned', mediaId: '11111111-2222-4333-8444-555555555555' })
    expect(image?.x).toBeCloseTo(60)
    expect(image?.y).toBeCloseTo(100)
    expect(image?.width).toBeCloseTo(40)
    expect(image?.height).toBeCloseTo(80)
    if (image?.type === 'image') expect(image.dx).toBeCloseTo(40)
  })
})
