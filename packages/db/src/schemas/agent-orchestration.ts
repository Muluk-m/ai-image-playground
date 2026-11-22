import type {
  AgentBatchAnalysisSource,
  AgentBatchAttemptSnapshot,
  AgentBatchConfirmation,
  AgentBatchEstimates,
  AgentBatchItem,
  AgentBatchPriceSnapshot,
  StageAuthorization,
} from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { agent_conversations } from './agent'
import { canvas_projects } from './canvas'
import { bunJsonb, epochMs } from './common'
import { users } from './identity'

export const agent_batches = pgTable(
  'agent_batches',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversation_id: text('conversation_id').references(() => agent_conversations.id, {
      onDelete: 'set null',
    }),
    origin_turn_id: text('origin_turn_id').notNull(),
    tool_call_id: text('tool_call_id').notNull(),
    experience: text('experience').$type<'chat' | 'canvas'>().notNull(),
    project_id: text('project_id'),
    project_revision: integer('project_revision'),
    current_version: integer('current_version').notNull().default(1),
    status: text('status')
      .$type<'draft' | 'cancelled' | 'running' | 'paused' | 'closed'>()
      .notNull()
      .default('draft'),
    pause_reason: text('pause_reason').$type<
      | 'price_changed'
      | 'insufficient_credits'
      | 'quota_exceeded'
      | 'input_limit'
      | 'upstream_auth'
      | 'model_unavailable'
      | 'submission_refused'
    >(),
    confirmed_version: integer('confirmed_version'),
    confirmation_command_id: text('confirmation_command_id'),
    device_id: text('device_id'),
    dispatch_generation: integer('dispatch_generation').notNull().default(0),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_agent_batches_confirmation').on(t.user_id, t.confirmation_command_id),
    uniqueIndex('idx_agent_batches_call').on(t.conversation_id, t.origin_turn_id, t.tool_call_id),
    index('idx_agent_batches_owner_conversation').on(
      t.user_id,
      t.conversation_id,
      t.created_at,
      t.id,
    ),
    check(
      'agent_batches_status_check',
      sql`${t.status} IN ('draft', 'cancelled', 'running', 'paused', 'closed')`,
    ),
    check('agent_batches_experience_check', sql`${t.experience} IN ('chat', 'canvas')`),
  ],
)

export const agent_batch_plans = pgTable(
  'agent_batch_plans',
  {
    batch_id: text('batch_id')
      .notNull()
      .references(() => agent_batches.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    rule: text('rule').notNull(),
    digest: text('digest').notNull(),
    item_count: integer('item_count').notNull(),
    estimate_snapshot: bunJsonb('estimate_snapshot').$type<AgentBatchEstimates>().notNull(),
    attempt_targets: bunJsonb('attempt_targets')
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    retry_item_keys: bunJsonb('retry_item_keys').$type<string[]>().notNull().default([]),
    retry_requires_resume: boolean('retry_requires_resume').notNull().default(false),
    confirmation: bunJsonb('confirmation').$type<AgentBatchConfirmation>(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.batch_id, t.version] })],
)

export const agent_batch_items = pgTable(
  'agent_batch_items',
  {
    batch_id: text('batch_id')
      .notNull()
      .references(() => agent_batches.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    key: text('key').notNull(),
    ordinal: integer('ordinal').notNull(),
    kind: text('kind').$type<AgentBatchItem['kind']>().notNull(),
    inputs: bunJsonb('inputs').$type<AgentBatchItem['inputs']>().notNull(),
    prompt: text('prompt').notNull(),
    params: bunJsonb('params').$type<AgentBatchItem['params']>().notNull(),
    source_analysis: bunJsonb('source_analysis').$type<readonly AgentBatchAnalysisSource[]>(),
    dependencies: bunJsonb('dependencies').$type<AgentBatchItem['dependencies']>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.batch_id, t.version, t.key] }),
    uniqueIndex('idx_agent_batch_items_order').on(t.batch_id, t.version, t.ordinal),
    foreignKey({
      columns: [t.batch_id, t.version],
      foreignColumns: [agent_batch_plans.batch_id, agent_batch_plans.version],
    }).onDelete('cascade'),
  ],
)

export const agent_batch_attempts = pgTable(
  'agent_batch_attempts',
  {
    batch_id: text('batch_id').notNull(),
    version: integer('version').notNull(),
    item_key: text('item_key').notNull(),
    attempt: integer('attempt').notNull(),
    task_id: text('task_id').notNull(),
    price_snapshot: bunJsonb('price_snapshot').$type<AgentBatchPriceSnapshot | null>(),
    reserved_credits: integer('reserved_credits').notNull(),
    terminal_snapshot: bunJsonb('terminal_snapshot').$type<AgentBatchAttemptSnapshot>(),
    submitted_at: epochMs('submitted_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.batch_id, t.version, t.item_key, t.attempt] }),
    uniqueIndex('idx_agent_batch_attempts_task').on(t.task_id),
    uniqueIndex('idx_agent_batch_attempts_number').on(t.batch_id, t.item_key, t.attempt),
    foreignKey({
      columns: [t.batch_id, t.version, t.item_key],
      foreignColumns: [
        agent_batch_items.batch_id,
        agent_batch_items.version,
        agent_batch_items.key,
      ],
    }).onDelete('restrict'),
  ],
)

export const agent_batch_commands = pgTable(
  'agent_batch_commands',
  {
    batch_id: text('batch_id')
      .notNull()
      .references(() => agent_batches.id, { onDelete: 'cascade' }),
    command_id: text('command_id').notNull(),
    kind: text('kind')
      .$type<
        | 'pause'
        | 'resume'
        | 'reprice'
        | 'retry_quote'
        | 'analysis_proposal'
        | 'generation_proposal'
        | 'phase_edit'
      >()
      .notNull(),
    request_hash: text('request_hash').notNull(),
    created_at: epochMs('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.batch_id, t.command_id] })],
)

/** Scope, activation and the append-only spend trail share one row lock. */
export const agent_stage_authorizations = pgTable(
  'agent_stage_authorizations',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => agent_conversations.id, { onDelete: 'cascade' }),
    project_id: text('project_id')
      .notNull()
      .references(() => canvas_projects.id, { onDelete: 'cascade' }),
    proposal_key: text('proposal_key').notNull(),
    execution_token_hash: text('execution_token_hash'),
    state: bunJsonb('state').$type<StageAuthorization>().notNull(),
    created_at: epochMs('created_at').notNull(),
    updated_at: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_agent_stage_proposal').on(t.conversation_id, t.proposal_key),
    index('idx_agent_stage_owner').on(t.user_id, t.conversation_id),
    foreignKey({
      columns: [t.user_id, t.conversation_id],
      foreignColumns: [agent_conversations.user_id, agent_conversations.id],
      name: 'agent_stage_authorizations_owner_conversation_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.user_id, t.project_id],
      foreignColumns: [canvas_projects.user_id, canvas_projects.id],
      name: 'agent_stage_authorizations_owner_project_fk',
    }).onDelete('cascade'),
  ],
)
