import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  parseFrames,
  scriptedAgentFetch,
} from '../helpers/agentStubs'

// 这个部署做不了视频：没开 generation:video，也没有视频 channel。
process.env.DATABASE_URL = await resetTestDatabase('agent_skills_novideo_a298')
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
const BODY = '# 分镜短片\n\n分镜表每行写：序号、时长、画面、引用。'

let root = ''
const calls: AgentCall[] = []

async function startConversation(): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/api/agent/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE }),
    }),
  )
  return ((await response.json()) as { conversation: { id: string } }).conversation.id
}

async function runVideoTurn(conversationId: string, text: string) {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE, text, mode: 'video' }),
    }),
  )
  return parseFrames(await response.text())
}

function systemPromptOf(call: AgentCall): string {
  const first = call.messages[0]
  const content = first?.content
  if (typeof content === 'string') return content
  return ((content ?? []) as { type: string; text?: string }[])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('')
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aip-skill-novideo-'))
  const dir = join(root, 'video', 'storyboard-short')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: storyboard-short\ndescription: 何时用：一句话要一条多镜短片。\n---\n\n${BODY}\n`,
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

describe('a deployment that cannot make video', () => {
  it('answers a video skill listing with nothing', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/agent/skills?mode=video', {
        headers: { [DEVICE_ID_HEADER]: DEVICE },
      }),
    )
    // 列出来用户就会点，点了却只拿得到生图工具——所以这里先关掉。
    expect(await response.json()).toEqual({ skills: [] })
  })

  it('assembles a video turn as an image turn instead of half a video turn', async () => {
    calls.length = 0
    const conversationId = await startConversation()
    await runVideoTurn(conversationId, '做个 15 秒的开箱片')

    const names = calls[0]!.tools?.map((tool) => tool.function.name).sort() ?? []
    expect(names).toEqual([
      'askClarification',
      'editImage',
      'generateImage',
      'readLibrary',
      'viewImage',
    ])
    const prompt = systemPromptOf(calls[0]!)
    expect(prompt).not.toContain('<available_skills>')
    expect(prompt).not.toContain('storyboard-short')
    expect(prompt).toContain('这一轮用户要的是图片。')
  })

  it('leaves an explicit /skill in a video turn as ordinary text', async () => {
    calls.length = 0
    const conversationId = await startConversation()
    await runVideoTurn(conversationId, '/storyboard-short 做个片子')

    const user = [...calls[0]!.messages].reverse().find((message) => message.role === 'user')
    const text =
      typeof user?.content === 'string'
        ? user.content
        : ((user?.content ?? []) as { type: string; text?: string }[])
            .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
            .join('')
    expect(text).toContain('/storyboard-short 做个片子')
    expect(text).not.toContain('分镜表每行写')
  })
})
