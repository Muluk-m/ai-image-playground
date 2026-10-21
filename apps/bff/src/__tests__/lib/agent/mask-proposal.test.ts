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
  maskProposalTool,
} = await import('../../../lib/agent/mask-proposal')
const { maskedEditSize } = await import('../../../lib/agent/masked-input')
const { protectMaskedOutput } = await import('../../../lib/agent/masked-output')
const {
  boxAgreement,
  falSam3Body,
  falSam3Masks,
  pickMask,
  segmentProposal,
  setSegmentationProviderForTesting,
} = await import('../../../lib/agent/segmentation')
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
      segmentation: 'browser',
      model: { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare' },
      switchedFrom: { id: 'agnes-image', label: 'Agnes' },
    })
    expect(proposal.maskMediaId).toBeUndefined()
    expect(ctx.maskProposals?.has('mug')).toBe(true)
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
    await expect(run(maskProposalTool(unsaved), args)).rejects.toThrow('没有可直接引用的原件')
  })

  it('refuses originals the strict model cannot edit instead of silently downscaling', async () => {
    const tool = maskProposalTool(context({}, url(await picture(4200, 1000))))
    await expect(run(tool, args)).rejects.toThrow('不要改成整图编辑')
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

  it('returns null without a provider so the browser path takes over', async () => {
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
