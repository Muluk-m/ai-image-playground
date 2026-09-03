import { describe, expect, it } from 'vitest'
import {
  buildTemplateMenuGroups,
  collectTemplateAssetIds,
  getSlashTemplateQuery,
  getTemplateAssetRefs,
  getTemplateParamEntries,
  getTemplatePreviewText,
  getTemplatePromptParts,
  matchTemplatesByName,
  pickTemplateParams,
  remapTemplateMentions,
} from '../../../../features/library/lib/templates'
import type { AssetRecord, TemplateRecord } from '../../../../features/library/types'
import { getSelectedImageMentionLabel } from '../../../../lib/promptImageMentions'
import type { InputImage, TaskParams } from '../../../../types'

const IMAGE_A: InputImage = { id: 'image-a', dataUrl: 'data:,a' }
const IMAGE_B: InputImage = { id: 'image-b', dataUrl: 'data:,b' }
const IMAGE_C: InputImage = { id: 'image-c', dataUrl: 'data:,c' }

function makeAsset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return { id: 'a1', name: '白底图', imageId: 'image-a', createdAt: 1, lastUsedAt: 1, ...overrides }
}

function makeTemplate(overrides: Partial<TemplateRecord> = {}): TemplateRecord {
  return {
    id: 't1',
    name: '锁产品前缀',
    prompt: '前缀',
    assetIds: [],
    params: { size: '1024x1024', quality: 'high', n: 1 },
    createdAt: 1,
    lastUsedAt: 1,
    ...overrides,
  }
}

const mention = getSelectedImageMentionLabel

describe('collecting the asset ids a prompt references', () => {
  it('records them by mention index', () => {
    const prompt = `${mention(1)} 和 ${mention(0)}`
    const assets = [makeAsset({ id: 'a1' }), makeAsset({ id: 'a2', imageId: 'image-b' })]

    expect(collectTemplateAssetIds(prompt, [IMAGE_A, IMAGE_B], assets)).toEqual(['a1', 'a2'])
  })

  it('records null where the referenced image is not an asset', () => {
    const prompt = `${mention(0)} 和 ${mention(1)}`

    expect(collectTemplateAssetIds(prompt, [IMAGE_A, IMAGE_B], [makeAsset()])).toEqual(['a1', null])
  })

  it('leaves unreferenced positions null and stops after the last reference', () => {
    const prompt = mention(2)
    const assets = [
      makeAsset({ id: 'a1' }),
      makeAsset({ id: 'a3', imageId: 'image-c' }),
      makeAsset({ id: 'a4', imageId: 'image-c', lastUsedAt: 0 }),
    ]

    expect(collectTemplateAssetIds(prompt, [IMAGE_A, IMAGE_B, IMAGE_C], assets)).toEqual([
      null,
      null,
      'a3',
    ])
  })

  it('records nothing when the prompt references no image', () => {
    expect(collectTemplateAssetIds('没有引用', [IMAGE_A], [makeAsset()])).toEqual([])
  })
})

describe('remapping a template prompt onto the new reference order', () => {
  it('points each reference at the position its image landed at', () => {
    const prompt = `${mention(0)} 与 ${mention(1)}`

    const remapped = remapTemplateMentions(prompt, ['image-b', 'image-a'], [IMAGE_A, IMAGE_B])

    expect(remapped).toBe(`${mention(1)} 与 ${mention(0)}`)
  })

  it('degrades a reference whose asset is gone', () => {
    const prompt = `${mention(0)} 与 ${mention(1)}`

    const remapped = remapTemplateMentions(prompt, ['image-a', null], [IMAGE_A])

    expect(remapped).toBe(`${mention(0)} 与 @已移除图片`)
  })

  it('degrades a reference whose image never made it into the strip', () => {
    const remapped = remapTemplateMentions(mention(0), ['image-b'], [IMAGE_A])

    expect(remapped).toBe('@已移除图片')
  })
})

describe('the panel preview', () => {
  it('shows the asset name for a live reference and the index for a deleted one', () => {
    const template = makeTemplate({
      prompt: `${mention(0)} 站在 ${mention(1)} 前`,
      assetIds: ['a1', 'gone'],
    })

    expect(getTemplatePreviewText(template, [makeAsset()])).toBe('@白底图 站在 @图2 前')
  })
})

describe('the referenced assets of a template', () => {
  it('keeps the deleted ones as empty slots and drops the positions that never were assets', () => {
    const template = makeTemplate({ assetIds: ['a1', null, 'gone'] })

    expect(getTemplateAssetRefs(template, [makeAsset()])).toEqual([
      { assetId: 'a1', asset: makeAsset() },
      { assetId: 'gone', asset: null },
    ])
  })
})

describe('the detail prompt', () => {
  it('splits into mention, slot and plain parts', () => {
    const template = makeTemplate({
      prompt: `${mention(0)} 背景换成 {背景}`,
      assetIds: ['a1'],
    })

    expect(getTemplatePromptParts(template, [makeAsset()])).toEqual([
      { type: 'mention', text: '@白底图' },
      { type: 'text', text: ' 背景换成 ' },
      { type: 'slot', text: '{背景}', name: '背景' },
    ])
  })

  it('falls back to the index when the asset is gone', () => {
    const template = makeTemplate({ prompt: mention(1), assetIds: [null, 'gone'] })

    expect(getTemplatePromptParts(template, [])).toEqual([{ type: 'mention', text: '@图2' }])
  })
})

describe('the param line', () => {
  it('labels every param and writes auto out', () => {
    expect(getTemplateParamEntries({ size: 'auto', quality: 'auto', n: 1 })).toEqual([
      { label: '尺寸', value: 'auto' },
      { label: '质量', value: 'auto' },
      { label: '数量', value: '1 张' },
    ])
  })
})

describe('the param snapshot', () => {
  it('keeps only size, quality and count', () => {
    const params = {
      size: '1536x1024',
      quality: 'medium',
      n: 3,
      output_format: 'png',
      moderation: 'low',
    } as TaskParams

    expect(pickTemplateParams(params)).toEqual({ size: '1536x1024', quality: 'medium', n: 3 })
  })
})

describe('the / menu', () => {
  it('opens at the start of a line and after whitespace', () => {
    expect(getSlashTemplateQuery('/锁', 2)).toEqual({ start: 0, query: '锁' })
    expect(getSlashTemplateQuery('前缀 /锁', 5)).toEqual({ start: 3, query: '锁' })
    expect(getSlashTemplateQuery('前缀\n/锁', 5)).toEqual({ start: 3, query: '锁' })
  })

  it('stays out of path-like text', () => {
    expect(getSlashTemplateQuery('src/lib', 7)).toBeNull()
    expect(getSlashTemplateQuery('没有斜杠', 4)).toBeNull()
  })

  it('closes once the query runs into whitespace', () => {
    expect(getSlashTemplateQuery('/锁 产品', 4)).toBeNull()
  })

  it('lists the most recently used first and filters by name', () => {
    const templates = [
      makeTemplate({ id: 't1', name: '锁产品前缀', lastUsedAt: 1 }),
      makeTemplate({ id: 't2', name: '分镜风格后缀', lastUsedAt: 2 }),
    ]

    expect(matchTemplatesByName(templates, '').map((template) => template.name)).toEqual([
      '分镜风格后缀',
      '锁产品前缀',
    ])
    expect(matchTemplatesByName(templates, '锁产品').map((template) => template.id)).toEqual(['t1'])
  })

  it('drops the group when nothing matches', () => {
    const templates = [makeTemplate({ name: '锁产品前缀' })]

    expect(buildTemplateMenuGroups({ query: '锁产品', templates })).toEqual([
      {
        key: 'templates',
        heading: '模板',
        options: [{ key: 't1', label: '锁产品前缀', value: 't1' }],
      },
    ])
    expect(buildTemplateMenuGroups({ query: '没有这个', templates })).toEqual([])
  })
})
