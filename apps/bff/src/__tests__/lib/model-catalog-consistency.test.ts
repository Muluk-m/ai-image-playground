import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  GEMINI_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_THINKING_LEVELS,
  IMAGE_PRESET_RATIOS,
  IMAGE_SIZE_PRESETS,
  QUEUE_MAX_INPUT_IMAGES,
} from '@image-playground/shared'
import { findCatalogModel, MODEL_CATALOG } from '@image-playground/shared/model-catalog'
import { defaultChannelsPath } from '../../lib/channels'
import type { HydratedSubmitRequest } from '../../lib/imageArchive'
import { buildGrokImagine2Body, GROK_IMAGINE_2_MAX_INPUTS } from '../../lib/upstream/grok'

/**
 * 能力目录（packages/shared/src/model-catalog/config.json）与现有代码的行为要一致：PR-1 只登记事实，
 * 不改线上行为。这里任何一条失败，说明有人改了一边没改另一边。
 */

interface RawModel {
  id: string
  media?: 'image' | 'video'
  capabilities: string[]
}
interface RawChannel {
  id: string
  kind: string
  models: RawModel[]
}

const channels: RawChannel[] = JSON.parse(readFileSync(defaultChannelsPath(), 'utf8')).channels
const imageModels = channels.flatMap((channel) =>
  channel.models
    .filter((model) => (model.media ?? 'image') === 'image')
    .map((model) => ({ channel, model })),
)

function grokBody(fields: Partial<HydratedSubmitRequest>) {
  return buildGrokImagine2Body('grok-imagine-image-2.0', {
    prompt: 'x',
    ...fields,
  } as HydratedSubmitRequest)
}

describe('model catalog vs channels.json', () => {
  it('has an entry for every image model in channels.json', () => {
    expect(imageModels.length).toBeGreaterThan(0)
    for (const { model } of imageModels) expect(findCatalogModel(model.id)?.id).toBe(model.id)
  })

  for (const { channel, model } of imageModels) {
    describe(model.id, () => {
      const image = () => findCatalogModel(model.id)!.image

      it('declares the same operations', () => {
        const expected = model.capabilities
          .filter((one) => one === 'generate' || one === 'edit' || one === 'mask')
          .map((one) => (one === 'mask' ? 'mask_edit' : one))
        expect([...image().operations].sort()).toEqual(expected.sort())
      })

      it("singleTask follows the 'n' capability", () => {
        expect(image().count.singleTask).toBe(model.capabilities.includes('n'))
      })

      it("injects the ratio into the prompt exactly when 'size' is not declared", () => {
        // apps/web/src/lib/api.ts 与 agent/prompt-shaping.ts：没有 size 能力就写构图指令。
        expect(image().ratioVia.includes('prompt')).toBe(!model.capabilities.includes('size'))
      })

      it('direct surface offers what ParamControls offers today', () => {
        // ParamControls：Gemini 协议给 GEMINI_ASPECT_RATIOS、没有自定义；其余给 PRESET_RATIOS + 自定义。
        const gemini = channel.kind === 'gemini-queue'
        const direct = image().surfaces.direct
        const expected = gemini ? GEMINI_ASPECT_RATIOS : IMAGE_PRESET_RATIOS
        expect([...direct.ratios].sort()).toEqual([...expected].sort())
        expect(direct.customSize).toBe(!gemini)
      })

      it('stays within the queue reference-image cap', () => {
        expect(image().references.max).toBeLessThanOrEqual(QUEUE_MAX_INPUT_IMAGES)
      })
    })
  }
})

describe('model catalog vs current code paths', () => {
  it("models without the 'size' capability expose a single tier (no resolution picker today)", () => {
    for (const { model } of imageModels) {
      const image = findCatalogModel(model.id)!.image
      if (model.capabilities.includes('size') || image.wire.kind === 'tier-token') continue
      expect(image.tiers.map((one) => one.id)).toEqual(['1K'])
    }
  })

  it('Gemini gateway tiers, ratios and thinking match image-parameters.ts', () => {
    const image = findCatalogModel('gemini-3.1-flash-image')!.image
    expect(image.tiers.map((one) => one.id)).toEqual([...GEMINI_IMAGE_SIZES])
    expect(image.thinking?.levels).toEqual([...GEMINI_THINKING_LEVELS])
    for (const ratio of image.ratios) expect(GEMINI_ASPECT_RATIOS).toContain(ratio)
  })

  it('Grok tier tokens are the resolution values grok.ts sends today', () => {
    const image = findCatalogModel('grok-imagine-image-2.0')!.image
    expect(image.wire).toMatchObject({ kind: 'tier-token', param: 'resolution' })
    const tokens = image.wire.kind === 'tier-token' ? image.wire.tokens : {}
    expect(grokBody({ quality: 'low' }).resolution).toBe(tokens['1K'])
    expect(grokBody({ quality: 'high' }).resolution).toBe(tokens['2K'])
  })

  it('Grok ratios survive grok.ts aspect-ratio mapping unchanged', () => {
    const image = findCatalogModel('grok-imagine-image-2.0')!.image
    const presets: Readonly<Record<string, string>> = IMAGE_SIZE_PRESETS['1K']
    for (const ratio of image.ratios) {
      expect(presets[ratio]).toBeDefined()
      expect(grokBody({ size: presets[ratio] }).aspect_ratio).toBe(ratio)
    }
  })

  it('Grok reference cap matches grok.ts', () => {
    expect(findCatalogModel('grok-imagine-image-2.0')!.image.references.max).toBe(
      GROK_IMAGINE_2_MAX_INPUTS,
    )
  })

  it('only describes image models (video stays in VIDEO_MODEL_SUPPORT for now)', () => {
    const videoIds = new Set(
      channels.flatMap((c) => c.models.filter((m) => m.media === 'video').map((m) => m.id)),
    )
    for (const spec of MODEL_CATALOG) expect(videoIds.has(spec.id)).toBe(false)
  })
})
