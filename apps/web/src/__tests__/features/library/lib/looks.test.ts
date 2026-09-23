import type { AgentSkillSummary } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { splitLookBody } from '../../../../features/library/lib/lookBody'
import {
  assetsForInputImages,
  checkLookSubmission,
} from '../../../../features/library/lib/lookSubmit'
import {
  lookItemFromSkill,
  lookNeedsRetune,
  mergeLookItems,
} from '../../../../features/library/lib/looks'
import type { AssetRecord, LookRecord } from '../../../../features/library/types'

function makeLook(overrides: Partial<LookRecord>): LookRecord {
  return {
    id: 'l1',
    name: '北欧客厅',
    description: '',
    purpose: 'scene',
    body: '',
    model: 'gpt-image-2.5-sunburst',
    size: '3:4',
    slotCount: 1,
    referenceImageIds: ['ref-1'],
    coverImageId: null,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
    ...overrides,
  }
}

function makeSkill(overrides: Partial<AgentSkillSummary>): AgentSkillSummary {
  return {
    name: 'look-rock-wall-marble',
    title: '岩壁大理石',
    description: '何时用：…',
    icon: 'image',
    summary: '',
    ...overrides,
  }
}

const BUILTIN = makeSkill({
  template: {
    purpose: 'scene',
    model: 'gpt-image-2.5-sunburst',
    size: '3:4',
    slotCount: 1,
    coverUrl: '/api/agent/skills/look-rock-wall-marble/files/cover.webp',
    referenceUrls: [],
    body: '## 1. 一句话目标\n把素材放进岩壁场景',
  },
})

function makeAsset(id: string, imageIds: string[]): AssetRecord {
  return {
    id,
    name: id,
    kind: 'product',
    views: imageIds.map((imageId) => ({ imageId, label: 'none', source: 'upload' })),
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
  }
}

describe('模板列表', () => {
  it('自建按最近使用排在预置前面，只有带 template 的技能算预置模板', () => {
    const items = mergeLookItems(
      [makeLook({ id: 'old', lastUsedAt: 1 }), makeLook({ id: 'new', lastUsedAt: 9 })],
      [makeSkill({ name: 'poster', title: '海报' }), BUILTIN],
    )
    expect(items.map((item) => item.skillName)).toEqual([
      'look-new',
      'look-old',
      'look-rock-wall-marble',
    ])
    expect(items[2].origin).toBe('builtin')
    expect(lookItemFromSkill(makeSkill({ name: 'poster' }))).toBeNull()
  })

  it('封面缺席时退回第一张参考图', () => {
    const [item] = mergeLookItems([makeLook({ coverImageId: null })], [])
    expect(item.cover).toEqual({ kind: 'image', imageId: 'ref-1' })
  })

  it('钉死的模型不在清单里才算需重新调试；清单未知时不判', () => {
    const [item] = mergeLookItems([makeLook({})], [])
    expect(lookNeedsRetune(item, new Set(['gemini-3.1-flash-image']))).toBe(true)
    expect(lookNeedsRetune(item, new Set(['gpt-image-2.5-sunburst']))).toBe(false)
    expect(lookNeedsRetune(item, new Set())).toBe(false)
  })
})

describe('模板正文分节', () => {
  it('丢掉开头的一级标题，按二级标题切段并去掉序号', () => {
    const sections = splitLookBody(
      '# 岩壁大理石\n\n## 1. 一句话目标\n出一张场景图\n\n## 3. 需要用户提供的输入\n- 产品素材 1 条',
    )
    expect(sections).toEqual([
      { title: '一句话目标', body: '出一张场景图' },
      { title: '需要用户提供的输入', body: '- 产品素材 1 条' },
    ])
  })
})

describe('生成模式带模板提交', () => {
  const tub = makeAsset('tub', ['sheet', 'front'])
  const model = makeAsset('model', ['face'])

  it('参考图条里的素材按首次出现去重排序', () => {
    const picked = assetsForInputImages(
      [{ id: 'front' }, { id: 'stray' }, { id: 'face' }, { id: 'sheet' }],
      [tub, model],
    )
    expect(picked.map((asset) => asset.id)).toEqual(['tub', 'model'])
  })

  it('素材条数与素材位不符就不发', () => {
    const [one] = mergeLookItems([makeLook({ slotCount: 1 })], [])
    const [two] = mergeLookItems([makeLook({ id: 'l2', slotCount: 2 })], [])
    expect(checkLookSubmission(one, [{ id: 'sheet' }], [tub, model])).toMatchObject({ ok: true })
    expect(checkLookSubmission(two, [{ id: 'sheet' }], [tub, model])).toEqual({
      ok: false,
      reason: 'slot_mismatch',
      expected: 2,
    })
    expect(checkLookSubmission(one, [{ id: 'stray' }], [tub, model])).toMatchObject({
      ok: false,
    })
  })
})
