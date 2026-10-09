import { hostname } from 'node:os'
import pino from 'pino'
import { appVersion } from './app-version'
import { requestLogFields } from './request-context'

/**
 * BFF 全局 logger。pino 输出 JSON line 到 stdout；部署里由 Docker 的 fluentd 日志驱动转给
 * 日志采集容器，再写进 server_logs 供 Admin 查询（docs/deploy/server-logs.md）。LOG_LEVEL
 * 环境变量可调级别，缺省 'info'。
 *
 * 调用约定：跟事件相关的字段放对象，可读消息放第二个参数。例：
 *   log.info({ event: 'task.completed', taskId, elapsedMs }, 'task completed')
 */
export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service:
      process.env.APP_ROLE === 'worker' ||
      process.argv.some((arg) => arg.endsWith('/worker-index.ts'))
        ? 'worker'
        : 'bff',
    instance: hostname(),
    version: appVersion(),
  },
  // ISO 时间戳比 epoch 数值方便人工读 & 聚合工具友好
  timestamp: pino.stdTimeFunctions.isoTime,
  // 请求里打的日志自动带上 requestId（见 request-context）。
  mixin: requestLogFields,
})
