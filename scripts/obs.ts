#!/usr/bin/env bun
/**
 * 查日志和链路（ADR 0033）：经各部署的 OpenObserve 只读代理，不依赖 Admin。
 *
 *   bun scripts/obs.ts task <task-id>             任务的日志，加上它每次执行的链路
 *   bun scripts/obs.ts trace <trace-id>           一条链路的 span 树和日志
 *   bun scripts/obs.ts logs [筛选]                日志，新的在前
 *       --task <id> --trace <id> --service <bff|worker|...> --level <info|warn|error>
 *       --grep <文字> --limit <n>
 *   bun scripts/obs.ts sql <SQL> [--type logs|traces]   原样执行一句 SQL
 *
 * 公共参数：--env paid|test（默认 paid），--since 15m|2h|7d（默认 task 7d、其余 1h），--json。
 *
 * 地址与令牌：环境变量 OBS_URL / OBS_TOKEN；没设时读
 * `$XDG_CONFIG_HOME/ai-image-playground/obs.env` 里的 OBS_<ENV>_URL / OBS_<ENV>_TOKEN
 * （例如 OBS_PAID_URL）；组织不是 default 时再设 OBS_ORG / OBS_<ENV>_ORG。令牌就是代理的
 * OBS_PROXY_TOKEN，不要提交进仓库。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  formatLog,
  formatTrace,
  isObsLevel,
  type LogFilter,
  logsSql,
  parseDuration,
  taskSpansSql,
  traceSql,
} from '../apps/bff/src/ops/obs-query'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string', default: 'paid' },
    since: { type: 'string' },
    task: { type: 'string' },
    trace: { type: 'string' },
    service: { type: 'string' },
    level: { type: 'string' },
    grep: { type: 'string' },
    limit: { type: 'string', default: '100' },
    type: { type: 'string', default: 'logs' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const [command, argument] = positionals
process.on('unhandledRejection', (error) =>
  fail(error instanceof Error ? error.message : String(error)),
)
if (values.help || !command) usage(0)

const { url, token, org } = connection(values.env!)
const sinceMs = parseDuration(values.since ?? (command === 'task' ? '7d' : '1h'))
const endUs = (Date.now() + 60_000) * 1_000
const startUs = (Date.now() - sinceMs) * 1_000

async function search(
  sql: string,
  type: 'logs' | 'traces',
  size = 1_000,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${url}/api/${org}/_search?type=${type}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: { sql, start_time: startUs, end_time: endUs, from: 0, size } }),
    signal: AbortSignal.timeout(60_000),
  }).catch((error: unknown) =>
    fail(`连不上 ${url}：${error instanceof Error ? error.message : String(error)}`),
  )
  const payload = (await response.json().catch(() => ({}))) as { hits?: unknown; message?: string }
  if (!response.ok) {
    // 还没有任何数据写进来时流不存在：当作没结果。
    if (/stream not found/i.test(String(payload.message))) return []
    if (response.status === 401) fail('令牌不对：检查 OBS_TOKEN 或 obs.env 里的令牌')
    fail(
      `查询失败（${response.status}）：${payload.message ?? (payload as { error?: string }).error ?? '未知错误'}`,
    )
  }
  return (payload.hits as Record<string, unknown>[]) ?? []
}

function print(
  hits: Record<string, unknown>[],
  render: (hits: Record<string, unknown>[]) => string,
) {
  console.log(values.json ? JSON.stringify(hits, null, 2) : render(hits))
}

const logList = (hits: Record<string, unknown>[]) =>
  hits.length
    ? [...hits]
        .reverse()
        .map((hit) => formatLog(hit))
        .join('\n')
    : '（没有日志）'

switch (command) {
  case 'logs': {
    const level = values.level
    if (level && !isObsLevel(level))
      usage(2, `--level 只认 trace/debug/info/warn/error/fatal：${level}`)
    const filter: LogFilter = {
      taskId: values.task,
      traceId: values.trace,
      service: values.service,
      level: level as LogFilter['level'],
      grep: values.grep,
      limit: Number(values.limit) || 100,
    }
    print(await search(logsSql(filter), 'logs'), logList)
    break
  }
  case 'trace': {
    if (!argument) usage(2, '缺 trace id')
    const spans = await search(traceSql(argument), 'traces')
    const logs = await search(logsSql({ traceId: argument, limit: 500 }), 'logs')
    if (values.json) console.log(JSON.stringify({ spans, logs }, null, 2))
    else console.log(`${formatTrace(spans)}\n\n${logList(logs)}`)
    break
  }
  case 'task': {
    if (!argument) usage(2, '缺任务 id')
    const logs = await search(logsSql({ taskId: argument, limit: 500 }), 'logs')
    const executions = await search(taskSpansSql(argument), 'traces')
    const traces = await Promise.all(
      executions.map(async (row) => ({
        traceId: String(row.trace_id),
        spans: await search(traceSql(String(row.trace_id)), 'traces'),
      })),
    )
    if (values.json) {
      console.log(JSON.stringify({ logs, traces }, null, 2))
      break
    }
    console.log(logList(logs))
    for (const { traceId, spans } of traces)
      console.log(`\n── trace ${traceId}\n${formatTrace(spans)}`)
    if (traces.length === 0)
      console.log('\n（没有这个任务的 span：未配置导出、被采样掉，或早于 P2 上线）')
    break
  }
  case 'sql': {
    if (!argument) usage(2, '缺 SQL')
    const type = values.type === 'traces' ? 'traces' : 'logs'
    console.log(JSON.stringify(await search(argument, type, Number(values.limit) || 100), null, 2))
    break
  }
  default:
    usage(2, `不认识的命令：${command}`)
}

function connection(env: string): { url: string; token: string; org: string } {
  const fromFile = readEnvFile()
  const key = env.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const url = process.env.OBS_URL ?? fromFile[`OBS_${key}_URL`]
  const token = process.env.OBS_TOKEN ?? fromFile[`OBS_${key}_TOKEN`]
  if (!url || !token)
    usage(
      2,
      `没找到 ${env} 的地址或令牌：设 OBS_URL/OBS_TOKEN，或在 obs.env 写 OBS_${key}_URL/OBS_${key}_TOKEN`,
    )
  const org = process.env.OBS_ORG ?? fromFile[`OBS_${key}_ORG`] ?? 'default'
  return { url: url!.replace(/\/+$/, ''), token: token!, org }
}

function readEnvFile(): Record<string, string> {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const path = process.env.OBS_ENV_FILE || join(base, 'ai-image-playground', 'obs.env')
  if (!existsSync(path)) return {}
  const entries: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) entries[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return entries
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function usage(code: number, message?: string): never {
  if (message) console.error(message)
  console.error(
    'bun scripts/obs.ts task <id> | trace <id> | logs [--task --trace --service --level --grep --limit] | sql <SQL> [--type traces]\n' +
      '  公共参数：--env paid|test  --since 15m|2h|7d  --json',
  )
  process.exit(code)
}
