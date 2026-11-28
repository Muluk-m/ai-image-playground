import type { ProductionContext } from '../production'
import type { StoredImageRef } from '../queue-protocol'
import type { VideoAspectRatio, VideoResolution } from '../video-presets'

/**
 * 匿名设备标识的传输位置。它是纯 bearer——知道就等于持有，所以只走请求头或请求体：
 * query string 会落进访问日志、代理日志、浏览器历史和 Referer。
 */
export const DEVICE_ID_HEADER = 'x-device-id'

export const AGENT_CONVERSATION_TITLE_MAX_CHARS = 60
export const AGENT_USER_MESSAGE_MAX_CHARS = 4_000

export type AgentMessageRole = 'user' | 'assistant'

export interface AgentTextBlock {
  readonly type: 'text'
  readonly text: string
  /**
   * 用户消息的参考图快照。内联那一路把字节复制进对象存储，跨轮与重开会话仍可用；
   * 云媒体那一路只记 id，字节仍在 R2 里的那一份，不再复制第二遍。
   */
  readonly references?: readonly AgentStoredReference[]
}

/**
 * 这一轮要创作什么。它决定模型收到哪些工具、系统提示词里列哪些技能，
 * 不决定历史怎么渲染——旧轮的工具结果在任何创作类型下都照样认得出来。
 * 请求里缺席即 `image`：老客户端不知道有这回事。
 */
export type AgentMode = 'image' | 'video'

export const AGENT_MODES: readonly AgentMode[] = ['image', 'video']

export function isAgentMode(value: unknown): value is AgentMode {
  return value === 'image' || value === 'video'
}

/**
 * 一轮里用户在输入框附上的参考图。数组下标加一就是提示词里 `[image N]` 的 N，
 * 所以顺序不能在传输途中被重排。
 *
 * 启用附件上传后，原件与遮罩先就绪再传媒体身份；旧客户端与纯静态入口仍可内联。
 * 批注、裁剪、扩图产生的新像素必须拥有自己的媒体身份，不能沿用画布原图绑定。
 */
export type AgentTurnReference = AgentInlineReference | AgentMediaReference

export type AgentImageEditAction = 'inpaint' | 'erase' | 'crop' | 'outpaint'

/** Numbered selection bounds in normalized image coordinates; the mask remains authoritative. */
export interface AgentMarkedRegion {
  /** Stable visible number; absent on older clients, which use array position. */
  readonly number?: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /**
   * 用户在范围确认卡上写的标注文字。只进定位图旁的文字清单与改图说明，不画进原图像素。
   */
  readonly note?: string
  /** 箭头标注的尾端（归一化坐标）；箭头指向这个区域的中心。只画在定位图上。 */
  readonly arrow?: { readonly x: number; readonly y: number }
}

/** 标注文字的上限：一句话说清楚这里要怎样。 */
export const AGENT_REGION_NOTE_MAX_CHARS = 120

export interface AgentInlineReference {
  /** 画布对象 id 或素材的图片 id；模型改图时用它指认要改哪一张。 */
  readonly imageId: string
  readonly dataUrl: string
  /** 素材名，只用来让模型在回复里说人话。 */
  readonly name?: string
  /** 用户在这张图上画的遮罩；改图时自动带上，模型无从指定。 */
  readonly maskDataUrl?: string
  readonly regions?: readonly AgentMarkedRegion[]
  readonly editAction?: AgentImageEditAction
}

/**
 * 字节在云媒体里的参考图（`media_objects.id`）。
 *
 * 原件和遮罩分别使用不可变媒体身份，编辑动作与区域属于同一份发话快照。
 */
export interface AgentMediaReference {
  readonly imageId: string
  readonly mediaId: string
  readonly name?: string
  readonly maskMediaId?: string
  readonly regions?: readonly AgentMarkedRegion[]
  readonly editAction?: AgentImageEditAction
}

export type AgentStoredReference = AgentStoredInlineReference | AgentStoredMediaReference

export interface AgentStoredInlineReference {
  readonly imageId: string
  readonly name?: string
  readonly image: StoredImageRef
  readonly mask?: StoredImageRef
  readonly regions?: readonly AgentMarkedRegion[]
  readonly editAction?: AgentImageEditAction
}

/** 云媒体那一路的快照：字节留在 R2，会话只按 id 认领它（见 `media_references`）。 */
export type AgentStoredMediaReference = AgentMediaReference

/**
 * 一轮里生效的生成参数：用户在输入框的参数浮层里选，随起轮一起送到服务端，
 * 生图与改图工具提交队列任务时按它填。张数由每次工具调用决定，审核使用应用默认。
 *
 * 字段名对齐 `SubmitRequest`，避免在途中翻译两次；但 `gemini_*` 三项保持前缀，
 * 因为它们只对 gemini 系模型成立，往队列请求里填哪一支由服务端按 provider 决定。
 */
export type AgentThinkingDepth = 'fast' | 'medium' | 'deep'

export interface AgentTurnParams {
  /** Explicit video controls selected by the user; frozen with the turn and its confirmation. */
  readonly video?: {
    readonly model: string
    readonly durationSeconds: number
    readonly aspectRatio: VideoAspectRatio
    readonly resolution: VideoResolution
    readonly voiceIds?: readonly string[]
  }
  /** 本轮进入制作文档流程，生成仍必须确认。 */
  readonly productionMode?: true
  readonly production?: ProductionContext
  readonly thinkingDepth?: AgentThinkingDepth
  /** 生成模型。解析不出来（模型下线、介质不符）就退回部署配置的那一个。 */
  readonly model?: string
  /**
   * 原标签页工作台当前的出图模型。只给阶段授权报价，让提案和预检用同一条模型；
   * 不改变这一轮对话要调用的生成模型。
   */
  readonly canvasImageModel?: string
  /**
   * 原标签页工作台当前的出图张数。同 canvasImageModel，只给阶段授权报价；
   * 画布轮不送 `n`（对话生图张数由工具决定），缺了它报价会按 1 张算，和画布实际提交对不上。
   */
  readonly canvasImageCount?: number
  /**
   * 直接出图：用户在参数里打开时，生成工具拟好稿就当场提交，不再逐张等确认。
   *
   * 对话里的生图工具只认显式 `true`；缺席和 `false` 都是拟稿等确认。
   * 节点画布的 `runNodes` 相反：缺席按默认打开，只有显式 `false` 才弹阶段授权卡。
   * 这个值只来自本轮请求里的用户偏好，模型不能在工具参数里改口。
   * 一轮最多自动提交 {@link AGENT_AUTO_SUBMIT_MAX_PER_TURN} 次，超出的照常退回等待确认。
   */
  readonly autoSubmit?: boolean
  /**
   * 图片生成模式：用用户原话调用一次生图工具，不追问、不改写成另一套方案，张数用本轮 `n`。
   * 只认显式 `true`，并且要和 `autoSubmit` 一起送，工具才会当场提交。
   */
  readonly directImage?: true
  readonly size?: string
  readonly quality?: string
  readonly output_format?: string
  readonly output_compression?: number
  /** Image 2.6 GIF 帧数。缺席时提交按设置卡的默认 6 帧。 */
  readonly frame_count?: number
  /** Image 2.6 GIF 每帧毫秒。缺席时提交按设置卡的默认 200ms。 */
  readonly frame_duration_ms?: number
  readonly gemini_aspect_ratio?: string
  readonly gemini_image_size?: string
  readonly gemini_thinking_level?: string
  /**
   * 用户在输入框选择的出图张数。工具参数里没写 `n` 时用它；工具写了就以工具为准。
   * 缺席与 1 等价。
   */
  readonly n?: number
}

/**
 * 出图模式下一轮最多自动提交多少次生成。
 *
 * 对话模式靠「拟稿即收尾」刹车：一拟稿这一轮就结束，模型没机会接着调。出图模式要的正是
 * 连着出，那条刹车就没了，剩下的只有模型自己。超过这个数之后的调用退回等待确认——
 * 不报错、不中断，用户仍然看得见那些稿，只是要自己点。
 *
 * 它不是排队：排队管怎么跑，这里管模型自己能决定花多少。与一轮能带的参考图上限对齐，
 * 圈几张就能出几张；真正的硬上限是余额。
 */
export const AGENT_AUTO_SUBMIT_MAX_PER_TURN = 50

/**
 * 这一轮用户在哪种模式里说话，决定模型拿到哪套工具与提示。
 *
 * - `agent`：Agent 模式（对话视图里的输入框）。不论项目入口是对话还是画布，只用直接生图、改图等工具，
 *   结果落在对话的产物卡里；拿不到任何画布节点工具，系统提示里也没有画布指引。
 * - `canvas`：画布模式（项目停在画布视图时说的话）。生成都落进节点（#1364、#1377）。
 *
 * 由客户端每一轮显式声明；项目文档里记的入口（`experience`）只管项目归在哪个分组，不再决定工具。
 */
export type AgentSurface = 'agent' | 'canvas'

/**
 * 客户端没声明模式时按 Agent 模式算：判成画布会让普通改图被拆成节点阶段授权（2026-10-22 线上用户
 * 改浴缸颗粒感一例），判成 Agent 最多是画布里说的话产物落在对话卡上，不会多建节点或多扣费。
 */
export const DEFAULT_AGENT_SURFACE: AgentSurface = 'agent'

export function isAgentSurface(value: unknown): value is AgentSurface {
  return value === 'agent' || value === 'canvas'
}

/**
 * 节点画布这一轮要不要直接跑 `runNodes`。
 * 只看本轮请求上的用户偏好：没带偏好时默认开，只有显式 `false` 才走确认卡。
 */
export function canvasStageRunsDirectly(
  params: { readonly autoSubmit?: boolean } | null | undefined,
): boolean {
  return params?.autoSubmit !== false
}

/** 图片工具单次调用的产出上限；模型参数与画布占位共用。 */
export const AGENT_IMAGE_MAX_N = 10

/**
 * 这次图片工具调用出几张。画布占位与队列请求的 `n` 共用这一个算式——两处算出的数不一样，
 * 占位框就会和真正出的张数对不上。语义与 `Type.Integer` 的 `Value.Convert` 一致：
 * 数字串按数字读，小数截断，读不出整数一律算一张，最后收口到 1..`AGENT_IMAGE_MAX_N`。
 */
export function agentImageCount(args: { readonly n?: unknown } | null | undefined): number {
  const raw = typeof args?.n === 'string' ? Number(args.n) : args?.n
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
  return Math.min(AGENT_IMAGE_MAX_N, Math.max(1, Math.trunc(raw)))
}

/**
 * 这次图片工具调用出几张。工具显式写了张数就用它；没写就用用户在这一轮选择的张数。
 * 画布占位与队列请求共用这一个算式。
 */
export function requestedImageCount(toolCount: unknown, turnCount: unknown): number {
  const chosen = toolCount == null || toolCount === '' ? turnCount : toolCount
  return agentImageCount({ n: chosen })
}

/**
 * 智能体一单最多出几张，按模型收紧（没列出的模型照 `AGENT_IMAGE_MAX_N`）。
 * Gemini 3.1 Flash Lite Image 在 Vertex 上按「项目 × 基础模型」限到达速率（约每分钟 2 条），
 * 一单 8 张会在同一个模型上排出 8 条请求，2026-10-29 整单撞 429 失败；先压到 4 张止损。
 */
export const AGENT_MODEL_IMAGE_MAX_N: Readonly<Record<string, number>> = {
  'gemini-3.1-flash-lite-image': 4,
}

/**
 * 这个模型智能体一单最多几张（{@link AGENT_MODEL_IMAGE_MAX_N}，没列出的照 `AGENT_IMAGE_MAX_N`）。
 * 服务端收口与前端「图片生成」张数档共用这一份，两边才不会一个能选 8 张、一个只出 4 张（BUG-91）。
 */
export function agentModelImageMax(model: string | undefined): number {
  return model && Object.prototype.hasOwnProperty.call(AGENT_MODEL_IMAGE_MAX_N, model)
    ? AGENT_MODEL_IMAGE_MAX_N[model]!
    : AGENT_IMAGE_MAX_N
}

/** 把张数收口到这个模型的单笔上限（{@link agentModelImageMax}）。 */
export function agentModelImageCount(model: string | undefined, count: number): number {
  return Math.min(count, agentModelImageMax(model))
}

/**
 * 一轮最多带多少张参考图。多数是画布上圈选的图：它们按 id 发（`AgentMediaReference`），
 * 字节不进请求体；超过 {@link AGENT_TURN_ATTACHED_MEDIA_MAX} 张时模型只拿到清单，
 * 要看内容自己调 viewImage——所以张数不再撑大请求与上下文。与画布批量操作对齐。
 */
export const AGENT_TURN_MAX_REFERENCES = 50

/**
 * 其中最多多少张能内联字节（`AgentInlineReference`）：拖进来的文件、画了遮罩或批注的图。
 * 它们云端没有，只能随请求带上，也一定随消息给模型看。
 */
export const AGENT_TURN_MAX_INLINE_REFERENCES = 8

/**
 * 按 id 发的参考图不超过这么多张时，预览随消息一起给模型看（小场景和从前一样顺手）；
 * 超过就只给清单，模型要看哪张自己调 viewImage。批量处理多半不需要看每一张。
 */
export const AGENT_TURN_ATTACHED_MEDIA_MAX = 3
