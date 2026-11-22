import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { bunJsonb, epochMs } from './common'
import { users } from './identity'

/**
 * 同步记录的通用列。删除以墓碑传播：`deleted_at` 非空的行内容列全为空，客户端读路径按它过滤。
 * `version` 是落库那一刻的每用户版本号，拉取即「取版本号大于客户端持有值的行」。
 */
const syncRecordColumns = {
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  id: text('id').notNull(),
  updated_at: epochMs('updated_at').notNull(),
  last_used_at: epochMs('last_used_at'),
  deleted_at: epochMs('deleted_at'),
  version: integer('version').notNull(),
}

export const user_templates = pgTable(
  'user_templates',
  {
    ...syncRecordColumns,
    name: text('name'),
    prompt: text('prompt'),
    asset_ids: bunJsonb('asset_ids').$type<Array<string | null>>(),
    params: bunJsonb('params').$type<Record<string, unknown>>(),
    created_at: epochMs('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.id] }),
    index('idx_user_templates_user_version').on(t.user_id, t.version),
    check(
      'user_templates_live_payload_check',
      sql`${t.deleted_at} IS NOT NULL OR (${t.name} IS NOT NULL AND ${t.prompt} IS NOT NULL AND ${t.created_at} IS NOT NULL)`,
    ),
  ],
)

export const user_assets = pgTable(
  'user_assets',
  {
    ...syncRecordColumns,
    name: text('name'),
    /**
     * 封面视角图片本体的内容哈希，同时是对象键 `users/<user_id>/assets/<image_id>` 的末段。
     * `views` 之前的客户端只读这一列，所以它始终等于 `views[0].imageId`。
     */
    image_id: text('image_id'),
    /** 产品或人物；`views` 之前建的素材没有类别。 */
    kind: text('kind'),
    description: text('description'),
    voice_id: text('voice_id'),
    /** 透明或纯色。 */
    background: text('background'),
    /** 有序视角 `[{ imageId, label, source }]`，第一条是封面。旧行为 null，读路径按封面补一条。 */
    views: bunJsonb('views').$type<Array<{ imageId: string; label: string; source: string }>>(),
    created_at: epochMs('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.id] }),
    index('idx_user_assets_user_version').on(t.user_id, t.version),
    check(
      'user_assets_live_payload_check',
      sql`${t.deleted_at} IS NOT NULL OR (${t.name} IS NOT NULL AND ${t.image_id} IS NOT NULL AND ${t.created_at} IS NOT NULL)`,
    ),
  ],
)

/**
 * 模板（代码里叫 `look`，旧「模板」占着 `user_templates`）：一份技能正文加它钉死的模型、尺寸、
 * 素材位数量与图片。参考图与封面走素材图同一条上传路径，计入同一项素材图配额。
 */
export const user_looks = pgTable(
  'user_looks',
  {
    ...syncRecordColumns,
    name: text('name'),
    /** 一句话描述。它进这个用户每一轮的技能清单，必须是一行人话。 */
    description: text('description'),
    purpose: text('purpose'),
    /** frontmatter 之后的分节正文，就是技能正文。 */
    body: text('body'),
    model: text('model'),
    size: text('size'),
    slot_count: integer('slot_count'),
    reference_image_ids: bunJsonb('reference_image_ids').$type<string[]>(),
    cover_image_id: text('cover_image_id'),
    created_at: epochMs('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.id] }),
    index('idx_user_looks_user_version').on(t.user_id, t.version),
    check(
      'user_looks_live_payload_check',
      sql`${t.deleted_at} IS NOT NULL OR (${t.name} IS NOT NULL AND ${t.description} IS NOT NULL AND ${t.body} IS NOT NULL AND ${t.created_at} IS NOT NULL)`,
    ),
  ],
)

/** 用户设置整份存取，不做字段级合并。 */
export const user_preferences = pgTable('user_preferences', {
  user_id: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  document: bunJsonb('document').$type<Record<string, unknown>>().notNull(),
  updated_at: epochMs('updated_at').notNull(),
  version: integer('version').notNull(),
})

/**
 * 已上传的素材图本体台账。对象键是 `users/<user_id>/assets/<image_id>`，这张表既是「对象在不在」
 * 的判据（同步接受素材记录的前提），也是每用户素材总字节的来源——对象存储自己数不出来。
 */
export const user_asset_objects = pgTable(
  'user_asset_objects',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    image_id: text('image_id').notNull(),
    bytes: integer('bytes').notNull(),
    content_type: text('content_type').notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.image_id] })],
)

/** 每用户单调递增的同步版本号；推送时锁住这一行，同一用户的并发同步因此串行。 */
export const user_sync_state = pgTable('user_sync_state', {
  user_id: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(0),
})

export type UserTemplateRow = typeof user_templates.$inferSelect
export type UserAssetRow = typeof user_assets.$inferSelect
export type UserLookRow = typeof user_looks.$inferSelect
export type UserPreferencesRow = typeof user_preferences.$inferSelect
export type UserAssetObjectRow = typeof user_asset_objects.$inferSelect
