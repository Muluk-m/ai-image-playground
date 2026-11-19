import { hostname } from 'node:os'
import { redactLogText } from '@image-playground/shared'
import {
  type Attributes,
  context,
  isSpanContextValid,
  type Link,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from '@opentelemetry/sdk-trace'
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
  // 只有本进程里的父 span 决定子 span 是否采样；外部传来的 traceparent 只用来接链路，
  // 它的 sampled 位不算数，调用方关不掉我们的记录。sdk-trace 3.x 不再读 OTEL_TRACES_SAMPLER。
  const ratio = traceSampleRatio()
  provider = new TracerProvider({
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(ratio),
      remoteParentSampled: new TraceIdRatioBasedSampler(ratio),
      remoteParentNotSampled: new TraceIdRatioBasedSampler(ratio),
    }),
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

/** `OTEL_TRACES_SAMPLE_RATIO`（0–1，默认 1）：流量涨上来后按比例降量，不用改代码。 */
function traceSampleRatio(): number {
  const raw = process.env.OTEL_TRACES_SAMPLE_RATIO?.trim()
  if (!raw) return 1
  const ratio = Number(raw)
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)
    throw new Error('OTEL_TRACES_SAMPLE_RATIO must be a number between 0 and 1')
  return ratio
}

/** 关停时把还没导出的 span 发完，最多等 5 秒：Collector 挂了也不能吃掉容器的停机宽限。 */
export async function shutdownTelemetry(): Promise<void> {
  const current = provider
  provider = undefined
  if (!current) return
  await Promise.race([current.shutdown().catch(() => {}), Bun.sleep(5_000)])
}

/** logger 的 mixin 调它：当前 span 里打的日志带上 trace_id / span_id。 */
export function traceLogFields(): { trace_id?: string; span_id?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext()
  if (!spanContext || !isSpanContextValid(spanContext)) return {}
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId }
}

/** 当前链路的 W3C traceparent，写进任务行；不在 span 里（或没初始化 SDK）时为 null。 */
export function currentTraceparent(): string | null {
  const carrier: { traceparent?: string } = {}
  propagation.inject(context.active(), carrier)
  return carrier.traceparent ?? null
}

/**
 * 在一个新的根 span 里跑一段后台工作（例如 worker 执行任务），用 link 指回提交时的链路：
 * 排队、重试、换 worker 都各算一次执行，不和提交请求挤在一条 trace 里（OTel 消息语义约定）。
 */
export async function runInLinkedSpan<T>(
  name: string,
  traceparent: string | null | undefined,
  attributes: Attributes,
  work: () => Promise<T>,
): Promise<T> {
  const links: Link[] = []
  if (traceparent) {
    const linked = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, { traceparent }))
    if (linked && isSpanContextValid(linked)) links.push({ context: linked })
  }
  return tracer.startActiveSpan(name, { root: true, links, attributes }, async (span) => {
    try {
      return await work()
    } catch (error) {
      span.recordException({
        name: error instanceof Error ? error.name : 'Error',
        message: redactLogText(error instanceof Error ? error.message : String(error)),
      })
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw error
    } finally {
      span.end()
    }
  })
}

export type TaskOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retry_scheduled'
  | 'reconciling'
  | 'archive_requeued'

/**
 * 在当前执行 span 上记下这次执行的结果。worker 把上游失败接住后自己写终态或安排重试、正常返回，
 * 外层看不到异常，只能在写终态的地方标：失败、重试、待核查、归档回队都算这次执行出错。
 */
export function recordTaskOutcome(outcome: TaskOutcome, detail?: string): void {
  const span = trace.getActiveSpan()
  if (!span) return
  span.setAttribute('task.outcome', outcome)
  if (outcome === 'completed' || outcome === 'cancelled') return
  span.setStatus({
    code: SpanStatusCode.ERROR,
    ...(detail ? { message: redactLogText(detail).slice(0, 500) } : {}),
  })
}
