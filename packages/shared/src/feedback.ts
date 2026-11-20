export const FEEDBACK_STATUSES = ['open', 'resolved'] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export const FEEDBACK_SENDER_TYPES = ['user', 'admin'] as const
export type FeedbackSenderType = (typeof FEEDBACK_SENDER_TYPES)[number]

export const FEEDBACK_ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type FeedbackAttachmentMimeType = (typeof FEEDBACK_ATTACHMENT_MIME_TYPES)[number]

export const FEEDBACK_MESSAGE_PAGE_SIZE = 20
export const FEEDBACK_INBOX_PAGE_SIZE = 40

export const FEEDBACK_MESSAGE_MAX_CHARS = 4000
export const FEEDBACK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const FEEDBACK_ATTACHMENT_ACCEPT = FEEDBACK_ATTACHMENT_MIME_TYPES.join(',')

export interface FeedbackAttachment {
  mimeType: FeedbackAttachmentMimeType
  bytes: number
  filename: string | null
}

export interface FeedbackMessage {
  id: string
  threadId: string
  senderType: FeedbackSenderType
  senderLabel: string | null
  body: string
  attachment: FeedbackAttachment | null
  createdAt: number
}

export interface FeedbackUserThread {
  id: string
  status: FeedbackStatus
  unreadReplyCount: number
  updatedAt: number
}

export interface FeedbackThreadResponse {
  thread: FeedbackUserThread | null
  messages: FeedbackMessage[]
  hasMore: boolean
}

export interface FeedbackSummaryResponse {
  unreadReplyCount: number
}

export interface FeedbackSendMessageResponse {
  thread: FeedbackUserThread
  message: FeedbackMessage
}

export interface FeedbackAdminThreadSummary {
  id: string
  userId: string
  username: string
  nickname: string | null
  status: FeedbackStatus
  messageCount: number
  lastMessagePreview: string
  lastMessageHasAttachment: boolean
  lastMessageSenderType: FeedbackSenderType
  lastMessageAt: number
  needsAdminReply: boolean
  createdAt: number
  updatedAt: number
}

export interface FeedbackAdminCounts {
  all: number
  awaitingReply: number
  open: number
  resolved: number
}

export interface FeedbackAdminListResponse {
  items: FeedbackAdminThreadSummary[]
  counts: FeedbackAdminCounts
  hasMore: boolean
}

export interface FeedbackAdminDetailResponse {
  thread: FeedbackAdminThreadSummary
  messages: FeedbackMessage[]
  hasMore: boolean
}

export function isFeedbackAttachmentMimeType(value: unknown): value is FeedbackAttachmentMimeType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp'
}
