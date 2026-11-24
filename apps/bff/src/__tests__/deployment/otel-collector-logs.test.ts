import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../../../../..')
const composeText = readFileSync(resolve(repoRoot, 'deploy/compose.app.yaml'), 'utf8')

function extractOtelLogStatements(): string[] {
  const compose = Bun.YAML.parse(composeText) as {
    configs: { 'otel-collector': { content: string } }
  }
  const otelContent = compose.configs['otel-collector'].content.replaceAll('$$', '$')
  const otel = Bun.YAML.parse(otelContent) as {
    processors: {
      'transform/logs': {
        log_statements: Array<{ statements: string[] }>
      }
    }
  }
  return otel.processors['transform/logs'].log_statements.flatMap((block) => block.statements)
}

function unescapeOttlString(raw: string): string {
  return JSON.parse(`"${raw}"`) as string
}

/**
 * 镜像 `deploy/compose.app.yaml` 中 `transform/logs` 的服务名归一化与文本日志级别语句，
 * 确保配置里的正则与先后顺序真实生效，不把 cloudflared 单连接回收误报成 ERROR，也不放过真故障。
 */
function evaluatePlainTextSeverity(
  statements: readonly string[],
  containerName: string,
  body: string,
  source: 'stdout' | 'stderr' = 'stdout',
): { service: string; severity: 'FATAL' | 'ERROR' | 'WARN' | 'INFO' } {
  const serviceRule = statements.find((s) =>
    s.startsWith('replace_pattern(attributes["service"], '),
  )
  expect(serviceRule).toBeDefined()
  const serviceMatch =
    /^replace_pattern\(attributes\["service"\],\s*"((?:\\.|[^"])*)",\s*"\$1"\)$/.exec(serviceRule!)
  expect(serviceMatch).not.toBeNull()
  const service = containerName.replace(new RegExp(unescapeOttlString(serviceMatch![1]!)), '$1')

  const severityRules = statements.filter((s) =>
    s.startsWith('set(severity_number, SEVERITY_NUMBER_'),
  )
  for (const stmt of severityRules) {
    const levelMatch =
      /^set\(severity_number, SEVERITY_NUMBER_(FATAL|ERROR|WARN|INFO)\) where (.+)$/.exec(stmt)
    if (!levelMatch) continue
    const level = levelMatch[1] as 'FATAL' | 'ERROR' | 'WARN' | 'INFO'
    const cond = levelMatch[2]!
    if (!cond.includes('severity_number == SEVERITY_NUMBER_UNSPECIFIED')) continue
    if (cond.includes('attributes["service"] == "cloudflared"') && service !== 'cloudflared')
      continue
    if (cond.includes('attributes["source"] == "stderr"') && source !== 'stderr') continue
    const bodyMatches = [...cond.matchAll(/IsMatch\(body, "((?:\\.|[^"])*)"\)/g)]
    if (bodyMatches.every((m) => new RegExp(unescapeOttlString(m[1]!)).test(body))) {
      return { service, severity: level }
    }
  }
  throw new Error(`No severity rule matched: ${body}`)
}

describe('deploy/compose.app.yaml otel-collector cloudflared log severity rules', () => {
  const statements = extractOtelLogStatements()

  it('normalizes service before applying cloudflared-scoped severity downgrades', () => {
    const serviceIdx = statements.findIndex((s) =>
      s.startsWith('replace_pattern(attributes["service"], '),
    )
    const firstCloudflaredSeverityIdx = statements.findIndex(
      (s) =>
        s.startsWith('set(severity_number, SEVERITY_NUMBER_WARN)') &&
        s.includes('attributes["service"] == "cloudflared"'),
    )
    expect(serviceIdx).toBeGreaterThan(-1)
    expect(firstCloudflaredSeverityIdx).toBeGreaterThan(serviceIdx)
  })

  it('downgrades routine cloudflared control-stream teardown and client cancel ERR lines to WARN', () => {
    const containers = [
      '/image-playground-paid-cloudflared-1',
      'image-playground-enterprise-tunnel-cloudflared-1',
      'image-playground-test-cloudflared-1',
    ]
    const benignLines = [
      '2026-11-23T23:24:22Z ERR failed to serve incoming request error="Error shutting down control stream: rpc: connection closed"',
      '2026-11-23T22:47:55Z ERR failed to serve incoming request error="Error shutting down control stream: stream error: stream ID 1; CANCEL"',
      '2026-11-23T06:58:42Z ERR failed to serve incoming request error="Error shutting down control stream: client disconnected"',
      '2026-11-23T18:51:11Z ERR failed to serve incoming request error="Error shutting down control stream: context canceled"',
      '2026-10-10T03:17:45Z ERR failed to serve incoming request error="failed to proxy HTTP: context canceled"',
      '2026-10-10T03:17:45Z ERR  error="context canceled" connIndex=2 event=1 ingressRule=0',
    ]
    for (const container of containers) {
      for (const line of benignLines) {
        expect(evaluatePlainTextSeverity(statements, container, line)).toEqual({
          service: 'cloudflared',
          severity: 'WARN',
        })
      }
    }
  })

  it('keeps real cloudflared failures and non-cloudflared ERR lines as ERROR/FATAL', () => {
    expect(
      evaluatePlainTextSeverity(
        statements,
        '/image-playground-paid-cloudflared-1',
        '2026-10-13T10:01:25Z ERR error="Unable to reach the origin service. dial tcp 172.22.0.3:37378: connect: connection refused"',
      ),
    ).toEqual({ service: 'cloudflared', severity: 'ERROR' })

    expect(
      evaluatePlainTextSeverity(
        statements,
        '/image-playground-paid-cloudflared-1',
        '2026-10-08T03:01:40Z ERR Failed to serve tunnel connection',
      ),
    ).toEqual({ service: 'cloudflared', severity: 'ERROR' })

    expect(
      evaluatePlainTextSeverity(
        statements,
        '/image-playground-paid-cloudflared-1',
        '2026-10-08T03:01:40Z FTL Failed to authenticate tunnel',
      ),
    ).toEqual({ service: 'cloudflared', severity: 'FATAL' })

    // Non-cloudflared services must not match cloudflared-scoped downgrades.
    expect(
      evaluatePlainTextSeverity(
        statements,
        '/image-playground-paid-r20261124142836-2255415-bff',
        '2026-11-23T23:24:22Z ERR failed to serve incoming request error="Error shutting down control stream: rpc: connection closed"',
      ),
    ).toEqual({ service: 'bff', severity: 'ERROR' })
  })
})
