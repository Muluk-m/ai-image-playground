import pino from 'pino'

/**
 * BFF 全局 logger。pino 默认 JSON line 输出到 stdout，方便后续接日志聚合
 * （Loki / Vector / launchd 的 StandardOutPath 任一）。LOG_LEVEL 环境变量
 * 可调级别，缺省 'info'。
 *
 * 调用约定：跟事件相关的字段放对象，可读消息放第二个参数。例：
 *   log.info({ event: 'task.completed', taskId, elapsedMs }, 'task completed')
 */
export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'bff' },
  // ISO 时间戳比 epoch 数值方便人工读 & 聚合工具友好
  timestamp: pino.stdTimeFunctions.isoTime,
})
