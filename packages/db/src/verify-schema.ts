import { SQL } from 'bun'

export const EXPECTED_TABLES = [
  'generation_images',
  'agent_executions',
  'deployment_controls',
  'media_objects',
  'media_references',
  'generation_commands',
  'generation_records',
  'user_change_heads',
  'user_changes',
  'domain_migrations',
  'domain_migration_chunks',
  'agent_conversations',
  'agent_messages',
  'agent_model_calls',
  'agent_turn_events',
  'agent_turns',
  'agent_tool_calls',
  'agent_inbox',
  'agent_jobs',
  'canvas_projects',
  'project_generation_outputs',
  'daily_quota',
  'operator_audits',
  'api_minutes',
  'container_samples',
  'host_samples',
  'service_heartbeats',
  'tasks',
  'user_asset_objects',
  'user_assets',
  'user_identities',
  'user_preferences',
  'user_sessions',
  'user_sync_state',
  'user_templates',
  'users',
] as const

export const EXPECTED_INDEXES = [
  'generation_images_generation_id_role_position_pk',
  'agent_executions_pkey',
  'deployment_controls_pkey',
  'idx_tasks_lease_expires',
  'media_objects_pkey',
  'media_references_user_id_owner_kind_owner_id_media_id_pk',
  'idx_media_objects_owner_hash',
  'idx_media_objects_pending',
  'idx_media_references_media',
  'generation_commands_user_id_command_id_pk',
  'generation_records_pkey',
  'idx_generation_records_owner_time',
  'user_change_heads_pkey',
  'user_changes_user_id_sequence_pk',
  'agent_conversations_pkey',
  'agent_model_calls_pkey',
  'idx_agent_model_calls_turn',
  'agent_messages_conversation_id_id_pk',
  'agent_turn_events_conversation_id_seq_pk',
  'agent_turns_conversation_id_turn_id_pk',
  'agent_tool_calls_conversation_id_message_id_pk',
  'idx_agent_tool_calls_turn',
  'agent_inbox_conversation_id_id_pk',
  'idx_agent_inbox_conversation_seq',
  'idx_agent_inbox_client_message',
  'idx_agent_inbox_pending',
  'agent_jobs_pkey',
  'idx_agent_jobs_undelivered',
  'canvas_projects_pkey',
  'project_generation_outputs_pkey',
  'idx_project_generation_objects',
  'idx_canvas_projects_owner_id',
  'idx_canvas_projects_conversation',
  'daily_quota_device_id_date_pk',
  'idx_agent_conversations_device_time',
  'idx_agent_conversations_user_time',
  'idx_agent_messages_conversation_seq',
  'idx_agent_messages_turn',
  'idx_agent_turn_events_created',
  'idx_agent_turn_events_turn',
  'idx_operator_audits_created_at',
  'idx_operator_audits_target',
  'api_minutes_minute_instance_pk',
  'container_samples_sampled_at_container_id_pk',
  'host_samples_pkey',
  'idx_service_heartbeats_seen',
  'idx_tasks_admin_device_time',
  'idx_tasks_agent_turn',
  'idx_tasks_anonymous_client_request_id',
  'idx_tasks_next_retry_at',
  'idx_tasks_status',
  'idx_tasks_submitted_at',
  'idx_tasks_user_client_request_id',
  'idx_tasks_user_status_time',
  'idx_tasks_user_time',
  'idx_user_assets_user_version',
  'idx_user_identities_provider_subject',
  'idx_user_identities_user_id',
  'idx_user_sessions_expires_at',
  'idx_user_sessions_user_id',
  'idx_user_templates_user_version',
  'idx_users_username',
  'operator_audits_pkey',
  'service_heartbeats_service_instance_pk',
  'tasks_pkey',
  'user_asset_objects_user_id_image_id_pk',
  'user_assets_user_id_id_pk',
  'user_identities_pkey',
  'user_preferences_pkey',
  'user_sessions_pkey',
  'user_sync_state_pkey',
  'user_templates_user_id_id_pk',
  'users_pkey',
] as const

const EXPECTED_MIGRATION_COUNT = 33

export interface SchemaVerificationResult {
  tables: number
  indexes: number
  migrations: number
}

export async function verifySchema(databaseUrl: string): Promise<SchemaVerificationResult> {
  const client = new SQL(databaseUrl, { max: 1 })
  try {
    const [tableRows, indexRows, migrationTableRows] = await Promise.all([
      client<{ tablename: string }[]>`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
      `,
      client<{ indexname: string }[]>`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
      `,
      client<{ relation: string | null }[]>`
        SELECT to_regclass('drizzle.__drizzle_migrations')::text AS relation
      `,
    ])
    const migrationRows = migrationTableRows[0]?.relation
      ? await client<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM drizzle.__drizzle_migrations
        `
      : []
    const tables = new Set(tableRows.map((row) => row.tablename))
    const indexes = new Set(indexRows.map((row) => row.indexname))
    const missingTables = EXPECTED_TABLES.filter((name) => !tables.has(name))
    const missingIndexes = EXPECTED_INDEXES.filter((name) => !indexes.has(name))
    const migrationCount = Number(migrationRows[0]?.count ?? 0)
    const failures = [
      missingTables.length ? `missing tables: ${missingTables.join(', ')}` : '',
      missingIndexes.length ? `missing indexes: ${missingIndexes.join(', ')}` : '',
      migrationCount < EXPECTED_MIGRATION_COUNT
        ? `migration count ${migrationCount} is below ${EXPECTED_MIGRATION_COUNT}`
        : '',
    ].filter(Boolean)
    if (failures.length) throw new Error(`Schema verification failed: ${failures.join('; ')}`)
    return {
      tables: EXPECTED_TABLES.length,
      indexes: EXPECTED_INDEXES.length,
      migrations: migrationCount,
    }
  } finally {
    await client.close()
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const result = await verifySchema(databaseUrl)
  console.log(
    `Schema verified: ${result.tables} tables, ${result.indexes} indexes, ${result.migrations} migrations`,
  )
}
