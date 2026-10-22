import { Value } from 'typebox/value'
import { catalogRatioValue } from './resolve'
import { IMAGE_TIERS, type ModelCatalogConfig, ModelCatalogSchema } from './schema'

/**
 * 校验目录：先按 schema 查结构，再查 schema 表达不了的约束。返回全部问题，空数组 = 通过。
 */
export function modelCatalogProblems(raw: unknown): string[] {
  if (!Value.Check(ModelCatalogSchema, raw)) {
    return Value.Errors(ModelCatalogSchema, raw).map(
      (error) => `${error.instancePath || '/'}: ${error.message}`,
    )
  }
  const problems: string[] = []
  const seen = new Set<string>()
  for (const model of raw.models) {
    const at = `model '${model.id}'`
    if (seen.has(model.id)) problems.push(`${at}: duplicate id`)
    seen.add(model.id)

    const image = model.image
    const tierIds = image.tiers.map((one) => one.id)
    const ranks = tierIds.map((id) => IMAGE_TIERS.indexOf(id))
    if (ranks.some((rank, index) => index > 0 && rank <= ranks[index - 1]!)) {
      problems.push(`${at}: tiers must be unique and ordered ${IMAGE_TIERS.join(' < ')}`)
    }
    if (!tierIds.includes(image.defaultTier)) {
      problems.push(`${at}: defaultTier ${image.defaultTier} is not one of its tiers`)
    }
    for (const tier of image.tiers) {
      for (const [ratio, pixels] of Object.entries(tier.pixels)) {
        if (!image.ratios.includes(ratio as (typeof image.ratios)[number])) {
          problems.push(`${at}: tier ${tier.id} lists pixels for unsupported ratio ${ratio}`)
        }
        const [width, height] = pixels.split('x').map(Number)
        const expected = catalogRatioValue(ratio)!
        // 上游会把像素量化到 16 或 32 的倍数，允许 4% 偏差（Gemini 4:3 是 1200x896）。
        if (Math.abs(Math.log(width! / height!) - Math.log(expected)) > 0.04) {
          problems.push(`${at}: tier ${tier.id} ${ratio} pixels ${pixels} do not match the ratio`)
        }
      }
    }
    if (image.wire.kind === 'tier-token') {
      const tokenTiers = Object.keys(image.wire.tokens).sort()
      if (tokenTiers.join() !== [...tierIds].sort().join()) {
        problems.push(`${at}: wire.tokens must cover exactly its tiers`)
      }
    } else {
      for (const tier of image.tiers) {
        for (const ratio of image.ratios) {
          if (!tier.pixels[ratio]) {
            problems.push(`${at}: pixels wire needs tier ${tier.id} pixels for ratio ${ratio}`)
          }
        }
      }
    }
    for (const key of Object.keys(image.etaSeconds ?? {})) {
      if (!tierIds.includes(key as (typeof tierIds)[number])) {
        problems.push(`${at}: etaSeconds has tier ${key} that the model does not support`)
      }
    }
    const multiplier = model.pricing.tierMultiplier
    if (multiplier) {
      for (const key of Object.keys(multiplier)) {
        if (!tierIds.includes(key as (typeof tierIds)[number])) {
          problems.push(`${at}: tierMultiplier has tier ${key} that the model does not support`)
        }
      }
      if (multiplier[image.defaultTier] !== 1) {
        problems.push(`${at}: tierMultiplier of defaultTier must be 1 (it is the price-list base)`)
      }
    }
    const unverified = Object.values(model.evidence).some((one) => one?.source === 'unverified')
    if (unverified && !model.todo) problems.push(`${at}: unverified evidence needs a todo`)
  }
  return problems
}

export function parseModelCatalog(raw: unknown): ModelCatalogConfig {
  const problems = modelCatalogProblems(raw)
  if (problems.length > 0) {
    throw new Error(`model catalog config.json is invalid:\n- ${problems.join('\n- ')}`)
  }
  return raw as ModelCatalogConfig
}
