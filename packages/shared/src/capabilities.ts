import { MAX_IMAGE_UPLOAD_BYTES } from './media-limits'
import { PROJECT_DOCUMENT_MAX_BYTES, PROJECT_ELEMENT_MAX_COUNT } from './project-protocol'

export const CAPABILITIES = {
  'accounts:local-recovery': { defaultValue: false, clientExposed: true },
  'accounts:login': { defaultValue: false, clientExposed: true },
  'accounts:email-verification': { defaultValue: false, clientExposed: true },
  'accounts:self-register': { defaultValue: false, clientExposed: true },
  'accounts:sync': { defaultValue: false, clientExposed: true },
  'agent:production': { defaultValue: false, clientExposed: true },
  'agent:chat': { defaultValue: false, clientExposed: true },
  'agent:batch-analysis': { defaultValue: false, clientExposed: true },
  'agent:batch-execution': { defaultValue: false, clientExposed: true },
  'agent:batch-plans': { defaultValue: false, clientExposed: true },
  'agent:attachments': { defaultValue: false, clientExposed: true },
  'agent:bulk-attachments': { defaultValue: false, clientExposed: true },
  /** 批次里单独取消正在生成的一张（取消接口与卡片上的取消按钮）。默认关，按环境逐步放开。 */
  'agent:batch-item-cancel': { defaultValue: false, clientExposed: true },
  /**
   * 智能体先提议修改范围（`proposeEditRegion` 范围确认卡）再按蒙版局部编辑。2026-10-27 线上
   * 屡次报「原图尺寸超出模型支持的局部编辑范围」后整轮无图，按 Nain 要求下线：默认关，
   * 关着时智能体不再收到这个工具、也不再把单对象修改退回去要求先圈范围，改图回到整图编辑。
   */
  'agent:edit-region': { defaultValue: false, clientExposed: false },
  'billing:credits': { defaultValue: false, clientExposed: true },
  /**
   * 对话限时免费的运营期。开着时对话轮**真的不计费**：BFF 既不预扣也不结算
   * （`chatTurnsBilled()`），这一轮的 `cost.chat` 恒为 0；工具产生的生图 / 生视频
   * 各自独立计费，不受影响。前端据此在轮页脚标明这一轮的对话没收钱。
   */
  'billing:chat-free': { defaultValue: false, clientExposed: true },
  'cli:api': { defaultValue: false, clientExposed: false },
  'generation:video': { defaultValue: false, clientExposed: true },
  'operator:console': { defaultValue: false, clientExposed: false },
  'quota:daily': { defaultValue: false, clientExposed: true },
} as const satisfies Record<`${string}:${string}`, CapabilityDefinition>

/**
 * 已下线能力的名字。旧运营配置里可能还留着它们，读配置时静默忽略而不是拒绝启动；
 * 不要复用这些名字表示新能力。
 */
export const RETIRED_CAPABILITIES: readonly string[] = [
  // 节点画布 v1 整份常开，不再由运营配置开关。旧文件里的这些键直接忽略。
  'canvas:nodes',
  'canvas:blank-generate',
  'canvas:node-run',
  'canvas:script',
  // 联网工具（搜索 / 抓网页 / 取网图 / 抓商品图）不再由能力开关控制，随部署默认在场。
  'agent:web',
  // 用户自带密钥已下线。旧运营配置里的这个开关直接忽略。
  'generation:byok',
  'generation:storyboard',
  'matte:server',
  'remix:analyze',
  'remix:listing',
]

/** 已经不存在的配额。部署里的旧配置文件不该因为改名而起不来，读到就跳过。 */
export const RETIRED_QUOTAS: readonly string[] = [
  'agent:compaction-keep-messages',
  'agent:compaction-max-folds',
]

export interface CapabilityDefinition {
  readonly defaultValue: false
  readonly clientExposed: boolean
}

export type CapabilityKey = keyof typeof CAPABILITIES

export type ClientCapabilityKey = {
  [Key in CapabilityKey]: (typeof CAPABILITIES)[Key]['clientExposed'] extends true ? Key : never
}[CapabilityKey]

export type CapabilityValues = { readonly [Key in CapabilityKey]: boolean }
export type ClientCapabilityManifest = { readonly [Key in ClientCapabilityKey]: boolean } & {
  readonly attachmentLimits?: AttachmentLimits
  readonly mediaLimits?: MediaLimits
}
/**
 * 普通云媒体（画布原图、按 id 引用的参考图）单张上限，与服务端预约上传时用的是同一份配置。
 * 对话附件那条通道关着时，大图按这一档上传后按 id 发，客户端在选图时就按它拦。
 */
export interface MediaLimits {
  readonly imageBytes: number
  readonly imagePixels: number
}
/** Limits apply to immutable uploaded originals, independently of model preview budgets. */
export interface AttachmentLimits {
  readonly logicalReferences: number
  readonly imageBytes: number
  readonly imagePixels: number
  readonly uploadConcurrency: number
}

export interface AdminCapabilityManifest {
  readonly accounts_login: boolean
  readonly operator_console: boolean
}

export const QUOTAS = {
  'agent:batch-source-versions': { defaultValue: 4 },
  'agent:batch-max-items': { defaultValue: 3 },
  'agent:batch-dispatch-window': { defaultValue: 2 },
  /** Independent analysis consumer keeps draining accepted tasks when intake is disabled. */
  'agent:analysis-concurrency': { defaultValue: 1 },
  /** Application resource guard, not a provider throughput guarantee. */
  'agent:visual-prepare-concurrency': { defaultValue: 1 },
  'agent:visual-prepare-queue': { defaultValue: 100 },
  /** 智能体同一轮里、未声明并发上限的同模型任务最多同时跑几条；1 即一律串行。 */
  'agent:turn-model-parallelism': { defaultValue: 1 },
  'agent:visual-max-pixels': { defaultValue: 16_777_216 },
  /** Zero keeps bulk intake closed until operators validate and configure resource budgets. */
  'agent:attachment-logical-references': { defaultValue: 0 },
  'agent:attachment-image-bytes': { defaultValue: 0 },
  'agent:attachment-image-pixels': { defaultValue: 0 },
  'agent:attachment-upload-concurrency': { defaultValue: 0 },
  /** Application memory/transport protection; operators must verify tighter gateway limits. */
  'agent:request-max-bytes': { defaultValue: 16 * 1024 * 1024 },
  'agent:compaction-buffer-tokens': { defaultValue: 13_000 },
  'agent:compaction-cooldown-minutes': { defaultValue: 6 * 60 },
  'agent:compaction-failure-threshold': { defaultValue: 3 },
  /** 近期原文保留多少 token。一条消息可能 1 token 也可能 1 万，按条数留在混合尺寸的会话里量不准。 */
  'agent:compaction-keep-tokens': { defaultValue: 20_000 },
  'agent:compaction-output-reserve-tokens': { defaultValue: 20_000 },
  'agent:compaction-verbatim-tokens': { defaultValue: 20_000 },
  /** 起一轮的速率限制，两维各一个阈值；0 关闭该维。 */
  'agent:turns-per-device-minute': { defaultValue: 20 },
  'agent:turns-per-ip-hour': { defaultValue: 600 },
  'generation:daily-images': { defaultValue: 0 },
  'sync:user-media-bytes': { defaultValue: 10 * 1024 * 1024 * 1024 },
  'sync:attachment-lease-seconds': { defaultValue: 0 },
  'sync:asset-video-bytes': { defaultValue: 256 * 1024 * 1024 },
  'sync:asset-image-bytes': { defaultValue: MAX_IMAGE_UPLOAD_BYTES },
  'sync:user-asset-bytes': { defaultValue: 500 * 1024 * 1024 },
  'sync:project-document-bytes': { defaultValue: PROJECT_DOCUMENT_MAX_BYTES },
  'sync:project-elements': { defaultValue: PROJECT_ELEMENT_MAX_COUNT },
  'sync:project-recycle-days': { defaultValue: 30 },
  'sync:user-projects': { defaultValue: 100 },
} as const satisfies Record<`${string}:${string}`, QuotaDefinition>

export interface QuotaDefinition {
  readonly defaultValue: number
}

export type OperatorValueKind = 'capability' | 'quota'
export type OperatorEditability = 'hot' | 'boot' | 'read-only'

export interface OperatorRegistryEntry {
  readonly key: string
  readonly kind: OperatorValueKind
  readonly name: string
  readonly description: string
  readonly group: string
  readonly editability: OperatorEditability
  readonly risk: 'low' | 'medium' | 'high'
  readonly unit?: string
  readonly min?: number
  readonly max?: number
  readonly dependencies: readonly string[]
  readonly derived?: boolean
}

const OPERATOR_METADATA: Readonly<Record<string, Partial<OperatorRegistryEntry>>> = {
  'accounts:local-recovery': {
    name: '账号恢复',
    description: '允许本地账号恢复流程',
    group: 'accounts',
  },
  'accounts:email-verification': {
    name: '邮箱验证',
    description: '注册时要求验证邮箱',
    group: 'accounts',
    dependencies: ['accounts:self-register'],
  },
  'agent:production': {
    name: '智能体制作',
    description: '允许智能体制作任务',
    dependencies: ['agent:chat'],
  },
  'agent:batch-analysis': { name: '批量分析', description: '允许提交批量分析任务' },
  'agent:batch-execution': {
    name: '批量执行',
    description: '允许执行已确认的批量计划',
    dependencies: ['agent:batch-plans'],
  },
  'agent:batch-plans': {
    name: '批量计划',
    description: '允许创建批量制作计划',
    dependencies: ['agent:chat', 'agent:attachments', 'accounts:login'],
  },
  'agent:attachments': {
    name: '对话附件',
    description: '允许上传对话附件；需有效附件租约',
    dependencies: ['accounts:sync'],
  },
  'agent:bulk-attachments': {
    name: '批量附件',
    description: '允许批量附件；所有附件资源配额必须大于零',
    dependencies: ['agent:attachments', 'agent:chat'],
  },
  'agent:batch-item-cancel': { name: '批次单项取消', description: '允许取消批次中单个生成任务' },
  'agent:edit-region': { name: '局部编辑', description: '允许智能体提出蒙版编辑区域' },
  'billing:credits': {
    name: '积分计费',
    description: '启动时加载积分计费；需发布修改',
    dependencies: ['accounts:login'],
  },
  'cli:api': {
    name: '命令行接口',
    description: '允许命令行连接及调用平台接口',
    dependencies: ['accounts:sync'],
  },
  'generation:video': { name: '视频生成', description: '允许生成视频' },
  'operator:console': { name: '运营控制台', description: '只读；不允许通过运营覆盖开启控制台' },
  'agent:batch-source-versions': {
    name: '批次来源版本数',
    description: '每个来源保留的版本数',
    unit: 'count',
  },
  'agent:batch-max-items': {
    name: '批次条目上限',
    description: '每个批次允许的最大条目数',
    unit: 'count',
  },
  'agent:batch-dispatch-window': {
    name: '批次派发窗口',
    description: '批次同时派发的任务数',
    unit: 'count',
  },
  'agent:visual-prepare-concurrency': {
    name: '视觉准备并发',
    description: '同时进行视觉预处理的任务数',
    unit: 'count',
    min: 1,
  },
  'agent:visual-prepare-queue': {
    name: '视觉准备队列',
    description: '视觉预处理等待队列上限',
    unit: 'count',
  },
  'agent:turn-model-parallelism': {
    name: '单轮模型并发',
    description: '同一轮同模型工具的并发上限',
    unit: 'count',
    min: 1,
  },
  'agent:visual-max-pixels': {
    name: '视觉像素上限',
    description: '视觉预处理允许的最大像素数',
    unit: 'pixels',
  },
  'agent:attachment-logical-references': {
    name: '附件引用上限',
    description: '每次批量上传允许的引用数',
    unit: 'count',
    max: 100,
  },
  'agent:attachment-image-bytes': {
    name: '附件图片大小',
    description: '单张附件图片的字节上限',
    unit: 'bytes',
  },
  'agent:attachment-image-pixels': {
    name: '附件图片像素',
    description: '单张附件图片的像素上限',
    unit: 'pixels',
    max: 1_000_000_000,
  },
  'agent:attachment-upload-concurrency': {
    name: '附件上传并发',
    description: '同时上传的附件数',
    unit: 'count',
    max: 4,
  },
  'agent:compaction-cooldown-minutes': {
    name: '压缩冷却时间',
    description: '自动上下文压缩之间的最短间隔',
    unit: 'minutes',
  },
  'agent:compaction-failure-threshold': {
    name: '压缩失败阈值',
    description: '触发压缩保护的失败次数',
    unit: 'count',
  },
  'agent:compaction-verbatim-tokens': {
    name: '原文保留 tokens',
    description: '压缩时保留的原文预算',
    unit: 'tokens',
  },
  'sync:user-asset-bytes': {
    name: '用户素材容量',
    description: '每个用户的素材存储上限',
    unit: 'bytes',
  },
  'sync:project-document-bytes': {
    name: '项目文档大小',
    description: '单个项目文档的字节上限',
    unit: 'bytes',
  },
  'sync:project-elements': {
    name: '项目元素上限',
    description: '单个项目允许的元素数',
    unit: 'count',
  },
  'sync:project-recycle-days': {
    name: '项目回收保留',
    description: '已删除项目在回收站保留的天数',
    unit: 'days',
  },
  'sync:user-projects': {
    name: '用户项目上限',
    description: '每个用户允许创建的项目数',
    unit: 'count',
  },
  'accounts:login': { name: '账号登录', description: '允许用户登录账号', group: 'accounts' },
  'accounts:self-register': {
    name: '自助注册',
    description: '允许用户自行注册账号',
    group: 'accounts',
  },
  'accounts:sync': { name: '账号同步', description: '允许账号同步项目与素材', group: 'accounts' },
  'agent:chat': { name: '智能体对话', description: '允许使用智能体对话', group: 'agent' },
  'agent:analysis-concurrency': {
    name: '分析并发',
    description: '分析任务同时执行数',
    group: 'agent',
    unit: 'count',
    min: 1,
    max: 64,
  },
  'billing:chat-free': {
    name: '免费对话',
    description: '免除对话轮次积分消耗；可能增加运营成本',
    group: 'billing',
    dependencies: ['billing:credits'],
  },
  'generation:daily-images': {
    name: '每日生图上限',
    description: '每个设备每日可生成的图片数',
    group: 'generation',
    unit: 'count',
    max: 1_000_000,
  },
  'sync:user-media-bytes': {
    name: '用户媒体容量',
    description: '单个用户可占用的媒体容量',
    group: 'sync',
    unit: 'bytes',
    max: 1024 ** 4,
  },
  'sync:attachment-lease-seconds': {
    name: '附件租约时长',
    description: '附件上传租约有效时间',
    group: 'sync',
    unit: 'seconds',
    max: 86_400,
  },
  'sync:asset-image-bytes': {
    name: '图片大小上限',
    description: '单张图片原图大小上限',
    group: 'sync',
    unit: 'bytes',
    max: 1024 ** 3,
  },
  'sync:asset-video-bytes': {
    name: '视频大小上限',
    description: '单个视频大小上限',
    group: 'sync',
    unit: 'bytes',
    max: 10 * 1024 ** 3,
  },
  'agent:compaction-buffer-tokens': {
    name: '压缩缓冲 tokens',
    description: '上下文压缩预留缓冲',
    group: 'agent',
    unit: 'tokens',
  },
  'agent:compaction-keep-tokens': {
    name: '保留 tokens',
    description: '上下文压缩保留的近期原文',
    group: 'agent',
    unit: 'tokens',
  },
  'agent:compaction-output-reserve-tokens': {
    name: '输出预留 tokens',
    description: '上下文压缩输出预留',
    group: 'agent',
    unit: 'tokens',
  },
  'agent:turns-per-device-minute': {
    name: '设备每分钟轮次',
    description: '单设备每分钟允许的智能体轮次',
    group: 'agent',
    unit: 'count',
  },
  'agent:turns-per-ip-hour': {
    name: 'IP 每小时轮次',
    description: '单 IP 每小时允许的智能体轮次',
    group: 'agent',
    unit: 'count',
  },
  'agent:request-max-bytes': {
    name: '请求大小上限',
    description: '智能体请求体大小上限',
    group: 'agent',
    unit: 'bytes',
    max: 256 * 1024 ** 2,
  },
  'quota:daily': { name: '每日额度', description: '启用每日生成额度', group: 'generation' },
}

const registryEntry = (
  key: string,
  kind: OperatorValueKind,
  _defaultValue: boolean | number,
): OperatorRegistryEntry => {
  const extra = OPERATOR_METADATA[key] ?? {}
  const editability: OperatorEditability =
    key === 'operator:console'
      ? 'read-only'
      : ['billing:credits', 'accounts:login', 'accounts:sync', 'agent:chat'].includes(key)
        ? 'boot'
        : 'hot'
  const dependencies =
    key === 'accounts:self-register'
      ? ['accounts:login']
      : key === 'accounts:email-verification'
        ? ['accounts:self-register']
        : key === 'cli:api'
          ? ['accounts:sync']
          : []
  return {
    key,
    kind,
    name: extra.name ?? key,
    description: extra.description ?? `运营配置：${key}`,
    group: extra.group ?? key.split(':', 1)[0] ?? 'other',
    editability,
    risk:
      extra.risk ??
      (key.startsWith('billing:') || key === 'quota:daily' || kind === 'quota' ? 'high' : 'low'),
    ...(kind === 'quota'
      ? {
          unit: extra.unit ?? 'count',
          min: extra.min ?? 0,
          max: extra.max ?? Number.MAX_SAFE_INTEGER,
        }
      : {}),
    dependencies: extra.dependencies ?? dependencies,
  }
}

/** Single source of truth for operator-facing metadata; keys are exhaustive by construction. */
export const OPERATOR_REGISTRY: Readonly<Record<string, OperatorRegistryEntry>> = Object.freeze({
  ...Object.fromEntries(
    Object.entries(CAPABILITIES).map(([key, value]) => [
      key,
      registryEntry(key, 'capability', value.defaultValue),
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(QUOTAS).map(([key, value]) => [
      key,
      registryEntry(key, 'quota', value.defaultValue),
    ]),
  ),
})

export function operatorRegistryEntry(key: string): OperatorRegistryEntry | undefined {
  return OPERATOR_REGISTRY[key]
}

export type QuotaKey = keyof typeof QUOTAS
export type QuotaValues = { readonly [Key in QuotaKey]: number }
