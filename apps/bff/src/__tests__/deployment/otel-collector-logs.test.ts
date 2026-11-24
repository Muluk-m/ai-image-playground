import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../../../../..')
const composeText = readFileSync(resolve(repoRoot, 'deploy/compose.app.yaml'), 'utf8')

function extractOtelLogStatements(): string[] {
  const compose = Bun.YAML.parse(composeText) as {
    configs: { 'otel-collector': { content: string } }
  }
  const rawContent = compose.configs['otel-collector'].content
  // Docker Compose interpolates single `$` inside inline configs as env vars; every literal `$`
  // (including regex `$` anchors, `$1` backrefs, and OTel `${env:...}`) must be escaped as `$$`.
  expect(rawContent).not.toMatch(/(?<!\$)\$(?!\$)/)
  const otelContent = rawContent.replaceAll('$$', '$')
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

function splitTopLevelAnd(cond: string): string[] {
  const parts: string[] = []
  let inQuotes = false
  let escaped = false
  let start = 0
  for (let i = 0; i < cond.length; i++) {
    const ch = cond[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (inQuotes && ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && cond.startsWith(' and ', i)) {
      parts.push(cond.slice(start, i))
      i += 4
      start = i + 1
    }
  }
  if (inQuotes) {
    throw new Error(`Unterminated string literal in OTTL condition: ${cond}`)
  }
  parts.push(cond.slice(start))
  return parts
}

const STRUCTURED_LEVEL_COND_RE =
  /^attributes\["level"\] == (?:\d+|"[a-z]+")(?: or attributes\["level"\] == (?:\d+|"[a-z]+"))*$/

/**
 * 按 `deploy/compose.app.yaml` 中 `transform/logs` 语句的实际顺序模拟纯文本容器日志的
 * 服务名归一化与严重级别求值，确保配置顺序、Docker Compose `$$` 转义与正则严格生效。
 */
function evaluatePlainTextSeverity(
  statements: readonly string[],
  containerName: string,
  body: string,
  source: 'stdout' | 'stderr' = 'stdout',
): { service: string; severity: 'FATAL' | 'ERROR' | 'WARN' | 'INFO' } {
  let service: string | undefined
  let severity: 'FATAL' | 'ERROR' | 'WARN' | 'INFO' | undefined

  for (const stmt of statements) {
    if (
      stmt ===
      'set(attributes["service"], attributes["container_name"]) where attributes["service"] == nil and attributes["container_name"] != nil'
    ) {
      if (service === undefined) {
        service = containerName
      }
      continue
    }

    if (stmt.startsWith('replace_pattern(attributes["service"], ')) {
      const serviceMatch =
        /^replace_pattern\(attributes\["service"\],\s*"((?:\\.|[^"])*)",\s*"\$1"\)$/.exec(stmt)
      expect(serviceMatch).not.toBeNull()
      if (service !== undefined) {
        service = service.replace(new RegExp(unescapeOttlString(serviceMatch![1]!)), '$1')
      }
      continue
    }

    if (!stmt.startsWith('set(severity_number, SEVERITY_NUMBER_')) continue

    const levelMatch =
      /^set\(severity_number, SEVERITY_NUMBER_(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\) where (.+)$/.exec(
        stmt,
      )
    if (!levelMatch) {
      throw new Error(`Unrecognized severity statement: ${stmt}`)
    }
    const level = levelMatch[1]!
    const cond = levelMatch[2]!
    if (STRUCTURED_LEVEL_COND_RE.test(cond)) {
      continue
    }

    const clauses = splitTopLevelAnd(cond)
    let matched = true
    for (const clause of clauses) {
      if (clause === 'severity_number == SEVERITY_NUMBER_UNSPECIFIED') {
        if (severity !== undefined) matched = false
        continue
      }
      const serviceEq = /^attributes\["service"\] == "((?:\\.|[^"])*)"$/.exec(clause)
      if (serviceEq) {
        if (service !== unescapeOttlString(serviceEq[1]!)) matched = false
        continue
      }
      const sourceEq = /^attributes\["source"\] == "((?:\\.|[^"])*)"$/.exec(clause)
      if (sourceEq) {
        if (source !== unescapeOttlString(sourceEq[1]!)) matched = false
        continue
      }
      const bodyMatch = /^IsMatch\(body, "((?:\\.|[^"])*)"\)$/.exec(clause)
      if (bodyMatch) {
        if (!new RegExp(unescapeOttlString(bodyMatch[1]!)).test(body)) matched = false
        continue
      }
      throw new Error(`Unsupported OTTL severity predicate "${clause}" in: ${stmt}`)
    }

    if (matched) {
      if (level !== 'FATAL' && level !== 'ERROR' && level !== 'WARN' && level !== 'INFO') {
        throw new Error(`Unexpected plain-text severity level: ${level}`)
      }
      severity = level
    }
  }

  expect(service).toBeDefined()
  expect(severity).toBeDefined()
  return { service: service!, severity: severity! }
}

describe('deploy/compose.app.yaml otel-collector cloudflared log severity rules', () => {
  const statements = extractOtelLogStatements()

  it('populates and normalizes service before applying cloudflared-scoped severity downgrades', () => {
    const setServiceIdx = statements.indexOf(
      'set(attributes["service"], attributes["container_name"]) where attributes["service"] == nil and attributes["container_name"] != nil',
    )
    const replaceServiceIdx = statements.findIndex((s) =>
      s.startsWith('replace_pattern(attributes["service"], '),
    )
    const firstCloudflaredSeverityIdx = statements.findIndex(
      (s) =>
        s.startsWith('set(severity_number, SEVERITY_NUMBER_WARN)') &&
        s.includes('attributes["service"] == "cloudflared"'),
    )
    expect(setServiceIdx).toBeGreaterThan(-1)
    expect(replaceServiceIdx).toBeGreaterThan(setServiceIdx)
    expect(firstCloudflaredSeverityIdx).toBeGreaterThan(replaceServiceIdx)
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
