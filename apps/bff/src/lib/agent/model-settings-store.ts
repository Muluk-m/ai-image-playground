import type { AgentModelSettingsView, AgentThinkingDepth } from '@image-playground/shared'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { isObject } from '../type-guards'
import {
  AgentSettingsError,
  agentProviderTemplates,
  configuredAgentRuntime,
  defaultAgentModelSettings,
  providerCredentialReady,
  validateAgentModelSettings,
} from './provider-settings'

export async function readAgentModelSettings() {
  const [row] = await db
    .select()
    .from(schema.agent_model_settings)
    .where(eq(schema.agent_model_settings.id, 'agent'))
  return row
    ? { revision: row.revision, settings: row.settings }
    : { revision: 0, settings: defaultAgentModelSettings() }
}

export async function agentModelSettingsView(): Promise<AgentModelSettingsView> {
  const current = await readAgentModelSettings()
  return {
    ...current,
    templates: agentProviderTemplates(),
    credentialReady: Object.fromEntries(
      current.settings.providers.map((provider) => [
        provider.id,
        providerCredentialReady(provider),
      ]),
    ),
  }
}

export async function saveAgentModelSettings(body: unknown, operator: string): Promise<void> {
  if (
    !isObject(body) ||
    Object.keys(body).some((key) => !['revision', 'settings'].includes(key)) ||
    !Number.isSafeInteger(body.revision) ||
    Number(body.revision) < 0
  )
    throw new AgentSettingsError('配置版本无效')
  const settings = validateAgentModelSettings(body.settings)
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agent-model-settings'))`)
    const [current] = await tx
      .select()
      .from(schema.agent_model_settings)
      .where(eq(schema.agent_model_settings.id, 'agent'))
    if ((current?.revision ?? 0) !== body.revision)
      throw new AgentSettingsError('配置已被其他操作更新，请刷新后重试', 409)
    const next = {
      id: 'agent',
      settings,
      revision: Number(body.revision) + 1,
      updated_at: Date.now(),
    }
    await tx
      .insert(schema.agent_model_settings)
      .values(next)
      .onConflictDoUpdate({ target: schema.agent_model_settings.id, set: next })
    await tx.insert(schema.operator_audits).values({
      id: crypto.randomUUID(),
      operator_id: operator,
      action: 'agent.models.configure',
      target_type: 'agent_model_settings',
      target_id: 'agent',
      created_at: next.updated_at,
      details: {
        revision: next.revision,
        providerIds: settings.providers.map((provider) => provider.id),
        profiles: settings.profiles,
      },
    })
  })
}

export async function resolveConfiguredAgentRuntime(depth?: AgentThinkingDepth) {
  const { settings } = await readAgentModelSettings()
  return configuredAgentRuntime(settings, depth)
}
