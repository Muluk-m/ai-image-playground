import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { type AgentMessageView, DEVICE_ID_HEADER } from '@image-playground/shared'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  type ControlledCompletion,
  controlledCompletion,
  readFrames,
  recordingAgentFetch,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_skill_steer_a299')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.LOG_LEVEL = 'silent'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-skills-operator-config.json')

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { ensureAgentSkills, setAgentSkillsRootForTesting } = await import('../../lib/agent/skills')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { close: closeDb, db, schema } = await import('../../db/client')

await silenceChatUpstream()

type InternalChannel = import('../../lib/channels').InternalChannel

const VIDEO_CHANNEL: InternalChannel = {
  id: 'video-gateway',
  kind: 'openai-queue',
  label: 'Video',
  baseUrl: 'https://gateway.example/v1',
  auth: { type: 'bearer', secretRef: 'VIDEO_API_KEY', secret: 'k' },
  allowedPaths: ['videos/generations'],
  models: [
    {
      id: 'grok-imagine-video',
      label: 'grok-imagine-video',
      media: 'video',
      capabilities: ['generate'],
    },
  ],
  defaults: { asyncTasks: true },
}

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const BODY = '分镜表每行写：序号、时长、画面、引用。'

let root = ''
let upstream: ControlledCompletion
let calls: AgentCall[]
const opened: string[] = []

async function post(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function startConversation(): Promise<string> {
  const response = await post('/api/agent/conversations', { deviceId: DEVICE })
  const json = (await response.json()) as { conversation: { id: string } }
  opened.push(json.conversation.id)
  return json.conversation.id
}

async function readMessages(conversationId: string): Promise<AgentMessageView[]> {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/messages`, {
      headers: { [DEVICE_ID_HEADER]: DEVICE },
    }),
  )
  return ((await response.json()) as { messages: AgentMessageView[] }).messages
}

function lastUserText(call: AgentCall): string {
  const user = [...call.messages].reverse().find((message) => message.role === 'user')
  const content = user?.content
  if (typeof content === 'string') return content
  return ((content ?? []) as { type: string; text?: string }[])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('')
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aip-skill-steer-'))
  const dir = join(root, 'video', 'storyboard-short')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: storyboard-short\ndescription: 何时用：一句话要一条多镜短片。\n---\n\n# 分镜短片\n\n${BODY}\n`,
    'utf8',
  )
  _setChannelsForTesting([VIDEO_CHANNEL])
  setAgentSkillsRootForTesting(root)
  await ensureAgentSkills()
})

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
  calls = []
  upstream = controlledCompletion()
  setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => upstream.responseFor(signal)))
})

/** 轮不再绑在消费者身上，用例留下的进行中的轮必须显式收掉，否则它会写向已关闭的库。 */
afterEach(async () => {
  for (const conversationId of opened.splice(0)) {
    const response = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${conversationId}/messages`, {
        headers: { [DEVICE_ID_HEADER]: DEVICE },
      }),
    )
    const { activeTurn } = (await response.json()) as { activeTurn: { turnId: string } | null }
    if (!activeTurn) continue
    await post(`/api/agent/conversations/${conversationId}/turns/${activeTurn.turnId}/abort`, {
      deviceId: DEVICE,
    })
  }
})

afterAll(async () => {
  _setChannelsForTesting([])
  setAgentSkillsRootForTesting(null)
  setAgentFetchForTesting()
  if (root) await rm(root, { recursive: true, force: true })
  await closeDb()
})

describe('naming a skill while the turn is still running', () => {
  it('expands it for the model and keeps the typed text in the record', async () => {
    const conversationId = await startConversation()
    const live = await post(`/api/agent/conversations/${conversationId}/turns`, {
      deviceId: DEVICE,
      text: '先聊聊',
      mode: 'video',
    })
    upstream.push('好的')
    const seen = await readFrames(live, 3)
    const start = seen[0]!.event
    const turnId = start.type === 'turnStart' ? start.turnId : ''

    const second = controlledCompletion()
    const interjected = await post(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/interject`,
      { deviceId: DEVICE, text: '/storyboard-short 加一镜结尾' },
    )
    expect(interjected.status).toBe(200)
    setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => second.responseFor(signal)))
    upstream.finish()
    await waitFor(() => calls.length === 2)

    // 插话走的是同一条 `/skill-name` 规则：模型拿到全文，对话记录留原话。
    expect(lastUserText(calls[1]!)).toContain(BODY)
    expect(lastUserText(calls[1]!)).toContain('加一镜结尾')

    second.push('好')
    second.finish()
    await waitFor(async () => {
      const messages = await readMessages(conversationId)
      return messages.filter((message) => message.role === 'user').length === 2
    })
    const messages = await readMessages(conversationId)
    const typed = messages.filter((message) => message.role === 'user')
    expect(typed.at(-1)?.content).toEqual([{ type: 'text', text: '/storyboard-short 加一镜结尾' }])
  })
})
