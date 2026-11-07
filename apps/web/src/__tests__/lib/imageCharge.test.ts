import {
  type ImageRateRequest,
  imageRateMultiplier,
  preparedImageRateMultiplier,
  resolveImageTier,
} from '@image-playground/shared'
import { describe, expect, it, vi } from 'vitest'
import { quotedGptMultiplier } from '../../lib/gptQuote'
import {
  composerImageRate,
  preparedComposerImageRate,
  preparedComposerNeedsMembership,
} from '../../lib/imageCharge'

const channels = vi.hoisted(() => ({
  list: [
    {
      id: 'vertex-images',
      models: [
        { id: 'gemini-nano-banana-2.1', imageSizes: ['1K', '2K'] },
        { id: 'gemini-3-pro-image', imageSizes: ['1K', '2K', '4K'] },
      ],
    },
    { id: 'openai-images', models: [{ id: 'gpt-image-2.5-flare' }, { id: 'gpt-image-2.6-flare' }] },
  ],
}))
vi.mock('../../lib/channels/publicChannels', () => ({
  getPublicChannels: () => channels.list,
}))

const MODELS = [
  'gpt-image-2.5-flare',
  'gpt-image-2.6-flare',
  'gemini-nano-banana-2.1',
  'gemini-3-pro-image',
  'unknown-model',
]
const REQUESTS: Array<ImageRateRequest | null | undefined> = [
  null,
  undefined,
  {},
  { size: '1024x1024' },
  { size: '2048x2048', quality: 'high' },
  { size: '3840x2160', quality: 'high' },
  { size: '3840x2160', quality: 'low' },
  { size: '1024x1024', quality: 'high' },
  { image_size: '1K' },
  { image_size: '2K' },
  { image_size: '4K' },
  { gemini_image_size: '4K' },
  { mask: true, size: '3840x2160', quality: 'high' },
  { input_images: ['a', 'b'], size: '1024x1024' },
  { output_format: 'gif', frame_count: 12, size: '768x768' },
  { output_format: 'svg' },
]

function declared(model: string): readonly string[] | undefined {
  for (const channel of channels.list) {
    const found = channel.models.find((one) => one.id === model) as
      | { imageSizes?: string[] }
      | undefined
    if (found?.imageSizes?.length) return found.imageSizes
  }
  return undefined
}

/** Independent baseline for the resolved public pricing paths. */
const legacy = {
  composer: (model: string, request: ImageRateRequest | null | undefined) =>
    imageRateMultiplier(model, request, declared(model)),
  prepared: (model: string, request: ImageRateRequest | null | undefined, member: boolean) =>
    preparedImageRateMultiplier(model, request, declared(model), member),
  quoted: (
    model: string,
    request: ImageRateRequest | null | undefined,
    keepMemberTier: boolean,
    member: boolean,
  ) =>
    keepMemberTier
      ? composerImageRate(model, request, member)
      : preparedComposerImageRate(model, request, member),
}

describe('前端报价与旧实现逐项等价', () => {
  it('composerImageRate matches the member direct path', () => {
    for (const model of MODELS)
      for (const request of REQUESTS)
        expect(composerImageRate(model, request, true), `${model} ${JSON.stringify(request)}`).toBe(
          legacy.composer(model, request),
        )
  })

  it('preparedComposerImageRate', () => {
    for (const model of MODELS)
      for (const request of REQUESTS)
        for (const member of [false, true])
          expect(
            preparedComposerImageRate(model, request, member),
            `${model} ${JSON.stringify(request)} member=${member}`,
          ).toBe(legacy.prepared(model, request, member))
  })

  it('does not query membership for an undeclared Gemini 4K tier', () => {
    expect(preparedComposerNeedsMembership('gemini-unknown-image', { image_size: '4K' })).toBe(
      false,
    )
    expect(preparedComposerNeedsMembership('gpt-image-2.6-flare', { size: '3840x2160' })).toBe(true)
  })

  it('direct quotes use the actual member bit', () => {
    expect(quotedGptMultiplier('gemini-3-pro-image', { image_size: '4K' }, true, false)).toBe(1)
    expect(quotedGptMultiplier('gemini-3-pro-image', { image_size: '4K' }, true, true)).toBe(1.8)
    expect(
      quotedGptMultiplier(
        'gpt-image-2.5-flare',
        { size: '3840x2160', quality: 'high' },
        true,
        false,
      ),
    ).toBe(2)
    expect(
      quotedGptMultiplier(
        'gpt-image-2.5-flare',
        { size: '3840x2160', quality: 'high' },
        true,
        true,
      ),
    ).toBe(8)
  })

  it('stage / batch / look 与 agent 入口的收口策略一致（前端 prepared 报价固定按 agent 算）', () => {
    for (const model of MODELS)
      for (const request of REQUESTS) {
        if (!request) continue
        for (const member of [false, true]) {
          const base = {
            model,
            provider: model.startsWith('gpt-') ? 'openai-compat' : 'gemini',
            request,
            member,
            directAvailable: true,
            supportedTiers: declared(model),
          }
          const agent = resolveImageTier({ ...base, entry: 'agent' })
          for (const entry of ['stage', 'batch', 'look'] as const)
            expect(resolveImageTier({ ...base, entry }), `${entry} ${model}`).toEqual(agent)
        }
      }
  })
})

describe('画布报价与服务端实扣一致', () => {
  it('非会员的 Gemini 4K 按 2K 报价，会员按 4K 报价', () => {
    const request = { gemini_image_size: '4K' }
    expect(composerImageRate('gemini-3-pro-image', request, false)).toBe(1)
    expect(composerImageRate('gemini-3-pro-image', request, true)).toBe(1.8)
  })

  it('Image 2.6 4K remains membership-gated although 2K and 4K cost the same', () => {
    expect(preparedComposerNeedsMembership('gpt-image-2.6-flare', { size: '3840x2160' })).toBe(true)
  })
})
