import type { ProjectDocument, ProjectReceipt } from '@image-playground/shared'
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { agent_conversations } from './agent'
import { bunJsonb, epochMs } from './common'
import { generation_records } from './execution'
import { users } from './identity'

export const canvas_projects = pgTable(
  'canvas_projects',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    revision: integer('revision').notNull(),
    document: bunJsonb('document').$type<ProjectDocument>().notNull(),
    element_count: integer('element_count').notNull(),
    cover_media_id: text('cover_media_id'),
    conversation_id: text('conversation_id').references(() => agent_conversations.id, {
      onDelete: 'set null',
    }),
    receipts: bunJsonb('receipts').$type<ProjectReceipt[]>().notNull(),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
    deleted_at: epochMs('deleted_at'),
    restore_until: epochMs('restore_until'),
  },
  (t) => [
    index('idx_canvas_projects_owner_id').on(t.user_id, t.id),
    uniqueIndex('idx_canvas_projects_conversation').on(t.conversation_id),
    unique('canvas_projects_owner_id_key').on(t.user_id, t.id),
  ],
)

/** Increment log and compacted snapshot. Legacy document is retained independently of the read model. */
export const canvas_documents = pgTable('canvas_documents', {
  project_id: text('project_id')
    .primaryKey()
    .references(() => canvas_projects.id, { onDelete: 'cascade' }),
  snapshot: text('snapshot').notNull(),
  sequence: integer('sequence').notNull().default(0),
  compacted_sequence: integer('compacted_sequence').notNull().default(0),
  compacted_at: epochMs('compacted_at').notNull(),
  legacy_document: bunJsonb('legacy_document').$type<ProjectDocument>().notNull(),
  migrated_at: epochMs('migrated_at').notNull(),
})
export const canvas_updates = pgTable(
  'canvas_updates',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => canvas_documents.project_id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    update: text('update').notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.project_id, t.sequence] })],
)

/** Durable reversible Agent commands; ownership follows the project. */
export const canvas_commands = pgTable(
  'canvas_commands',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => canvas_documents.project_id, { onDelete: 'cascade' }),
    turn_id: text('turn_id').notNull(),
    tool_call_id: text('tool_call_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    label: text('label').notNull(),
    before: text('before').notNull(),
    update: text('update').notNull(),
    reversed: boolean('reversed').notNull().default(false),
    revision: integer('revision').notNull().default(0),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_canvas_commands_call').on(t.project_id, t.turn_id, t.tool_call_id),
    index('idx_canvas_commands_project_created').on(t.project_id, t.created_at),
  ],
)

export const project_generation_outputs = pgTable(
  'project_generation_outputs',
  {
    generation_id: text('generation_id')
      .notNull()
      .references(() => generation_records.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    project_id: text('project_id')
      .notNull()
      .references(() => canvas_projects.id, { onDelete: 'cascade' }),
    conversation_id: text('conversation_id').notNull(),
    turn_id: text('turn_id').notNull(),
    object_id: text('object_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.generation_id, t.position] }),
    uniqueIndex('idx_project_generation_objects').on(t.project_id, t.object_id),
  ],
)
