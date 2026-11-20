import { hostname } from 'node:os'
import { redactLogText } from '@image-playground/shared'
import {
  type Attributes,
  context,
  isSpanContextValid,
  type Link,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
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
  return tracer.startActiveSpan(name, { root: true, links, attributes }, (span) =>
    runRecorded(span, work),
  )
}

/**
 * 在当前链路下建一个子 span 跑一段调用（R2 读写之类的出口）：抛错时记下脱敏后的异常、标成错误，
 * 照原样往外抛。`work` 拿到 span，可以按结果补属性。
 */
export function withSpan<T>(
  name: string,
  options: {
    kind?: SpanKind
    attributes?: Attributes
    /**
     * 调用方当正常分支处理的失败（缓存未命中的 404、用户取消）：返回一个结果标签写进
     * `outcome` 属性，不标错，免得把错误率基线顶高。返回 undefined 的照常算错误。
     */
    expectedFailure?: (error: unknown) => string | undefined
  },
  work: (span: Span) => Promise<T>,
): Promise<T> {
  const { expectedFailure, ...spanOptions } = options
  return tracer.startActiveSpan(name, spanOptions, (span) =>
    runRecorded(span, () => work(span), expectedFailure),
  )
}

async function runRecorded<T>(
  span: Span,
  work: () => Promise<T>,
  expectedFailure?: (error: unknown) => string | undefined,
): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const outcome = expectedFailure?.(error)
    if (outcome) span.setAttribute('outcome', outcome)
    else recordSpanError(span, error)
    throw error
  } finally {
    span.end()
  }
}

/**
 * 把异常写进 span：只留名字和脱敏后的消息，不带堆栈。传输层错误的消息里常带完整地址：
 * 查询串可能是 R2 预签名或 `?key=`，路径里是带用户、任务 id 的对象 key，一律只留主机名。
 */
export function recordSpanError(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  span.recordException({
    name: error instanceof Error ? error.name : 'Error',
    message: redactLogText(message.replace(/(https?:\/\/[^\s/?#"']+)[^\s"']*/gi, '$1/<redacted>')),
  })
  span.setStatus({ code: SpanStatusCode.ERROR })
}

/**
 * 发上游请求前把 span 的 traceparent 写进请求头，上游（Vertex 之类）能把它们那边的记录挂到同一条链路。
 * 先复制成 Headers 再 `set`：调用方已经带了 traceparent（任何大小写）也是覆盖，不会合并成逗号串；
 * 调用方的 headers 对象不改。SDK 没初始化时原样返回。
 */
export function withTraceHeaders(headers: unknown, span: Span): unknown {
  const carrier: Record<string, string> = {}
  propagation.inject(trace.setSpan(context.active(), span), carrier)
  if (Object.keys(carrier).length === 0) return headers
  const merged = new Headers(headers as HeadersInit | undefined)
  for (const [name, value] of Object.entries(carrier)) merged.set(name, value)
  return merged
}

export { SpanKind, SpanStatusCode }

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
