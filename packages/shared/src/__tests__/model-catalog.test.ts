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

/** Agent 模式参数菜单的 5 档（AgentParamsChip IMAGE_RATIOS，用户截图里的那 5 档）。 */
const AGENT_RATIOS = ['1:1', '3:4', '9:16', '4:3', '16:9'] as const

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

  it('rejects surfaces that offer ratios the model does not support', () => {
    const config = rawConfig()
    const lite = config.models.find(
      (one: { id: string }) => one.id === 'gemini-3.1-flash-lite-image',
    )
    lite.image.ratios = lite.image.ratios.filter((ratio: string) => ratio !== '21:9')
    const gpt = config.models.find((one: { id: string }) => one.id === 'gpt-image-2.5-flare')
    gpt.image.tiers.push({ id: '2K', pixels: {} })
    const problems = modelCatalogProblems(config).join('\n')
    expect(problems).toContain('surfaces.direct offers ratio 21:9')
    expect(problems).toContain('fixed wire means exactly one tier')
  })

  it('every model stays within the catalog ratios and the Agent menu keeps its five', () => {
    for (const spec of MODEL_CATALOG) {
      for (const ratio of spec.image.ratios) expect(CATALOG_RATIOS).toContain(ratio)
      expect(spec.image.surfaces.agent).toEqual({ ratios: [...AGENT_RATIOS], customSize: false })
    }
  })

  it('pixel-wire tiers use the existing composer presets', () => {
    for (const spec of MODEL_CATALOG) {
      if (spec.image.wire.kind !== 'pixels') continue
      for (const tier of spec.image.tiers) {
        const presets = IMAGE_SIZE_PRESETS[tier.id as keyof typeof IMAGE_SIZE_PRESETS]
        for (const ratio of spec.image.ratios) {
          expect(tier.pixels[ratio]).toBe(presets[ratio as keyof typeof presets])
        }
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

  it('GPT has a single measured tier, prompt-injected ratio and no tier pricing', () => {
    for (const id of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
      expect(caps(id).ratioVia).toEqual(['prompt'])
      expect(caps(id).wire.kind).toBe('fixed')
      expect(caps(id).tiers).toEqual([
        { id: '1K', pixels: { '1:1': '1254x1254', '16:9': '1672x941' } },
      ])
      expect(findCatalogModel(id)?.pricing.tierMultiplier).toBeUndefined()
    }
  })

  it('Grok has the measured 1K / 2K tiers priced 1 : 1.5', () => {
    expect(caps('grok-imagine-image-2.0').tiers).toEqual([
      { id: '1K', pixels: { '1:1': '1024x1024', '16:9': '1280x720' } },
      { id: '2K', pixels: { '1:1': '2048x2048', '16:9': '2816x1584' } },
    ])
    expect(findCatalogModel('grok-imagine-image-2.0')?.pricing.tierMultiplier).toEqual({
      '1K': 1,
      '2K': 1.5,
    })
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
      pixels: '1254x1254',
      adjustments: [{ field: 'tier', from: '4K', to: '1K' }],
    })
  })

  it('falls back upward when every supported tier is higher', () => {
    expect(nearestImageTier('512', ['1K', '2K'])).toBe('1K')
    const result = resolveImageRequest(caps('gemini-3.1-flash-lite-image'), { tier: '512' })
    expect(result).toMatchObject({ ok: true, tier: '1K' })
  })

  it('maps unsupported ratios to the nearest supported ratio', () => {
    expect(nearestCatalogRatio('21:9', AGENT_RATIOS)).toBe('16:9')
    expect(nearestCatalogRatio('2:3', AGENT_RATIOS)).toBe('3:4')
    expect(nearestCatalogRatio('1:4', AGENT_RATIOS)).toBe('9:16')
    expect(nearestCatalogRatio('nope', AGENT_RATIOS)).toBeUndefined()
    const result = resolveImageRequest(caps('gemini-nano-banana-2.1'), { ratio: '1:4' })
    expect(result).toMatchObject({
      ok: true,
      ratio: '9:16',
      adjustments: [{ field: 'ratio', from: '1:4', to: '9:16' }],
    })
  })

  it('falls back within the ratios of the submitting surface', () => {
    const model = caps('gpt-image-2.5-flare')
    expect(resolveImageRequest(model, { ratio: '21:9', surface: 'direct' })).toMatchObject({
      ok: true,
      ratio: '21:9',
      adjustments: [],
    })
    expect(resolveImageRequest(model, { ratio: '21:9', surface: 'agent' })).toMatchObject({
      ok: true,
      ratio: '16:9',
      adjustments: [{ field: 'ratio', from: '21:9', to: '16:9' }],
    })
    const pro = caps('gemini-3-pro-image')
    expect(resolveImageRequest(pro, { ratio: '4:5', surface: 'direct' })).toMatchObject({
      ratio: '4:5',
      pixels: '928x1152',
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

  it('rejects reference counts that are not non-negative integers', () => {
    const model = caps('gemini-3-pro-image')
    for (const references of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveImageRequest(model, { references })).toEqual({
        ok: false,
        field: 'references',
        max: 14,
      })
    }
    expect(resolveImageRequest(model, { references: 14 })).toMatchObject({ ok: true })
  })

  it('records non-finite n as a string so adjustments stay JSON-safe', () => {
    const model = caps('gpt-image-2.5-flare')
    expect(resolveImageRequest(model, { n: Number.POSITIVE_INFINITY })).toMatchObject({
      n: 1,
      adjustments: [{ field: 'n', from: 'Infinity', to: 1 }],
    })
    expect(resolveImageRequest(model, { n: Number.NaN })).toMatchObject({
      n: 1,
      adjustments: [{ field: 'n', from: 'NaN', to: 1 }],
    })
    expect(resolveImageRequest(model, { n: 2.7 })).toMatchObject({
      n: 2,
      adjustments: [{ field: 'n', from: 2.7, to: 2 }],
    })
  })

  it('treats a non-string ratio as missing instead of throwing', () => {
    const model = caps('gemini-3-pro-image')
    const input = { ratio: 42 } as unknown as { ratio: string }
    expect(resolveImageRequest(model, input)).toMatchObject({ ok: true, ratio: 'auto' })
  })

  it('ignores an unknown tier and uses the default', () => {
    const result = resolveImageRequest(caps('gemini-3-pro-image'), { tier: '8K' })
    expect(result).toMatchObject({ ok: true, tier: '1K', adjustments: [] })
  })
})
