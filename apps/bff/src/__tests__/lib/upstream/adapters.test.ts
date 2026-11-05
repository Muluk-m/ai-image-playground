import { describe, expect, it } from 'bun:test'
import { PROMPT_REWRITE_GUARD_PREFIX } from '@image-playground/shared'
import { FormData } from 'undici'
import { extractMeta } from '../../../lib/extractImages'
import {
  agnesAdapter,
  geminiAdapter,
  grokAdapter,
  openaiImagesDirect,
  openaiImagesSub2api,
  openaiResponsesAdapter,
  stampReceipt,
} from '../../../lib/upstream/adapters'
import type { RouteContext } from '../../../lib/upstream/adapters/types'
import { mergeOpenAIImageResults } from '../../../lib/upstream/openai'

const TINY_PNG = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='}`

const member: RouteContext = { member: true, directOn: true }
const guest: RouteContext = { member: false, directOn: false }

describe('image adapters plan platform requests into upstream calls', () => {
  it('direct text-to-image n=4 is one native request', () => {
    const plan = openaiImagesDirect.plan(
      { prompt: 'a cat', resolution: '1K', ratio: '1:1', count: 4, quality: 'medium' },
      'gpt-image-2.5-flare',
      { ...member, supportsNativeN: true, gptRoute: 'direct' },
    )
    expect(plan.calls).toHaveLength(1)
    expect(plan.calls[0]).toMatchObject({
      method: 'POST',
      path: '/images/generations',
      images: 4,
    })
    expect(plan.calls[0]!.multipart).toBeUndefined()
    expect(plan.calls[0]!.body).toEqual({
      model: 'gpt-image-2.5-flare',
      prompt: 'a cat',
      size: '1024x1024',
      quality: 'medium',
      n: 4,
    })
    expect(plan.dropped).toEqual([])
    expect(plan.applied).toMatchObject({ size: '1024x1024', quality: 'medium', n: 4 })
  })

  it('does not strip a guard that the caller already left on the queue request', () => {
    const prompt = `${PROMPT_REWRITE_GUARD_PREFIX}\na cat`
    const plan = openaiImagesDirect.plan({ prompt: 'unused', count: 1 }, 'gpt-image-2.5-flare', {
      ...member,
      supportsNativeN: true,
      gptRoute: 'direct',
      request: { prompt, size: '1024x1024', quality: 'medium' },
    })
    expect(plan.calls[0]!.body).toMatchObject({ prompt, quality: 'medium', size: '1024x1024' })
  })

  it('direct edit n=3 fans out into three multipart calls and does not send n', () => {
    const plan = openaiImagesDirect.plan(
      {
        prompt: 'make it blue',
        resolution: '1K',
        ratio: '1:1',
        count: 3,
        quality: 'medium',
        references: [TINY_PNG],
      },
      'gpt-image-2.5-flare',
      { ...member, supportsNativeN: true, gptRoute: 'direct' },
    )
    expect(plan.calls).toHaveLength(3)
    for (const call of plan.calls) {
      expect(call).toMatchObject({
        method: 'POST',
        path: '/images/edits',
        multipart: true,
        images: 1,
      })
      expect(call.body).toBeInstanceOf(FormData)
      const form = call.body as FormData
      expect(form.get('model')).toBe('gpt-image-2.5-flare')
      expect(form.get('prompt')).toBe('make it blue')
      expect(form.get('size')).toBe('1024x1024')
      expect(form.get('quality')).toBe('medium')
      expect(form.get('n')).toBeNull()
    }
    expect(plan.freshBody?.()).toBeInstanceOf(FormData)
  })

  it('sub2api 2K request records size as dropped and still sends the current body', () => {
    const plan = openaiImagesSub2api.plan(
      { prompt: 'a cat', resolution: '2K', ratio: '1:1', count: 1, quality: 'medium' },
      'gpt-image-2.5-flare',
      { ...guest, supportsNativeN: false, gptRoute: 'sub2api' },
    )
    expect(plan.dropped).toEqual([
      { param: 'size', reason: 'sub2api 不兑现 size，构图只写在提示词里' },
      { param: 'quality', reason: 'sub2api 不兑现 quality，不把它记成生效画质' },
    ])
    expect(plan.applied).not.toHaveProperty('size')
    expect(plan.applied).not.toHaveProperty('quality')
    expect(plan.calls).toHaveLength(1)
    // 线协议不变：网关忽略 size，请求体里仍然带着它。
    expect(plan.calls[0]!.body).toEqual({
      model: 'gpt-image-2.5-flare',
      prompt: 'a cat\n\nComposition: a 1:1 square frame.',
      size: '2048x2048',
      quality: 'medium',
      n: 1,
    })
  })

  it('keeps native n for a non-GPT OpenAI-compatible model when the channel declares it', () => {
    const plan = openaiImagesSub2api.plan(
      { prompt: 'a cat', count: 3 },
      'custom-image-model',
      { ...guest, supportsNativeN: true },
    )
    expect(plan.calls).toHaveLength(1)
    expect(plan.calls[0]).toMatchObject({ images: 3 })
    expect(plan.calls[0]!.body).toMatchObject({ model: 'custom-image-model', n: 3 })
  })

  it('vertex n=2 is two calls and never sends candidateCount', () => {
    const plan = geminiAdapter.plan(
      { prompt: 'a cup', resolution: '1K', ratio: '1:1', count: 2 },
      'gemini-nano-banana-2.1',
      { ...guest, vertex: true, imageSizes: ['1K', '2K'] },
    )
    expect(plan.calls).toHaveLength(2)
    for (const call of plan.calls) {
      expect(call.path).toBe('/models/gemini-nano-banana-2.1:generateContent')
      expect(call.images).toBe(1)
      expect(JSON.stringify(call.body)).not.toContain('candidateCount')
    }
    expect(plan.calls[0]!.body).toMatchObject({
      generationConfig: { imageConfig: { aspectRatio: '1:1', imageSize: '1K' } },
    })
    expect(plan.dropped).toEqual([])
  })

  it('gemini 4K is downgraded when that tier is not open', () => {
    const plan = geminiAdapter.plan(
      { prompt: 'a cup', resolution: '4K', ratio: '16:9', count: 1 },
      'gemini-3-pro-image',
      { ...member, vertex: true, imageSizes: ['1K', '2K'] },
    )
    expect(plan.calls).toHaveLength(1)
    expect(plan.calls[0]!.body).toMatchObject({
      generationConfig: { imageConfig: { aspectRatio: '16:9', imageSize: '2K' } },
    })
    expect(JSON.stringify(plan.calls[0]!.body)).not.toContain('candidateCount')
    expect(plan.dropped).toEqual([{ param: 'image_size', reason: '模型未开放 4K，已降到 2K' }])
    expect(plan.applied).toMatchObject({ image_size: '2K', aspect_ratio: '16:9', n: 1 })
    expect(geminiAdapter.capabilities('gemini-3-pro-image', member).tiers).toEqual(['1K', '2K'])
    expect(geminiAdapter.capabilities('gemini-3-pro-image', member).memberTiers).toEqual(['4K'])
  })

  it('grok 2.0 maps a 16:9 size into aspect_ratio and fans out count', () => {
    const plan = grokAdapter.plan(
      { prompt: 'a cat', resolution: '1K', ratio: '16:9', count: 2, quality: 'low' },
      'grok-imagine-image-2.0',
      guest,
    )
    expect(plan.calls).toHaveLength(2)
    expect(plan.calls[0]).toMatchObject({ path: '/images/generations', images: 1 })
    expect(plan.calls[0]!.body).toMatchObject({
      model: 'grok-imagine-image-2.0',
      aspect_ratio: '16:9',
      quality: 'low',
      resolution: '1k',
    })
    expect(plan.calls[0]!.body).not.toHaveProperty('n')
    expect(plan.calls[0]!.body).not.toHaveProperty('size')
  })

  it('agnes fans out generations and rejects a mask before any call', () => {
    const plan = agnesAdapter.plan(
      { prompt: 'a star', resolution: '1K', ratio: '1:1', count: 2 },
      'agnes-image-2.5-flash',
      guest,
    )
    expect(plan.calls).toHaveLength(2)
    expect(plan.calls[0]!.path).toBe('/images/generations')
    expect(plan.calls[0]!.body).toMatchObject({
      model: 'agnes-image-2.5-flash',
      prompt: 'a star',
      size: '1024x1024',
    })
    expect(plan.calls[0]!.body).not.toHaveProperty('n')
    expect(() =>
      agnesAdapter.plan(
        { prompt: 'edit', count: 1, references: [TINY_PNG], mask: TINY_PNG },
        'agnes-image-2.5-flash',
        guest,
      ),
    ).toThrow(/遮罩/)
  })

  it('responses bridge fans out and does not put n on the image tool', () => {
    const plan = openaiResponsesAdapter.plan(
      { prompt: 'a cat', resolution: '1K', ratio: '1:1', count: 2, quality: 'low' },
      'gpt-image-2',
      { ...guest, gptRoute: 'sub2api', imageResponsesModel: 'gpt-6-astra' },
    )
    expect(plan.calls).toHaveLength(2)
    expect(plan.calls[0]).toMatchObject({ path: '/responses', images: 1 })
    const body = plan.calls[0]!.body as {
      model: string
      tools: Array<{ model: string; n?: number; size?: string }>
    }
    expect(body.model).toBe('gpt-6-astra')
    expect(body.tools[0]).toMatchObject({ model: 'gpt-image-2', size: '1024x1024' })
    expect(body.tools[0]!.n).toBeUndefined()
    expect(plan.dropped.map((one) => one.param)).toEqual(['size', 'quality'])
  })
})

describe('fan-out keeps the parameter receipt', () => {
  it('keeps echoed size and attaches the plan after merge', () => {
    const merged = mergeOpenAIImageResults([
      {
        payload: {
          created: 1,
          size: '1024x1024',
          quality: 'medium',
          output_format: 'png',
          data: [{ b64_json: 'a' }],
        },
      },
      { payload: { size: '1024x1024', data: [{ b64_json: 'b' }] } },
    ])
    const stamped = stampReceipt(merged, {
      calls: [],
      applied: { size: '2048x2048', quality: 'high', n: 2 },
      dropped: [],
    })
    expect(stamped.payload).toMatchObject({
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
      applied: { size: '2048x2048', quality: 'high', n: 2 },
      dropped: [],
    })
    expect(stamped.payload).not.toHaveProperty('created')
    expect(extractMeta('openai-compat', stamped.payload).actual_params).toEqual({
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    })
  })

  it('fills actual params from the plan when the upstream echo is missing', () => {
    const merged = mergeOpenAIImageResults([
      { payload: { data: [{ b64_json: 'a' }] } },
      { payload: { data: [{ b64_json: 'b' }] } },
    ])
    const stamped = stampReceipt(merged, {
      calls: [],
      applied: { size: '1024x1024', quality: 'medium', output_format: 'png', n: 2 },
      dropped: [{ param: 'size', reason: 'ignored' }],
    })
    expect(extractMeta('openai-compat', stamped.payload).actual_params).toEqual({
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    })
    expect(stamped.payload).toMatchObject({
      dropped: [{ param: 'size', reason: 'ignored' }],
    })
  })
})

describe('adapter capabilities are the membership source for channel tiers', () => {
  it('marks only 4K as member-only and hides size on sub2api', () => {
    const direct = openaiImagesDirect.capabilities('gpt-image-2.5-flare', member)
    const gateway = openaiImagesSub2api.capabilities('gpt-image-2.5-flare', guest)
    expect(direct.memberTiers).toEqual(['4K'])
    expect(direct.honorsSize).toBe(true)
    expect(direct.nativeCount).toEqual({ generate: true, edit: false })
    expect(direct.promptGuard).toBe('none')
    expect(gateway.honorsSize).toBe(false)
    expect(gateway.nativeCount).toEqual({ generate: false, edit: false })
    expect(gateway.promptGuard).toBe('prefix')
    expect(gateway.memberTiers).toEqual(['4K'])
  })
})
