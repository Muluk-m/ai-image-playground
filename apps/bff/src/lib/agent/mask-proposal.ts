import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentClarificationBlock,
  AgentMaskPromptPoint,
  AgentMaskProposal,
  AgentMessageView,
  AgentNormalizedBox,
  AgentTurnParams,
  AgentTurnReference,
} from '@image-playground/shared'
import sharp from 'sharp'
import { Type } from 'typebox'
import { modelLabel, resolveQueueModel, strictMaskModels } from '../channels'
import { storeMedia } from '../projectMedia'
import { addConversationMediaClaims } from './images'
import { maskedEditSize } from './masked-input'
import { segmentProposal } from './segmentation'
import { asPiTool, piToolResult } from './tools/adapter'
import { AgentToolError } from './tools/errors'
import type { AgentToolContext } from './tools/types'
import { visualPixelLimit } from './visual-resources'

export const AGENT_MASK_PROPOSAL_TOOL = 'proposeEditRegion'

/** 框太小就不是「一个对象」了，多半是模型把坐标写成了像素或写反了。 */
const MIN_BOX_SIDE = 0.01
const EPSILON = 1e-6

const unit = (description: string) => Type.Number({ minimum: 0, maximum: 1, description })

const parameters = Type.Object({
  imageId: Type.String({
    description: '要改的那张图的真实图片 id（用户引用、会话图片或本轮产物）。一次只提一张。',
  }),
  target: Type.String({
    minLength: 1,
    maxLength: 40,
    description: '要改的对象，名词短语，用用户的语言，例如「杯身和把手」。只写对象，不写动作。',
  }),
  segmentPrompt: Type.String({
    minLength: 1,
    maxLength: 60,
    description: '给分割模型的英文短名词，只写对象类别，例如 "mug" 或 "left shoe"。',
  }),
  change: Type.String({
    minLength: 1,
    maxLength: 120,
    description: '要改成什么，照用户原话压成一句，例如「换成米白色釉面」。不要替他加没说过的属性。',
  }),
  keep: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 24 }), {
      maxItems: 4,
      description: '用户明确或显然不想动的东西，至多 4 项，例如「桌面」「书」。',
    }),
  ),
  box: Type.Object(
    {
      x: unit('外接框左上角 x，按原图宽度归一化到 0–1'),
      y: unit('外接框左上角 y，按原图高度归一化到 0–1'),
      width: unit('外接框宽度，0–1'),
      height: unit('外接框高度，0–1'),
    },
    {
      description: '把要改的全部部分框进去的外接框（略宽于对象），坐标按原图归一化，原点在左上。',
    },
  ),
  points: Type.Optional(
    Type.Array(
      Type.Object({
        x: unit('点的 x，0–1'),
        y: unit('点的 y，0–1'),
        include: Type.Boolean({
          description: 'true 表示落在要改的对象上，false 表示明确不改的地方',
        }),
      }),
      {
        maxItems: 8,
        description:
          '可选的提示点：至少一个落在目标上最有代表性的位置；对象挨着不想改的东西时，在那里放一个 include=false 的点。',
      },
    ),
  ),
})

interface MaskProposalDetails {
  readonly clarification: AgentClarificationBlock
}

function cleanBox(box: AgentNormalizedBox): AgentNormalizedBox {
  const values = [box.x, box.y, box.width, box.height]
  if (!values.every((value) => Number.isFinite(value)))
    throw new AgentToolError('invalid_params', '外接框坐标要是 0–1 之间的数')
  if (box.width < MIN_BOX_SIDE || box.height < MIN_BOX_SIDE)
    throw new AgentToolError(
      'invalid_params',
      '外接框太小。坐标按原图宽高归一化到 0–1（不是像素），请把要改的部分整个框进去',
    )
  if (box.x < 0 || box.y < 0 || box.x + box.width > 1 + EPSILON || box.y + box.height > 1 + EPSILON)
    throw new AgentToolError('invalid_params', '外接框超出了图片范围，坐标要落在 0–1 之内')
  return {
    x: box.x,
    y: box.y,
    width: Math.min(box.width, 1 - box.x),
    height: Math.min(box.height, 1 - box.y),
  }
}

function cleanPoints(
  points: readonly AgentMaskPromptPoint[] | undefined,
): AgentMaskPromptPoint[] | undefined {
  if (!points?.length) return undefined
  for (const point of points)
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.x > 1 ||
      point.y < 0 ||
      point.y > 1
    )
      throw new AgentToolError('invalid_params', '提示点坐标要落在 0–1 之内')
  return points.map(({ x, y, include }) => ({ x, y, include: include === true }))
}

/**
 * 这次局部编辑用哪个模型。只在严格蒙版族里选：用户选的就是其中之一就用它，否则取第一个；
 * 用户明确选了别的（Agnes、Grok 等不支持蒙版的）时把它记下，卡片上提示改用。
 */
export function chooseMaskModel(preferred: string | undefined): {
  model: AgentMaskProposal['model']
  switchedFrom?: AgentMaskProposal['switchedFrom']
} {
  const models = strictMaskModels()
  const chosen = models.find((one) => one.model === preferred) ?? models[0]
  if (!chosen)
    throw new AgentToolError(
      'model_unavailable',
      '当前没有支持按蒙版生成的模型，无法保证只改圈内。如实告诉用户这个限制，不要改成整图编辑。',
    )
  const model = { id: chosen.model, label: chosen.label }
  if (preferred && preferred !== chosen.model && resolveQueueModel('image', preferred))
    return { model, switchedFrom: { id: preferred, label: modelLabel(preferred) } }
  return { model }
}

/** 把二值蒙版写成上游与合成共用的格式：同尺寸 PNG，不透明保留、透明重绘。 */
export async function editMaskPng(
  target: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  const rgba = Buffer.alloc(width * height * 4, 255)
  for (let i = 0; i < target.length; i++) if (target[i]) rgba[i * 4 + 3] = 0
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()
}

async function propose(
  context: AgentToolContext,
  params: {
    imageId: string
    target: string
    segmentPrompt: string
    change: string
    keep?: string[]
    box: AgentNormalizedBox
    points?: AgentMaskPromptPoint[]
  },
  signal?: AbortSignal,
): Promise<AgentToolResult<MaskProposalDetails>> {
  if (context.images.masked)
    throw new AgentToolError(
      'invalid_params',
      '本轮已经有用户画好的选区，直接按选区调 editImage，不要再提议范围。',
    )
  const target = params.target.trim()
  const change = params.change.trim()
  const prompt = params.segmentPrompt.trim()
  if (!target || !change || !prompt)
    throw new AgentToolError('invalid_params', '要写清改哪个对象、改成什么，以及英文分割提示')
  const box = cleanBox(params.box)
  const points = cleanPoints(params.points)
  const keep = [...new Set((params.keep ?? []).map((one) => one.trim()).filter(Boolean))]

  const imageId = context.images.identify(params.imageId)
  const [reference] = await context.images.resolveMediaReferences([imageId])
  if (!reference)
    throw new AgentToolError(
      'invalid_params',
      `图片 ${params.imageId} 没有可直接引用的原件（未登录或尚未保存），不能发起范围确认。请用户在图上手动圈选后再改。`,
    )
  const image = await context.images.resolve(imageId, 'original')
  if (!image) throw new AgentToolError('invalid_params', `图片 ${params.imageId} 不可用`)
  const metadata = await sharp(
    Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64'),
    {
      limitInputPixels: visualPixelLimit(),
    },
  ).metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (!width || !height) throw new AgentToolError('invalid_params', '读不出这张图的尺寸')

  const { model, switchedFrom } = chooseMaskModel(context.params?.model)
  const size = maskedEditSize(model.id, width, height)
  if ('problem' in size)
    throw new AgentToolError(
      'invalid_params',
      `${size.problem}。原图 ${width}×${height}，如实告诉用户，不要改成整图编辑。`,
    )

  if (signal?.aborted) throw new AgentToolError('cancelled', '这一轮被中止了')
  let maskMediaId: string | undefined
  if (context.userId) {
    const segmented = await segmentProposal({
      dataUrl: image.dataUrl,
      width,
      height,
      prompt,
      box,
      ...(points ? { points } : {}),
      ...(signal ? { signal } : {}),
    })
    if (segmented) {
      const stored = await storeMedia(
        context.userId,
        await editMaskPng(segmented.mask.data, width, height),
        'image/png',
      )
      await addConversationMediaClaims(context.conversationId, context.userId, [stored.id])
      maskMediaId = stored.id
    }
  }

  context.maskProposals?.add(imageId)
  context.maskProposals?.add(reference.imageId)
  const proposal: AgentMaskProposal = {
    id: crypto.randomUUID(),
    imageId: reference.imageId,
    mediaId: reference.mediaId,
    width,
    height,
    target,
    change,
    keep,
    box,
    ...(points ? { points } : {}),
    segmentation: maskMediaId ? 'server' : 'browser',
    ...(maskMediaId ? { maskMediaId } : {}),
    model,
    ...(switchedFrom ? { switchedFrom } : {}),
  }
  return {
    content: [
      {
        type: 'text',
        text: '修改范围已发给用户确认。这一轮到此为止：不要先改图，他确认或调整后会带着蒙版回来，再按选区调 editImage。',
      },
    ],
    details: {
      clarification: {
        type: 'clarification',
        question: `确认修改范围：${target}`,
        options: [],
        maskProposal: proposal,
      },
    },
  }
}

export function maskProposalTool(context: AgentToolContext): AgentTool {
  const tool: AgentTool<typeof parameters, MaskProposalDetails> = {
    name: AGENT_MASK_PROPOSAL_TOOL,
    label: '确认修改范围',
    description: MASK_PROPOSAL_DESCRIPTION,
    parameters,
    execute: async (_toolCallId, params, signal) =>
      propose(context, params as Parameters<typeof propose>[1], signal),
  }
  return asPiTool(tool)
}

const MASK_PROPOSAL_DESCRIPTION =
  '用户只想改图里某个对象或局部、而本轮没有附带选区时，先用它请用户确认修改范围：你给出对象名、英文分割提示与外接框，系统据此圈出蒙版，用户在卡片上确认，或者调整范围、加标注。发出后这一轮结束；确认后用户会带着蒙版作为下一条消息回来，再按选区调 editImage。生成只改蒙版内，蒙版外像素与原图一致。'

/** 只给预扣估算与清单用的声明；不需要运行期 context。 */
export const maskProposalDeclaration = {
  name: AGENT_MASK_PROPOSAL_TOOL,
  description: MASK_PROPOSAL_DESCRIPTION,
  parameters,
}

export const MASK_PROPOSAL_GUIDANCE =
  '用户只想改图中某个对象或局部、本轮却没有附带选区时，不要直接整图改：先调 proposeEditRegion 请他确认修改范围，确认后他会带着蒙版回来，再按选区调 editImage。生成只改蒙版内，蒙版外像素保持原样。已有选区、或用户要的是整体风格、光线、构图变化时不用它。'

export function maskProposalFromResult(result: unknown): AgentClarificationBlock | null {
  const block = piToolResult<MaskProposalDetails>(result).details?.clarification
  return block?.maskProposal ? block : null
}

/**
 * 末尾那条未答的范围确认与这一轮的关系：
 * - `confirmed`：这条用户消息带着同一张图（同一份原件）的蒙版回来了，按它改图、用提议里的模型。
 * - `pending`：用户答了别的话，没带蒙版；这一轮不能对那张图做无蒙版的编辑。
 */
export type MaskProposalAnswer =
  | { readonly kind: 'confirmed'; readonly proposal: AgentMaskProposal }
  | { readonly kind: 'pending'; readonly proposal: AgentMaskProposal }

/**
 * 用户带着蒙版确认了范围：这一轮按提议里的严格蒙版模型生成，并当场提交——卡上的
 * 「确认并生成」就是那一次确认。其余情况原样返回。
 */
export function confirmedMaskProposalParams(
  history: readonly AgentMessageView[],
  references: readonly AgentTurnReference[],
  params: AgentTurnParams | undefined,
): AgentTurnParams | undefined {
  const answer = maskProposalAnswer(history, references)
  if (answer?.kind !== 'confirmed') return params
  if (!strictMaskModels().some((one) => one.model === answer.proposal.model.id)) return params
  return { ...params, model: answer.proposal.model.id, autoSubmit: true }
}

export function maskProposalAnswer(
  history: readonly AgentMessageView[],
  references: readonly AgentTurnReference[],
): MaskProposalAnswer | null {
  let proposal: AgentMaskProposal | undefined
  for (let at = history.length - 1; at >= 0; at--) {
    const message = history[at]!
    if (message.role === 'user') break
    for (const block of message.content)
      if (block.type === 'clarification' && block.maskProposal) proposal = block.maskProposal
    if (proposal) break
  }
  if (!proposal) return null
  const confirmed = references.some(
    (reference) =>
      reference.imageId === proposal.imageId &&
      ('mediaId' in reference
        ? reference.mediaId === proposal.mediaId && Boolean(reference.maskMediaId)
        : Boolean(reference.maskDataUrl)),
  )
  return { kind: confirmed ? 'confirmed' : 'pending', proposal }
}
