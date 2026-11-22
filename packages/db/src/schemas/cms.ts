import type {
  FeedbackAttachmentMimeType,
  FeedbackSenderType,
  FeedbackStatus,
} from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from 'drizzle-orm/pg-core'
import { bunJsonb, epochMs } from './common'
import { users } from './identity'

export type InspirationKind = 'showcase' | 'template' | 'skill'
export type InspirationStatus = 'draft' | 'published' | 'archived'
export interface InspirationParams {
  size: string
  quality?: 'auto' | 'low' | 'medium' | 'high'
  n?: number
}
export interface InspirationReferenceImage {
  key: string
  name: string
}

export const inspiration_categories = pgTable('inspiration_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  sort: integer('sort').notNull().default(0),
  created_at: epochMs('created_at').notNull(),
  updated_at: epochMs('updated_at').notNull(),
})

export const inspiration_items = pgTable(
  'inspiration_items',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<InspirationKind>().notNull(),
    status: text('status').$type<InspirationStatus>().notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),
    title: text('title').notNull(),
    description: text('description'),
    category_id: text('category_id')
      .notNull()
      .references(() => inspiration_categories.id),
    prompt: text('prompt').notNull(),
    recommended_provider: text('recommended_provider').notNull(),
    recommended_model: text('recommended_model').notNull(),
    params: bunJsonb('params').$type<InspirationParams>().notNull(),
    tags: bunJsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    cover_key: text('cover_key').notNull(),
    image_key: text('image_key'),
    reference_images: bunJsonb('reference_images')
      .$type<InspirationReferenceImage[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    skill_name: text('skill_name'),
    source_url: text('source_url'),
    author: text('author'),
    thumb_width: integer('thumb_width'),
    thumb_height: integer('thumb_height'),
    sort: integer('sort').notNull().default(0),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
    updated_by: text('updated_by').notNull(),
    published_at: epochMs('published_at'),
  },
  (t) => [
    index('idx_inspiration_items_public').on(t.status, t.sort, t.id),
    index('idx_inspiration_items_category').on(t.category_id, t.sort, t.id),
    check('inspiration_items_kind_check', sql`${t.kind} IN ('showcase', 'template', 'skill')`),
    check('inspiration_items_status_check', sql`${t.status} IN ('draft', 'published', 'archived')`),
  ],
)

export const inspiration_publications = pgTable('inspiration_publications', {
  version: integer('version').primaryKey(),
  published_at: epochMs('published_at').notNull(),
  item_count: integer('item_count').notNull(),
  manifest_hash: text('manifest_hash').notNull(),
})

export type AnnouncementType = 'feature' | 'improvement' | 'notice'
export type AnnouncementImportance = 'normal' | 'major'
export type AnnouncementStatus = 'draft' | 'scheduled' | 'published' | 'archived'
/**
 * 投放对象。paid / free 还不能入库：公开树没有订阅状态，等 overlay 的 isActiveMember
 * 能在读路径上用了再加。当前只有全部、登录、未登录。
 */
export type AnnouncementAudience = 'all' | 'logged_in' | 'anonymous'

export const announcements = pgTable(
  'announcements',
  {
    id: text('id').primaryKey(),
    type: text('type').$type<AnnouncementType>().notNull(),
    importance: text('importance').$type<AnnouncementImportance>().notNull().default('normal'),
    title_zh: text('title_zh').notNull(),
    body_zh: text('body_zh').notNull().default(''),
    title_en: text('title_en'),
    body_en: text('body_en'),
    cover_key: text('cover_key'),
    cta_label: text('cta_label'),
    cta_url: text('cta_url'),
    version_tag: text('version_tag'),
    status: text('status').$type<AnnouncementStatus>().notNull().default('draft'),
    publish_at: epochMs('publish_at'),
    expire_at: epochMs('expire_at'),
    audience: text('audience').$type<AnnouncementAudience>().notNull().default('all'),
    created_by: text('created_by').notNull(),
    updated_by: text('updated_by').notNull(),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
  },
  (t) => [
    index('idx_announcements_status_publish').on(t.status, t.publish_at),
    check('announcements_type_check', sql`${t.type} IN ('feature', 'improvement', 'notice')`),
    check('announcements_importance_check', sql`${t.importance} IN ('normal', 'major')`),
    check(
      'announcements_status_check',
      sql`${t.status} IN ('draft', 'scheduled', 'published', 'archived')`,
    ),
    check('announcements_audience_check', sql`${t.audience} IN ('all', 'logged_in', 'anonymous')`),
    check('announcements_title_zh_check', sql`char_length(${t.title_zh}) BETWEEN 1 AND 80`),
    check('announcements_body_zh_check', sql`char_length(${t.body_zh}) <= 20000`),
    check(
      'announcements_title_en_check',
      sql`${t.title_en} IS NULL OR char_length(${t.title_en}) BETWEEN 1 AND 80`,
    ),
    check(
      'announcements_body_en_check',
      sql`${t.body_en} IS NULL OR char_length(${t.body_en}) <= 20000`,
    ),
    check(
      'announcements_cta_check',
      sql`(${t.cta_label} IS NULL AND ${t.cta_url} IS NULL) OR (${t.cta_label} IS NOT NULL AND ${t.cta_url} IS NOT NULL AND char_length(btrim(${t.cta_label})) > 0 AND char_length(btrim(${t.cta_url})) > 0)`,
    ),
    check(
      'announcements_window_check',
      sql`${t.expire_at} IS NULL OR ${t.publish_at} IS NULL OR ${t.expire_at} > ${t.publish_at}`,
    ),
  ],
)

export const announcement_reads = pgTable(
  'announcement_reads',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    announcement_id: text('announcement_id')
      .notNull()
      .references(() => announcements.id, { onDelete: 'cascade' }),
    read_at: epochMs('read_at'),
    dismissed_at: epochMs('dismissed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.announcement_id] }),
    index('idx_announcement_reads_announcement').on(t.announcement_id),
  ],
)

/** 用户反馈会话：每个账号一条会话，管理员回复与用户追问按时间线展示。 */
export const feedback_threads = pgTable(
  'feedback_threads',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').$type<FeedbackStatus>().notNull().default('open'),
    last_message_at: epochMs('last_message_at').notNull(),
    last_user_message_at: epochMs('last_user_message_at'),
    last_admin_reply_at: epochMs('last_admin_reply_at'),
    user_last_read_at: epochMs('user_last_read_at'),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
  },
  (t) => [
    unique('feedback_threads_user_id_key').on(t.user_id),
    index('idx_feedback_threads_status_last_message').on(t.status, t.last_message_at),
    check('feedback_threads_status_check', sql`${t.status} IN ('open', 'resolved')`),
  ],
)

/** 用户反馈消息（文字与单张图片附件）。 */
export const feedback_messages = pgTable(
  'feedback_messages',
  {
    id: text('id').primaryKey(),
    thread_id: text('thread_id')
      .notNull()
      .references(() => feedback_threads.id, { onDelete: 'cascade' }),
    sender_type: text('sender_type').$type<FeedbackSenderType>().notNull(),
    sender_user_id: text('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    operator_id: text('operator_id'),
    body: text('body').notNull().default(''),
    attachment_key: text('attachment_key'),
    attachment_mime: text('attachment_mime').$type<FeedbackAttachmentMimeType>(),
    attachment_bytes: integer('attachment_bytes'),
    attachment_filename: text('attachment_filename'),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [
    index('idx_feedback_messages_thread_created').on(t.thread_id, t.created_at),
    check('feedback_messages_sender_type_check', sql`${t.sender_type} IN ('user', 'admin')`),
    check('feedback_messages_body_check', sql`char_length(${t.body}) <= 4000`),
    check(
      'feedback_messages_content_check',
      sql`char_length(btrim(${t.body})) > 0 OR ${t.attachment_key} IS NOT NULL`,
    ),
    check(
      'feedback_messages_attachment_mime_check',
      sql`${t.attachment_mime} IS NULL OR ${t.attachment_mime} IN ('image/png', 'image/jpeg', 'image/webp')`,
    ),
    check(
      'feedback_messages_attachment_bytes_check',
      sql`${t.attachment_bytes} IS NULL OR (${t.attachment_bytes} > 0 AND ${t.attachment_bytes} <= 10485760)`,
    ),
    check(
      'feedback_messages_attachment_check',
      sql`(${t.attachment_key} IS NULL AND ${t.attachment_mime} IS NULL AND ${t.attachment_bytes} IS NULL) OR (${t.attachment_key} IS NOT NULL AND ${t.attachment_mime} IS NOT NULL AND ${t.attachment_bytes} IS NOT NULL)`,
    ),
  ],
)
