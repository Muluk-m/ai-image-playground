import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type {
  AgentContentBlock,
  AgentMaskProposal,
  AgentMessageView,
} from '@image-playground/shared'
import sharp from 'sharp'
import type { AgentToolContext } from '../../../lib/agent/tools/types'

process.env.DATABASE_URL = await resetTestDatabase('agent_mask_proposal')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { _setChannelsForTesting } = await import('../../../lib/channels')
const {
  chooseMaskModel,
  confirmedMaskProposalParams,
  editMaskPng,
  maskProposalAnswer,
  maskProposalFromResult,
  MaskProposalUnavailable,
  maskProposalFailedText,
  maskProposalTool,
  seedPoints,
} = await import('../../../lib/agent/mask-proposal')
const { maskedEditSize } = await import('../../../lib/agent/masked-input')
const { protectMaskedOutput } = await import('../../../lib/agent/masked-output')
const {
  boxAgreement,
  dilationRadius,
  falSam3Body,
  falSam3Masks,
  pickMask,
  promptBox,
  segmentationProvider,
  resetSegmenterProbeForTesting,
  segmenterKey,
  segmenterSize,
  segmenterStatus,
  segmentProposal,
  setSegmentationProviderForTesting,
  setSegmenterFetchForTesting,
  shapeMask,
  unpackMaskBits,
} = await import('../../../lib/agent/segmentation')
const { config } = await import('../../../config')
const { close: closeDb } = await import('../../../db/client')

const MASK_CHANNEL = {
  id: 'openai-images',
  kind: 'openai-queue' as const,
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  auth: { type: 'bearer' as const, secretRef: 'OPENAI_API_KEY', secret: 'k' },
  allowedPaths: ['images/generations', 'images/edits'],
  models: [
    {
      id: 'gpt-image-2.5-flare',
      label: 'GPT Image 2.5 Flare',
      capabilities: ['generate' as const, 'edit' as const, 'mask' as const],
    },
    {
      id: 'agnes-image',
      label: 'Agnes',
      capabilities: ['generate' as const, 'edit' as const],
    },
  ],
  defaults: { apiMode: 'images' as const, timeout: 600 },
}

const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`

async function picture(width: number, height: number) {
  const raw = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const tone = 120 + 60 * Math.sin(x / 23) * Math.cos(y / 19)
      raw.set([tone, (tone * 0.8 + x) % 256, (tone * 0.6 + y) % 256, 255], (y * width + x) * 4)
    }
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
}

function context(overrides: Partial<AgentToolContext> = {}, dataUrl = ''): AgentToolContext {
  return {
    mode: 'image',
    conversationId: 'conversation',
    turnId: 'turn',
    userId: null,
    experience: 'chat',
    deviceId: 'device',
    maskProposals: new Set<string>(),
    images: {
      masked: false,
      references: [],
      identify: (id: string) => id,
      resolve: async (imageId: string) => ({ imageId, dataUrl }),
      resolveMany: async () => [],
      resolveMediaReferences: async (ids: readonly string[]) =>
        ids.map((imageId) => ({ imageId, mediaId: '00000000-0000-4000-8000-000000000001' })),
    } as unknown as AgentToolContext['images'],
    ...overrides,
  } as AgentToolContext
}

const args = {
  imageId: 'mug',
  target: '杯身和把手',
  segmentPrompt: 'mug',
  change: '换成米白色釉面',
  keep: ['桌面', '书'],
  box: { x: 0.2, y: 0.3, width: 0.5, height: 0.5 },
  points: [{ x: 0.45, y: 0.55, include: true }],
}

async function run(tool: { execute: (...args: never[]) => Promise<unknown> }, params: unknown) {
  return (tool.execute as (...args: unknown[]) => Promise<unknown>)(
    'call',
    params,
    undefined,
    undefined,
  )
}

beforeEach(() => {
  _setChannelsForTesting([MASK_CHANNEL])
  setSegmentationProviderForTesting(null)
})
afterAll(async () => {
  setSegmentationProviderForTesting()
  await closeDb()
})

describe('proposeEditRegion', () => {
  it('issues a mask proposal bound to the stored original and a strict mask model', async () => {
    const image = url(await picture(1024, 768))
    const ctx = context({ params: { model: 'agnes-image' } }, image)
    const result = await run(maskProposalTool(ctx), args)
    const block = maskProposalFromResult(result)
    expect(block?.question).toBe('确认修改范围：杯身和把手')
    const proposal = block!.maskProposal!
    expect(proposal).toMatchObject({
      imageId: 'mug',
      mediaId: '00000000-0000-4000-8000-000000000001',
      width: 1024,
      height: 768,
      target: '杯身和把手',
      change: '换成米白色釉面',
      keep: ['桌面', '书'],
      segmentation: 'box',
      model: { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare' },
      switchedFrom: { id: 'agnes-image', label: 'Agnes' },
    })
    expect(proposal.maskMediaId).toBeUndefined()
    expect(proposal.regions).toBeUndefined()
    expect(ctx.maskProposals?.has('mug')).toBe(true)
  })

  it('numbers similar objects left to right and keeps which ones the agent picked', async () => {
    const tool = maskProposalTool(context({}, url(await picture(1024, 768))))
    const result = await run(tool, {
      ...args,
      instances: [
        { box: { x: 0.6, y: 0.4, width: 0.2, height: 0.3 }, label: '右边的杯子', selected: true },
        { box: { x: 0.1, y: 0.4, width: 0.2, height: 0.3 }, label: '左边的杯子', selected: false },
      ],
    })
    const regions = maskProposalFromResult(result)!.maskProposal!.regions!
    expect(regions.map((one) => [one.number, one.label, one.selected])).toEqual([
      [1, '左边的杯子', false],
      [2, '右边的杯子', true],
    ])
    // 未登录、没有分割服务：区域按框画，不带蒙版。
    expect(regions.every((one) => one.maskMediaId === undefined)).toBe(true)
  })

  it('rejects similar-object lists with nothing selected or only one entry', async () => {
    const tool = maskProposalTool(context({}, url(await picture(64, 64))))
    const box = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }
    await expect(
      run(tool, {
        ...args,
        instances: [
          { box, selected: false },
          { box: { ...box, x: 0.5 }, selected: false },
        ],
      }),
    ).rejects.toThrow('至少要有一个 selected')
    await expect(run(tool, { ...args, instances: [{ box, selected: true }] })).rejects.toThrow(
      'instances 只在',
    )
  })

  it('marks a background proposal as inverted and keeps the box on the subject', async () => {
    const tool = maskProposalTool(context({}, url(await picture(1024, 768))))
    const box = { x: 0.3, y: 0.1, width: 0.4, height: 0.85 }
    const result = await run(tool, { ...args, target: '背景', box, invert: true })
    const proposal = maskProposalFromResult(result)!.maskProposal!
    expect(proposal).toMatchObject({ target: '背景', box, invert: true })
    expect(maskProposalFromResult(await run(tool, args))!.maskProposal!.invert).toBeUndefined()
  })

  it('rejects an inverted proposal that also lists similar objects', async () => {
    const tool = maskProposalTool(context({}, url(await picture(64, 64))))
    const box = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }
    await expect(
      run(tool, {
        ...args,
        invert: true,
        instances: [
          { box, selected: true },
          { box: { ...box, x: 0.5 }, selected: false },
        ],
      }),
    ).rejects.toThrow('不要同时写 instances')
  })

  it('rejects boxes in pixels, outside the image or too small', async () => {
    const tool = maskProposalTool(context({}, url(await picture(64, 64))))
    await expect(
      run(tool, { ...args, box: { x: 0.2, y: 0.2, width: 0.001, height: 0.5 } }),
    ).rejects.toThrow('外接框太小')
    await expect(
      run(tool, { ...args, box: { x: 0.8, y: 0.2, width: 0.5, height: 0.5 } }),
    ).rejects.toThrow('超出了图片范围')
    await expect(
      run(tool, { ...args, points: [{ x: 1.4, y: 0.2, include: true }] }),
    ).rejects.toThrow('提示点')
  })

  it('refuses when the turn already carries a user selection or the image has no stored original', async () => {
    const image = url(await picture(64, 64))
    const masked = context({}, image)
    ;(masked.images as { masked: boolean }).masked = true
    await expect(run(maskProposalTool(masked), args)).rejects.toThrow('已经有用户画好的选区')
    const unsaved = context({}, image)
    ;(unsaved.images as { resolveMediaReferences: unknown }).resolveMediaReferences = async () => []
    // 未登录又没有保存的原件：说清楚不可用，告诉模型别再调，也不叫用户手画。
    const refused = run(maskProposalTool(unsaved), args)
    await expect(refused).rejects.toBeInstanceOf(MaskProposalUnavailable)
    await expect(refused).rejects.toThrow('不要再调用 proposeEditRegion')
    await expect(refused).rejects.not.toThrow(/手动圈选|自己画/)
  })

  it('refuses originals the strict model cannot edit instead of silently downscaling', async () => {
    const tool = maskProposalTool(context({}, url(await picture(4200, 1000))))
    const refused = run(tool, args)
    await expect(refused).rejects.toBeInstanceOf(MaskProposalUnavailable)
    await expect(refused).rejects.toThrow('4200×1000')
  })

  it('tells the user in one sentence why the region could not be proposed', () => {
    const sized = maskProposalFailedText(
      new MaskProposalUnavailable('原图尺寸超出模型支持的局部编辑范围；原图 4200×1000').message,
    )
    expect(sized).toContain('4200×1000')
    expect(sized).toContain('没有改图')
    const generic = maskProposalFailedText('外接框太小')
    expect(generic).toContain('没有改图')
    for (const text of [sized, generic]) {
      expect(text).not.toMatch(/proposeEditRegion|手动|圈选后|自己画/)
    }
  })

  it('fails closed when no strict mask model is configured', () => {
    _setChannelsForTesting([{ ...MASK_CHANNEL, models: [MASK_CHANNEL.models[1]!] }])
    expect(() => chooseMaskModel(undefined)).toThrow('没有支持按蒙版生成的模型')
  })

  it('keeps the chosen strict model without a switch notice', () => {
    expect(chooseMaskModel('gpt-image-2.5-flare')).toEqual({
      model: { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare' },
    })
    expect(chooseMaskModel(undefined).switchedFrom).toBeUndefined()
  })
})

describe('mask proposal answer', () => {
  const proposal: AgentMaskProposal = {
    id: 'p',
    imageId: 'mug',
    mediaId: '00000000-0000-4000-8000-000000000001',
    width: 640,
    height: 480,
    target: '杯身',
    change: '换色',
    keep: [],
    box: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    segmentation: 'browser',
    model: { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare' },
  }
  const asked: AgentMessageView = {
    id: 'a',
    turnId: 't',
    role: 'assistant',
    createdAt: 1,
    content: [
      {
        type: 'clarification',
        question: '确认修改范围：杯身',
        options: [],
        maskProposal: proposal,
      },
    ] as AgentContentBlock[],
  }
  const masked = {
    imageId: 'mug',
    mediaId: proposal.mediaId,
    maskMediaId: '00000000-0000-4000-8000-000000000002',
  }

  it('treats a masked reference to the same original as the confirmation', () => {
    expect(maskProposalAnswer([asked], [masked])?.kind).toBe('confirmed')
    expect(confirmedMaskProposalParams([asked], [masked], { model: 'agnes-image', n: 2 })).toEqual({
      model: 'gpt-image-2.5-flare',
      n: 2,
      autoSubmit: true,
    })
  })

  it('makes two images by default after a confirmation and keeps a larger count', () => {
    expect(confirmedMaskProposalParams([asked], [masked], undefined)?.n).toBe(2)
    expect(confirmedMaskProposalParams([asked], [masked], { n: 1 })?.n).toBe(2)
    expect(confirmedMaskProposalParams([asked], [masked], { n: 4 })?.n).toBe(4)
  })

  it('stays pending without a mask, for another image version, or after the user moved on', () => {
    expect(maskProposalAnswer([asked], [{ imageId: 'mug', mediaId: proposal.mediaId }])?.kind).toBe(
      'pending',
    )
    expect(
      maskProposalAnswer([asked], [{ ...masked, mediaId: '00000000-0000-4000-8000-000000000009' }])
        ?.kind,
    ).toBe('pending')
    const params = { model: 'agnes-image' }
    expect(confirmedMaskProposalParams([asked], [], params)).toBe(params)
    const later: AgentMessageView = {
      ...asked,
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: '算了' }],
    }
    expect(maskProposalAnswer([asked, later], [masked])).toBeNull()
  })
})

describe('server segmentation', () => {
  const mask = (
    width: number,
    height: number,
    box: [number, number, number, number],
    score?: number,
  ) => {
    const data = new Uint8Array(width * height)
    for (let y = box[1]; y < box[3]; y++)
      for (let x = box[0]; x < box[2]; x++) data[y * width + x] = 255
    return { data, width, height, ...(score === undefined ? {} : { score }) }
  }

  it('builds the fal SAM 3 request in source pixels with include/exclude points', () => {
    const body = falSam3Body({
      dataUrl: 'data:image/png;base64,AA==',
      width: 1000,
      height: 500,
      prompt: 'mug',
      box: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
      points: [
        { x: 0.3, y: 0.4, include: true },
        { x: 0.55, y: 0.4, include: false },
      ],
    })
    expect(body.box_prompts).toEqual([{ x_min: 100, y_min: 100, x_max: 600, y_max: 300 }])
    expect(body.point_prompts).toEqual([
      { x: 300, y: 200, label: 1 },
      { x: 550, y: 200, label: 0 },
    ])
    expect(body).toMatchObject({ apply_mask: false, sync_mode: true, return_multiple_masks: true })
  })

  it('reads only inline data-URI masks and ignores remote URLs', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } })
      .png()
      .toBuffer()
    const decoded = await falSam3Masks(
      { masks: [{ url: 'https://evil.example/mask.png' }, { url: url(png) }], scores: [0.9, 0.8] },
      8,
      8,
    )
    expect(decoded).toHaveLength(1)
    expect(decoded[0]!.data.every((value) => value === 255)).toBe(true)
  })

  it('picks the confident mask that agrees with the agent box and rejects ones that do not', () => {
    const box = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }
    const right = mask(100, 100, [20, 20, 60, 60], 0.8)
    const wrong = mask(100, 100, [70, 70, 100, 100], 0.99)
    expect(boxAgreement(right, box)).toBeCloseTo(1, 5)
    expect(pickMask([wrong, right], box)).toBe(right)
    expect(pickMask([wrong], box)).toBeNull()
  })

  it('returns null without a provider so the card falls back to the agent box', async () => {
    expect(
      await segmentProposal({
        dataUrl: '',
        width: 1,
        height: 1,
        prompt: 'x',
        box: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ).toBeNull()
  })

  it('falls back quietly when the provider fails', async () => {
    setSegmentationProviderForTesting({
      id: 'broken',
      segment: async () => {
        throw new Error('down')
      },
    })
    expect(
      await segmentProposal({
        dataUrl: '',
        width: 1,
        height: 1,
        prompt: 'x',
        box: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ).toBeNull()
  })
})

describe('strict compositing at original resolution', () => {
  it('writes the upstream mask format and keeps every pixel outside the mask identical', async () => {
    // 宽于旧对话框的 1920 上限：原件按 id 引用，不再先缩小。
    const width = 2400
    const height = 1600
    expect('problem' in maskedEditSize('gpt-image-2.5-flare', width, height)).toBe(false)
    const source = await picture(width, height)
    const target = new Uint8Array(width * height)
    for (let y = 500; y < 1100; y++) for (let x = 900; x < 1500; x++) target[y * width + x] = 1
    const maskPng = await editMaskPng(target, width, height)
    const maskRaw = await sharp(maskPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(maskRaw.info).toMatchObject({ width, height })
    expect(maskRaw.data[(600 * width + 1000) * 4 + 3]).toBe(0)
    expect(maskRaw.data[(10 * width + 10) * 4 + 3]).toBe(255)

    // 候选：圈内整块换色，圈外加一层轻微噪声（模型重编码时常见）。
    const sourceRaw = await sharp(source).raw().toBuffer()
    const candidate = Buffer.from(sourceRaw)
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = pixel * 4
      if (target[pixel]) candidate.set([235, 228, 210, 255], offset)
      else candidate[offset] = Math.min(255, candidate[offset]! + (pixel % 3 === 0 ? 1 : 0))
    }
    const protect = await protectMaskedOutput(url(source), url(maskPng))
    const result = await protect(
      await sharp(candidate, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer(),
    )
    const output = await sharp(result.bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(output.info).toMatchObject({ width, height })
    let outsideChanged = 0
    let insideChanged = 0
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = pixel * 4
      const same = sourceRaw
        .subarray(offset, offset + 4)
        .equals(output.data.subarray(offset, offset + 4))
      if (target[pixel]) insideChanged += same ? 0 : 1
      else outsideChanged += same ? 0 : 1
    }
    expect(outsideChanged).toBe(0)
    expect(insideChanged).toBeGreaterThan(0.9 * 600 * 600)
  }, 60_000)
})

describe('EdgeTAM segmenter', () => {
  const segmentation = config.agent.segmentation as { segmenterUrl: string; provider: string }
  const original = { ...segmentation }
  const pack = (mask: Uint8Array) => {
    const bits = new Uint8Array(Math.ceil(mask.length / 8))
    for (let i = 0; i < mask.length; i++) if (mask[i]) bits[i >> 3]! |= 0x80 >> (i & 7)
    return Buffer.from(bits).toString('base64')
  }
  const square = (width: number, height: number, box: [number, number, number, number]) => {
    const data = new Uint8Array(width * height)
    for (let y = box[1]; y < box[3]; y++)
      for (let x = box[0]; x < box[2]; x++) data[y * width + x] = 1
    return data
  }

  beforeEach(() => {
    setSegmentationProviderForTesting()
    segmentation.segmenterUrl = 'http://segmenter:8080'
    segmentation.provider = 'fal-sam3'
  })
  afterAll(() => {
    Object.assign(segmentation, original)
    setSegmenterFetchForTesting()
  })

  it('prefers the in-house segmenter and honours off', () => {
    expect(segmentationProvider()?.id).toBe('edgetam')
    segmentation.provider = 'off'
    expect(segmentationProvider()).toBeNull()
  })

  it('sizes requests to a 1024 long edge and unpacks MSB-first bits', () => {
    expect(segmenterSize(2048, 1536)).toEqual({ width: 1024, height: 768 })
    expect(segmenterSize(640, 480)).toEqual({ width: 640, height: 480 })
    expect([...unpackMaskBits(new Uint8Array([0b1010_0000, 0b1000_0000]), 3, 3)]).toEqual([
      255, 0, 255, 0, 0, 0, 0, 0, 255,
    ])
  })

  it('asks by cache key first, resends a reduced image on 404 and returns the box-agreeing mask', async () => {
    const source = url(await picture(2048, 1024))
    const calls: Record<string, unknown>[] = []
    setSegmenterFetchForTesting((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      calls.push(body)
      if (!body.image) return Response.json({ error: 'image_required' }, { status: 404 })
      const right = square(1024, 512, [256, 128, 512, 384])
      const wrong = square(1024, 512, [800, 0, 1024, 100])
      return Response.json({
        width: 1024,
        height: 512,
        masks: [
          { score: 0.99, bits: pack(wrong) },
          { score: 0.8, bits: pack(right) },
        ],
      })
    }) as unknown as typeof fetch)
    const loaded: string[] = []
    const result = await segmentProposal({
      key: 'media:abc',
      loadDataUrl: async () => {
        loaded.push('read')
        return source
      },
      width: 2048,
      height: 1024,
      prompt: 'mug',
      box: { x: 0.25, y: 0.25, width: 0.25, height: 0.5 },
      points: [{ x: 0.3, y: 0.5, include: true }],
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      key: 'media:abc',
      box: [0.25, 0.25, 0.5, 0.75],
      points: [[0.3, 0.5, 1]],
      output: { width: 1024, height: 512 },
    })
    expect(calls[0]!.image).toBeUndefined()
    const sent = await sharp(Buffer.from(String(calls[1]!.image), 'base64')).metadata()
    expect([sent.format, sent.width, sent.height]).toEqual(['jpeg', 1024, 512])
    expect(loaded).toEqual(['read'])
    expect(result?.provider).toBe('edgetam')
    const mask = result!.mask
    expect([mask.width, mask.height]).toEqual([2048, 1024])
    // 放大回原图，再外扩 8px（长边 2048）。
    const at = (x: number, y: number) => mask.data[y * 2048 + x]
    expect(at(600, 400)).toBe(255)
    expect(at(512 - 7, 400)).toBe(255)
    expect(at(512 - 12, 400)).toBe(0)
    expect(at(1700, 50)).toBe(0)
  })

  it('does not read the original when the segmenter already cached it', async () => {
    setSegmenterFetchForTesting((async () =>
      Response.json({
        width: 64,
        height: 64,
        masks: [{ score: 0.9, bits: pack(square(64, 64, [16, 16, 48, 48])) }],
      })) as unknown as typeof fetch)
    const result = await segmentProposal({
      key: 'media:abc',
      loadDataUrl: async () => {
        throw new Error('should not read the original')
      },
      width: 64,
      height: 64,
      prompt: 'x',
      box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    })
    expect(result?.mask.data[32 * 64 + 32]).toBe(255)
  })

  it('gives up after the 3 s budget so the card keeps the agent box', async () => {
    setSegmenterFetchForTesting(
      ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        )) as unknown as typeof fetch,
    )
    const startedAt = Date.now()
    const result = await segmentProposal({
      key: 'media:slow',
      dataUrl: url(await picture(32, 32)),
      width: 32,
      height: 32,
      prompt: 'x',
      box: { x: 0, y: 0, width: 1, height: 1 },
    })
    expect(result).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(4_500)
  }, 10_000)

  it('dilates 4–8 px with the image size and grows the box to points clicked outside it', async () => {
    expect(dilationRadius(512, 512)).toBe(4)
    expect(dilationRadius(1536, 1024)).toBe(6)
    expect(dilationRadius(4096, 4096)).toBe(8)
    const shaped = await shapeMask(
      { data: square(40, 40, [10, 10, 30, 30]).map((v) => v * 255), width: 40, height: 40 },
      40,
      40,
      4,
    )
    expect(shaped.data[20 * 40 + 6]).toBe(255)
    expect(shaped.data[20 * 40 + 4]).toBe(0)
    expect(
      promptBox({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, [
        { x: 0.9, y: 0.5, include: true },
        { x: 0.1, y: 0.1, include: false },
      ]),
    ).toEqual({ x: 0.4, y: 0.4, width: expect.closeTo(0.52, 5), height: expect.closeTo(0.2, 5) })
  })

  it('reports the segmenter state and probes at most once per window', async () => {
    resetSegmenterProbeForTesting()
    const paths: string[] = []
    setSegmenterFetchForTesting((async (url: string, init?: RequestInit) => {
      paths.push(new URL(url).pathname)
      if (url.endsWith('/health'))
        return Response.json({ ok: true, loaded: true, dtype: 'fp16', rssMB: 360, version: 'v' })
      const body = JSON.parse(String(init?.body)) as { image?: string }
      return Response.json({ masks: [], timings: { cached: !body.image } })
    }) as unknown as typeof fetch)
    expect(await segmenterStatus(false)).toMatchObject({ configured: true, ok: true, rssMB: 360 })
    const probed = (await segmenterStatus(true)) as { probe?: { firstMs: number } }
    expect(probed.probe?.firstMs).toBeGreaterThanOrEqual(0)
    await segmenterStatus(true)
    expect(paths.filter((one) => one === '/v1/segment')).toHaveLength(2)
    segmentation.segmenterUrl = ''
    expect(await segmenterStatus(true)).toEqual({ configured: false })
  })

  it("keeps each deployment's cache keys apart on the shared segmenter", () => {
    const settings = config.agent.segmentation as { segmenterNamespace: string }
    expect(segmenterKey('m1')).toBe('media:m1')
    settings.segmenterNamespace = 'image-playground-test'
    expect(segmenterKey('m1')).toBe('image-playground-test:media:m1')
    settings.segmenterNamespace = ''
  })

  it("lets a click override the agent's point right next to it", () => {
    const agent = [
      { x: 0.5, y: 0.6, include: true },
      { x: 0.88, y: 0.56, include: true },
    ]
    expect(seedPoints(agent, [{ x: 0.9, y: 0.56, include: false }])).toEqual([
      { x: 0.5, y: 0.6, include: true },
      { x: 0.9, y: 0.56, include: false },
    ])
    expect(seedPoints(undefined, [])).toEqual([])
  })
})
