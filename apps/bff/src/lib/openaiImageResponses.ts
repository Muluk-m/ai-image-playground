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

/** 逐行拼接，避免每个网络分片都复制一次尚未收完的大段图片 base64。 */
async function* readEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let lineParts: string[] = []
  let dataLines: string[] = []
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      const text = decoder.decode(chunk.value, { stream: !chunk.done })
      let start = 0
      for (;;) {
        const end = text.indexOf('\n', start)
        if (end < 0) {
          if (start < text.length) lineParts.push(text.slice(start))
          break
        }
        lineParts.push(text.slice(start, end))
        const line = lineParts.join('').replace(/\r$/, '')
        lineParts = []
        start = end + 1
        if (!line) {
          if (dataLines.length) {
            yield dataLines.join('\n')
            dataLines = []
          }
        } else if (line.startsWith('data:')) {
          const value = line.slice(5)
          dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
        }
      }
      if (chunk.done) {
        const line = lineParts.join('').replace(/\r$/, '')
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
        if (dataLines.length) yield dataLines.join('\n')
        return
      }
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
