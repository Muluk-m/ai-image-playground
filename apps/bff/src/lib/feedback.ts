import { randomUUID } from 'node:crypto'
import {
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  FEEDBACK_INBOX_PAGE_SIZE,
  FEEDBACK_MESSAGE_MAX_CHARS,
  FEEDBACK_MESSAGE_PAGE_SIZE,
  type FeedbackAdminCounts,
  type FeedbackAdminDetailResponse,
  type FeedbackAdminListResponse,
  type FeedbackAdminThreadSummary,
  type FeedbackAttachmentMimeType,
  type FeedbackMessage,
  type FeedbackSendMessageResponse,
  type FeedbackStatus,
  type FeedbackSummaryResponse,
  type FeedbackThreadResponse,
  type FeedbackUserThread,
  isFeedbackAttachmentMimeType,
} from '@image-playground/shared'
import { and, asc, desc, eq, exists, gt, ilike, lt, or, type SQL, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { db, schema } from '../db/client'
import { durableMediaStore } from './durableMediaStore'
import { detectMediaMime } from './imageArchive'
import { log } from './logger'
import { readLimitedBody } from './request-body'

export type FeedbackErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'empty_message'
  | 'body_too_long'
  | 'attachment_type'
  | 'attachment_too_large'
  | 'attachment_invalid'
  | 'stale_thread'

export class FeedbackError extends Error {
  constructor(
    readonly code: FeedbackErrorCode,
    readonly status: number,
  ) {
    super(code)
    this.name = 'FeedbackError'
  }
}

const FEEDBACK_PIXEL_LIMIT = 40_000_000

const MIME_TO_EXT: Record<FeedbackAttachmentMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

type ThreadRow = typeof schema.feedback_threads.$inferSelect
type MessageRow = typeof schema.feedback_messages.$inferSelect

export interface FeedbackUploadInput {
  body: string
  attachment?: {
    bytes: Uint8Array
    declaredType: string
    filename: string | null
  }
}

function normalizeDeclaredType(value: string): string | null {
  const type = value.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!type || type === 'application/octet-stream') return null
  if (type === 'image/jpg') return 'image/jpeg'
  return type
}

function sanitizeFilename(name: string | null | undefined): string | null {
  if (!name) return null
  const base = name
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.replace(/[\r\n\0]/g, '')
    .trim()
  if (!base) return null
  return base.slice(0, 160)
}

function normalizeBody(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (trimmed.length > FEEDBACK_MESSAGE_MAX_CHARS) {
    throw new FeedbackError('body_too_long', 400)
  }
  return trimmed
}

export async function readFeedbackUpload(request: Request): Promise<FeedbackUploadInput> {
  const type = request.headers.get('content-type') ?? ''
  const multipart = type.toLowerCase().startsWith('multipart/form-data;')
  const bytes = await readLimitedBody(
    request,
    multipart ? FEEDBACK_ATTACHMENT_MAX_BYTES + 256 * 1024 : 32 * 1024,
  )
  if (bytes === null) {
    throw multipart
      ? new FeedbackError('attachment_too_large', 413)
      : new FeedbackError('body_too_long', 413)
  }
  const payload = new Response(bytes, { headers: { 'content-type': type } })
  if (multipart) {
    let form: FormData
    try {
      form = await payload.formData()
    } catch {
      throw new FeedbackError('attachment_invalid', 400)
    }
    const rawBody = form.get('body')
    const body = normalizeBody(rawBody)
    const file = form.get('attachment')
    if (file === null || file === '') {
      return { body }
    }
    if (!(file instanceof File)) {
      throw new FeedbackError('attachment_type', 400)
    }
    if (file.size === 0) {
      throw new FeedbackError('attachment_invalid', 400)
    }
    if (file.size > FEEDBACK_ATTACHMENT_MAX_BYTES) {
      throw new FeedbackError('attachment_too_large', 413)
    }
    return {
      body,
      attachment: {
        bytes: new Uint8Array(await file.arrayBuffer()),
        declaredType: file.type,
        filename: sanitizeFilename(file.name),
      },
    }
  }

  let json: unknown
  try {
    json = await payload.json()
  } catch {
    throw new FeedbackError('empty_message', 400)
  }
  if (!json || typeof json !== 'object' || !('body' in json)) {
    throw new FeedbackError('empty_message', 400)
  }
  const body = normalizeBody(json.body)
  return { body }
}

async function validateAttachment(
  bytes: Uint8Array,
  declaredType: string,
): Promise<FeedbackAttachmentMimeType> {
  if (bytes.byteLength === 0) throw new FeedbackError('attachment_invalid', 400)
  if (bytes.byteLength > FEEDBACK_ATTACHMENT_MAX_BYTES) {
    throw new FeedbackError('attachment_too_large', 413)
  }
  const sniffed = detectMediaMime(bytes)
  const declared = normalizeDeclaredType(declaredType)
  if (
    !sniffed ||
    !isFeedbackAttachmentMimeType(sniffed) ||
    (declared !== null && declared !== sniffed)
  ) {
    throw new FeedbackError('attachment_type', 400)
  }
  try {
    const metadata = await sharp(bytes, {
      limitInputPixels: FEEDBACK_PIXEL_LIMIT,
      animated: false,
    }).metadata()
    if (!metadata.width || !metadata.height) {
      throw new FeedbackError('attachment_invalid', 422)
    }
  } catch (error) {
    if (error instanceof FeedbackError) throw error
    throw new FeedbackError('attachment_invalid', 422)
  }
  return sniffed
}

function toFeedbackMessage(row: MessageRow, showOperator = false): FeedbackMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    senderType: row.sender_type,
    senderLabel: showOperator ? row.operator_id : null,
    body: row.body,
    attachment:
      row.attachment_key && row.attachment_mime && row.attachment_bytes !== null
        ? {
            mimeType: row.attachment_mime,
            bytes: row.attachment_bytes,
            filename: row.attachment_filename,
          }
        : null,
    createdAt: row.created_at,
  }
}

async function countUnreadReplies(
  thread: ThreadRow,
  client: Pick<typeof db, 'select'> = db,
): Promise<number> {
  const conditions = [
    eq(schema.feedback_messages.thread_id, thread.id),
    eq(schema.feedback_messages.sender_type, 'admin'),
  ]
  if (thread.user_last_read_at !== null) {
    conditions.push(gt(schema.feedback_messages.created_at, thread.user_last_read_at))
  }
  const [row] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.feedback_messages)
    .where(and(...conditions))
  return Number(row?.count ?? 0)
}

function toUserThread(row: ThreadRow, unreadReplyCount: number): FeedbackUserThread {
  return {
    id: row.id,
    status: row.status,
    unreadReplyCount,
    updatedAt: row.updated_at,
  }
}

export async function getUserFeedbackSummary(userId: string): Promise<FeedbackSummaryResponse> {
  const [thread] = await db
    .select()
    .from(schema.feedback_threads)
    .where(eq(schema.feedback_threads.user_id, userId))
    .limit(1)
  if (!thread) return { unreadReplyCount: 0 }
  return { unreadReplyCount: await countUnreadReplies(thread) }
}

interface MessageCursor {
  before?: number
  after?: number
}

async function messagePage(threadId: string, cursor: MessageCursor, showOperator = false) {
  const messages = schema.feedback_messages
  const ascending = cursor.after !== undefined
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.thread_id, threadId),
        cursor.before === undefined ? undefined : lt(messages.created_at, cursor.before),
        cursor.after === undefined ? undefined : gt(messages.created_at, cursor.after),
      ),
    )
    .orderBy(ascending ? asc(messages.created_at) : desc(messages.created_at))
    .limit(FEEDBACK_MESSAGE_PAGE_SIZE + 1)
  const page = rows.slice(0, FEEDBACK_MESSAGE_PAGE_SIZE)
  return {
    messages: (ascending ? page : page.reverse()).map((message) =>
      toFeedbackMessage(message, showOperator),
    ),
    hasMore: rows.length > FEEDBACK_MESSAGE_PAGE_SIZE,
  }
}

export async function getUserFeedbackThread(
  userId: string,
  cursor: MessageCursor,
): Promise<FeedbackThreadResponse> {
  const [thread] = await db
    .select()
    .from(schema.feedback_threads)
    .where(eq(schema.feedback_threads.user_id, userId))
    .limit(1)
  if (!thread) return { thread: null, messages: [], hasMore: false }

  const [page, unreadReplyCount] = await Promise.all([
    messagePage(thread.id, cursor),
    countUnreadReplies(thread),
  ])
  return { thread: toUserThread(thread, unreadReplyCount), ...page }
}

export async function markUserFeedbackRead(
  userId: string,
  messageId: string,
): Promise<FeedbackSummaryResponse> {
  const { feedback_threads: threads, feedback_messages: messages } = schema
  const seenReplyAt = db
    .select({ createdAt: messages.created_at })
    .from(messages)
    .where(
      and(
        eq(messages.thread_id, threads.id),
        eq(messages.id, messageId),
        eq(messages.sender_type, 'admin'),
      ),
    )
  await db
    .update(threads)
    .set({ user_last_read_at: sql`greatest(${threads.user_last_read_at}, (${seenReplyAt}))` })
    .where(eq(threads.user_id, userId))
  return getUserFeedbackSummary(userId)
}

// Updating the thread first serializes writers and gives every message a unique, ordered timestamp.
function nextFeedbackVersion(now: number) {
  return sql`greatest(${new Date(now).toISOString()}::timestamptz, ${schema.feedback_threads.updated_at} + interval '1 millisecond', ${schema.feedback_threads.last_message_at} + interval '1 millisecond')`
}

export async function postUserFeedbackMessage(
  userId: string,
  input: FeedbackUploadInput,
): Promise<FeedbackSendMessageResponse> {
  const body = normalizeBody(input.body)
  if (!body && !input.attachment) {
    throw new FeedbackError('empty_message', 400)
  }

  const messageId = randomUUID()
  let attachmentKey: string | null = null
  let attachmentMime: FeedbackAttachmentMimeType | null = null
  let attachmentBytes: number | null = null
  let attachmentFilename: string | null = null

  if (input.attachment) {
    attachmentMime = await validateAttachment(input.attachment.bytes, input.attachment.declaredType)
    attachmentBytes = input.attachment.bytes.byteLength
    attachmentFilename = sanitizeFilename(input.attachment.filename)
    attachmentKey = `feedback/${userId}/${messageId}.${MIME_TO_EXT[attachmentMime]}`
    await durableMediaStore().write(attachmentKey, input.attachment.bytes, attachmentMime)
  }

  const now = Date.now()
  const result = await db
    .transaction(async (tx) => {
      const [thread] = await tx
        .insert(schema.feedback_threads)
        .values({
          id: randomUUID(),
          user_id: userId,
          status: 'open',
          last_message_at: now,
          last_user_message_at: now,
          last_admin_reply_at: null,
          user_last_read_at: null,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: schema.feedback_threads.user_id,
          set: {
            status: 'open',
            last_message_at: nextFeedbackVersion(now),
            last_user_message_at: nextFeedbackVersion(now),
            updated_at: nextFeedbackVersion(now),
          },
        })
        .returning()

      if (!thread) throw new FeedbackError('not_found', 404)

      const [message] = await tx
        .insert(schema.feedback_messages)
        .values({
          id: messageId,
          thread_id: thread.id,
          sender_type: 'user',
          sender_user_id: userId,
          operator_id: null,
          body,
          attachment_key: attachmentKey,
          attachment_mime: attachmentMime,
          attachment_bytes: attachmentBytes,
          attachment_filename: attachmentFilename,
          created_at: thread.last_message_at,
        })
        .returning()

      if (!message) throw new FeedbackError('not_found', 404)
      return { thread, message, unread: await countUnreadReplies(thread, tx) }
    })
    .catch(async (error: unknown) => {
      if (attachmentKey) {
        await durableMediaStore()
          .deletePrefix(attachmentKey)
          .catch((cleanupError) => {
            log.warn(
              { event: 'feedback.attachment_cleanup_failed', attachmentKey, err: cleanupError },
              'failed to clean up feedback attachment after db error',
            )
          })
      }
      throw error
    })
  return {
    thread: toUserThread(result.thread, result.unread),
    message: toFeedbackMessage(result.message),
  }
}

export async function readFeedbackAttachment(
  messageId: string,
  ownerUserId?: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: FeedbackAttachmentMimeType } | null> {
  const [row] = await db
    .select({
      attachment_key: schema.feedback_messages.attachment_key,
      attachment_mime: schema.feedback_messages.attachment_mime,
      thread_user_id: schema.feedback_threads.user_id,
    })
    .from(schema.feedback_messages)
    .innerJoin(
      schema.feedback_threads,
      eq(schema.feedback_messages.thread_id, schema.feedback_threads.id),
    )
    .where(eq(schema.feedback_messages.id, messageId))
    .limit(1)

  if (!row || !row.attachment_key || !row.attachment_mime) return null
  if (ownerUserId !== undefined && row.thread_user_id !== ownerUserId) return null

  try {
    const bytes = await durableMediaStore().read(row.attachment_key)
    return { bytes, mimeType: row.attachment_mime }
  } catch {
    return null
  }
}

function previewText(body: string, hasAttachment: boolean): string {
  const singleLine = body.replace(/\s+/g, ' ').trim()
  if (singleLine) {
    return singleLine.length > 120 ? `${singleLine.slice(0, 120)}…` : singleLine
  }
  return hasAttachment ? '[图片附件]' : ''
}

const { feedback_threads: threads, feedback_messages: messages, users } = schema
const needsReply = and(
  eq(threads.status, 'open'),
  sql`${threads.last_user_message_at} > coalesce(${threads.last_admin_reply_at}, '-infinity'::timestamptz)`,
)

async function buildAdminSummaries(
  where?: SQL,
  offset = 0,
  limit = 1,
): Promise<FeedbackAdminThreadSummary[]> {
  const selected = db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(users, eq(users.id, threads.user_id))
    .where(where)
    .orderBy(desc(threads.last_message_at), desc(threads.id))
    .limit(limit)
    .offset(offset)
    .as('selected_threads')
  const latestMessage = db
    .select({
      preview: sql<string>`left(${messages.body}, 160)`.as('preview'),
      hasAttachment: sql<boolean>`${messages.attachment_key} is not null`.as('has_attachment'),
      senderType: messages.sender_type,
    })
    .from(messages)
    .where(eq(messages.thread_id, threads.id))
    .orderBy(desc(messages.created_at), desc(messages.id))
    .limit(1)
    .as('latest_message')

  const rows = await db
    .select({
      thread: threads,
      username: users.username,
      nickname: users.nickname,
      latestMessage: {
        preview: latestMessage.preview,
        hasAttachment: latestMessage.hasAttachment,
        senderType: latestMessage.senderType,
      },
      messageCount: db.$count(messages, eq(messages.thread_id, threads.id)),
    })
    .from(selected)
    .innerJoin(threads, eq(threads.id, selected.id))
    .innerJoin(users, eq(threads.user_id, users.id))
    .leftJoinLateral(latestMessage, sql`true`)
    .orderBy(desc(threads.last_message_at), desc(threads.id))

  return rows.map(({ thread, username, nickname, latestMessage: latest, messageCount }) => {
    const lastMessageSenderType = latest?.senderType ?? 'user'
    const lastMessageHasAttachment = latest?.hasAttachment ?? false
    const needsAdminReply = thread.status === 'open' && lastMessageSenderType === 'user'
    return {
      id: thread.id,
      userId: thread.user_id,
      username,
      nickname,
      status: thread.status,
      messageCount,
      lastMessagePreview: previewText(latest?.preview ?? '', lastMessageHasAttachment),
      lastMessageHasAttachment,
      lastMessageSenderType,
      lastMessageAt: thread.last_message_at,
      needsAdminReply,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
    }
  })
}

export async function listAdminFeedbackThreads(filters: {
  filter?: string
  q?: string
  page: number
}): Promise<FeedbackAdminListResponse> {
  const filter =
    filters.filter === 'awaiting_reply'
      ? needsReply
      : filters.filter === 'open' || filters.filter === 'resolved'
        ? eq(threads.status, filters.filter)
        : undefined
  const query = filters.q?.trim()
  const pattern = query ? `%${query.replace(/[%_\\]/g, '\\$&')}%` : undefined
  const search = pattern
    ? or(
        ilike(users.username, pattern),
        ilike(users.nickname, pattern),
        ilike(users.id, pattern),
        exists(
          db
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.thread_id, threads.id), ilike(messages.body, pattern))),
        ),
      )
    : undefined

  const [page, countRows] = await Promise.all([
    buildAdminSummaries(
      and(filter, search),
      (filters.page - 1) * FEEDBACK_INBOX_PAGE_SIZE,
      FEEDBACK_INBOX_PAGE_SIZE + 1,
    ),
    db
      .select({
        all: sql<number>`count(*)::int`,
        awaitingReply: sql<number>`(count(*) filter (where ${needsReply}))::int`,
        open: sql<number>`(count(*) filter (where ${threads.status} = 'open'))::int`,
        resolved: sql<number>`(count(*) filter (where ${threads.status} = 'resolved'))::int`,
      })
      .from(threads),
  ])
  const counts: FeedbackAdminCounts = countRows[0] ?? {
    all: 0,
    awaitingReply: 0,
    open: 0,
    resolved: 0,
  }
  return {
    items: page.slice(0, FEEDBACK_INBOX_PAGE_SIZE),
    counts,
    hasMore: page.length > FEEDBACK_INBOX_PAGE_SIZE,
  }
}

export async function getAdminFeedbackThread(
  threadId: string,
  cursor: MessageCursor,
): Promise<FeedbackAdminDetailResponse> {
  const [summary] = await buildAdminSummaries(eq(threads.id, threadId))
  if (!summary) throw new FeedbackError('not_found', 404)
  return { thread: summary, ...(await messagePage(threadId, cursor, true)) }
}

export async function replyAdminFeedbackThread(
  threadId: string,
  rawBody: string,
  operatorId: string,
): Promise<{ thread: FeedbackAdminThreadSummary; message: FeedbackMessage }> {
  const body = normalizeBody(rawBody)
  if (!body) throw new FeedbackError('empty_message', 400)

  const now = Date.now()
  const message = await db.transaction(async (tx) => {
    const [existing] = await tx
      .update(schema.feedback_threads)
      .set({
        last_message_at: nextFeedbackVersion(now),
        last_admin_reply_at: nextFeedbackVersion(now),
        updated_at: nextFeedbackVersion(now),
      })
      .where(eq(schema.feedback_threads.id, threadId))
      .returning({ createdAt: schema.feedback_threads.last_message_at })
    if (!existing) throw new FeedbackError('not_found', 404)

    const [inserted] = await tx
      .insert(schema.feedback_messages)
      .values({
        id: randomUUID(),
        thread_id: threadId,
        sender_type: 'admin',
        sender_user_id: null,
        operator_id: operatorId,
        body,
        attachment_key: null,
        attachment_mime: null,
        attachment_bytes: null,
        attachment_filename: null,
        created_at: existing.createdAt,
      })
      .returning()
    if (!inserted) throw new FeedbackError('not_found', 404)

    await tx.insert(schema.operator_audits).values({
      id: randomUUID(),
      operator_id: operatorId,
      action: 'feedback.reply',
      target_type: 'feedback_thread',
      target_id: threadId,
      details: { messageId: inserted.id, bodyLength: body.length },
      created_at: now,
    })

    return inserted
  })

  const [summary] = await buildAdminSummaries(eq(threads.id, threadId))
  if (!summary) throw new FeedbackError('not_found', 404)
  return {
    thread: summary,
    message: toFeedbackMessage(message, true),
  }
}

export async function updateAdminFeedbackThreadStatus({
  threadId,
  nextStatus,
  operatorId,
  updatedAt,
}: {
  threadId: string
  nextStatus: FeedbackStatus
  operatorId: string
  updatedAt: number
}): Promise<{ thread: FeedbackAdminThreadSummary }> {
  const now = Date.now()
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(threads)
      .set({ status: nextStatus, updated_at: nextFeedbackVersion(now) })
      .where(and(eq(threads.id, threadId), eq(threads.updated_at, updatedAt)))
      .returning({ id: threads.id })
    if (!updated) {
      const [current] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.id, threadId))
      if (!current) throw new FeedbackError('not_found', 404)
      throw new FeedbackError('stale_thread', 409)
    }

    await tx.insert(schema.operator_audits).values({
      id: randomUUID(),
      operator_id: operatorId,
      action: 'feedback.status',
      target_type: 'feedback_thread',
      target_id: threadId,
      details: { status: nextStatus },
      created_at: now,
    })
  })

  const [summary] = await buildAdminSummaries(eq(threads.id, threadId))
  if (!summary) throw new FeedbackError('not_found', 404)
  return { thread: summary }
}
