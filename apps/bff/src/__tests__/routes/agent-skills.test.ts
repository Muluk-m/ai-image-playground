import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { type AgentMessageView, DEVICE_ID_HEADER } from '@image-playground/shared'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  parseFrames,
  scriptedAgentFetch,
} from '../helpers/agentStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_skills_a297')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.LOG_LEVEL = 'silent'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { ensureAgentSkills, setAgentSkillsRootForTesting } = await import('../../lib/agent/skills')
const { close: closeDb } = await import('../../db/client')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const BODY = '分镜表每行写：序号、时长、画面、引用。'

let root = ''
const calls: AgentCall[] = []

async function post(path: string, body: unknown) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, json: await response.json() }
}

async function startConversation(): Promise<string> {
  const { status, json } = await post('/api/agent/conversations', { deviceId: DEVICE })
  expect(status).toBe(200)
  return (json as { conversation: { id: string } }).conversation.id
}

async function runTurn(conversationId: string, text: string, mode?: string) {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE, text, ...(mode ? { mode } : {}) }),
    }),
  )
  return parseFrames(await response.text())
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
  return (content as { type: string; text?: string }[])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('')
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aip-skill-routes-'))
  const dir = join(root, 'video', 'storyboard-short')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: storyboard-short\ndescription: 何时用：一句话要一条多镜短片。不处理：单张图。\n---\n\n${BODY}\n`,
    'utf8',
  )
  setAgentSkillsRootForTesting(root)
  await ensureAgentSkills()
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('好的')]))
})

afterAll(async () => {
  setAgentSkillsRootForTesting(null)
  setAgentFetchForTesting()
  if (root) await rm(root, { recursive: true, force: true })
  await closeDb()
})

describe('GET /api/agent/skills', () => {
  it('lists the skills of the asked mode', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/agent/skills?mode=video', {
        headers: { [DEVICE_ID_HEADER]: DEVICE },
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      skills: [
        { name: 'storyboard-short', description: '何时用：一句话要一条多镜短片。不处理：单张图。' },
      ],
    })
  })

  it('answers an image turn with nothing, and treats a missing mode as image', async () => {
    for (const path of ['/api/agent/skills?mode=image', '/api/agent/skills']) {
      const response = await app.handle(
        new Request(`http://localhost${path}`, { headers: { [DEVICE_ID_HEADER]: DEVICE } }),
      )
      expect(await response.json()).toEqual({ skills: [] })
    }
  })
})

describe('a turn that names a skill with a slash', () => {
  it('sends the model the full skill but stores what the user typed', async () => {
    calls.length = 0
    const conversationId = await startConversation()
    const frames = await runTurn(conversationId, '/storyboard-short 做个 15 秒的开箱片', 'video')
    expect(frames.some((frame) => frame.event.type === 'turnEnd')).toBe(true)

    expect(lastUserText(calls[0]!)).toContain(BODY)
    expect(lastUserText(calls[0]!)).toContain('做个 15 秒的开箱片')
    expect(lastUserText(calls[0]!)).not.toContain(root)

    const messages = await readMessages(conversationId)
    const user = messages.find((message) => message.role === 'user')
    expect(user?.content).toEqual([{ type: 'text', text: '/storyboard-short 做个 15 秒的开箱片' }])
  })

  it('leaves an unknown skill name as ordinary text', async () => {
    calls.length = 0
    const conversationId = await startConversation()
    await runTurn(conversationId, '/nope 做个片子', 'video')
    expect(lastUserText(calls[0]!)).toContain('/nope 做个片子')
    expect(lastUserText(calls[0]!)).not.toContain(BODY)
  })
})

describe('the tool list the model receives', () => {
  it('carries loadSkill in a mode that has skills', async () => {
    calls.length = 0
    const conversationId = await startConversation()
    await runTurn(conversationId, '做个片子', 'video')
    expect(calls[0]!.tools?.map((tool) => tool.function.name)).toContain('loadSkill')
  })

  it('leaves loadSkill out of a mode with no skills at all', async () => {
    calls.length = 0
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一只猫')
    const names = calls[0]!.tools?.map((tool) => tool.function.name) ?? []
    expect(names).not.toContain('loadSkill')
    expect(names).not.toContain('generateVideo')
    expect(names).toContain('generateImage')
  })
})
