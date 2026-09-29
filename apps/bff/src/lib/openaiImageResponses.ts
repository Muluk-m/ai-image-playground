import { createParser } from 'eventsource-parser'
import type { HydratedSubmitRequest } from './imageArchive'
import { isObject } from './type-guards'

/** 上游明确结束为失败，与断流导致的执行结果未知分开处理。 */
export class ImageResponsesError extends Error {
  constructor(
    message: string,
    readonly upstreamPayload: unknown,
    readonly upstreamStatus?: number,
  ) {
    super(message)
    this.name = 'ImageResponsesError'
  }
}

export function buildImageResponsesBody(
  mainModel: string,
  imageModel: string,
  request: HydratedSubmitRequest,
): Record<string, unknown> {
  const inputs = request.input_images ?? []
  if (request.mask && inputs.length === 0) {
    throw new ImageResponsesError('遮罩编辑需要至少一张参考图', null, 400)
  }
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    model: imageModel,
    action: inputs.length ? 'edit' : 'generate',
  }
  // extra 只补充图片工具参数，不能覆盖主模型、工具选择或用户消息。
  for (const field of [
    'size',
    'quality',
    'output_format',
    'output_compression',
    'moderation',
  ] as const) {
    const value = request.extra?.[field] ?? request[field]
    if (value !== undefined && value !== null) tool[field] = value
  }
  for (const field of ['background', 'input_fidelity', 'partial_images']) {
    const value = request.extra?.[field]
    if (value !== undefined && value !== null) tool[field] = value
  }
  if (request.mask) tool.input_image_mask = { image_url: request.mask }
  return {
    model: mainModel,
    instructions:
      "When invoking the image_generation tool, use the user's image prompt verbatim. Do not rewrite, expand, translate, or add visual details or constraints.",
    stream: true,
    store: false,
    reasoning: { effort: 'medium', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    parallel_tool_calls: true,
    tool_choice: { type: 'image_generation' },
    tools: [tool],
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: request.prompt },
          ...inputs.map((image_url) => ({ type: 'input_image', image_url })),
        ],
      },
    ],
  }
}

/** 单条事件最多缓冲多少字符。一张 4K PNG 的 base64 约 3300 万字符，留一倍余量。 */
const EVENT_BUFFER_LIMIT_CHARS = 64_000_000
let eventBufferLimit = EVENT_BUFFER_LIMIT_CHARS

/** 测试注入点；undefined 恢复默认上限。 */
export function setImageResponsesBufferLimitForTesting(chars?: number): void {
  eventBufferLimit = chars ?? EVENT_BUFFER_LIMIT_CHARS
}

/** 按 SSE 规范切事件。eventsource-parser 用片段列表缓存未收完的行，几 MB 的图片 base64 不会被反复拼接。 */
async function* readEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const ready: string[] = []
  let overflow: Error | undefined
  // 超限时解析器只回调 onError、这次 feed 并不抛错，得自己接住再抛。
  const parser = createParser({
    maxBufferSize: eventBufferLimit,
    onEvent: (event) => ready.push(event.data),
    onError: (error) => {
      overflow = error
    },
  })
  const feed = (text: string) => {
    parser.feed(text)
    if (overflow) throw overflow
  }
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) {
        // 末尾事件后面可能没有空行；reset({ consume }) 只收残行不派发，补一个空行才会交出它。
        feed(`${decoder.decode()}\n\n`)
        yield* ready.splice(0)
        return
      }
      feed(decoder.decode(chunk.value, { stream: true }))
      yield* ready.splice(0)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function responseFailure(event: Record<string, unknown>): ImageResponsesError {
  const response = isObject(event.response) ? event.response : event
  const error: Record<string, unknown> = isObject(response.error)
    ? response.error
    : { message: response.message, code: response.code, type: response.type }
  const message = typeof error.message === 'string' ? error.message : '上游图片响应未成功完成'
  // 不把 response.output 中可能已有的图片复制进错误日志。
  const payload = {
    error,
    response_id: response.id,
    status: response.status,
    incomplete_details: response.incomplete_details,
  }
  return new ImageResponsesError(
    message,
    payload,
    typeof error.status_code === 'number' ? error.status_code : undefined,
  )
}

export async function readImageResponses(
  body: ReadableStream<Uint8Array> | null | undefined,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!body) throw new Error('上游没有返回图片响应流')
  const images = new Map<string | number, Record<string, unknown>>()
  const actualParams: Record<string, string> = {}
  const remember = (item: unknown, index: unknown) => {
    if (!isObject(item) || item.type !== 'image_generation_call') return
    if (typeof item.result !== 'string' || !item.result) return
    const format = typeof item.output_format === 'string' ? item.output_format : 'png'
    const key = typeof item.id === 'string' ? item.id : typeof index === 'number' ? index : 0
    images.set(key, {
      b64_json: item.result,
      mime: format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png',
      ...(typeof item.revised_prompt === 'string' ? { revised_prompt: item.revised_prompt } : {}),
    })
    for (const field of ['size', 'quality', 'output_format']) {
      if (typeof item[field] === 'string') actualParams[field] = item[field]
    }
  }
  for await (const data of readEvents(body, signal)) {
    if (data === '[DONE]') break
    const event: unknown = JSON.parse(data)
    if (!isObject(event)) throw new Error('上游图片响应事件格式无效')
    if (
      event.type === 'error' ||
      event.type === 'response.failed' ||
      event.type === 'response.incomplete'
    ) {
      throw responseFailure(event)
    }
    if (event.type === 'response.output_item.done') remember(event.item, event.output_index)
    if (event.type !== 'response.completed') continue
    if (!isObject(event.response)) throw new Error('上游图片完成事件缺少响应内容')
    const response = event.response
    if (response.status !== 'completed' || response.error) throw responseFailure(event)
    if (Array.isArray(response.output)) {
      response.output.forEach((item, index) => remember(item, index))
    }
    if (images.size === 0) {
      throw new ImageResponsesError('上游响应已完成，但没有返回图片', { response_id: response.id })
    }
    const payload: Record<string, unknown> = { data: [...images.values()], ...actualParams }
    if (typeof response.created_at === 'number') payload.created = response.created_at
    if (isObject(response.usage)) payload.usage = response.usage
    return payload
  }
  // 收到图片片段不等于请求成功，缺少终态不能触发自动重试和重复计费。
  throw new Error('上游图片响应在完成事件之前中断')
}
