import { afterAll, expect, it } from 'bun:test'
import { createDb } from '../client'
import { resetTestDatabase } from '../testing'

const connection = createDb(await resetTestDatabase('batch_rollback_guard'))
afterAll(() => connection.close())
const rollback = await Bun.file(
  new URL('../../drizzle/rollback/0052_agent_batch_execution.down.sql', import.meta.url),
).text()

for (const state of ['queued', 'completed', 'unknown', 'missing-status', 'null-status'] as const) {
  it(`refuses execution rollback with ${state} attempts lacking known durable settlement`, async () => {
    const now = new Date()
    await expect(
      connection.client.begin(async (tx) => {
        await tx`INSERT INTO users (id, username, password_hash, status, created_at, updated_at) VALUES (${state}, ${state}, 'fixture', 'active', ${now}, ${now})`
        await tx`INSERT INTO agent_batches (id, user_id, origin_turn_id, tool_call_id, experience, created_at, updated_at) VALUES (${state}, ${state}, 'turn', 'call', 'chat', ${now}, ${now})`
        await tx`INSERT INTO agent_batch_plans (batch_id, version, title, rule, digest, item_count, estimate_snapshot, created_at) VALUES (${state}, 1, 'plan', 'rule', 'digest', 1, '{}'::jsonb, ${now})`
        await tx`INSERT INTO agent_batch_items (batch_id, version, key, ordinal, kind, inputs, prompt, params, dependencies) VALUES (${state}, 1, 'one', 0, 'generation', '[]'::jsonb, 'prompt', '{}'::jsonb, '[]'::jsonb)`
        const status = state === 'queued' ? 'queued' : 'completed'
        await tx`INSERT INTO tasks (id, user_id, provider, model, status, request_payload, submitted_at) VALUES (${state}, ${state}, 'openai-compat', 'fixture', ${status}, '{"device_id":"fixture","prompt":"one","n":1}'::jsonb, ${now})`
        await tx`INSERT INTO agent_batch_attempts (batch_id, version, item_key, attempt, task_id, reserved_credits, submitted_at) VALUES (${state}, 1, 'one', 1, ${state}, 7, ${now})`
        if (state === 'unknown')
          await tx`UPDATE agent_batch_attempts SET terminal_snapshot = '{"status":"failed","errorCode":"result_unknown","actualCredits":null}'::jsonb WHERE batch_id = ${state}`
        if (state === 'missing-status')
          await tx`UPDATE agent_batch_attempts SET terminal_snapshot = '{"actualCredits":0}'::jsonb WHERE batch_id = ${state}`
        if (state === 'null-status')
          await tx`UPDATE agent_batch_attempts SET terminal_snapshot = '{"status":null,"actualCredits":0}'::jsonb WHERE batch_id = ${state}`
        await tx.unsafe(rollback)
        // Roll the test transaction back even when the unsafe rollback unexpectedly succeeds.
        throw new Error('rollback discarded unsettled attempts')
      }),
    ).rejects.toThrow('unsettled batch attempts')
    const [table] = await connection.client`SELECT to_regclass('agent_batch_attempts') AS name`
    expect(table.name).toBe('agent_batch_attempts')
  })
}
