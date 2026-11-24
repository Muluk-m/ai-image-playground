import type { Deployment } from './deployment'

/**
 * 配置清单（ADR 0035）：每个配置项在这里登记一次。
 *
 * - `SECRETS`：放 Cloudflare Secrets Store 的值，按部署分别存（`PROD__X`、`TEST__X`）。
 * - `SETTINGS`：每个服务容器里的变量，值来自固定值、部署描述、密钥或推导。
 * - `TUNABLES`：允许在部署描述 `tunables` 里覆盖的业务调参；不写就用代码默认值。
 *
 * 发布时 `config render` 按这里为每个服务生成一份 env，服务只拿到自己登记过的键。
 */

export const SERVICES = [
  'bff',
  'worker',
  'migrate',
  'dependency-check',
  'admin',
  'web',
  'host-collector',
  'pg-backup',
  'obs-proxy',
  'openobserve',
  'otel-collector',
  'postgres-provision',
] as const
export type Service = (typeof SERVICES)[number]

/** bff 和 worker 跑同一份代码（apps/bff/src/config.ts），配置相同。 */
const APP = ['bff', 'worker'] as const satisfies readonly Service[]

// ---------------------------------------------------------------------------
// 密钥
// ---------------------------------------------------------------------------

export interface SecretDef {
  /** Secrets Store 里去掉部署前缀的名字；直接下发时也是容器里的变量名。 */
  name: string
  doc: string
  /** 这个部署必须有它；返回 false 表示可选。 */
  required: (d: Deployment) => boolean
}

const always = () => true
const optional = () => false
const withObservability = (d: Deployment) => d.observability !== undefined

export const SECRETS: readonly SecretDef[] = [
  // 数据库：三个角色的密码，连接串由它们拼出来。
  { name: 'POSTGRES_APP_PASSWORD', doc: 'bff/worker 的读写角色', required: always },
  { name: 'POSTGRES_ADMIN_PASSWORD', doc: 'Admin 和备份用的只读角色', required: always },
  { name: 'POSTGRES_MIGRATOR_PASSWORD', doc: '迁移角色（库的 owner）', required: always },
  // 对象存储（用户文件、备份）。endpoint 里带账号 ID，所以也当密钥。
  { name: 'S3_ENDPOINT', doc: 'R2 S3 endpoint', required: always },
  { name: 'S3_ACCESS_KEY_ID', doc: 'R2 访问密钥 ID', required: always },
  { name: 'S3_SECRET_ACCESS_KEY', doc: 'R2 访问密钥', required: always },
  // 服务之间、登录与邮件。
  {
    name: 'INTERNAL_API_TOKEN',
    doc: 'Admin、host-collector 调 bff 内部接口的令牌',
    required: always,
  },
  { name: 'EMAIL_CODE_SECRET', doc: '邮箱验证码 HMAC 密钥', required: always },
  {
    name: 'RESEND_API_KEY',
    doc: '发信（Resend）；开了邮箱验证码就必填，bff 启动时会检查',
    required: (d) => d.operator.capabilities['accounts:email-verification'] === true,
  },
  {
    name: 'OAUTH_GOOGLE_CLIENT_SECRET',
    doc: '用户 Google 登录',
    required: (d) => d.auth.googleClientId !== undefined,
  },
  {
    name: 'OAUTH_FEISHU_CLIENT_SECRET',
    doc: '用户飞书登录',
    required: (d) => d.auth.feishuClientId !== undefined,
  },
  {
    name: 'UPSTREAM_SECRETS_MASTER_KEY',
    doc: '后台「上游密钥」入库加密用的主密钥',
    required: optional,
  },
  // Admin。
  { name: 'ADMIN_COOKIE_SECRET', doc: 'Admin 会话 cookie 签名（至少 32 字符）', required: always },
  {
    name: 'ADMIN_PASSWORD',
    doc: 'Admin 密码登录（没配 Google 登录时必填）',
    required: (d) => d.admin.googleClientId === undefined,
  },
  {
    name: 'ADMIN_GOOGLE_CLIENT_SECRET',
    doc: 'Admin Google 登录',
    required: (d) => d.admin.googleClientId !== undefined,
  },
  {
    name: 'ADMIN_GOOGLE_ALLOWED_EMAILS',
    doc: '允许登录 Admin 的邮箱，逗号分隔（个人信息，不进仓库）',
    required: (d) => d.admin.googleClientId !== undefined,
  },
  // 上游模型网关与服务商。env 里的服务商密钥只是首次启动的来源，后台「上游密钥」页存了就以库里的为准。
  { name: 'UPSTREAM_BASE_URL', doc: 'sub2api 网关地址', required: optional },
  { name: 'UPSTREAM_API_KEY', doc: 'sub2api 默认密钥', required: optional },
  { name: 'UPSTREAM_OPENAI_API_KEY', doc: 'sub2api OpenAI 分组密钥', required: optional },
  { name: 'UPSTREAM_CLAUDE_API_KEY', doc: 'sub2api Claude 分组密钥', required: optional },
  { name: 'UPSTREAM_GEMINI_API_KEY', doc: 'sub2api Gemini 分组密钥', required: optional },
  { name: 'OPENAI_API_KEY', doc: 'GPT Image OpenAI 直连', required: optional },
  { name: 'OPENAI_API_KEYS', doc: 'OpenAI 直连多把密钥（逗号分隔）', required: optional },
  { name: 'OPENAI_API_KEY_BUDGETS_USD', doc: '多把直连密钥各自的月预算', required: optional },
  { name: 'OPENAI_ADMIN_KEY', doc: '查 OpenAI 官方账单', required: optional },
  { name: 'OPENAI_ORG_ID', doc: 'OpenAI 组织 ID', required: optional },
  { name: 'GEMINI_API_KEY', doc: 'Gemini 原生', required: optional },
  { name: 'VERTEX_API_KEY', doc: 'Vertex', required: optional },
  {
    name: 'VERTEX_API_KEYS',
    doc: 'Gemini 直连密钥池（逗号分隔；后台没存密钥时才用）',
    required: optional,
  },
  { name: 'VERTEX_BASE_URL', doc: 'Vertex 端点（带 GCP 项目名）', required: optional },
  { name: 'GROK_API_KEY', doc: 'Grok', required: optional },
  { name: 'GROK_BASE_URL', doc: 'Grok 网关地址', required: optional },
  { name: 'AGNES_API_KEY', doc: 'Agnes', required: optional },
  { name: 'ARK_API_KEY', doc: '火山方舟', required: optional },
  { name: 'ARK_BASE_URL', doc: '火山方舟网关地址', required: optional },
  { name: 'VEO_API_KEY', doc: 'Veo', required: optional },
  // 告警。webhook 地址里带令牌。
  { name: 'OPS_ALERT_WEBHOOK_URL', doc: '订单通知与告警的单个 webhook（旧）', required: optional },
  { name: 'OPS_ALERT_WEBHOOK_URLS', doc: '告警 webhook，逗号分隔', required: optional },
  { name: 'OPS_ALERT_WEBHOOK_HEADERS', doc: '告警 webhook 请求头（JSON）', required: optional },
  // 可观测性（ADR 0033）。只给 openobserve、otel-collector、obs-proxy。
  { name: 'OBS_ROOT_EMAIL', doc: 'OpenObserve root 账号', required: withObservability },
  { name: 'OBS_ROOT_PASSWORD', doc: 'OpenObserve root 密码', required: withObservability },
  { name: 'OBS_PROXY_TOKEN', doc: '只读查询代理的令牌', required: withObservability },
  { name: 'OBS_S3_ENDPOINT', doc: '日志库 R2 endpoint', required: withObservability },
  { name: 'OBS_S3_ACCESS_KEY_ID', doc: '日志库 R2 访问密钥 ID', required: withObservability },
  { name: 'OBS_S3_SECRET_ACCESS_KEY', doc: '日志库 R2 访问密钥', required: withObservability },
  // Cloudflare Tunnel。
  {
    name: 'TUNNEL_CREDENTIALS',
    doc: '本部署 Tunnel 的 cloudflared credentials.json（JSON）',
    required: always,
  },
  {
    name: 'ENTERPRISE_TUNNEL_CREDENTIALS',
    doc: '企业域名 Tunnel 的 cloudflared credentials.json（JSON）',
    required: (d) => d.tunnels.enterprise !== undefined,
  },
]

/** 宿主机级密钥，Secrets Store 里以 `HOST__` 开头。 */
export const HOST_SECRETS: readonly Omit<SecretDef, 'required'>[] = [
  { name: 'POSTGRES_PASSWORD', doc: '共享 PostgreSQL 超级用户密码' },
  { name: 'GHCR_PULL_TOKEN', doc: '从私有 GHCR 拉镜像的只读令牌' },
]

const SECRET_NAMES = new Set(SECRETS.map((one) => one.name))

/** Secrets Store 里的名字：`PROD__S3_SECRET_ACCESS_KEY`、`HOST__POSTGRES_PASSWORD`。 */
export function secretStoreName(scope: Deployment['name'] | 'host', name: string): string {
  return `${scope.toUpperCase()}__${name}`
}

// ---------------------------------------------------------------------------
// 业务调参
// ---------------------------------------------------------------------------

/** 允许部署描述覆盖的调参，全部只给 bff/worker；默认值在代码里（ADR 0035 P4 收进清单）。 */
export const TUNABLES: Readonly<Record<string, string>> = {
  AGENT_CHAT_MODEL: '主对话模型',
  AGENT_CHAT_CONTEXT_WINDOW: '主对话上下文窗口（token）',
  AGENT_CHAT_MAX_TOKENS: '主对话单次输出上限',
  AGENT_SUMMARY_MODEL: '压缩摘要模型',
  AGENT_SUMMARY_CONTEXT_WINDOW: '摘要模型上下文窗口',
  AGENT_FOLLOWUP_MODEL: '追问建议模型',
  AGENT_SEARCH_MODEL: '搜索模型',
  AGENT_IMAGE_MODEL: 'Agent 默认生图模型',
  AGENT_VIDEO_MODEL: 'Agent 默认视频模型',
  AGENT_SEGMENTATION_PROVIDER: '服务端分割：edgetam 或 off',
  WORKER_POLL_INTERVAL_MS: 'worker 取任务间隔',
  WORKER_HEALTH_STALE_AFTER_MS: 'worker 心跳多久算失联',
  WORKER_IDLE_CONCURRENCY_ENABLED: '空闲时放宽并发',
  WORKER_OPENAI_CONCURRENCY: 'OpenAI 兼容通道并发',
  WORKER_GEMINI_CONCURRENCY: 'Gemini 通道并发',
  WORKER_DRAIN_TIMEOUT_MS: '停机排空等待',
  UPSTREAM_ASYNC_IMAGE_TASKS: 'sub2api 用异步图片任务',
  UPSTREAM_IMAGE_RESPONSES_MODEL: '走 Responses 接口出图的模型',
  GPT_DIRECT_ENABLED: 'GPT Image 直连开关',
  GPT_DIRECT_BASE_URL: '直连地址',
  GPT_DIRECT_MONTHLY_BUDGET_USD: '直连月预算（美元）',
  GEMINI_DIRECT_MONTHLY_BUDGET_USD: 'Gemini 直连月预算（美元）',
  GEMINI_DIRECT_BUDGET_PERCENT: 'Gemini 直连预算可用比例（%）',
  GEMINI_DIRECT_COOLDOWN_MS: 'Gemini 直连密钥出错后的冷却（毫秒）',
  VERTEX_API_KEY_BUDGETS_USD: 'VERTEX_API_KEYS 每个密钥的月预算（美元，逗号分隔）',
  GPT_DIRECT_BUDGET_PERCENT: '直连预算使用上限（%）',
  GPT_DIRECT_IPM: '直连每分钟出图数',
  GPT_DIRECT_ORG_IPM: '直连组织级每分钟出图数',
  GPT_DIRECT_CONCURRENCY: '直连并发',
  GPT_DIRECT_ATTEMPT_TIMEOUT_MS: '直连单次超时',
  GPT_DIRECT_PRICE_INPUT_TEXT: '直连文本输入单价（每百万 token）',
  GPT_DIRECT_PRICE_INPUT_IMAGE: '直连图片输入单价',
  GPT_DIRECT_PRICE_OUTPUT: '直连输出单价',
  GPT_SUB2API_CONCURRENCY: 'sub2api GPT 并发',
  GPT_SUB2API_ATTEMPT_TIMEOUT_MS: 'sub2api 单次超时',
  GPT_SUB2API_BREAKER_FAILURES: 'sub2api 熔断失败次数',
  GPT_SUB2API_BREAKER_COOLDOWN_MS: 'sub2api 熔断冷却',
  GPT_IMAGE_26_ENABLED: 'GPT Image 2.6 开关',
  GPT_IMAGE_26_SVG_MODEL: 'GPT Image 2.6 SVG 模型',
  GPT_IMAGE_26_SUB2API_FLARE: '2.6 flare 在 sub2api 上的模型名',
  GPT_IMAGE_26_SUB2API_SUNBURST: '2.6 sunburst 在 sub2api 上的模型名',
  SCHEDULER_NAMESPACE: '调度租约命名空间',
  SCHEDULER_LEASE_TTL_MS: '调度租约有效期',
  SCHEDULER_HEARTBEAT_MS: '调度心跳',
  SCHEDULER_RATE_LIMIT_COOLDOWN_MS: '限流冷却',
  VERTEX_RATE_LIMIT_FALLBACK_MODEL: 'Vertex 限流时的回退模型',
  VERTEX_FALLBACK_AFTER_MS: 'Vertex 回退持续时间',
  VERTEX_RATE_LIMIT_BACKOFF_MS: 'Vertex 限流退避',
  WELCOME_CREDITS: '新用户赠送积分',
  BILLING_RECHARGE_AMOUNTS_YUAN: '充值档位（元）',
  BILLING_RECHARGE_CREDITS_PER_YUAN: '每元积分',
  DEPLOYMENT_TIMEZONE: '账单按哪个时区切日',
  LOG_LEVEL: '日志级别',
  OTEL_TRACES_SAMPLE_RATIO: '链路采样比例',
}

// ---------------------------------------------------------------------------
// 每个服务的变量
// ---------------------------------------------------------------------------

export interface RenderContext {
  deployment: Deployment
  /** 取本部署的密钥；没存就是 undefined。 */
  secret: (name: string) => string | undefined
}

export interface SettingDef {
  env: string
  services: readonly Service[]
  doc: string
  /** 返回 undefined 表示这个部署不下发该键（服务用自己的默认值）。 */
  value: (ctx: RenderContext) => string | undefined
}

const fixed = (value: string) => () => value
const secret = (name: string) => {
  if (!SECRET_NAMES.has(name)) throw new Error(`catalog: unknown secret ${name}`)
  return (ctx: RenderContext) => ctx.secret(name)
}
const list = (values: readonly string[]) => values.join(',')
const webOrigins = (d: Deployment) => Object.keys(d.web.origins)

function databaseUrl(role: 'app' | 'admin' | 'migrator', options?: { directOnly?: boolean }) {
  const passwordName = {
    app: 'POSTGRES_APP_PASSWORD',
    admin: 'POSTGRES_ADMIN_PASSWORD',
    migrator: 'POSTGRES_MIGRATOR_PASSWORD',
  }[role]
  return (ctx: RenderContext) => {
    const password = ctx.secret(passwordName)
    if (password === undefined) return undefined
    const { name, users, pooler } = ctx.deployment.database
    const hostPort =
      !options?.directOnly && role === 'app' && pooler ? 'pgbouncer:6432' : 'postgres:5432'
    return `postgresql://${users[role]}:${encodeURIComponent(password)}@${hostPort}/${name}`
  }
}

function loginMethodsByOrigin(d: Deployment): string {
  const entries = Object.entries(d.web.origins).flatMap(([origin, one]) =>
    one.login ? [[origin, one.login] as const] : [],
  )
  return JSON.stringify(Object.fromEntries(entries))
}

const observability =
  (get: (o: NonNullable<Deployment['observability']>, ctx: RenderContext) => string) =>
  (ctx: RenderContext) =>
    ctx.deployment.observability ? get(ctx.deployment.observability, ctx) : undefined

const BASE_SETTINGS: SettingDef[] = [
  // 角色与端口：原来写在 compose 和 rollout-runtime.sh 里的固定值。
  { env: 'APP_ROLE', services: ['bff'], doc: '入口角色', value: fixed('bff') },
  { env: 'APP_ROLE', services: ['worker'], doc: '入口角色', value: fixed('worker') },
  { env: 'APP_ROLE', services: ['migrate'], doc: '入口角色', value: fixed('migrate') },
  {
    env: 'APP_ROLE',
    services: ['dependency-check'],
    doc: '入口角色',
    value: fixed('dependency-check'),
  },
  { env: 'APP_ROLE', services: ['admin'], doc: '入口角色', value: fixed('admin') },
  { env: 'APP_ROLE', services: ['web'], doc: '入口角色', value: fixed('web') },
  {
    env: 'APP_ROLE',
    services: ['host-collector'],
    doc: '入口角色',
    value: fixed('host-collector'),
  },
  { env: 'APP_ROLE', services: ['obs-proxy'], doc: '入口角色', value: fixed('obs-proxy') },
  // bff 和 worker 用同一份配置模块，这几项两边都给（与 rollout-runtime.sh 一致）。
  {
    env: 'PORT',
    services: APP,
    doc: '监听端口（worker 不监听，只为同一份配置模块）',
    value: fixed('37377'),
  },
  { env: 'PORT', services: ['admin'], doc: '监听端口', value: fixed('37378') },
  { env: 'PORT', services: ['obs-proxy'], doc: '监听端口', value: fixed('5090') },
  { env: 'WORKER_HEALTH_PORT', services: APP, doc: 'worker 健康检查端口', value: fixed('37379') },
  { env: 'DATABASE_POOL_MAX', services: ['bff'], doc: '连接池上限', value: fixed('6') },
  { env: 'DATABASE_POOL_MAX', services: ['worker'], doc: '连接池上限', value: fixed('4') },
  { env: 'DATABASE_POOL_MAX', services: ['admin'], doc: '连接池上限', value: fixed('3') },
  {
    env: 'STATIC_DIR',
    services: APP,
    doc: '前端由 Pages 托管，bff 不托管静态文件',
    value: fixed(''),
  },
  {
    env: 'EXECUTOR_ORIGIN',
    services: APP,
    doc: '执行器地址；rollout-runtime.sh 按代次覆盖成 http://<代次>-bff:37377',
    value: fixed('http://bff:37377'),
  },
  {
    env: 'CLIENT_IP_SOURCE',
    services: APP,
    doc: '流量只从 Cloudflare Tunnel 进来',
    value: fixed('cf-connecting-ip'),
  },
  {
    env: 'OPERATOR_CONFIG_FILE',
    services: [...APP, 'migrate'],
    doc: '由部署描述 operator 段生成',
    value: fixed('/run/operator/operator-config.json'),
  },
  {
    env: 'BFF_INTERNAL_URL',
    services: ['admin', 'host-collector'],
    doc: '经发布路由器访问当前代次的 bff',
    value: fixed('http://release-router:37377'),
  },
  {
    env: 'OPS_DEPLOYMENTS_LOG',
    services: ['admin'],
    doc: '发布记录（只读挂载）',
    value: fixed('/host/deployments.log'),
  },
  {
    env: 'RUNTIME_CONFIG_FILE',
    services: ['web'],
    doc: 'entrypoint 写前端运行时配置的位置',
    value: fixed('/usr/share/nginx/html/runtime-config.json'),
  },
  {
    env: 'PG_DRILL_RETRY_AFTER_SECONDS',
    services: ['pg-backup'],
    doc: '恢复演练失败后多久重试',
    value: fixed('21600'),
  },

  // 数据库：entrypoint 按角色把这些映射成 DATABASE_URL（启用 PgBouncer 时额外映射 DIRECT_DATABASE_URL）。
  {
    env: 'APP_DATABASE_URL',
    services: [...APP, 'dependency-check'],
    doc: '读写角色（启用 database.pooler 时走 pgbouncer:6432）',
    value: databaseUrl('app'),
  },
  {
    env: 'APP_DIRECT_DATABASE_URL',
    services: APP,
    doc: '读写角色直连地址（仅启用 database.pooler 时下发，绕过 PgBouncer 供 session advisory lock 使用）',
    value: (ctx) =>
      ctx.deployment.database.pooler ? databaseUrl('app', { directOnly: true })(ctx) : undefined,
  },
  {
    env: 'ADMIN_DATABASE_URL',
    services: ['admin', 'pg-backup'],
    doc: '只读角色（直连 postgres:5432，兼容 pg_dump）',
    value: databaseUrl('admin', { directOnly: true }),
  },
  {
    env: 'MIGRATOR_DATABASE_URL',
    services: ['migrate'],
    doc: '迁移角色（直连 postgres:5432，DDL 与 advisory lock 绕过连接池）',
    value: databaseUrl('migrator', { directOnly: true }),
  },

  // 域名：全部由 web / api / admin 三段推导。
  {
    env: 'CORS_ALLOWED_ORIGINS',
    services: APP,
    doc: '允许的前端',
    value: (c) => list(webOrigins(c.deployment)),
  },
  {
    env: 'AUTH_FRONTEND_ORIGIN',
    services: APP,
    doc: '主前端',
    value: (c) => c.deployment.web.primary,
  },
  {
    env: 'AUTH_FRONTEND_ORIGINS',
    services: APP,
    doc: 'OAuth 可回跳的前端',
    value: (c) => list(webOrigins(c.deployment)),
  },
  {
    env: 'AUTH_LOGIN_METHODS_BY_ORIGIN',
    services: APP,
    doc: '各前端的登录方式',
    value: (c) => loginMethodsByOrigin(c.deployment),
  },
  {
    env: 'AUTH_PUBLIC_ORIGIN',
    services: APP,
    doc: '主 API 域名（OAuth 回调）',
    value: (c) => c.deployment.api.primary,
  },
  {
    env: 'AUTH_PUBLIC_ORIGINS',
    services: APP,
    doc: '所有第一方 API 域名',
    value: (c) => list([c.deployment.api.primary, ...c.deployment.api.aliases]),
  },
  {
    env: 'PUBLIC_WEB_ORIGIN',
    services: APP,
    doc: '公告等对外链接用的前端',
    value: (c) => c.deployment.web.primary,
  },
  {
    env: 'ADMIN_FRONTEND_ORIGIN',
    services: [...APP, 'admin'],
    doc: 'Admin 前端',
    value: (c) => c.deployment.admin.frontend,
  },
  {
    env: 'ADMIN_CORS_ALLOWED_ORIGINS',
    services: ['admin'],
    doc: 'Admin 允许的来源',
    value: (c) => c.deployment.admin.frontend,
  },
  {
    env: 'ADMIN_PUBLIC_ORIGIN',
    services: ['admin'],
    doc: 'Admin API 公开域名',
    value: (c) => c.deployment.admin.api,
  },
  {
    env: 'ADMIN_DIST_DIR',
    services: ['admin'],
    doc: '有独立 Admin 前端时不托管页面；否则用镜像默认目录',
    value: (c) => (c.deployment.admin.frontend ? '' : undefined),
  },
  { env: 'BFF_ENABLED', services: ['web'], doc: '前端运行时配置', value: fixed('true') },
  {
    env: 'BFF_BASE_URL',
    services: ['web'],
    doc: '前端运行时配置',
    value: (c) => c.deployment.api.primary,
  },

  // 登录与邮件。
  { env: 'EMAIL_FROM', services: APP, doc: '发件人', value: (c) => c.deployment.auth.emailFrom },
  {
    env: 'OAUTH_GOOGLE_CLIENT_ID',
    services: APP,
    doc: '用户 Google 登录',
    value: (c) => c.deployment.auth.googleClientId,
  },
  {
    env: 'OAUTH_FEISHU_CLIENT_ID',
    services: APP,
    doc: '用户飞书登录',
    value: (c) => c.deployment.auth.feishuClientId,
  },
  {
    env: 'ADMIN_GOOGLE_CLIENT_ID',
    services: ['admin'],
    doc: 'Admin Google 登录',
    value: (c) => c.deployment.admin.googleClientId,
  },

  // 存储。
  {
    env: 'S3_BUCKET',
    services: [...APP, 'dependency-check', 'pg-backup'],
    doc: '用户文件与备份的桶',
    value: (c) => c.deployment.storage.bucket,
  },
  {
    env: 'S3_KEY_PREFIX',
    services: [...APP, 'dependency-check', 'pg-backup'],
    doc: '桶内前缀',
    value: (c) => c.deployment.storage.keyPrefix,
  },
  {
    env: 'PUBLIC_ASSET_BUCKET',
    services: APP,
    doc: '公开素材桶',
    value: (c) => c.deployment.storage.publicAssets?.bucket,
  },
  {
    env: 'PUBLIC_ASSET_BASE_URL',
    services: APP,
    doc: '公开素材域名',
    value: (c) => c.deployment.storage.publicAssets?.baseUrl,
  },

  // 运维。
  {
    env: 'OPS_DEPLOYMENT_NAME',
    services: [...APP, 'admin', 'host-collector'],
    doc: '告警与看板里的部署名',
    value: (c) => c.deployment.legacy.opsName,
  },
  {
    env: 'OPS_HOST_ALERTS',
    services: ['host-collector'],
    doc: '宿主机资源告警',
    value: (c) => String(c.deployment.ops.hostAlerts),
  },

  // 可观测性：应用侧只拿导出地址和只读代理令牌。
  {
    env: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    services: APP,
    doc: 'span 导出',
    value: observability(() => 'http://otel-collector:4318'),
  },
  {
    env: 'OTEL_DEPLOYMENT_ENVIRONMENT',
    services: APP,
    doc: 'span 上的部署名',
    value: observability((_, c) => c.deployment.legacy.opsName),
  },
  {
    env: 'OBS_PROXY_URL',
    services: APP,
    doc: '断流告警查询入口',
    value: observability(() => 'http://obs-proxy:5090'),
  },
  {
    env: 'OBS_PROXY_TOKEN',
    services: [...APP, 'obs-proxy'],
    doc: '只读查询代理令牌',
    value: secret('OBS_PROXY_TOKEN'),
  },
  {
    env: 'OBS_UPSTREAM_URL',
    services: ['obs-proxy'],
    doc: 'OpenObserve 地址',
    value: fixed('http://openobserve:5080'),
  },
  {
    env: 'OBS_ORG',
    services: ['obs-proxy', 'otel-collector'],
    doc: 'OpenObserve 组织',
    value: fixed('default'),
  },
  {
    env: 'OBS_ROOT_EMAIL',
    services: ['obs-proxy', 'otel-collector'],
    doc: 'OpenObserve 账号',
    value: secret('OBS_ROOT_EMAIL'),
  },
  {
    env: 'OBS_ROOT_PASSWORD',
    services: ['obs-proxy', 'otel-collector'],
    doc: 'OpenObserve 密码',
    value: secret('OBS_ROOT_PASSWORD'),
  },
  {
    env: 'OBS_DEPLOYMENT',
    services: ['otel-collector'],
    doc: '日志上的部署标签',
    value: (c) => c.deployment.legacy.composeProject,
  },
  {
    env: 'ZO_ROOT_USER_EMAIL',
    services: ['openobserve'],
    doc: 'root 账号',
    value: secret('OBS_ROOT_EMAIL'),
  },
  {
    env: 'ZO_ROOT_USER_PASSWORD',
    services: ['openobserve'],
    doc: 'root 密码',
    value: secret('OBS_ROOT_PASSWORD'),
  },
  {
    env: 'ZO_S3_SERVER_URL',
    services: ['openobserve'],
    doc: 'R2 endpoint',
    value: secret('OBS_S3_ENDPOINT'),
  },
  {
    env: 'ZO_S3_BUCKET_NAME',
    services: ['openobserve'],
    doc: '桶',
    value: observability((o) => o.bucket),
  },
  {
    env: 'ZO_S3_BUCKET_PREFIX',
    services: ['openobserve'],
    doc: '前缀',
    value: observability((o) => o.prefix),
  },
  {
    env: 'ZO_S3_ACCESS_KEY',
    services: ['openobserve'],
    doc: 'R2 访问密钥 ID',
    value: secret('OBS_S3_ACCESS_KEY_ID'),
  },
  {
    env: 'ZO_S3_SECRET_KEY',
    services: ['openobserve'],
    doc: 'R2 访问密钥',
    value: secret('OBS_S3_SECRET_ACCESS_KEY'),
  },
  { env: 'ZO_LOCAL_MODE', services: ['openobserve'], doc: '单机模式', value: fixed('true') },
  {
    env: 'ZO_LOCAL_MODE_STORAGE',
    services: ['openobserve'],
    doc: '数据放对象存储',
    value: fixed('s3'),
  },
  { env: 'ZO_S3_PROVIDER', services: ['openobserve'], doc: 'S3 协议', value: fixed('s3') },
  {
    env: 'ZO_S3_REGION_NAME',
    services: ['openobserve'],
    doc: 'R2 的 region',
    value: fixed('auto'),
  },
  {
    env: 'ZO_DATA_DIR',
    services: ['openobserve'],
    doc: '本地缓存目录（数据卷）',
    value: fixed('/data'),
  },
  // 宿主机只有 3.6 GB 内存、约 19 GB 空闲盘，缓存按固定上限而不是按机器算。
  {
    env: 'ZO_DISK_CACHE_MAX_SIZE',
    services: ['openobserve'],
    doc: '磁盘数据缓存（MB）',
    value: fixed('1024'),
  },
  {
    env: 'ZO_DISK_RESULT_CACHE_MAX_SIZE',
    services: ['openobserve'],
    doc: '磁盘结果缓存（MB）',
    value: fixed('128'),
  },
  {
    env: 'ZO_MEMORY_CACHE_DATAFUSION_MAX_SIZE',
    services: ['openobserve'],
    doc: '内存缓存（MB）',
    value: fixed('128'),
  },
  // 除了 R2 不对外连：不发用量心跳、不下载 GeoIP 库和模型价目表。
  { env: 'ZO_TELEMETRY', services: ['openobserve'], doc: '关闭用量心跳', value: fixed('false') },
  {
    env: 'ZO_MMDB_DISABLE_DOWNLOAD',
    services: ['openobserve'],
    doc: '不下载 GeoIP 库',
    value: fixed('true'),
  },
  {
    env: 'ZO_MODEL_PRICING_ENABLED',
    services: ['openobserve'],
    doc: '不下载模型价目表',
    value: fixed('false'),
  },
  {
    env: 'ZO_COMPACT_DATA_RETENTION_DAYS',
    services: ['openobserve'],
    doc: '保留天数',
    value: observability((o) => String(o.retentionDays)),
  },

  // 数据库开通（infra compose 的 postgres-provision）。
  {
    env: 'POSTGRES_APP_DATABASE',
    services: ['postgres-provision'],
    doc: '库名',
    value: (c) => c.deployment.database.name,
  },
  {
    env: 'POSTGRES_APP_USER',
    services: ['postgres-provision'],
    doc: '读写角色',
    value: (c) => c.deployment.database.users.app,
  },
  {
    env: 'POSTGRES_ADMIN_USER',
    services: ['postgres-provision'],
    doc: '只读角色',
    value: (c) => c.deployment.database.users.admin,
  },
  {
    env: 'POSTGRES_MIGRATOR_USER',
    services: ['postgres-provision'],
    doc: '迁移角色',
    value: (c) => c.deployment.database.users.migrator,
  },
  {
    env: 'POSTGRES_EXTRA_SCHEMAS',
    services: ['postgres-provision'],
    doc: '额外 schema',
    value: (c) => list(c.deployment.database.extraSchemas),
  },
  {
    env: 'POSTGRES_APP_PASSWORD',
    services: ['postgres-provision'],
    doc: '读写角色密码',
    value: secret('POSTGRES_APP_PASSWORD'),
  },
  {
    env: 'POSTGRES_ADMIN_PASSWORD',
    services: ['postgres-provision'],
    doc: '只读角色密码',
    value: secret('POSTGRES_ADMIN_PASSWORD'),
  },
  {
    env: 'POSTGRES_MIGRATOR_PASSWORD',
    services: ['postgres-provision'],
    doc: '迁移角色密码',
    value: secret('POSTGRES_MIGRATOR_PASSWORD'),
  },
]

/** 原样下发的密钥：变量名就是密钥名。 */
const DIRECT_SECRETS: Readonly<Record<string, readonly Service[]>> = {
  S3_ENDPOINT: [...APP, 'dependency-check', 'pg-backup'],
  S3_ACCESS_KEY_ID: [...APP, 'dependency-check', 'pg-backup'],
  S3_SECRET_ACCESS_KEY: [...APP, 'dependency-check', 'pg-backup'],
  INTERNAL_API_TOKEN: [...APP, 'admin', 'host-collector'],
  EMAIL_CODE_SECRET: APP,
  RESEND_API_KEY: APP,
  OAUTH_GOOGLE_CLIENT_SECRET: APP,
  OAUTH_FEISHU_CLIENT_SECRET: APP,
  UPSTREAM_SECRETS_MASTER_KEY: APP,
  ADMIN_COOKIE_SECRET: ['admin'],
  ADMIN_PASSWORD: ['admin'],
  ADMIN_GOOGLE_CLIENT_SECRET: ['admin'],
  ADMIN_GOOGLE_ALLOWED_EMAILS: ['admin'],
  UPSTREAM_BASE_URL: APP,
  UPSTREAM_API_KEY: APP,
  UPSTREAM_OPENAI_API_KEY: APP,
  UPSTREAM_CLAUDE_API_KEY: APP,
  UPSTREAM_GEMINI_API_KEY: APP,
  OPENAI_API_KEY: APP,
  OPENAI_API_KEYS: APP,
  OPENAI_API_KEY_BUDGETS_USD: APP,
  OPENAI_ADMIN_KEY: APP,
  OPENAI_ORG_ID: APP,
  GEMINI_API_KEY: APP,
  VERTEX_API_KEY: APP,
  VERTEX_API_KEYS: APP,
  VERTEX_BASE_URL: APP,
  GROK_API_KEY: APP,
  GROK_BASE_URL: APP,
  AGNES_API_KEY: APP,
  ARK_API_KEY: APP,
  ARK_BASE_URL: APP,
  VEO_API_KEY: APP,
  OPS_ALERT_WEBHOOK_URL: [...APP, 'host-collector'],
  OPS_ALERT_WEBHOOK_URLS: [...APP, 'host-collector'],
  OPS_ALERT_WEBHOOK_HEADERS: [...APP, 'host-collector'],
}

const TUNABLE_SETTINGS: SettingDef[] = Object.entries(TUNABLES).map(([env, doc]) => ({
  env,
  services: APP,
  doc,
  value: (ctx) => {
    const raw = ctx.deployment.tunables[env]
    return raw === undefined ? undefined : String(raw)
  },
}))

export const SETTINGS: readonly SettingDef[] = [
  ...BASE_SETTINGS,
  ...Object.entries(DIRECT_SECRETS).map(([name, services]) => ({
    env: name,
    services,
    doc: SECRETS.find((one) => one.name === name)?.doc ?? '',
    value: secret(name),
  })),
  ...TUNABLE_SETTINGS,
]

/** 清单自身的一致性：同一服务里变量名不重复，密钥都有去处。 */
export function catalogProblems(): string[] {
  const problems: string[] = []
  const seen = new Map<string, string>()
  for (const setting of SETTINGS) {
    for (const service of setting.services) {
      const key = `${service}:${setting.env}`
      if (seen.has(key)) problems.push(`${setting.env} is declared twice for ${service}`)
      seen.set(key, setting.env)
    }
  }
  const delivered = new Set([
    ...Object.keys(DIRECT_SECRETS),
    'POSTGRES_APP_PASSWORD',
    'POSTGRES_ADMIN_PASSWORD',
    'POSTGRES_MIGRATOR_PASSWORD',
    'OBS_ROOT_EMAIL',
    'OBS_ROOT_PASSWORD',
    'OBS_PROXY_TOKEN',
    'OBS_S3_ENDPOINT',
    'OBS_S3_ACCESS_KEY_ID',
    'OBS_S3_SECRET_ACCESS_KEY',
    'TUNNEL_CREDENTIALS',
    'ENTERPRISE_TUNNEL_CREDENTIALS',
  ])
  for (const one of SECRETS) {
    if (!delivered.has(one.name)) problems.push(`secret ${one.name} is never delivered`)
  }
  return problems
}

/**
 * 代码会读、但不归部署配置管的变量，每个写明由谁提供。`scripts/check-deploy-config.ts` 要求运行时代码
 * 读到的变量要么在清单里，要么在这里；新加变量先登记，别直接读。ADR 0035 P4 统一读取后再收窄。
 */
export const NOT_DEPLOYMENT_CONFIG: Readonly<Record<string, string>> = {
  APP_VERSION: '镜像构建参数',
  APP_RELEASE: '镜像构建参数',
  NODE_ENV: '运行时',
  DATABASE_URL: 'docker-entrypoint.sh 按角色从 *_DATABASE_URL 映射',
  DIRECT_DATABASE_URL:
    'docker-entrypoint.sh 按角色从 APP_DIRECT_DATABASE_URL 映射（可选，绕过 PgBouncer 供 session advisory lock 与迁移使用）',
  DATABASE_IDLE_TIMEOUT_SECONDS: '连接池默认值，部署不覆盖',
  DATABASE_STATEMENT_TIMEOUT_MS: '连接池默认值，部署不覆盖',
  DATABASE_LOCK_TIMEOUT_MS: '连接池默认值，部署不覆盖',
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '连接池默认值，部署不覆盖',
  DATABASE_PREPARE: '连接池 prepared statement 开关，部署按需覆盖',
  TEST_DATABASE_URL: '测试',
  WORKER_ACTIVATION_FILE: 'rollout-runtime.sh 按代次传入',
  WORKER_START_PAUSED: 'rollout-runtime.sh 按代次传入',
  LEGACY_EXECUTOR_ORIGIN: 'rollout-runtime.sh 按代次传入',
  CHANNELS_FILE: '本地开发覆盖渠道清单',
  AGENT_SEGMENTER_URL: 'vps-deploy.sh 按分割服务是否健康注入（部署描述 segmenter 决定是否接入）',
  AGENT_SEGMENTER_NAMESPACE: 'vps-deploy.sh 注入',
  HOST_DISK_PROBE: 'host-collector 本地运行时覆盖挂载路径',
  HOST_MEMINFO: 'host-collector 本地运行时覆盖挂载路径',
  HOST_PROC_STAT: 'host-collector 本地运行时覆盖挂载路径',
  HOST_LOADAVG: 'host-collector 本地运行时覆盖挂载路径',
  HOST_CGROUP: 'host-collector 本地运行时覆盖挂载路径',
  HOST_CONTAINER_NAMES: 'host-collector 本地运行时覆盖挂载路径',
  HOST_SAMPLE_INTERVAL_MS: 'host-collector 采样间隔默认值',
}
