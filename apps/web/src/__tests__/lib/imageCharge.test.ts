import {
  clampGeminiNonMemberRequest,
  type ImageRateRequest,
  imageRateMultiplier,
  preparedImageRateMultiplier,
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

/** 改成走 resolveImageTier 之前的实现，作为等价基准。 */
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
  ) => {
    const effective = request ? clampGeminiNonMemberRequest(request, member) : request
    return keepMemberTier
      ? imageRateMultiplier(model, effective, declared(model))
      : preparedImageRateMultiplier(model, effective, declared(model), member)
  },
}

describe('前端报价与旧实现逐项等价', () => {
  it('composerImageRate', () => {
    for (const model of MODELS)
      for (const request of REQUESTS)
        expect(composerImageRate(model, request), `${model} ${JSON.stringify(request)}`).toBe(
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

  it('preparedComposerNeedsMembership', () => {
    for (const model of MODELS)
      for (const request of REQUESTS)
        expect(preparedComposerNeedsMembership(model, request)).toBe(
          legacy.prepared(model, request, false) !== legacy.prepared(model, request, true),
        )
  })

  it('quotedGptMultiplier（keepMemberTier 为真时必为会员：直连开着且是会员）', () => {
    for (const model of MODELS)
      for (const request of REQUESTS)
        for (const [keep, member] of [
          [false, false],
          [false, true],
          [true, true],
        ] as const)
          expect(
            quotedGptMultiplier(model, request, keep, member),
            `${model} ${JSON.stringify(request)} keep=${keep} member=${member}`,
          ).toBe(legacy.quoted(model, request, keep, member))
  })
})
