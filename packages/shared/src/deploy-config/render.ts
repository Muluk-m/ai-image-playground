import { CAPABILITIES, QUOTAS, RETIRED_CAPABILITIES, RETIRED_QUOTAS } from '../capabilities'
import {
  HOST_SECRETS,
  type RenderContext,
  SECRETS,
  SERVICES,
  SETTINGS,
  type Service,
  TUNABLES,
} from './catalog'
import type { Deployment, Host } from './deployment'

/**
 * 只有对照清单和能力表才查得出的描述错误：调参键名、未知或已下线的能力与配额。
 * bff 的 loader 对已下线的键静默忽略，描述文件里留着只会误导人，所以这里直接报错。
 */
export function descriptorProblems(deployment: Deployment): string[] {
  const problems: string[] = []
  for (const name of Object.keys(deployment.tunables)) {
    if (!Object.hasOwn(TUNABLES, name))
      problems.push(`tunables.${name} is not a registered tunable`)
  }
  for (const key of Object.keys(deployment.operator.capabilities)) {
    if (RETIRED_CAPABILITIES.includes(key))
      problems.push(`operator.capabilities.${key} is retired; remove it`)
    else if (!Object.hasOwn(CAPABILITIES, key))
      problems.push(`operator.capabilities.${key} is not a capability`)
  }
  for (const key of Object.keys(deployment.operator.quotas)) {
    if (RETIRED_QUOTAS.includes(key)) problems.push(`operator.quotas.${key} is retired; remove it`)
    else if (!Object.hasOwn(QUOTAS, key)) problems.push(`operator.quotas.${key} is not a quota`)
  }
  return problems
}

/** 只在部署开了可观测性时才生成的服务。 */
const OBSERVABILITY_SERVICES: ReadonlySet<Service> = new Set([
  'openobserve',
  'otel-collector',
  'obs-proxy',
])

export interface RenderedDeployment {
  /** 每个服务一份 env（键已排序）。没开可观测性时不含那三个服务。 */
  env: Partial<Record<Service, Record<string, string>>>
  /**
   * 给发布脚本和 compose 插值用的非密钥值（`deploy.env`）：compose 项目名、端口、开关。
   * 只含 `[A-Za-z0-9_.:/-]`，可以直接被 sh 读入。
   */
  deploy: Record<string, string>
  /** 需要以文件形式交给容器的配置，路径相对生成目录。 */
  files: Record<string, string>
}

export interface RenderResult {
  rendered: RenderedDeployment
  /** 非空时不能发布：缺必填密钥、多出未登记的密钥、调参写错键名、值里带换行。 */
  problems: string[]
}

/**
 * 按清单把部署描述和密钥展开成各服务的配置。纯函数，不读文件、不联网。
 * `secrets` 的键是去掉部署前缀的密钥名（`S3_SECRET_ACCESS_KEY`）。
 */
export function renderDeployment(
  deployment: Deployment,
  secrets: Readonly<Record<string, string>>,
  host: Host,
): RenderResult {
  const problems: string[] = []
  const known = new Set(SECRETS.map((one) => one.name))
  for (const name of Object.keys(secrets)) {
    if (!known.has(name)) problems.push(`secret ${name} is not in the catalog`)
  }
  for (const one of SECRETS) {
    const value = secrets[one.name]
    if (one.required(deployment) && (value === undefined || value === '')) {
      problems.push(`secret ${one.name} is required for ${deployment.name} (${one.doc})`)
    }
  }
  problems.push(...descriptorProblems(deployment))

  const ctx: RenderContext = {
    deployment,
    secret: (name) => {
      const value = secrets[name]
      return value === undefined || value === '' ? undefined : value
    },
  }
  const env: RenderedDeployment['env'] = {}
  for (const service of SERVICES) {
    if (OBSERVABILITY_SERVICES.has(service) && !deployment.observability) continue
    env[service] = {}
  }
  for (const setting of SETTINGS) {
    const value = setting.value(ctx)
    if (value === undefined) continue
    if (/[\r\n]/.test(value)) {
      problems.push(`${setting.env} contains a line break; env files cannot carry it`)
      continue
    }
    for (const service of setting.services) {
      const target = env[service]
      if (target) target[setting.env] = value
    }
  }
  for (const service of Object.keys(env) as Service[]) {
    const entries = Object.entries(env[service] ?? {}).sort(([a], [b]) => a.localeCompare(b))
    env[service] = Object.fromEntries(entries)
  }

  const files: Record<string, string> = {
    'operator-config.json': `${JSON.stringify(deployment.operator, null, 2)}\n`,
  }
  for (const [name, tunnel] of Object.entries(deployment.tunnels)) {
    if (!tunnel) continue
    const secretName = name === 'main' ? 'TUNNEL_CREDENTIALS' : 'ENTERPRISE_TUNNEL_CREDENTIALS'
    const raw = ctx.secret(secretName)
    if (raw === undefined) continue
    let credentials: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not an object')
      credentials = parsed as Record<string, unknown>
    } catch {
      // 不回显内容：里面就是密钥。
      problems.push(`${secretName} is not valid JSON`)
      continue
    }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (
      typeof credentials.TunnelID !== 'string' ||
      !uuid.test(credentials.TunnelID) ||
      typeof credentials.TunnelSecret !== 'string' ||
      !credentials.TunnelSecret
    ) {
      problems.push(`${secretName} must have a UUID TunnelID and a non-empty TunnelSecret`)
      continue
    }
    files[`cloudflared/${name}/credentials.json`] = `${JSON.stringify(credentials)}\n`
    files[`cloudflared/${name}/config.yml`] = tunnelConfig(credentials.TunnelID, tunnel.routes)
  }

  const deploy: Record<string, string> = {
    DEPLOYMENT: deployment.name,
    COMPOSE_PROJECT: deployment.legacy.composeProject,
    INFRA_NETWORK_NAME: host.infraNetwork,
    DEPLOY_KEEP_IMAGES: String(host.deploy.keepImages),
    DEPLOY_MIN_FREE_GB: String(host.deploy.minFreeGb),
    SEGMENTER_ENABLED: String(deployment.segmenter),
    OBSERVABILITY_ENABLED: String(deployment.observability !== undefined),
    OBS_UI_HOST_PORT: String(deployment.observability?.uiHostPort ?? ''),
    OBS_PROXY_HOST_PORT: String(deployment.observability?.proxyHostPort ?? ''),
    ENTERPRISE_TUNNEL_ENABLED: String(deployment.tunnels.enterprise !== undefined),
  }
  for (const [key, value] of Object.entries(deploy)) {
    if (!/^[A-Za-z0-9_.:/-]*$/.test(value))
      problems.push(`deploy.env ${key} has characters sh would interpret`)
  }
  return { rendered: { env, deploy, files }, problems }
}

const TUNNEL_TARGETS = { api: 'http://release-router:37377', admin: 'http://admin:37378' } as const

/**
 * cloudflared 配置。api 一律指向发布路由器；第一次部署还没有路由器时，config-render.sh 会把它
 * 换成 compose 的 bff（rollout-runtime.sh 交接时再换回来）。
 */
function tunnelConfig(tunnelId: string, routes: Record<string, 'api' | 'admin'>): string {
  const lines = [
    `tunnel: ${tunnelId}`,
    'credentials-file: /etc/cloudflared/credentials.json',
    '',
    'ingress:',
  ]
  for (const [hostname, target] of Object.entries(routes)) {
    lines.push(
      `  - hostname: ${hostname}`,
      `    service: ${TUNNEL_TARGETS[target]}`,
      '    originRequest:',
      '      connectTimeout: 30s',
      '      keepAliveTimeout: 90s',
      '      keepAliveConnections: 100',
    )
  }
  lines.push('  - service: http_status:404', 'protocol: http2', '')
  return lines.join('\n')
}

export interface RenderedHost {
  /** 共享 PostgreSQL 的超级用户，infra compose 的 postgres 和各部署的 provision 都要。 */
  postgres: Record<string, string>
  files: Record<string, string>
}

/** 宿主机级配置：共享 PostgreSQL、GHCR 拉取令牌。 */
export function renderHost(
  host: Host,
  secrets: Readonly<Record<string, string>>,
): { rendered: RenderedHost; problems: string[] } {
  const problems: string[] = []
  const known = new Set(HOST_SECRETS.map((one) => one.name))
  for (const name of Object.keys(secrets)) {
    if (!known.has(name)) problems.push(`host secret ${name} is not in the catalog`)
  }
  for (const one of HOST_SECRETS) {
    const value = secrets[one.name]
    if (!value) problems.push(`host secret ${one.name} is required (${one.doc})`)
    else if (/[\r\n]/.test(value)) problems.push(`host secret ${one.name} contains a line break`)
  }
  const postgres: Record<string, string> = {
    POSTGRES_DB: host.postgres.database,
    POSTGRES_PASSWORD: secrets.POSTGRES_PASSWORD ?? '',
    POSTGRES_USER: host.postgres.superuser,
  }
  const files: Record<string, string> = {}
  if (secrets.GHCR_PULL_TOKEN) files['ghcr-pull-token'] = `${secrets.GHCR_PULL_TOKEN}\n`
  return { rendered: { postgres, files }, problems }
}

/** docker `--env-file` / compose `env_file`（format: raw）格式：一行一个，值按字面。 */
export function formatEnvFile(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('')
}
