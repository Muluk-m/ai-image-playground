import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'

/**
 * 一套部署的非密钥描述：`deploy/deployments/<name>.json`（ADR 0035）。
 *
 * 只放公开或可审查的值：域名、Pages 项目、桶名、模型、并发、开关、operator 设置。
 * 凭据和带账号信息的连接地址（存储 endpoint、上游网关、Vertex 项目）一律放 Secrets Store，见 catalog.ts。
 */

const Origin = Type.String({
  pattern: '^https?://[^/\\s]+$',
  description: '不带路径和结尾斜杠的 origin',
})
const Port = Type.Integer({ minimum: 1, maximum: 65535 })
const PositiveInt = Type.Integer({ minimum: 1 })

const LoginMethods = Type.Object(
  {
    password: Type.Boolean(),
    registration: Type.Boolean(),
    providers: Type.Array(Type.Union([Type.Literal('google'), Type.Literal('feishu')])),
  },
  { additionalProperties: false },
)

const Hostname = Type.String({ pattern: '^[a-z0-9.-]+$' })
const TunnelSchema = Type.Object(
  { routes: Type.Record(Hostname, Type.Union([Type.Literal('api'), Type.Literal('admin')])) },
  { additionalProperties: false },
)

const WebOrigin = Type.Object(
  {
    /** 这个前端连哪个 API；省略时用 api.primary。 */
    api: Type.Optional(Origin),
    /** 这个前端允许的登录方式；省略时按后端默认。 */
    login: Type.Optional(LoginMethods),
  },
  { additionalProperties: false },
)

export const DeploymentSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    name: Type.Union([Type.Literal('prod'), Type.Literal('test')]),
    /** 迁移期保留的旧标识（ADR 0035 P7 统一改名后删除整段）。 */
    legacy: Type.Object(
      {
        /** 现有 compose 项目名：容器、数据卷、网络都带这个前缀。 */
        composeProject: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]*$' }),
        /** 告警、运维看板和日志里显示的部署名。 */
        opsName: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    web: Type.Object(
      {
        /** 主前端：OAuth 默认回跳、公告链接。必须是 origins 里的一个。 */
        primary: Origin,
        /** 所有允许的前端（CORS、OAuth 回跳、按域名登录方式都从这里推导）。 */
        origins: Type.Record(Type.String(), WebOrigin),
      },
      { additionalProperties: false },
    ),
    api: Type.Object(
      {
        primary: Origin,
        /** 同一后端的其他第一方 API 域名（企业域名等）。 */
        aliases: Type.Array(Origin),
      },
      { additionalProperties: false },
    ),
    admin: Type.Object(
      {
        /** Admin 前端（Pages）。不填表示 Admin 只在内网，由容器自己托管页面。 */
        frontend: Type.Optional(Origin),
        /** Admin API 的公开域名（Tunnel 入口）。 */
        api: Type.Optional(Origin),
        /** Admin 用 Google 登录时的 client ID（公开值）；不填则用密码登录。 */
        googleClientId: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    /** 是否接入宿主机共享的 EdgeTAM 分割服务（deploy/segmenter）。 */
    segmenter: Type.Boolean(),
    auth: Type.Object(
      {
        emailFrom: Type.String({ minLength: 1 }),
        googleClientId: Type.Optional(Type.String()),
        feishuClientId: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    database: Type.Object(
      {
        name: Type.String({ pattern: '^[a-z_][a-z0-9_]*$' }),
        users: Type.Object(
          {
            app: Type.String({ pattern: '^[a-z_][a-z0-9_]*$' }),
            admin: Type.String({ pattern: '^[a-z_][a-z0-9_]*$' }),
            migrator: Type.String({ pattern: '^[a-z_][a-z0-9_]*$' }),
          },
          { additionalProperties: false },
        ),
        extraSchemas: Type.Array(Type.String({ pattern: '^[a-z_][a-z0-9_]*$' })),
      },
      { additionalProperties: false },
    ),
    storage: Type.Object(
      {
        bucket: Type.String({ minLength: 1 }),
        keyPrefix: Type.String(),
        publicAssets: Type.Optional(
          Type.Object({ bucket: Type.String(), baseUrl: Origin }, { additionalProperties: false }),
        ),
      },
      { additionalProperties: false },
    ),
    observability: Type.Optional(
      Type.Object(
        {
          retentionDays: PositiveInt,
          bucket: Type.String({ minLength: 1 }),
          prefix: Type.String(),
          /** 只绑 127.0.0.1 的宿主端口，经 SSH 隧道访问。 */
          uiHostPort: Port,
          proxyHostPort: Port,
        },
        { additionalProperties: false },
      ),
    ),
    ops: Type.Object({ hostAlerts: Type.Boolean() }, { additionalProperties: false }),
    /**
     * Cloudflare Tunnel：每个 Tunnel 的主机名分别转给哪个服务（api = 当前代次的 bff，admin = Admin）。
     * main 是本部署自己的 Tunnel；enterprise 是企业域名所在账号的 Tunnel，凭据分开存。
     */
    tunnels: Type.Object(
      {
        main: TunnelSchema,
        enterprise: Type.Optional(TunnelSchema),
      },
      { additionalProperties: false },
    ),
    /**
     * 业务调参，键就是容器里的变量名（未列出的用代码默认值）。
     * 只允许 catalog.ts 里登记为 `tunable` 的键，值是字符串、数字或布尔。
     */
    tunables: Type.Record(
      Type.String({ pattern: '^[A-Z][A-Z0-9_]*$' }),
      Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
    ),
    /** operator-config.json 的全部内容（capabilities / quotas），由 bff 启动时再按自己的规则校验。 */
    operator: Type.Object(
      {
        capabilities: Type.Record(Type.String(), Type.Boolean()),
        quotas: Type.Record(Type.String(), Type.Number()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

export type Deployment = Static<typeof DeploymentSchema>
export type DeploymentName = Deployment['name']
export const DEPLOYMENT_NAMES = ['prod', 'test'] as const satisfies readonly DeploymentName[]

/** 校验部署描述，返回全部问题；空数组表示通过。 */
export function deploymentProblems(raw: unknown): string[] {
  if (!Value.Check(DeploymentSchema, raw)) {
    return Value.Errors(DeploymentSchema, raw).map(
      (error) => `${error.instancePath || '/'}: ${error.message}`,
    )
  }
  const problems: string[] = []
  const origins = Object.keys(raw.web.origins)
  for (const origin of origins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin))
      problems.push(`/web/origins: ${origin} is not a bare origin`)
  }
  if (!origins.includes(raw.web.primary)) {
    problems.push(`/web/primary: ${raw.web.primary} must be one of /web/origins`)
  }
  const apis = new Set([raw.api.primary, ...raw.api.aliases])
  for (const [origin, entry] of Object.entries(raw.web.origins)) {
    if (entry.api && !apis.has(entry.api)) {
      problems.push(`/web/origins/${origin}/api: ${entry.api} is neither api.primary nor an alias`)
    }
    for (const provider of entry.login?.providers ?? []) {
      const clientId = provider === 'google' ? raw.auth.googleClientId : raw.auth.feishuClientId
      if (!clientId)
        problems.push(`/web/origins/${origin}/login: ${provider} needs auth.${provider}ClientId`)
    }
  }
  return problems
}

export function parseDeployment(raw: unknown, source = 'deployment'): Deployment {
  const problems = deploymentProblems(raw)
  if (problems.length > 0) throw new Error(`${source} is invalid:\n  ${problems.join('\n  ')}`)
  return raw as Deployment
}

/** 宿主机级描述：`deploy/host.json`。一台机器上的共享 PostgreSQL 和发布参数。 */
export const HostSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    infraNetwork: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]*$' }),
    postgres: Type.Object(
      {
        /** 超级用户和它的默认库；各部署的库和角色由 provision 建。 */
        superuser: Type.String({ pattern: '^[a-z_][a-z0-9_]*$' }),
        database: Type.String({ pattern: '^[a-z_][a-z0-9_]*$' }),
      },
      { additionalProperties: false },
    ),
    deploy: Type.Object(
      {
        /** 每个部署保留的旧镜像份数。 */
        keepImages: PositiveInt,
        /** 构建和拉取前要求的最小空闲磁盘（GB）。 */
        minFreeGb: PositiveInt,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

export type Host = Static<typeof HostSchema>

export function parseHost(raw: unknown, source = 'host'): Host {
  if (!Value.Check(HostSchema, raw)) {
    const problems = Value.Errors(HostSchema, raw).map(
      (error) => `${error.instancePath || '/'}: ${error.message}`,
    )
    throw new Error(`${source} is invalid:\n  ${problems.join('\n  ')}`)
  }
  return raw
}

export function renderDeploymentSchema(): string {
  return `${JSON.stringify(DeploymentSchema, null, 2)}\n`
}

export function renderHostSchema(): string {
  return `${JSON.stringify(HostSchema, null, 2)}\n`
}
