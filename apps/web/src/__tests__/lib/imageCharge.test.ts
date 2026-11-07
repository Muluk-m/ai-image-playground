import {
  clampGeminiNonMemberRequest,
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

  it('quotedGptMultiplier（含 keepMemberTier 为真而 member 为假：2.6 与 Gemini 的 highQuality 恒为 true）', () => {
    for (const model of MODELS)
      for (const request of REQUESTS)
        for (const [keep, member] of [
          [false, false],
          [false, true],
          [true, false],
          [true, true],
        ] as const)
          expect(
            quotedGptMultiplier(model, request, keep, member),
            `${model} ${JSON.stringify(request)} keep=${keep} member=${member}`,
          ).toBe(legacy.quoted(model, request, keep, member))
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

/**
 * 已知不一致，留给 4b：画布批量、分镜、改图等入口用 composerImageRate 报价，等于按会员档，
 * 非会员的 Gemini 4K 实际会被服务端收到 2K。这里钉住当前报价，4b 修正时同步改断言。
 */
describe('画布报价按会员档（4b 待修）', () => {
  it('非会员的 Gemini 4K：画布报价高于服务端实扣', () => {
    const request = { gemini_image_size: '4K' }
    expect(composerImageRate('gemini-3-pro-image', request)).toBeGreaterThan(
      preparedComposerImageRate('gemini-3-pro-image', request, false),
    )
  })
})
