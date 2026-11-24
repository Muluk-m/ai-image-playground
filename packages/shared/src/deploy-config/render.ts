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

/** 只在部署开了可观测性时才生成的服务。 */
const OBSERVABILITY_SERVICES: ReadonlySet<Service> = new Set([
  'openobserve',
  'otel-collector',
  'obs-proxy',
])

export interface RenderedDeployment {
  /** 每个服务一份 env（键已排序）。没开可观测性时不含那三个服务。 */
  env: Partial<Record<Service, Record<string, string>>>
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
  for (const name of Object.keys(deployment.tunables)) {
    if (!(name in TUNABLES)) problems.push(`tunables.${name} is not a registered tunable`)
  }

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
  const tunnel = ctx.secret('TUNNEL_CREDENTIALS')
  if (tunnel !== undefined) {
    try {
      const parsed = JSON.parse(tunnel) as Record<string, unknown>
      if (typeof parsed.TunnelID !== 'string' || typeof parsed.TunnelSecret !== 'string') {
        problems.push('TUNNEL_CREDENTIALS must have TunnelID and TunnelSecret')
      }
      files['cloudflared/credentials.json'] = `${JSON.stringify(parsed)}\n`
    } catch {
      // 不回显内容：里面就是密钥。
      problems.push('TUNNEL_CREDENTIALS is not valid JSON')
    }
  }
  return { rendered: { env, files }, problems }
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
    if (!secrets[one.name]) problems.push(`host secret ${one.name} is required (${one.doc})`)
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
