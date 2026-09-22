/**
 * PROTOTYPE — 后台 v2 交互稿共用的假数据。只读、纯内存，不接任何 API。
 *
 * 三个变体（VariantA / B / C）都从这里取数据，保证它们比的是「布局与交互」，不是内容。
 * 词汇跟 CONTEXT.md：概览 / 运维看板 / 心跳 / 告警 / 部署记录 / 运营者 / 技能 / 探索。
 */

export const BRAND = {
  ink: '#23282B',
  sprout: '#DBFFA0',
  mint: '#83EEB0',
} as const

export type Tone = 'up' | 'down' | 'flat'

export interface Kpi {
  key: string
  label: string
  value: string
  delta?: string
  tone?: Tone
  hint?: string
}

export const KPIS: readonly Kpi[] = [
  { key: 'tasks', label: '任务量 (24h)', value: '1,284', delta: '+12.4%', tone: 'up' },
  { key: 'success', label: '成功率', value: '96.8%', delta: '-0.6pt', tone: 'down' },
  { key: 'p50', label: 'P50 耗时', value: '14.2s', delta: '+1.1s', tone: 'down' },
  { key: 'devices', label: '活跃设备', value: '412', delta: '+31', tone: 'up' },
  { key: 'signups', label: '新注册', value: '27', delta: '+9', tone: 'up' },
  { key: 'credits', label: '积分消耗', value: '38.6k', delta: '+8.9%', tone: 'up', hint: '私有树' },
]

export interface VolumePoint {
  t: string
  ok: number
  failed: number
}

export const VOLUME_SERIES: readonly VolumePoint[] = Array.from({ length: 24 }, (_, h) => {
  const base = 30 + Math.round(28 * Math.sin((h / 24) * Math.PI * 2 - 1.2) + 20)
  const failed = h === 9 || h === 10 ? 9 : h % 5 === 0 ? 3 : 1
  return { t: `${String(h).padStart(2, '0')}:00`, ok: Math.max(8, base), failed }
})

export interface ModelUsage {
  model: string
  provider: 'openai-compat' | 'gemini'
  count: number
  share: number
  p50Ms: number
}

export const MODEL_USAGE: readonly ModelUsage[] = [
  {
    model: 'gpt-image-2.5-flare',
    provider: 'openai-compat',
    count: 812,
    share: 0.63,
    p50Ms: 13800,
  },
  { model: 'gpt-image-2', provider: 'openai-compat', count: 261, share: 0.2, p50Ms: 17400 },
  { model: 'nano-banana-2', provider: 'gemini', count: 158, share: 0.12, p50Ms: 9100 },
  { model: 'veo-3.1', provider: 'gemini', count: 53, share: 0.05, p50Ms: 61200 },
]

export interface FailureBucket {
  reason: string
  count: number
  sample: string
}

export const FAILURES: readonly FailureBucket[] = [
  { reason: 'content_policy', count: 21, sample: 'tsk_9f2a…' },
  { reason: 'upstream_timeout', count: 11, sample: 'tsk_71bc…' },
  { reason: 'upstream_5xx', count: 6, sample: 'tsk_02de…' },
  { reason: 'invalid_reference', count: 3, sample: 'tsk_5a11…' },
]

export type AlertLevel = 'critical' | 'warning' | 'info'

export interface Alert {
  id: string
  level: AlertLevel
  title: string
  detail: string
  at: string
  source: 'host' | 'queue' | 'backup' | 'api' | 'billing'
}

export const ALERTS: readonly Alert[] = [
  {
    id: 'al-1',
    level: 'critical',
    title: '宿主机磁盘 91%',
    detail: '/var/lib/docker 剩余 7.2 GB，低于 8 GB 阈值',
    at: '3 分钟前',
    source: 'host',
  },
  {
    id: 'al-2',
    level: 'warning',
    title: '队列有 4 条任务卡住 > 10 分钟',
    detail: 'worker r1727 上 4 条 processing 无心跳',
    at: '12 分钟前',
    source: 'queue',
  },
  {
    id: 'al-3',
    level: 'warning',
    title: '5xx 比例 2.1%（近 5 分钟）',
    detail: 'POST /v1/queue/openai-queue/gpt-image-2.5-flare/submit',
    at: '25 分钟前',
    source: 'api',
  },
  {
    id: 'al-4',
    level: 'info',
    title: '昨日 pg_dump 完成',
    detail: '412 MB → R2 backups/2026-09-21.sql.gz',
    at: '今天 03:10',
    source: 'backup',
  },
]

export interface Service {
  name: 'bff' | 'worker' | 'admin' | 'host-collector' | 'pg-backup' | 'cloudflared'
  status: 'up' | 'down' | 'degraded'
  version: string
  heartbeat: string
  instances?: number
}

export const SERVICES: readonly Service[] = [
  { name: 'bff', status: 'up', version: '8c52e2bb+1a9f0c2', heartbeat: '8 秒前', instances: 2 },
  {
    name: 'worker',
    status: 'degraded',
    version: '8c52e2bb+1a9f0c2',
    heartbeat: '9 分钟前',
    instances: 2,
  },
  { name: 'admin', status: 'up', version: '8c52e2bb+1a9f0c2', heartbeat: '12 秒前' },
  { name: 'host-collector', status: 'up', version: '8c52e2bb', heartbeat: '41 秒前' },
  { name: 'pg-backup', status: 'up', version: '8c52e2bb', heartbeat: '今天 03:10' },
  { name: 'cloudflared', status: 'up', version: '2026.9.1', heartbeat: '—' },
]

export interface HostSample {
  disk: { used: number; total: number }
  memory: { used: number; total: number }
  cpu: number
  load: string
  uptime: string
  swap: { used: number; total: number }
}

export const HOST: HostSample = {
  disk: { used: 72.8, total: 80 },
  memory: { used: 5.9, total: 8 },
  cpu: 0.37,
  load: '1.42 / 1.18 / 0.96',
  uptime: '41 天',
  swap: { used: 0.4, total: 2 },
}

export interface HostPoint {
  t: string
  disk: number
  memory: number
  cpu: number
}

export const HOST_SERIES: readonly HostPoint[] = Array.from({ length: 48 }, (_, i) => ({
  t: `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
  disk: 0.86 + i * 0.001,
  memory: 0.62 + 0.1 * Math.sin(i / 5),
  cpu: 0.25 + 0.2 * Math.abs(Math.sin(i / 3)),
}))

export interface Deployment {
  id: string
  at: string
  edition: 'paid' | 'internal'
  publicSha: string
  privateSha?: string
  result: 'ok' | 'failed'
  actor: string
}

export const DEPLOYMENTS: readonly Deployment[] = [
  {
    id: 'd-1',
    at: '今天 10:42',
    edition: 'paid',
    publicSha: '8c52e2bb',
    privateSha: '1a9f0c2',
    result: 'ok',
    actor: 'github-actions/run-9812',
  },
  {
    id: 'd-2',
    at: '昨天 22:15',
    edition: 'paid',
    publicSha: '4d31365b',
    privateSha: '1a9f0c2',
    result: 'ok',
    actor: 'github-actions/run-9790',
  },
  {
    id: 'd-3',
    at: '昨天 18:03',
    edition: 'internal',
    publicSha: '4d31365b',
    result: 'failed',
    actor: 'github-actions/run-9786',
  },
]

export type UserStatus = 'active' | 'disabled'

export interface User {
  id: string
  email: string
  displayName: string
  status: UserStatus
  plan: '免费' | '月付' | '年付'
  credits: number
  tasks30d: number
  lastActiveAt: string
  createdAt: string
  invitedBy?: string
}

export const USERS: readonly User[] = [
  {
    id: 'u_01',
    email: 'lin.zhou@example.com',
    displayName: '林舟',
    status: 'active',
    plan: '年付',
    credits: 18240,
    tasks30d: 412,
    lastActiveAt: '2 分钟前',
    createdAt: '2026-06-02',
  },
  {
    id: 'u_02',
    email: 'mia.chen@example.com',
    displayName: 'Mia',
    status: 'active',
    plan: '月付',
    credits: 2130,
    tasks30d: 96,
    lastActiveAt: '18 分钟前',
    createdAt: '2026-08-14',
    invitedBy: 'u_01',
  },
  {
    id: 'u_03',
    email: 'studio.k@example.com',
    displayName: 'K Studio',
    status: 'active',
    plan: '免费',
    credits: 60,
    tasks30d: 12,
    lastActiveAt: '1 小时前',
    createdAt: '2026-09-19',
  },
  {
    id: 'u_04',
    email: 'yang.ec@example.com',
    displayName: '阿杨（电商）',
    status: 'active',
    plan: '月付',
    credits: 940,
    tasks30d: 233,
    lastActiveAt: '3 小时前',
    createdAt: '2026-07-21',
  },
  {
    id: 'u_05',
    email: 'spam-bot@example.com',
    displayName: '—',
    status: 'disabled',
    plan: '免费',
    credits: 0,
    tasks30d: 0,
    lastActiveAt: '12 天前',
    createdAt: '2026-09-08',
  },
]

export type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  id: string
  deviceId: string
  userId?: string
  model: string
  status: TaskStatus
  createdAt: string
  durationMs?: number
  thumbnailUrl?: string
  prompt: string
  errorCode?: string
}

export const TASKS: readonly Task[] = [
  {
    id: 'tsk_9f2a3c',
    deviceId: 'dev_b71c',
    userId: 'u_01',
    model: 'gpt-image-2.5-flare',
    status: 'failed',
    createdAt: '10:58',
    durationMs: 3200,
    prompt: '生成一张「足球主题电影海报」风格的高清写真海报…',
    errorCode: 'content_policy',
  },
  {
    id: 'tsk_71bc00',
    deviceId: 'dev_02aa',
    userId: 'u_04',
    model: 'gpt-image-2.5-flare',
    status: 'processing',
    createdAt: '10:57',
    prompt: '白底产品主图，三视图，柔光棚拍…',
  },
  {
    id: 'tsk_02de91',
    deviceId: 'dev_02aa',
    userId: 'u_04',
    model: 'nano-banana-2',
    status: 'completed',
    createdAt: '10:55',
    durationMs: 8800,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case7.jpg?w=320&q=85',
    prompt: '生成一张竖版手机截图风格的图片…',
  },
  {
    id: 'tsk_5a1177',
    deviceId: 'dev_f0e3',
    model: 'gpt-image-2',
    status: 'completed',
    createdAt: '10:51',
    durationMs: 16100,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case11.jpg?w=320&q=85',
    prompt: '一张手绘风格的城市美食地图，以台州为主题…',
  },
  {
    id: 'tsk_c3d4e5',
    deviceId: 'dev_b71c',
    userId: 'u_01',
    model: 'veo-3.1',
    status: 'queued',
    createdAt: '10:50',
    prompt: '产品主视频，5 秒，环绕镜头…',
  },
  {
    id: 'tsk_8811aa',
    deviceId: 'dev_9c9c',
    userId: 'u_02',
    model: 'gpt-image-2.5-flare',
    status: 'completed',
    createdAt: '10:44',
    durationMs: 12900,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case6.jpg?w=320&q=85',
    prompt: '参考图是角色人设图，为参考图的少女绘制一副日系唯美奇幻风格插画…',
  },
]

/** 灵感库条目：运营维护，主站「探索」直接读。 */
export type InspirationKind = 'showcase' | 'template' | 'skill'
export type InspirationStatus = 'draft' | 'published' | 'archived'

export interface Inspiration {
  id: string
  kind: InspirationKind
  title: string
  description?: string
  category: string
  status: InspirationStatus
  featured: boolean
  thumbnailUrl: string
  prompt: string
  recommendedModel: string
  recommendedProvider: 'openai-compat' | 'gemini'
  params: { size: string; quality?: 'auto' | 'low' | 'medium' | 'high'; n?: number }
  tags: string[]
  /** 挂一条部署技能：玩同款时进画布并以 `/skill` 起手 */
  skill?: string
  /** 玩同款时预填的参考图（公开桶 URL） */
  referenceImages: { url: string; name: string }[]
  /** 模板类才有：槽位名 */
  slots?: string[]
  updatedAt: string
  updatedBy: string
  plays7d: number
}

export const CATEGORIES: readonly string[] = [
  '精选',
  '海报与字体',
  '插画与艺术',
  '人物与角色',
  '建筑与空间',
  '图表与信息图',
  '场景与叙事',
  'UI 与界面',
  '产品与电商',
]

export const INSPIRATIONS: readonly Inspiration[] = [
  {
    id: 'insp-3',
    kind: 'showcase',
    title: '足球主题电影海报',
    category: '海报与字体',
    status: 'published',
    featured: true,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case3.jpg?w=320&q=85',
    prompt:
      '生成一张「足球主题电影海报」风格的高清写真海报：国际米兰后卫巴斯托尼站在圣西罗球场中央激情庆祝，双手高举并披着波黑国旗，神情热血、坚定、自信，现场灯光璀璨。',
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    params: { size: '1024x1536', quality: 'high', n: 1 },
    tags: ['海报', '写实', '人物'],
    referenceImages: [],
    updatedAt: '今天 09:12',
    updatedBy: 'qiqian',
    plays7d: 318,
  },
  {
    id: 'insp-6',
    kind: 'showcase',
    title: '插画艺术创作图',
    category: '插画与艺术',
    status: 'published',
    featured: true,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case6.jpg?w=320&q=85',
    prompt:
      '参考图是角色人设图，为参考图的少女绘制一副日系唯美奇幻风格插画。【构图】宏大的中景日系奇幻插画构图，画面中心是完全保留了完整细节的可爱少女。',
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    params: { size: '1024x1536', quality: 'high', n: 1 },
    tags: ['插画', '人物', '创意'],
    referenceImages: [
      {
        url: 'https://cms-r2.deepclick.com/image-playground/case27.jpg?w=320&q=85',
        name: '角色人设图',
      },
    ],
    updatedAt: '昨天 17:40',
    updatedBy: 'qiqian',
    plays7d: 204,
  },
  {
    id: 'insp-8',
    kind: 'template',
    title: '科普百科图',
    description: '填一个主题，产出模块化的竖版科普信息图。',
    category: '图表与信息图',
    status: 'published',
    featured: true,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case8.jpg?w=320&q=85',
    prompt:
      '根据【{主题}】生成一张高质量竖版「科普百科图」。这张图不是普通海报，而是一张兼具图鉴感、百科感、信息结构感和收藏感的模块化科普信息图。',
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    params: { size: '1024x1536', quality: 'medium', n: 2 },
    tags: ['信息图', '教育'],
    slots: ['主题'],
    referenceImages: [],
    updatedAt: '2 天前',
    updatedBy: 'qiqian',
    plays7d: 156,
  },
  {
    id: 'insp-11',
    kind: 'showcase',
    title: '手绘城市美食地图',
    category: '建筑与空间',
    status: 'published',
    featured: false,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case11.jpg?w=320&q=85',
    prompt:
      '一张手绘风格的城市美食地图，以台州为主题。画面以鸟瞰视角的手绘简化城市地图为底，标注椒江、路桥、黄岩等区域和灵江、台州湾等水系地标。',
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    params: { size: '1536x1024', quality: 'high', n: 1 },
    tags: ['插画', '旅行'],
    referenceImages: [],
    updatedAt: '3 天前',
    updatedBy: 'qiqian',
    plays7d: 87,
  },
  {
    id: 'insp-27',
    kind: 'showcase',
    title: '人物角色设定图',
    category: '人物与角色',
    status: 'published',
    featured: false,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case27.jpg?w=320&q=85',
    prompt:
      '{ "type": "collection of instant photos", "setting": "laid out flat on a white table", "subject": "the same character in six outfits" }',
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    params: { size: 'auto', n: 1 },
    tags: ['写实', '人物'],
    skill: 'character-sheet',
    referenceImages: [],
    updatedAt: '4 天前',
    updatedBy: 'qiqian',
    plays7d: 132,
  },
  {
    id: 'insp-182',
    kind: 'showcase',
    title: '千禧年日系校园喜剧场景',
    category: '场景与叙事',
    status: 'draft',
    featured: false,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case182.jpg?w=320&q=85',
    prompt: '2000 年代面向中学生的日剧喜剧场景，胶片颗粒，暖色调，教室窗边。',
    recommendedModel: 'nano-banana-2',
    recommendedProvider: 'gemini',
    params: { size: 'auto', n: 1 },
    tags: ['场景', '故事'],
    referenceImages: [],
    updatedAt: '1 小时前',
    updatedBy: 'qiqian',
    plays7d: 0,
  },
  {
    id: 'insp-poster',
    kind: 'skill',
    title: '海报与营销物料',
    description: '做一张带标题文案的海报或活动主视觉（部署技能 /poster）',
    category: '海报与字体',
    status: 'published',
    featured: false,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case9.jpg?w=320&q=85',
    prompt: '/poster 2026 中国城市系列宣传海报，主题为【北京】，国潮风，竖版 9:16。',
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    params: { size: '1024x1536', quality: 'high', n: 1 },
    tags: ['海报', '技能'],
    skill: 'poster',
    referenceImages: [],
    updatedAt: '5 天前',
    updatedBy: 'qiqian',
    plays7d: 61,
  },
  {
    id: 'insp-product',
    kind: 'skill',
    title: '电商主图',
    description: '白底三视图 → 带场景的主图（部署技能 /product-main-image）',
    category: '产品与电商',
    status: 'published',
    featured: false,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case7.jpg?w=320&q=85',
    prompt: '/product-main-image 把这双运动鞋放到清晨的城市街头，保留鞋型与配色。',
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    params: { size: '1024x1024', quality: 'high', n: 2 },
    tags: ['电商', '技能'],
    skill: 'product-main-image',
    referenceImages: [
      {
        url: 'https://cms-r2.deepclick.com/image-playground/case4.jpg?w=320&q=85',
        name: '产品白底图',
      },
    ],
    updatedAt: '1 周前',
    updatedBy: 'qiqian',
    plays7d: 44,
  },
  {
    id: 'insp-old',
    kind: 'showcase',
    title: '老干妈风味',
    category: 'UI 与界面',
    status: 'archived',
    featured: false,
    thumbnailUrl: 'https://cms-r2.deepclick.com/image-playground/case4.jpg?w=320&q=85',
    prompt: '直播间卖老干妈，科技感背景，弹幕飘过。',
    recommendedModel: 'gpt-image-2',
    recommendedProvider: 'openai-compat',
    params: { size: 'auto', n: 1 },
    tags: ['社交'],
    referenceImages: [],
    updatedAt: '2 周前',
    updatedBy: 'qiqian',
    plays7d: 3,
  },
]

export interface Skill {
  name: string
  title: string
  summary: string
  icon: string
  mode: 'image' | 'video'
  linkedInspirations: number
}

/** 部署技能目录（来自 BFF `GET /api/agent/skills`，文件随镜像发布，后台只读） */
export const SKILLS: readonly Skill[] = [
  {
    name: 'poster',
    title: '海报与营销物料',
    summary: '做一张带标题文案的海报或活动主视觉',
    icon: 'image-plus',
    mode: 'image',
    linkedInspirations: 1,
  },
  {
    name: 'product-main-image',
    title: '电商主图',
    summary: '白底产品图变成带场景的主图',
    icon: 'shopping-bag',
    mode: 'image',
    linkedInspirations: 1,
  },
  {
    name: 'character-sheet',
    title: '角色设定图',
    summary: '同一角色的多视角与表情设定',
    icon: 'user-round',
    mode: 'image',
    linkedInspirations: 1,
  },
  {
    name: 'scene-swap',
    title: '换场景',
    summary: '保留主体，换背景与光线',
    icon: 'mountain',
    mode: 'image',
    linkedInspirations: 0,
  },
  {
    name: 'image-localize',
    title: '图片本地化',
    summary: '替换图中文字并保持排版',
    icon: 'languages',
    mode: 'image',
    linkedInspirations: 0,
  },
  {
    name: 'product-main-video',
    title: '产品主视频',
    summary: '5 秒环绕展示视频',
    icon: 'clapperboard',
    mode: 'video',
    linkedInspirations: 0,
  },
]

export interface PendingPayment {
  id: string
  userId: string
  email: string
  amountCents: number
  kind: '充值' | '开通月付' | '续费年付'
  createdAt: string
}

/** 私有树：待运营确认的收款（后台只是展示与代理写 BFF） */
export const PENDING_PAYMENTS: readonly PendingPayment[] = [
  {
    id: 'pay_1',
    userId: 'u_03',
    email: 'studio.k@example.com',
    amountCents: 9900,
    kind: '开通月付',
    createdAt: '11:02',
  },
  {
    id: 'pay_2',
    userId: 'u_04',
    email: 'yang.ec@example.com',
    amountCents: 19900,
    kind: '充值',
    createdAt: '09:47',
  },
]

export interface AuditEntry {
  id: string
  at: string
  operator: string
  action: string
  target: string
}

export const AUDITS: readonly AuditEntry[] = [
  {
    id: 'a1',
    at: '10:41',
    operator: 'qiqian',
    action: '发布灵感',
    target: 'insp-3 足球主题电影海报',
  },
  {
    id: 'a2',
    at: '10:12',
    operator: 'qiqian',
    action: '确认收款 ¥199',
    target: 'u_04 阿杨（电商）',
  },
  {
    id: 'a3',
    at: '昨天 22:20',
    operator: 'qiqian',
    action: '修改模型价格',
    target: 'gpt-image-2.5-flare',
  },
  { id: 'a4', at: '昨天 18:05', operator: 'qiqian', action: '停用用户', target: 'u_05 spam-bot' },
]

export function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(0)}`
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}
