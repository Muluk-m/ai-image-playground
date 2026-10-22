import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IMAGE_SIZE_PRESETS } from '../image'
import {
  CATALOG_RATIOS,
  findCatalogModel,
  type ImageCapabilities,
  MODEL_CATALOG,
  modelCatalogProblems,
  nearestCatalogRatio,
  nearestImageTier,
  renderModelCatalogSchema,
  resolveImageRequest,
} from '../model-catalog'

const DIR = join(import.meta.dir, '../model-catalog')
const rawConfig = () => JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'))

function caps(id: string): ImageCapabilities {
  const spec = findCatalogModel(id)
  if (!spec) throw new Error(`missing ${id}`)
  return spec.image
}

describe('model catalog config', () => {
  it('schema.json is generated from schema.ts (run `bun run catalog:schema` after editing schema.ts)', () => {
    expect(readFileSync(join(DIR, 'schema.json'), 'utf8')).toBe(renderModelCatalogSchema())
  })

  it('config.json points editors at schema.json and passes validation', () => {
    const config = rawConfig()
    expect(config.$schema).toBe('./schema.json')
    expect(modelCatalogProblems(config)).toEqual([])
  })

  it('rejects unknown fields, tiers and ratios', () => {
    const config = rawConfig()
    config.models[0].image.tiers.push({ id: '8K', pixels: {} })
    config.models[0].image.ratios.push('1:4')
    config.models[0].image.colour = 'red'
    const problems = modelCatalogProblems(config)
    expect(problems.some((one) => one.includes('/models/0/image/tiers'))).toBe(true)
    expect(problems.some((one) => one.includes('/models/0/image/ratios'))).toBe(true)
    expect(problems.some((one) => one.includes('additional properties'))).toBe(true)
  })

  it('rejects semantic mistakes the schema cannot express', () => {
    const config = rawConfig()
    const pro = config.models.find((one: { id: string }) => one.id === 'gemini-3-pro-image')
    pro.image.defaultTier = '512'
    pro.image.tiers[0].pixels['16:9'] = '1024x1024'
    pro.pricing.tierMultiplier['512'] = 0.5
    delete pro.image.wire.tokens['4K']
    pro.evidence.count = { source: 'unverified' }
    config.models.push(structuredClone(config.models[0]))
    const problems = modelCatalogProblems(config).join('\n')
    expect(problems).toContain('defaultTier 512')
    expect(problems).toContain('do not match the ratio')
    expect(problems).toContain('tierMultiplier has tier 512')
    expect(problems).toContain('wire.tokens must cover exactly its tiers')
    expect(problems).toContain('unverified evidence needs a todo')
    expect(problems).toContain('duplicate id')
  })

  it('every model offers only the five product ratios', () => {
    for (const spec of MODEL_CATALOG) {
      for (const ratio of spec.image.ratios) expect(CATALOG_RATIOS).toContain(ratio)
    }
  })

  it('pixel-wire tiers use the existing composer presets', () => {
    for (const spec of MODEL_CATALOG) {
      if (spec.image.wire.kind !== 'pixels') continue
      for (const tier of spec.image.tiers) {
        const presets = IMAGE_SIZE_PRESETS[tier.id as keyof typeof IMAGE_SIZE_PRESETS]
        for (const ratio of spec.image.ratios) expect(tier.pixels[ratio]).toBe(presets[ratio])
      }
    }
  })

  it('records the decided tier pricing (1K base × official cost ratio)', () => {
    expect(findCatalogModel('gemini-nano-banana-2.1')?.pricing.tierMultiplier).toEqual({
      '1K': 1,
      '2K': 1.5,
      '4K': 3.4,
    })
    expect(findCatalogModel('gemini-3-pro-image')?.pricing.tierMultiplier).toEqual({
      '1K': 1,
      '2K': 1,
      '4K': 1.8,
    })
    expect(findCatalogModel('gemini-3.1-flash-lite-image')?.pricing.tierMultiplier).toBeUndefined()
  })

  it('GPT keeps its prompt-injected ratio and has no 4K', () => {
    for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
      expect(caps(id).ratioVia).toEqual(['prompt'])
      expect(caps(id).tiers.map((one) => one.id)).not.toContain('4K')
    }
  })
})

describe('resolveImageRequest', () => {
  it('keeps supported values untouched and returns known pixels', () => {
    expect(resolveImageRequest(caps('gemini-3-pro-image'), { tier: '4K', ratio: '16:9' })).toEqual({
      ok: true,
      tier: '4K',
      ratio: '16:9',
      n: 1,
      pixels: '5504x3072',
      adjustments: [],
    })
  })

  it('falls back to the highest tier at or below the request', () => {
    const result = resolveImageRequest(caps('gpt-image-2.5-flare'), { tier: '4K', ratio: '1:1' })
    expect(result).toMatchObject({
      ok: true,
      tier: '1K',
      pixels: '1024x1024',
      adjustments: [{ field: 'tier', from: '4K', to: '1K' }],
    })
  })

  it('falls back upward when every supported tier is higher', () => {
    expect(nearestImageTier('512', ['1K', '2K'])).toBe('1K')
    const result = resolveImageRequest(caps('gemini-3.1-flash-lite-image'), { tier: '512' })
    expect(result).toMatchObject({ ok: true, tier: '1K' })
  })

  it('maps unsupported ratios to the nearest product ratio', () => {
    expect(nearestCatalogRatio('21:9', CATALOG_RATIOS)).toBe('16:9')
    expect(nearestCatalogRatio('2:3', CATALOG_RATIOS)).toBe('3:4')
    expect(nearestCatalogRatio('1:4', CATALOG_RATIOS)).toBe('9:16')
    expect(nearestCatalogRatio('nope', CATALOG_RATIOS)).toBeUndefined()
    const result = resolveImageRequest(caps('gemini-nano-banana-2.1'), { ratio: '1:4' })
    expect(result).toMatchObject({
      ok: true,
      ratio: '9:16',
      adjustments: [{ field: 'ratio', from: '1:4', to: '9:16' }],
    })
  })

  it('treats a missing or auto ratio as auto when the model allows it', () => {
    const result = resolveImageRequest(caps('grok-imagine-image-2.0'), { ratio: 'auto' })
    expect(result).toEqual({ ok: true, tier: '1K', ratio: 'auto', n: 1, adjustments: [] })
  })

  it('clamps n into 1..count.max', () => {
    const model = caps('gpt-image-2.5-flare')
    expect(resolveImageRequest(model, { n: 30 })).toMatchObject({
      n: model.count.max,
      adjustments: [{ field: 'n', from: 30, to: model.count.max }],
    })
    expect(resolveImageRequest(model, { n: 0 })).toMatchObject({ n: 1 })
  })

  it('refuses to drop reference images', () => {
    expect(resolveImageRequest(caps('grok-imagine-image-2.0'), { references: 6 })).toEqual({
      ok: false,
      field: 'references',
      max: 5,
    })
  })

  it('ignores an unknown tier and uses the default', () => {
    const result = resolveImageRequest(caps('gemini-3-pro-image'), { tier: '8K' })
    expect(result).toMatchObject({ ok: true, tier: '1K', adjustments: [] })
  })
})
