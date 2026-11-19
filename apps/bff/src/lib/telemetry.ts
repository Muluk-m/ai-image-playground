import { hostname } from 'node:os'
import { context, isSpanContextValid, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, type SpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { appVersion } from './app-version'

/**
 * OpenTelemetry 链路追踪（ADR 0033）。Bun 上自动埋点覆盖不到 `Bun.serve` 与 Bun 的 `fetch`，
 * span 一律在少数出口手动建（HTTP 边界见 request-context，上游、R2、任务执行各自的模块）。
 *
 * 没配 `OTEL_EXPORTER_OTLP_ENDPOINT` 时照样生成 trace / span id 写进日志，只是不导出 span。
 * 没调 {@link initTelemetry} 的进程（测试、一次性脚本）拿到的是 API 的空实现，不产生 id。
 */

let provider: TracerProvider | undefined

export const tracer = trace.getTracer('image-playground-bff')

export function initTelemetry(
  service: 'bff' | 'worker',
  /** 测试注入（InMemorySpanExporter）；生产只按环境变量决定是否导出。 */
  extraProcessors: readonly SpanProcessor[] = [],
): void {
  if (provider) return
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, '')
  provider = new TracerProvider({
    resource: resourceFromAttributes({
      'service.name': service,
      'service.version': appVersion(),
      'service.instance.id': hostname(),
      ...(process.env.OTEL_DEPLOYMENT_ENVIRONMENT
        ? { 'deployment.environment.name': process.env.OTEL_DEPLOYMENT_ENVIRONMENT }
        : {}),
    }),
    spanProcessors: [
      ...(endpoint
        ? [
            new BatchSpanProcessor({
              exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
              // Collector 不可达时队列满了就丢 span，不拖住请求，也不无限占内存。
              maxQueueSize: 2048,
            }),
          ]
        : []),
      ...extraProcessors,
    ],
  })
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  trace.setGlobalTracerProvider(provider)
}

/** 关停时把还没导出的 span 发完；导出端不可达也只等到 SDK 自己的超时。 */
export async function shutdownTelemetry(): Promise<void> {
  const current = provider
  provider = undefined
  await current?.shutdown().catch(() => {})
}

/** logger 的 mixin 调它：当前 span 里打的日志带上 trace_id / span_id。 */
export function traceLogFields(): { trace_id?: string; span_id?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext()
  if (!spanContext || !isSpanContextValid(spanContext)) return {}
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId }
}
