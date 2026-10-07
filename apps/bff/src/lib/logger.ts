import { hostname } from 'node:os'
import pino from 'pino'
import { appVersion } from './app-version'
import { requestLogFields } from './request-context'
import { createServerLogBuffer, parseServerLog } from './server-log-buffer'

/**
 * BFF 全局 logger。pino 默认 JSON line 输出到 stdout，方便后续接任意日志聚合
 * （Loki / Vector / Docker logs / systemd journal 等）。LOG_LEVEL 环境变量
 * 可调级别，缺省 'info'。
 *
 * 调用约定：跟事件相关的字段放对象，可读消息放第二个参数。例：
 *   log.info({ event: 'task.completed', taskId, elapsedMs }, 'task completed')
 */
const identity = {
  service: (process.env.APP_ROLE === 'worker' ||
  process.argv.some((arg) => arg.endsWith('/worker-index.ts'))
    ? 'worker'
    : 'bff') as 'bff' | 'worker',
  instance: hostname(),
  version: appVersion(),
}
let lastWarningAt = 0
export const serverLogBuffer = createServerLogBuffer({
  write: async (entries) => {
    const { writeServerLogs } = await import('./server-logs')
    await writeServerLogs(entries)
  },
  onFailure: () => {
    if (Date.now() - lastWarningAt < 30_000) return
    lastWarningAt = Date.now()
    // Do not feed a database failure back into the log collector.
    process.stderr.write('server log persistence failed; stdout remains available\n')
  },
})
const stdout = pino.destination(1)
const destination = pino.multistream([
  { level: 'trace', stream: stdout },
  {
    level: 'trace',
    stream: {
      write(line: string) {
        const entry = parseServerLog(line, identity)
        if (entry) serverLogBuffer.enqueue(entry)
      },
    },
  },
])
export const log = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: identity,
    // ISO 时间戳比 epoch 数值方便人工读 & 聚合工具友好
    timestamp: pino.stdTimeFunctions.isoTime,
    // 请求里打的日志自动带上 requestId（见 request-context）。
    mixin: requestLogFields,
  },
  destination,
)
