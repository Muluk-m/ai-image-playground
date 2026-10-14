import type { TaskErrorType, TaskProgressPhase } from '@image-playground/shared'
import {
  DEFAULT_IMAGE_MODERATION,
  GEMINI_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_THINKING_LEVELS,
} from '@image-playground/shared'
import type { ClientProfile } from './lib/channels/types'

// ===== 设置 =====

export type ApiMode = 'images' | 'responses'
export type BuiltInApiProvider = 'openai' | 'gemini'
/** 历史任务上记下的协议族。新任务只写平台渠道映射出来的 openai / gemini。 */
export type ApiProvider = BuiltInApiProvider | string

export interface AppSettings {
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  alwaysShowRetryButton: boolean
  enterSubmit: boolean
  profiles: ClientProfile[]
  activeProfileId: string
}

// ===== 任务参数 =====

export {
  GEMINI_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_THINKING_LEVELS,
} from '@image-playground/shared'

export type GeminiAspectRatio = (typeof GEMINI_ASPECT_RATIOS)[number]
export type GeminiImageSize = (typeof GEMINI_IMAGE_SIZES)[number]
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number]

export interface TaskParams {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
  /** Generate on a chroma-key background, then remove it locally as transparent PNG. */
  transparent_output: boolean
  /**
   * 防改写：在 prompt 前加 guard 前缀，指示上游（Codex 系网关）原样使用提示词不要重写。
   * 默认开启；可在 composer 的「防改写」chip 关闭（旧持久化数据在 hydration 时
   * 与 DEFAULT_PARAMS 合并补齐；已存过显式值的以用户选择为准）。
   */
  no_rewrite: boolean
  /** Gemini 专属：明确的画面比例（替代从 OpenAI size 字符串推测） */
  gemini_aspect_ratio?: GeminiAspectRatio
  /** Gemini 专属：分辨率档位；缺省让模型自选 */
  gemini_image_size?: GeminiImageSize
  /** Gemini 专属：思考级别；缺省让模型自选 */
  gemini_thinking_level?: GeminiThinkingLevel
}

export const DEFAULT_PARAMS: TaskParams = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: DEFAULT_IMAGE_MODERATION,
  n: 1,
  transparent_output: false,
  no_rewrite: true,
}

// ===== 输入图片（UI 层面） =====

export interface InputImage {
  /** IndexedDB image store 的 id（SHA-256 hash） */
  id: string
  /** data URL，用于预览 */
  dataUrl: string
}

export interface MaskDraft {
  targetImageId: string
  maskDataUrl: string
  updatedAt: number
  /** 遮罩写进 IndexedDB 后的 id；刷新恢复只认它，localStorage 里不放遮罩本体。 */
  maskImageId?: string
}

/**
 * 从别处（商品图版本）打开遮罩编辑：自带初始遮罩，存哪去由发起方决定，
 * composer 的输入图与遮罩草稿一概不动。
 */
export interface MaskEditorSession {
  /** 打底的遮罩，透明处是重绘区；没有就从整张保留开始。 */
  maskDataUrl: string | null
  /** 画笔涂的是保留区，与 composer 里「涂掉 = 重绘」相反。 */
  keepSemantics: boolean
  /**
   * 待编辑图片本身。给了就直接拿它打底，不再按 id 回图片存储里找——画布对象的 id
   * 不是图片存储的 id，这是它进遮罩编辑器的唯一通路。
   */
  targetDataUrl?: string
  /** 给了才出「移除遮罩」按钮；遮罩存哪由发起方决定，清除也一样。 */
  onRemove?: () => void | Promise<void>
  onSave: (result: {
    maskDataUrl: string
    targetImageId: string
    targetDataUrl: string
  }) => void | Promise<void>
}

// ===== 任务记录 =====

export type TaskStatus = 'running' | 'done' | 'error'

/** 任务的归属：属于哪一套的哪一镜。 */
export interface TaskOrigin {
  setId: string
  shotId: string
  /** 缺省是商品图套图；分镜的镜头图带 'storyboard'。 */
  kind?: 'storyboard'
}

export interface TaskRecord {
  id: string
  prompt: string
  params: TaskParams
  /** 生成时使用的 Provider 类型 */
  apiProvider?: ApiProvider
  /** 生成时使用的 API 配置 ID */
  apiProfileId?: string
  /** 生成时使用的 Provider 名称 */
  apiProfileName?: string
  /** 生成时使用的模型 ID */
  apiModel?: string
  /**
   * 旧版自带密钥的异步任务号。平台渠道不再写它，读到旧记录时也不再续轮询。
   */
  customTaskId?: string
  /** 旧版自带密钥任务的自动重连标记。读到就清掉，避免界面停在重连中。 */
  customRecoverable?: boolean
  /**
   * 这条任务是平台队列任务。旧的自带密钥记录没有这个标记，也没有
   * `bffRequestId`，刷新后不能当成平台任务重提交。
   */
  platformTask?: true
  /** BFF queue 模式的 request_id，刷新页面后用于恢复轮询 */
  bffRequestId?: string
  /** Server-reported durable queue phase; absent for older BFFs. */
  queuePhase?: TaskProgressPhase
  /**
   * 客户端幂等键。submitTask 时为每个任务生成一次 UUID 并持久化；提交期间
   * 页面刷新时重提带相同 ID，BFF 用它去重。仅 BFF queue 路径会带。
   */
  clientRequestId?: string
  /** API 返回的实际生效参数，用于标记与请求值不一致的情况 */
  actualParams?: Partial<TaskParams>
  /** 输出图片对应的实际生效参数，key 为 outputImages 中的图片 id */
  actualParamsByImage?: Record<string, Partial<TaskParams>>
  /** 输出图片对应的 API 改写提示词，key 为 outputImages 中的图片 id */
  revisedPromptByImage?: Record<string, string>
  /** Whether transparent-background post-processing was requested for this task. */
  transparentOutput?: boolean
  /** Effective prompt sent to the API when transparent output is enabled. */
  transparentPrompt?: string
  /** Original generated image ids before local chroma-key removal; empty string means fallback. */
  transparentOriginalImages?: string[]
  /** 输入图片的 image store id 列表 */
  inputImageIds: string[]
  maskTargetImageId?: string | null
  maskImageId?: string | null
  /** 输出图片的 image store id 列表 */
  outputImages: string[]
  /** API 返回的原始图片 HTTP URL（非 base64 时记录） */
  rawImageUrls?: string[]
  /** 发生解析错误时的原始响应 JSON */
  rawResponsePayload?: string
  status: TaskStatus
  error: string | null
  /**
   * 失败分类。界面按它出文案与出路（ADR 0006），`error` 只留给「复制完整错误」。
   * 旧记录与认不出分类的失败都缺席，那些照旧显示 `error` 原文。
   */
  errorCode?: TaskErrorType
  createdAt: number
  finishedAt: number | null
  /** 总耗时毫秒 */
  elapsed: number | null
  /** 是否收藏 */
  isFavorite?: boolean
  /** 归属：套内逐镜提交才带，零散提交不带。 */
  origin?: TaskOrigin
  /**
   * 只在平台上留有记录的生成：像素不在本机，`outputImages` 是 `aip-media:` 引用。
   * 删除要走平台接口，本机删掉不算删。
   */
  remoteOnly?: true
  /**
   * 平台记录里的 provider（`openai-compat` / `gemini` …），只有镜像卡有。
   * 它和 `apiModel` 一起认回内置 channel，复用不必为这一个字段再读一次详情。
   * 缺席的是更早版本镜下来的卡，那些仍走详情。
   */
  cloudProvider?: string
}

// ===== IndexedDB 存储的图片 =====

export interface StoredImage {
  id: string
  dataUrl: string
  /** 图片首次存储时间（ms） */
  createdAt?: number
  /** 图片来源：用户上传 / API 生成 / 遮罩 */
  source?: 'upload' | 'generated' | 'mask'
  /** 原图宽度 */
  width?: number
  /** 原图高度 */
  height?: number
}

export interface StoredImageThumbnail {
  id: string
  /** 列表缩略图，用于避免卡片页解码完整 4K 原图 */
  thumbnailDataUrl: string
  /** 原图宽度 */
  width?: number
  /** 原图高度 */
  height?: number
  /** 缩略图生成参数版本 */
  thumbnailVersion?: number
}

// ===== API 请求体 =====

export interface ImageGenerationRequest {
  model: string
  prompt: string
  size: string
  quality: string
  output_format: string
  moderation: string
  output_compression?: number
  n?: number
}

// ===== API 响应 =====

export interface ImageResponseItem {
  b64_json?: string
  url?: string
  revised_prompt?: string
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
}

export interface ImageApiResponse {
  data: ImageResponseItem[]
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
  n?: number
}

export interface ResponsesOutputItem {
  type?: string
  result?:
    | string
    | {
        b64_json?: string
        image?: string
        data?: string
      }
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
  revised_prompt?: string
}

export interface ResponsesApiResponse {
  output?: ResponsesOutputItem[]
  tools?: Array<{
    type?: string
    size?: string
    quality?: string
    output_format?: string
    output_compression?: number
    moderation?: string
    n?: number
  }>
}

// ===== 导出数据 =====

/** ZIP manifest.json 格式 */
export interface ExportData {
  version: number
  exportedAt: string
  settings?: AppSettings
  tasks?: TaskRecord[]
  /** imageId → 图片信息 */
  imageFiles?: Record<
    string,
    {
      path: string
      createdAt?: number
      source?: 'upload' | 'generated' | 'mask'
      width?: number
      height?: number
    }
  >
  /** imageId → 缩略图信息 */
  thumbnailFiles?: Record<
    string,
    {
      path: string
      width?: number
      height?: number
      thumbnailVersion?: number
    }
  >
}
