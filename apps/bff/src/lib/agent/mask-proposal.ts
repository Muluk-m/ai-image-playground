import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentClarificationBlock,
  AgentContentBlock,
  AgentMaskPromptPoint,
  AgentMaskProposal,
  AgentMaskRegion,
  AgentMessageView,
  AgentNormalizedBox,
  AgentTurnParams,
  AgentTurnReference,
} from '@image-playground/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import sharp from 'sharp'
import { Type } from 'typebox'
import { db, schema } from '../../db/client'
import { modelLabel, resolveQueueModel, strictMaskModels } from '../channels'
import { storeMedia } from '../projectMedia'
import { addConversationMediaClaims, readConversationMedia } from './images'
import { maskedEditSize } from './masked-input'
import {
  promptBox,
  type SegmentationMask,
  segmentationProvider,
  segmenterKey,
  segmentProposal,
} from './segmentation'
import { asPiTool, piToolResult } from './tools/adapter'
import { AgentToolError } from './tools/errors'
import type { AgentToolContext } from './tools/types'
import { visualPixelLimit } from './visual-resources'

export const AGENT_MASK_PROPOSAL_TOOL = 'proposeEditRegion'

/** 框太小就不是「一个对象」了，多半是模型把坐标写成了像素或写反了。 */
const MIN_BOX_SIDE = 0.01
const EPSILON = 1e-6
/** 相似对象至多列几个：再多卡片上的编号就挤在一起，用户也数不过来。 */
const MASK_REGION_MAX = 6
/** 卡片上一个区域至多累积的点（含智能体给的）；与分割服务的上限一致。 */
export const MASK_PROMPT_POINTS_MAX = 16
/** 卡片上显示得下的长度与条数；模型多写的部分截掉，不当参数错误。 */
const MASK_TARGET_MAX = 40
const MASK_CHANGE_MAX = 120
const MASK_KEEP_MAX = 4
const MASK_KEEP_ITEM_MAX = 24
const MASK_LABEL_MAX = 16
const MASK_POINTS_MAX = 8
const MASK_INSTANCE_POINTS_MAX = 4

const clip = (text: string, max: number) => Array.from(text).slice(0, max).join('')

const unit = (description: string) => Type.Number({ minimum: 0, maximum: 1, description })

const boxSchema = (description: string) =>
  Type.Object(
    {
      x: unit('外接框左上角 x，按原图宽度归一化到 0–1'),
      y: unit('外接框左上角 y，按原图高度归一化到 0–1'),
      width: unit('外接框宽度，0–1'),
      height: unit('外接框高度，0–1'),
    },
    { description },
  )

const pointSchema = Type.Object({
  x: unit('点的 x，0–1'),
  y: unit('点的 y，0–1'),
  include: Type.Boolean({
    description: 'true 表示落在要改的对象上，false 表示明确不改的地方',
  }),
})

const parameters = Type.Object({
  imageId: Type.String({
    description: '要改的那张图的真实图片 id（用户引用、会话图片或本轮产物）。一次只提一张。',
  }),
  // 长度与条数的上限都放宽、在服务端截断：参数校验失败这一轮就不再重试（见 turn.ts），
  // 多写一项「不动」不该让用户拿不到卡片。
  target: Type.String({
    minLength: 1,
    maxLength: 200,
    description: '要改的对象，名词短语，用用户的语言，例如「杯身和把手」。只写对象，不写动作。',
  }),
  change: Type.String({
    minLength: 1,
    maxLength: 400,
    description: '要改成什么，照用户原话压成一句，例如「换成米白色釉面」。不要替他加没说过的属性。',
  }),
  keep: Type.Optional(
    Type.Array(Type.String({ maxLength: 200 }), {
      maxItems: 32,
      description: '用户明确或显然不想动的东西，至多 4 项（多写的会被截掉），例如「桌面」「书」。',
    }),
  ),
  box: boxSchema(
    '把要改的全部部分框进去的外接框（略宽于对象），坐标按原图归一化，原点在左上。有 instances 时框住选中的那几个。',
  ),
  points: Type.Optional(
    Type.Array(pointSchema, {
      maxItems: 32,
      description:
        '可选的提示点：至少一个落在目标上最有代表性的位置；对象挨着不想改的东西时，在那里放一个 include=false 的点。',
    }),
  ),
  invert: Type.Optional(
    Type.Boolean({
      description:
        '用户要改的是主体以外的部分（换背景、改背景颜色等）时为 true：此时 target 写「背景」，box 与 points 都指向要保留的主体（例如人物），系统会取反，并把主体边缘一圈（发丝）也交给模型重画。只改主体本身时不要写。',
    }),
  ),
  instances: Type.Optional(
    Type.Array(
      Type.Object({
        box: boxSchema('这一个对象的外接框，按原图归一化'),
        label: Type.Optional(
          Type.String({ maxLength: 200, description: '短称呼，例如「左边的杯子」' }),
        ),
        selected: Type.Boolean({ description: '用户要改的是不是这一个' }),
        points: Type.Optional(
          Type.Array(pointSchema, { maxItems: 32, description: '可选，落在这一个对象上的点' }),
        ),
      }),
      {
        maxItems: 32,
        description:
          '画面里有多个相似对象（例如几只杯子、几个人）时逐个列出，含不改的那几个，按从左到右排；selected 标出用户要改的。卡片上按编号显示，用户可以点编号增减。只有一个目标时不要写。',
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

interface InstanceParams {
  box: AgentNormalizedBox
  label?: string
  selected: boolean
  points?: AgentMaskPromptPoint[]
}

/** 相似对象按从左到右、从上到下编号；至少要有一个选中，不然卡片打开就是空的。 */
function cleanInstances(instances: readonly InstanceParams[] | undefined) {
  // 只列了一个就是单个目标，照 box 处理。
  if (!instances || instances.length < 2) return undefined
  if (instances.length > MASK_REGION_MAX)
    throw new AgentToolError(
      'invalid_params',
      `instances 只在有 2–${MASK_REGION_MAX} 个相似对象时写；只有一个目标就只给 box`,
    )
  const cleaned = instances
    .map((one) => ({
      box: cleanBox(one.box),
      label: clip(one.label?.trim() ?? '', MASK_LABEL_MAX) || undefined,
      selected: one.selected === true,
      points: cleanPoints(one.points)?.slice(0, MASK_INSTANCE_POINTS_MAX),
    }))
    .sort((a, b) => a.box.x + a.box.width / 2 - (b.box.x + b.box.width / 2) || a.box.y - b.box.y)
  if (!cleaned.some((one) => one.selected))
    throw new AgentToolError('invalid_params', 'instances 里至少要有一个 selected=true')
  return cleaned
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

/**
 * 范围确认发不出去：不是模型能换个参数修好的问题。这一轮不再重试，由轮直接给用户一句话
 * （见 turn.ts 对 proposeEditRegion 失败的处理），不要叫用户自己去画。
 */
export class MaskProposalUnavailable extends AgentToolError {
  constructor(readonly reason: string) {
    super(
      'invalid_params',
      `范围确认暂时不可用（${reason}）。不要再调用 proposeEditRegion，也不要让用户自己圈选；这一轮到此为止。`,
    )
  }
}

const UNAVAILABLE = /^范围确认暂时不可用（(.*)）。不要再调用/s

/**
 * 范围确认失败后发给用户的那一句：轮直接收尾，不再追加模型调用。可以照实说的原因
 * （比如尺寸超限）带上，参数类失败只说没改成；都不叫用户自己去画。
 */
export function maskProposalFailedText(errorText: string): string {
  const reason = UNAVAILABLE.exec(errorText)?.[1]
  return reason
    ? `这张图暂时没法自动圈出修改范围（${reason}），这次没有改图。你可以稍后再试或换一张图。`
    : '这次没能圈出要改的范围，没有改图。你可以稍后再试，或说得更具体一点（比如要改的是哪一个物体）。'
}

/** 内联上传的原图存成媒体并挂到会话上，返回与云媒体引用同形的引用。 */
async function persistOriginal(
  context: AgentToolContext,
  userId: string,
  imageId: string,
  bytes: Buffer,
  dataUrl: string,
) {
  const contentType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png'
  const media = await storeMedia(userId, bytes, contentType)
  await addConversationMediaClaims(context.conversationId, userId, [media.id])
  return { imageId, mediaId: media.id }
}

/** 分割好的蒙版存成媒体并挂到会话上，卡片与确认都按 id 取。 */
async function storeMask(context: AgentToolContext, userId: string, mask: SegmentationMask) {
  const stored = await storeMedia(
    userId,
    await editMaskPng(mask.data, mask.width, mask.height),
    'image/png',
  )
  await addConversationMediaClaims(context.conversationId, userId, [stored.id])
  return stored.id
}

async function propose(
  context: AgentToolContext,
  params: {
    imageId: string
    target: string
    change: string
    keep?: string[]
    box: AgentNormalizedBox
    points?: AgentMaskPromptPoint[]
    invert?: boolean
    instances?: InstanceParams[]
  },
  signal?: AbortSignal,
): Promise<AgentToolResult<MaskProposalDetails>> {
  if (context.images.masked)
    throw new AgentToolError(
      'invalid_params',
      '本轮已经有用户画好的选区，直接按选区调 editImage，不要再提议范围。',
    )
  const target = clip(params.target.trim(), MASK_TARGET_MAX)
  const change = clip(params.change.trim(), MASK_CHANGE_MAX)
  if (!target || !change) throw new AgentToolError('invalid_params', '要写清改哪个对象、改成什么')
  const box = cleanBox(params.box)
  const points = cleanPoints(params.points)?.slice(0, MASK_POINTS_MAX)
  const invert = params.invert === true
  // 换背景只认 box 框住的那一个主体；多列的相似对象没有意义，丢掉。
  const instances = invert ? undefined : cleanInstances(params.instances)
  const keep = [...new Set((params.keep ?? []).map((one) => clip(one.trim(), MASK_KEEP_ITEM_MAX)))]
    .filter(Boolean)
    .slice(0, MASK_KEEP_MAX)

  const imageId = context.images.identify(params.imageId)
  const image = await context.images.resolve(imageId, 'original')
  if (!image) throw new MaskProposalUnavailable(`图片 ${params.imageId} 不可用`)
  const bytes = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64')
  const metadata = await sharp(bytes, { limitInputPixels: visualPixelLimit() }).metadata()
  // 云媒体里已有原件就直接引用；随消息内联上传的图（附件上传未开启时就是这样）在服务端
  // 存成媒体并挂到会话上，与蒙版走同一条路，卡片、点选与确认都按这个 id 取原件。
  const [stored] = await context.images.resolveMediaReferences([imageId])
  const reference =
    stored ??
    (context.userId
      ? await persistOriginal(context, context.userId, imageId, bytes, image.dataUrl)
      : null)
  if (!reference) throw new MaskProposalUnavailable('这张图还没有保存的原件（未登录）')
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (!width || !height) throw new MaskProposalUnavailable('读不出这张图的尺寸')

  const { model, switchedFrom } = chooseMaskModel(context.params?.model)
  const size = maskedEditSize(model.id, width, height)
  if ('problem' in size)
    throw new MaskProposalUnavailable(`${size.problem}；原图 ${width}×${height}`)

  if (signal?.aborted) throw new AgentToolError('cancelled', '这一轮被中止了')
  // 同一张原图用同一个缓存键：多个区域与卡片上的点选都只编码一次。
  const segment = (target: { box: AgentNormalizedBox; points?: AgentMaskPromptPoint[] }) =>
    segmentProposal({
      dataUrl: image.dataUrl,
      key: segmenterKey(reference.mediaId),
      width,
      height,
      box: target.box,
      ...(target.points ? { points: target.points } : {}),
      ...(signal ? { signal } : {}),
    })
  let maskMediaId: string | undefined
  let regions: AgentMaskRegion[] | undefined
  if (context.userId && !instances) {
    const segmented = await segment({ box, ...(points ? { points } : {}) })
    if (segmented) maskMediaId = await storeMask(context, context.userId, segmented.mask)
  } else if (instances) {
    regions = []
    // 一个区域分割失败（多半是超时）就不再试后面的：卡片按框画，别让用户多等几个超时。
    let available = Boolean(context.userId)
    for (const [index, instance] of instances.entries()) {
      const segmented = available ? await segment(instance) : null
      if (!segmented) available = false
      regions.push({
        number: index + 1,
        ...(instance.label ? { label: instance.label } : {}),
        box: instance.box,
        ...(instance.points ? { points: instance.points } : {}),
        selected: instance.selected,
        ...(segmented && context.userId
          ? { maskMediaId: await storeMask(context, context.userId, segmented.mask) }
          : {}),
      })
    }
  }
  const segmented = Boolean(maskMediaId) || Boolean(regions?.some((one) => one.maskMediaId))

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
    segmentation: segmented ? 'server' : 'box',
    ...(maskMediaId ? { maskMediaId } : {}),
    ...(regions ? { regions } : {}),
    ...(invert ? { invert: true } : {}),
    model,
    ...(switchedFrom ? { switchedFrom } : {}),
  }
  return {
    content: [
      {
        type: 'text',
        text: '修改范围已发给用户确认。这一轮到此为止：不要先改图，他确认或调整后会带着蒙版回来，再按选区调 editImage（不写 n，张数按确认时的设置，默认 2 张）。',
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
  '用户要改图里某个对象或局部（含「换掉 X、背景不变」）、或只换背景，而本轮没有附带选区时，必须先用它请用户确认修改范围，不要整图改：你给出对象名与外接框，系统据此圈出蒙版，用户在卡片上确认，或者点选增减、调整范围、加标注。画面里有几个相似对象时用 instances 逐个列出并标出要改的，卡片会按编号显示。要换背景时用 invert：框住要保留的主体，系统取反。发出后这一轮结束；确认后用户会带着蒙版作为下一条消息回来，再按选区调 editImage。生成只改蒙版内，蒙版外像素与原图一致。'

/** 只给预扣估算与清单用的声明；不需要运行期 context。 */
export const maskProposalDeclaration = {
  name: AGENT_MASK_PROPOSAL_TOOL,
  description: MASK_PROPOSAL_DESCRIPTION,
  parameters,
}

export const MASK_PROPOSAL_GUIDANCE =
  '用户要改图里的某一个对象或局部（换掉、改色、去掉某样东西，包括「把 X 换一下、背景不变」这类说法），或者只换背景、主体不动，而本轮没有附带选区时，先调 proposeEditRegion 请他确认修改范围，不要直接整图改；第一次无蒙版的整图编辑会被系统退回提醒。如果要的其实是整张图的变化（季节、昼夜、明暗、画风、把人整体变成卡通），就照原样再调一次 editImage，会按整图提交。不要先追问要换成什么样：用户没说的交给生成按原话处理，确认卡上他可以补充。只有要改的对象本身真有歧义（比如有几个都说得通、又不能用 instances 列出来让他选）时才先问一句。确认后他会带着蒙版回来，再按选区调 editImage；生成只改蒙版内，蒙版外像素保持原样。已有选区、或用户要的是整体风格、色调、光线、构图变化时不用它。'

export function maskProposalFromResult(result: unknown): AgentClarificationBlock | null {
  const block = piToolResult<MaskProposalDetails>(result).details?.clarification
  return block?.maskProposal ? block : null
}

/**
 * 末尾那条未答的范围确认与这一轮的关系：
 * - `confirmed`：这条用户消息带着同一张图（同一份原件）的蒙版回来了，按它改图、用提议里的模型。
 * - `pending`：用户答了别的话，没带蒙版；这一轮不能对那张图做无蒙版的编辑。
 */
type MaskProposalAnswer =
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
  return {
    ...params,
    model: answer.proposal.model.id,
    autoSubmit: true,
    // 局部重绘一次出 2 张给用户挑；输入框里选了更多就照他的。
    n: Math.max(params?.n ?? 1, MASK_CONFIRMED_DEFAULT_COUNT),
  }
}

/** 确认范围后默认出几张。 */
export const MASK_CONFIRMED_DEFAULT_COUNT = 2

/** 会话里那条范围确认卡；只看这个会话自己的助手消息，找不到就是 null。 */
async function findMaskProposal(
  conversationId: string,
  proposalId: string,
): Promise<AgentMaskProposal | null> {
  const rows = await db
    .select({ content: schema.agent_messages.content })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        eq(schema.agent_messages.role, 'assistant'),
        isNull(schema.agent_messages.deleted_at),
      ),
    )
    .orderBy(desc(schema.agent_messages.seq))
    .limit(200)
  for (const row of rows)
    for (const block of row.content as readonly AgentContentBlock[])
      if (block.type === 'clarification' && block.maskProposal?.id === proposalId)
        return block.maskProposal
  return null
}

type RefineEditRegionResult =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'ok'
      /** 编辑格式的 PNG（不透明保留、透明重绘），与原图同尺寸。 */
      readonly mask: Buffer
      readonly provider: string
      readonly elapsedMs: number
    }

/** 用户点在智能体给的点附近，就以用户的为准：那一点不再交给模型，免得一正一负互相抵消。 */
const SEED_OVERRIDE_DISTANCE = 0.06

/** 智能体给的点在前、用户这几下在后；离用户某一下太近的智能体点去掉。 */
export function seedPoints(
  agent: readonly AgentMaskPromptPoint[] | undefined,
  user: readonly AgentMaskPromptPoint[],
): AgentMaskPromptPoint[] {
  const kept = (agent ?? []).filter((point) =>
    user.every(
      (click) => Math.hypot(click.x - point.x, click.y - point.y) > SEED_OVERRIDE_DISTANCE,
    ),
  )
  return [...kept, ...user]
}

/**
 * 卡片上点一下：在提议的那个区域上叠加用户的包含 / 排除点重新分割。原图只按会话的认领读，
 * 分割服务缓存过这张图时连原图都不读。结果不落库，确认时卡片会把最终蒙版一起交回来。
 */
export async function refineEditRegion(input: {
  readonly conversationId: string
  readonly userId: string
  readonly proposalId: string
  readonly region?: number
  readonly points: readonly AgentMaskPromptPoint[]
  readonly signal?: AbortSignal
}): Promise<RefineEditRegionResult> {
  const proposal = await findMaskProposal(input.conversationId, input.proposalId)
  if (!proposal) return { kind: 'not_found' }
  const region =
    input.region === undefined
      ? undefined
      : proposal.regions?.find((one) => one.number === input.region)
  if (input.region !== undefined && !region) return { kind: 'not_found' }
  const provider = segmentationProvider()
  if (!provider) return { kind: 'unavailable' }
  const user = cleanPoints(input.points) ?? []
  const points = seedPoints((region ?? proposal).points, user).slice(-MASK_PROMPT_POINTS_MAX)
  const startedAt = Date.now()
  const segmented = await segmentProposal({
    key: segmenterKey(proposal.mediaId),
    loadDataUrl: async () => {
      const media = await readConversationMedia(
        proposal.mediaId,
        input.conversationId,
        input.userId,
        'original',
      )
      if (!media) throw new Error('source media unavailable')
      return `data:${media.contentType};base64,${Buffer.from(media.bytes).toString('base64')}`
    },
    width: proposal.width,
    height: proposal.height,
    box: promptBox((region ?? proposal).box, user),
    ...(points.length ? { points } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!segmented) return { kind: 'failed' }
  return {
    kind: 'ok',
    mask: await editMaskPng(segmented.mask.data, proposal.width, proposal.height),
    provider: segmented.provider,
    elapsedMs: Date.now() - startedAt,
  }
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
