import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  catalogProblems,
  type Deployment,
  deploymentProblems,
  descriptorProblems,
  formatEnvFile,
  type Host,
  parseDeployment,
  parseHost,
  renderHost,
  renderDeployment as renderWithHost,
  SECRETS,
} from '../deploy-config'

const descriptor = (name: 'prod' | 'test'): Deployment =>
  parseDeployment(
    JSON.parse(
      readFileSync(join(import.meta.dir, `../../../../deploy/deployments/${name}.json`), 'utf8'),
    ),
  )

const host: Host = parseHost(
  JSON.parse(readFileSync(join(import.meta.dir, '../../../../deploy/host.json'), 'utf8')),
)
const renderDeployment = (deployment: Deployment, secrets: Record<string, string>) =>
  renderWithHost(deployment, secrets, host)

/** 每个已登记的密钥都给一个可辨认的假值。 */
function fakeSecrets(deployment: Deployment): Record<string, string> {
  const values: Record<string, string> = {}
  for (const one of SECRETS) {
    if (!one.required(deployment)) continue
    values[one.name] = `fake-${one.name.toLowerCase()}`
  }
  values.TUNNEL_CREDENTIALS = JSON.stringify({
    AccountTag: 'a',
    TunnelID: '00000000-0000-4000-8000-000000000001',
    TunnelSecret: 's',
  })
  if (deployment.tunnels.enterprise) {
    values.ENTERPRISE_TUNNEL_CREDENTIALS = JSON.stringify({
      TunnelID: '00000000-0000-4000-8000-00000000000e',
      TunnelSecret: 's',
    })
  }
  values.POSTGRES_APP_PASSWORD = 'p@ss/word'
  return values
}

describe('deploy config catalog', () => {
  it('is consistent and both deployments validate', () => {
    expect(catalogProblems()).toEqual([])
    expect(descriptor('prod').name).toBe('prod')
    expect(descriptor('test').name).toBe('test')
  })

  it('gives each service only what it declared, so the log store password never reaches the app', () => {
    const prod = descriptor('prod')
    const { rendered, problems } = renderDeployment(prod, fakeSecrets(prod))
    expect(problems).toEqual([])
    expect(rendered.env.openobserve?.ZO_ROOT_USER_PASSWORD).toBe('fake-obs_root_password')
    for (const service of [
      'bff',
      'worker',
      'admin',
      'web',
      'migrate',
      'dependency-check',
    ] as const) {
      const env = rendered.env[service] ?? {}
      expect(env.OBS_ROOT_PASSWORD).toBeUndefined()
      expect(env.OBS_S3_SECRET_ACCESS_KEY).toBeUndefined()
    }
    expect(rendered.env.bff?.ADMIN_COOKIE_SECRET).toBeUndefined()
    expect(rendered.env.admin?.S3_SECRET_ACCESS_KEY).toBeUndefined()
    expect(rendered.env.web).toEqual({
      APP_ROLE: 'web',
      BFF_BASE_URL: 'https://api.muvloom.online',
      BFF_ENABLED: 'true',
      RUNTIME_CONFIG_FILE: '/usr/share/nginx/html/runtime-config.json',
    })
  })

  it('routes each tunnel hostname to the bff router or admin, enterprise tunnel included', () => {
    const prod = descriptor('prod')
    const { rendered } = renderDeployment(prod, fakeSecrets(prod))
    expect(rendered.files['cloudflared/main/config.yml']).toContain(
      '  - hostname: admin-api.muvloom.online\n    service: http://admin:37378',
    )
    expect(rendered.files['cloudflared/enterprise/config.yml']).toContain(
      'tunnel: 00000000-0000-4000-8000-00000000000e\n',
    )
    expect(rendered.files['cloudflared/enterprise/config.yml']).toContain(
      '  - hostname: image-api.qiliangjia.one\n    service: http://release-router:37377',
    )
    expect(rendered.deploy.OBS_PROXY_HOST_PORT).toBe('15090')
  })

  it('reports malformed tunnel credentials and multi-line host secrets as problems, without throwing', () => {
    const test = descriptor('test')
    const { problems } = renderDeployment(test, {
      ...fakeSecrets(test),
      TUNNEL_CREDENTIALS: 'null',
    })
    expect(problems).toContain('TUNNEL_CREDENTIALS is not valid JSON')
    const host_ = renderHost(host, {
      POSTGRES_PASSWORD: 'abc\nPOSTGRES_USER=other',
      GHCR_PULL_TOKEN: 'token',
    })
    expect(host_.problems).toEqual(['host secret POSTGRES_PASSWORD contains a line break'])
  })

  it('rejects shared database roles, non-bare origins and quotas the loader would refuse', () => {
    const test = descriptor('test')
    const problems = deploymentProblems({
      ...test,
      api: { ...test.api, primary: 'https://api.example.com?x=1' },
      database: {
        ...test.database,
        users: { ...test.database.users, admin: test.database.users.app },
      },
      operator: { ...test.operator, quotas: { 'generation:daily-images': -1 } },
    })
    expect(problems.join('\n')).toContain('/operator/quotas/generation:daily-images')
    const shapeOk = deploymentProblems({
      ...test,
      api: { ...test.api, primary: 'https://user@api.example.com' },
      database: {
        ...test.database,
        users: { ...test.database.users, admin: test.database.users.app },
      },
    })
    expect(shapeOk).toContain('/api/primary: https://user@api.example.com is not a bare origin')
    expect(shapeOk).toContain('/database/users: app, admin and migrator must be different roles')
  })

  it('rejects tunnel routes off the hostname pattern, prototype keys and a bad tunnel id', () => {
    const test = descriptor('test')
    expect(
      deploymentProblems({
        ...test,
        tunnels: { main: { routes: { 'api_example.com': 'ap1' } } },
      }).length,
    ).toBeGreaterThan(0)
    expect(
      descriptorProblems({
        ...test,
        tunables: { constructor: 'x' } as Deployment['tunables'],
        operator: { capabilities: { constructor: true }, quotas: { toString: 1 } },
      }),
    ).toEqual([
      'tunables.constructor is not a registered tunable',
      'operator.capabilities.constructor is not a capability',
      'operator.quotas.toString is not a quota',
    ])
    const { problems } = renderDeployment(test, {
      ...fakeSecrets(test),
      TUNNEL_CREDENTIALS: JSON.stringify({ TunnelID: 'x\ningress: []', TunnelSecret: 's' }),
    })
    expect(problems).toContain(
      'TUNNEL_CREDENTIALS must have a UUID TunnelID and a non-empty TunnelSecret',
    )
  })

  it('requires the Resend key whenever email verification is on', () => {
    const test = descriptor('test')
    const secrets = fakeSecrets(test)
    delete secrets.RESEND_API_KEY
    expect(renderDeployment(test, secrets).problems.join('\n')).toContain(
      'RESEND_API_KEY is required',
    )
  })

  it('rejects retired or unknown operator keys and misspelled tunables', () => {
    const prod = descriptor('prod')
    expect(descriptorProblems(prod)).toEqual([])
    const broken: Deployment = {
      ...prod,
      tunables: { ...prod.tunables, AGENT_CHAT_MODLE: 'x' },
      operator: {
        capabilities: { ...prod.operator.capabilities, 'matte:server': true, 'no:such': true },
        quotas: { ...prod.operator.quotas, 'agent:compaction-max-folds': 3 },
      },
    }
    expect(descriptorProblems(broken)).toEqual([
      'tunables.AGENT_CHAT_MODLE is not a registered tunable',
      'operator.capabilities.matte:server is retired; remove it',
      'operator.capabilities.no:such is not a capability',
      'operator.quotas.agent:compaction-max-folds is retired; remove it',
    ])
  })

  it('derives every origin from the web, api and admin sections', () => {
    const prod = descriptor('prod')
    const bff = renderDeployment(prod, fakeSecrets(prod)).rendered.env.bff ?? {}
    expect(bff.CORS_ALLOWED_ORIGINS?.split(',')).toContain(
      'https://image-playground.qiliangjia.one',
    )
    expect(bff.AUTH_FRONTEND_ORIGINS).toBe(bff.CORS_ALLOWED_ORIGINS)
    expect(bff.AUTH_PUBLIC_ORIGINS).toBe(
      'https://api.muvloom.online,https://image-api.qiliangjia.one,https://api.nainma.online',
    )
    expect(JSON.parse(bff.AUTH_LOGIN_METHODS_BY_ORIGIN ?? '')).toMatchObject({
      'https://image-playground.qiliangjia.one': { password: false, providers: ['feishu'] },
    })
  })

  it('builds connection strings from role names and escaped passwords', () => {
    const test = descriptor('test')
    const { rendered } = renderDeployment(test, fakeSecrets(test))
    expect(rendered.env.bff?.APP_DATABASE_URL).toBe(
      'postgresql://aip_test_app:p%40ss%2Fword@postgres:5432/aip_test',
    )
    expect(rendered.env.migrate?.MIGRATOR_DATABASE_URL).toBe(
      'postgresql://aip_test_migrator:fake-postgres_migrator_password@postgres:5432/aip_test',
    )
    // 没开可观测性的部署不生成那三个服务。
    expect(rendered.env.openobserve).toBeUndefined()
    expect(rendered.files['cloudflared/main/credentials.json']).toContain('TunnelSecret')
    expect(rendered.files['cloudflared/main/config.yml']).toContain(
      '  - hostname: test-api.muvloom.online\n    service: http://release-router:37377',
    )
    expect(rendered.files['cloudflared/enterprise/config.yml']).toBeUndefined()
    expect(rendered.deploy).toMatchObject({
      COMPOSE_PROJECT: 'image-playground-test',
      OBSERVABILITY_ENABLED: 'false',
      SEGMENTER_ENABLED: 'true',
      ENTERPRISE_TUNNEL_ENABLED: 'false',
      INFRA_NETWORK_NAME: 'image-playground-infra',
    })
  })

  it('refuses to render without a required secret, without echoing any value', () => {
    const prod = descriptor('prod')
    const secrets = fakeSecrets(prod)
    delete secrets.S3_SECRET_ACCESS_KEY
    secrets.TYPO_KEY = 'fake-typo'
    secrets.TUNNEL_CREDENTIALS = 'not json fake-tunnel'
    const { problems } = renderDeployment(prod, secrets)
    expect(problems.join('\n')).toContain('S3_SECRET_ACCESS_KEY is required')
    expect(problems.join('\n')).toContain('TYPO_KEY is not in the catalog')
    expect(problems.join('\n')).not.toContain('fake-')
  })

  it('rejects unknown tunables and descriptor fields', () => {
    const prod = descriptor('prod')
    const { problems } = renderDeployment(
      { ...prod, tunables: { AGENT_CHAT_MODLE: 'x' } },
      fakeSecrets(prod),
    )
    expect(problems).toContain('tunables.AGENT_CHAT_MODLE is not a registered tunable')
    expect(() => parseDeployment({ ...prod, extra: true })).toThrow(
      'must not have additional properties',
    )
    expect(() =>
      parseDeployment({ ...prod, web: { ...prod.web, primary: 'https://elsewhere.example' } }),
    ).toThrow('/web/primary')
  })

  it('writes env files that docker reads literally', () => {
    expect(formatEnvFile({ A: 'x=y', B: '$HOME "quoted"' })).toBe('A=x=y\nB=$HOME "quoted"\n')
  })
})
