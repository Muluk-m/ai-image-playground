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

  it('完整输入超过统一上限时拒绝，不裁掉参考图', () => {
    const result = assembleLookRequest({
      look: {
        body: BODY,
        slotCount: 1,
        referenceImageIds: Array.from({ length: 16 }, (_, i) => `ref-${i}`),
      },
      assets: [CUP],
    })
    expect(result).toEqual({ ok: false, reason: 'input_limit_exceeded', required: 17, limit: 16 })
  })

  it('五个素材位和全部参考图在统一上限内完整发送', () => {
    const assets = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      id,
      name: id,
      views: [{ imageId: id, label: 'front' }],
    }))
    const result = assembleLookRequest({
      look: { body: BODY, slotCount: 5, referenceImageIds: ['ref'] },
      assets,
    })
    expect(result).toMatchObject({ ok: true, inputImageIds: ['a', 'b', 'c', 'd', 'e', 'ref'] })
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

  it('maxInputs 收紧时拒绝残缺输入', () => {
    expect(
      assembleLookRequest({
        look: { body: BODY, slotCount: 2, referenceImageIds: ['ref-a'] },
        assets: [CUP, { id: 'box', name: '包装盒', views: [{ imageId: 'box-1', label: 'none' }] }],
        maxInputs: 1,
      }),
    ).toEqual({ ok: false, reason: 'input_limit_exceeded', required: 3, limit: 1 })
  })
  it('遮罩目标排第一时引用序号跟着真实顺序走', () => {
    const result = assembleLookRequest({
      look: { body: BODY, slotCount: 2, referenceImageIds: [] },
      assets: [CUP, { id: 'box', name: '盒子', views: [{ imageId: 'box', label: 'front' }] }],
      firstImageId: 'box',
    })
    expect(result).toMatchObject({ ok: true, inputImageIds: ['box', 'cup-sheet'] })
    if (result.ok) expect(result.prompt).toContain('输入 2 = 素材「白瓷杯」')
  })
})

it('eight slots and eight unique references fit the platform boundary exactly', () => {
  const assets = Array.from({ length: 8 }, (_, i) => ({
    id: `a${i}`,
    name: `Asset ${i}`,
    views: [{ imageId: `i${i}`, label: 'front' }],
  }))
  const result = assembleLookRequest({
    assets,
    look: {
      body: BODY,
      slotCount: 8,
      referenceImageIds: Array.from({ length: 8 }, (_, i) => `r${i}`),
    },
  })
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.inputImageIds).toHaveLength(16)
})

it('a mask target takes precedence over the preferred sheet view', () => {
  const result = assembleLookRequest({
    look: { body: BODY, slotCount: 1, referenceImageIds: [] },
    assets: [CUP],
    firstImageId: 'cup-front',
  })
  expect(result).toMatchObject({ ok: true, inputImageIds: ['cup-front'] })
})
