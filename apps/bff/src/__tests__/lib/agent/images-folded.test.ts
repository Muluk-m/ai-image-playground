import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { projectArtifactId } from '@image-playground/shared'
import sharp from 'sharp'
import { TEST_RESULT_PAYLOAD } from '../../helpers/agentStubs'

/**
 * 折进摘要的那段历史不再读回来（#708），可摘要的「产物」一节仍然点着那些图的 id，模型照样
 * 会去 `viewImage` / `editImage`。这一组钉的就是「窗口之外的产物仍然取得到，而且只取得到
 * 这个会话自己的」。
 */

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_images_folded')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { createAgentImageSource } = await import('../../../lib/agent/images')
const { createAgentConversation } = await import('../../../lib/agent/conversations')
const { close: closeDb, db, schema } = await import('../../../db/client')

const DEVICE = { kind: 'device', deviceId: 'device-abcdefgh' } as const

async function conversation(): Promise<string> {
  const created = await createAgentConversation(DEVICE, '第一句')
  return created.id
}

/** 一条已经出完图的任务，挂在指定会话名下。 */
async function completedTask(taskId: string, conversationId: string): Promise<void> {
  await db.insert(schema.tasks).values({
    id: taskId,
    provider: 'openai-compat',
    model: 'gpt-image-1',
    status: 'completed',
    submitted_at: Date.now(),
    agent_conversation_id: conversationId,
    request_payload: { device_id: DEVICE.deviceId, prompt: '橘猫' },
    result_payload: TEST_RESULT_PAYLOAD,
  })
}

/** 一张真位图，大到必然被预览规格缩掉；`aGk=` 那种假字节缩不动，证明不了任何事。 */
async function wideTask(taskId: string, conversationId: string): Promise<void> {
  const png = await sharp({
    create: { width: 2000, height: 1200, channels: 3, background: '#4488cc' },
  })
    .png()
    .toBuffer()
  await db.insert(schema.tasks).values({
    id: taskId,
    provider: 'openai-compat',
    model: 'gpt-image-1',
    status: 'completed',
    submitted_at: Date.now(),
    agent_conversation_id: conversationId,
    request_payload: { device_id: DEVICE.deviceId, prompt: '橘猫' },
    result_payload: { data: [{ b64_json: png.toString('base64'), mime: 'image/png' }] },
  })
}

function pixels(dataUrl: string) {
  return sharp(Buffer.from(dataUrl.split(',')[1]!, 'base64')).metadata()
}

/** 历史一条都不给：模拟产物早就折进摘要、原文不在这一份窗口里。 */
function sourceFor(conversationId: string) {
  return createAgentImageSource({
    references: [],
    history: [],
    conversationId,
    userId: null,
  })
}

beforeEach(async () => {
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
})

afterAll(async () => {
  await closeDb()
})

it('resolves an artifact whose result card was folded out of the window', async () => {
  const conversationId = await conversation()
  await completedTask('task-folded', conversationId)

  const resolved = await sourceFor(conversationId).resolve(projectArtifactId('task-folded', 0))

  expect(resolved?.dataUrl).toBe('data:image/png;base64,aGk=')
})

// 产物 id 来自模型输出，而模型输出受用户文本影响：能解析不等于能拿。
it('refuses an artifact that belongs to another conversation', async () => {
  const mine = await conversation()
  const theirs = await conversation()
  await completedTask('task-theirs', theirs)

  expect(await sourceFor(mine).resolve(projectArtifactId('task-theirs', 0))).toBeNull()
})

// 画布上被反复查看的恰恰是产物，而产物只存一份原件。这一路不降采样，省钱就省在了分母最小的
// 那一类上（#396）。
it('shrinks an artifact to preview size and keeps the original when asked', async () => {
  const conversationId = await conversation()
  await wideTask('task-wide', conversationId)
  const source = sourceFor(conversationId)
  const id = projectArtifactId('task-wide', 0)

  const preview = await pixels((await source.resolve(id, 'preview'))!.dataUrl)
  const original = await pixels((await source.resolve(id, 'original'))!.dataUrl)

  expect(preview.width).toBe(1024)
  expect(preview.height).toBe(614)
  expect(original.width).toBe(2000)
})
