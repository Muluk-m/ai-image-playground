import type {
  FeedbackSendMessageResponse,
  FeedbackSummaryResponse,
  FeedbackThreadResponse,
} from '@image-playground/shared'
import { authenticatedBffFetch } from '../../lib/authClient'
import { bffBaseUrl } from '../../lib/runtimeConfig'

export class FeedbackClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = 'FeedbackClientError'
  }
}

async function parseFeedbackError(response: Response): Promise<FeedbackClientError> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error) {
      return new FeedbackClientError(response.status, body.error)
    }
  } catch {
    // 非 JSON 错误体直接落回状态码
  }
  return new FeedbackClientError(response.status, `http_${response.status}`)
}

export async function fetchFeedbackSummary(signal?: AbortSignal): Promise<FeedbackSummaryResponse> {
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/feedback/summary`, { signal })
  if (!response.ok) throw await parseFeedbackError(response)
  return (await response.json()) as FeedbackSummaryResponse
}

export async function fetchFeedbackThread(
  cursor: { before?: number; after?: number },
  signal?: AbortSignal,
): Promise<FeedbackThreadResponse> {
  const params = new URLSearchParams()
  if (cursor.before !== undefined) params.set('before', String(cursor.before))
  if (cursor.after !== undefined) params.set('after', String(cursor.after))
  const suffix = params.size ? `?${params}` : ''
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/feedback${suffix}`, { signal })
  if (!response.ok) throw await parseFeedbackError(response)
  return (await response.json()) as FeedbackThreadResponse
}

export async function markFeedbackRead(
  messageId: string,
  signal?: AbortSignal,
): Promise<FeedbackSummaryResponse> {
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/feedback/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageId }),
    signal,
  })
  if (!response.ok) throw await parseFeedbackError(response)
  return response.json()
}

export async function sendFeedbackMessage(input: {
  body: string
  attachment?: File | null
}): Promise<FeedbackSendMessageResponse> {
  let response: Response
  if (input.attachment) {
    const form = new FormData()
    form.set('body', input.body)
    form.set('attachment', input.attachment, input.attachment.name || 'screenshot.png')
    response = await authenticatedBffFetch(`${bffBaseUrl()}/api/feedback/messages`, {
      method: 'POST',
      body: form,
    })
  } else {
    response = await authenticatedBffFetch(`${bffBaseUrl()}/api/feedback/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: input.body }),
    })
  }
  if (!response.ok) throw await parseFeedbackError(response)
  return (await response.json()) as FeedbackSendMessageResponse
}

export async function fetchFeedbackAttachmentBlobUrl(
  messageId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await authenticatedBffFetch(
    `${bffBaseUrl()}/api/feedback/attachments/${encodeURIComponent(messageId)}`,
    { signal },
  )
  if (!response.ok) throw await parseFeedbackError(response)
  const blob = await response.blob()
  return URL.createObjectURL(blob)
}
