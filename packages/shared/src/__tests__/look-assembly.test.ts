import { describe, expect, it } from 'bun:test'
import { assembleLookRequest } from '../look-assembly'

const BODY = [
  '## 1. 一句话目标',
  '把产品放进极简棚拍场景。',
  '',
  '## 2. 适用场景',
  '电商主图。',
  '',
  '## 3. 需要用户提供的输入',
  '- 产品素材 ×1（建议三视图）',
  '- 素材位不足时先问用户',
  '',
  '## 4. 工作流程',
  '1. 先看输入图。',
].join('\n')

function prompt(slotSection: readonly string[]): string {
  return [
    '## 1. 一句话目标',
    '把产品放进极简棚拍场景。',
    '',
    '## 2. 适用场景',
    '电商主图。',
    '',
    '## 3. 需要用户提供的输入',
    ...slotSection,
    '',
    '## 4. 工作流程',
    '1. 先看输入图。',
  ].join('\n')
}

const CUP = {
  id: 'cup',
  name: '白瓷杯',
  views: [
    { imageId: 'cup-front', label: 'front' },
    { imageId: 'cup-sheet', label: 'sheet' },
  ],
}

describe('assembleLookRequest', () => {
  it('素材按位填满后参考图接着排，第三节换成这次真的送了什么', () => {
    const result = assembleLookRequest({
      look: { body: BODY, slotCount: 2, referenceImageIds: ['ref-a', 'ref-b'] },
      assets: [
        CUP,
        {
          id: 'model',
          name: '模特',
          views: [
            { imageId: 'model-side', label: 'side' },
            { imageId: 'model-front', label: 'front' },
          ],
        },
      ],
    })

    expect(result).toEqual({
      ok: true,
      inputImageIds: ['cup-sheet', 'model-front', 'ref-a', 'ref-b'],
      prompt: prompt([
        '输入 1 = 素材「白瓷杯」',
        '输入 2 = 素材「模特」',
        '参考图：输入 3、输入 4',
      ]),
    })
  })

  it('没有拼图也没有正面时取封面那张', () => {
    const result = assembleLookRequest({
      look: { body: BODY, slotCount: 1, referenceImageIds: [] },
      assets: [
        {
          id: 'lamp',
          name: '台灯',
          views: [
            { imageId: 'lamp-detail', label: 'detail' },
            { imageId: 'lamp-back', label: 'back' },
          ],
        },
      ],
    })

    expect(result).toMatchObject({ ok: true, inputImageIds: ['lamp-detail'] })
  })

  it('输入图满 4 张后余下的参考图被裁掉', () => {
    const result = assembleLookRequest({
      look: {
        body: BODY,
        slotCount: 1,
        referenceImageIds: ['ref-a', 'ref-b', 'ref-c', 'ref-d', 'ref-e'],
      },
      assets: [CUP],
    })

    expect(result).toEqual({
      ok: true,
      inputImageIds: ['cup-sheet', 'ref-a', 'ref-b', 'ref-c'],
      prompt: prompt(['输入 1 = 素材「白瓷杯」', '参考图：输入 2、输入 3、输入 4']),
    })
  })

  it('素材位多过输入上限时只带得下前几条，参考图一张都排不上', () => {
    const assets = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      id,
      name: id.toUpperCase(),
      views: [{ imageId: `${id}-front`, label: 'front' }],
    }))

    const result = assembleLookRequest({
      look: { body: BODY, slotCount: 5, referenceImageIds: ['ref-a'] },
      assets,
    })

    expect(result).toEqual({
      ok: true,
      inputImageIds: ['a-front', 'b-front', 'c-front', 'd-front'],
      prompt: prompt([
        '输入 1 = 素材「A」',
        '输入 2 = 素材「B」',
        '输入 3 = 素材「C」',
        '输入 4 = 素材「D」',
      ]),
    })
  })

  it('已经作为素材送进去的那张不再占一个参考图位', () => {
    const result = assembleLookRequest({
      look: { body: BODY, slotCount: 1, referenceImageIds: ['cup-sheet', 'ref-b'] },
      assets: [CUP],
    })

    expect(result).toEqual({
      ok: true,
      inputImageIds: ['cup-sheet', 'ref-b'],
      prompt: prompt(['输入 1 = 素材「白瓷杯」', '参考图：输入 2']),
    })
  })

  it('素材条数与素材位不符时不出图', () => {
    expect(
      assembleLookRequest({
        look: { body: BODY, slotCount: 2, referenceImageIds: [] },
        assets: [CUP],
      }),
    ).toEqual({ ok: false, reason: 'slot_mismatch' })
  })

  it('素材一张视角都没有时点名是哪一条', () => {
    expect(
      assembleLookRequest({
        look: { body: BODY, slotCount: 2, referenceImageIds: [] },
        assets: [CUP, { id: 'hollow', name: '空素材', views: [] }],
      }),
    ).toEqual({ ok: false, reason: 'no_views', assetId: 'hollow' })
  })

  it('正文没有第三节时输入清单接在末尾', () => {
    const result = assembleLookRequest({
      look: { body: '# 预置模板\n\n照着参考图的光线来。\n', slotCount: 1, referenceImageIds: [] },
      assets: [CUP],
    })

    expect(result).toEqual({
      ok: true,
      inputImageIds: ['cup-sheet'],
      prompt: '# 预置模板\n\n照着参考图的光线来。\n\n输入 1 = 素材「白瓷杯」',
    })
  })

  it('maxInputs 收紧时素材也照样裁', () => {
    expect(
      assembleLookRequest({
        look: { body: BODY, slotCount: 2, referenceImageIds: ['ref-a'] },
        assets: [CUP, { id: 'box', name: '包装盒', views: [{ imageId: 'box-1', label: 'none' }] }],
        maxInputs: 1,
      }),
    ).toMatchObject({ ok: true, inputImageIds: ['cup-sheet'] })
  })
})
