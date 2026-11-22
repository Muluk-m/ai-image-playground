import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { epochMs } from './common'
import { users } from './identity'

export const media_objects = pgTable(
  'media_objects',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    content_type: text('content_type').notNull(),
    status: text('status').$type<'pending' | 'ready' | 'deleting'>().notNull(),
    attachment_managed: boolean('attachment_managed').notNull().default(false),
    attachment_lease_until: epochMs('attachment_lease_until'),
    reserved_bytes: bigint('reserved_bytes', { mode: 'number' }).notNull(),
    staging_key: text('staging_key').notNull(),
    object_key: text('object_key'),
    preview_key: text('preview_key'),
    preview_bytes: bigint('preview_bytes', { mode: 'number' }).notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    expires_at: epochMs('expires_at').notNull(),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_media_objects_owner_hash').on(t.user_id, t.sha256),
    index('idx_media_objects_pending').on(t.status, t.expires_at),
    check('media_objects_bytes_check', sql`${t.bytes} > 0`),
    check('media_objects_reserved_bytes_check', sql`${t.reserved_bytes} >= 0`),
    check('media_objects_status_check', sql`${t.status} IN ('pending', 'ready', 'deleting')`),
  ],
)

export const media_references = pgTable(
  'media_references',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    media_id: text('media_id')
      .notNull()
      .references(() => media_objects.id, { onDelete: 'restrict' }),
    owner_kind: text('owner_kind')
      .$type<'project' | 'asset' | 'conversation' | 'generation' | 'batch' | 'analysis'>()
      .notNull(),
    owner_id: text('owner_id').notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.owner_kind, t.owner_id, t.media_id] }),
    index('idx_media_references_media').on(t.media_id),
    check(
      'media_references_owner_kind_check',
      sql`${t.owner_kind} IN ('project', 'asset', 'conversation', 'generation', 'batch', 'analysis')`,
    ),
  ],
)

/** Media uploaded through the CLI as reference input; listing reference media reads this table. */
export const cli_reference_media = pgTable(
  'cli_reference_media',
  {
    media_id: text('media_id')
      .primaryKey()
      .references(() => media_objects.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [index('idx_cli_reference_media_user_created').on(t.user_id, t.created_at)],
)
