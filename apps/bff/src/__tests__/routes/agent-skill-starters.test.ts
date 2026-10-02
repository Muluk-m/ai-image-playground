import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { type AgentSkillSummary, DEVICE_ID_HEADER } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { silenceChatUpstream } from '../helpers/chatStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_skill_starters_a997')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.AGENT_IMAGE_MODEL = ''
process.env.LOG_LEVEL = 'silent'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { ensureAgentSkills, setAgentSkillsRootForTesting, agentSkillInvocation, findAgentSkill } =
  await import('../../lib/agent/skills')
const { turnInitialState } = await import('../../lib/agent/turn-input')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { close: closeDb } = await import('../../db/client')
const { log } = await import('../../lib/logger')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)

await silenceChatUpstream()
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const VERIFIED_MODEL = 'gpt-image-2.5-sunburst'

type InternalChannel = import('../../lib/channels').InternalChannel

/** 部署的出图模型：非模板技能的「已验证」跟它比。 */
function imageChannel(model: string): InternalChannel {
  return {
    id: 'image-gateway',
    kind: 'openai-queue',
    label: 'Image',
    baseUrl: 'https://gateway.example/v1',
    auth: { type: 'bearer', secretRef: 'IMAGE_API_KEY', secret: 'k' },
    allowedPaths: ['images/generations'],
    models: [{ id: model, label: model, media: 'image', capabilities: ['generate'] }],
    defaults: {},
  }
}

let root = ''
const warnings: string[] = []
const warn = log.warn.bind(log)

async function skill(name: string, meta: unknown, extraFiles: readonly string[] = []) {
  const dir = join(root, 'image', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 何时用：${name}。不处理：别的。\n---\n\n# ${name} 标题\n\n${name} 正文`,
    'utf8',
  )
  await writeFile(
    join(dir, 'meta.json'),
    typeof meta === 'string' ? meta : JSON.stringify(meta),
    'utf8',
  )
  for (const file of extraFiles) await writeFile(join(dir, file), 'webp', 'utf8')
}

const PRODUCT_INPUT = {
  key: 'product',
  label: { 'zh-CN': '商品素材', en: 'Product' },
  required: true,
  multiple: true,
}

function template(model: string, slotCount: number) {
  return {
    purpose: 'hero',
    model,
    size: '3:4',
    slotCount,
    cover: 'cover.webp',
    references: ['cover.webp'],
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aip-skill-starters-'))
  await skill('main-image', {
    icon: 'shopping-bag',
    summary: '商品主图',
    inputs: [PRODUCT_INPUT, { key: 'Bad Key', label: { 'zh-CN': '坏位' } }],
    scene: 'ecommerce',
    starters: [
      {
        text: {
          'zh-CN': '为 {product} 出一张白底主图',
          en: 'Make a white main image for {product}',
        },
        highlight: { 'zh-CN': '白底', en: 'white' },
      },
      // 引用了没声明的位：这一条丢掉，技能与别的起手句留下。
      { text: { 'zh-CN': '把 {ghost} 放进 {product} 的图' } },
      // 英文没写：界面回退中文，服务端不替它补。
      { text: { 'zh-CN': '给 {product} 换个角度' } },
      // 示例词不在句子里：只丢示例词，句子留下。
      { text: { 'zh-CN': '为 {product} 出图' }, highlight: { 'zh-CN': '海报' } },
    ],
    verified: { date: '2026-10-02', model: VERIFIED_MODEL, score: 2.7 },
  })
  await skill(
    'pinned-look',
    {
      icon: 'camera',
      summary: '柔光影棚',
      template: template('pinned-model', 2),
      scene: 'look',
      starters: [{ text: { 'zh-CN': '把 {asset1} 和 {asset2} 放进影棚' } }],
      // 模板跟钉死的模型比，与部署默认的出图模型无关。
      verified: { date: '2026-10-02', model: 'pinned-model', score: 2.6 },
    },
    ['cover.webp'],
  )
  await skill(
    'stale-look',
    {
      icon: 'flame',
      summary: '钉死的模型改过',
      template: template('new-pinned-model', 1),
      scene: 'look',
      starters: [{ text: { 'zh-CN': '给 {asset1} 出图' } }],
      verified: { date: '2026-10-02', model: 'old-pinned-model', score: 2.9 },
    },
    ['cover.webp'],
  )
  await skill('broken-meta', '{ 这不是 JSON')
  await skill('odd-fields', {
    icon: 'shapes',
    summary: '字段写坏',
    scene: 'video',
    starters: 'not-an-array',
    verified: { model: VERIFIED_MODEL },
  })
  _setChannelsForTesting([imageChannel(VERIFIED_MODEL)])
  log.warn = ((first: unknown, ...rest: unknown[]) => {
    warnings.push(JSON.stringify(first))
    return warn(first as never, ...(rest as never[]))
  }) as typeof log.warn
  setAgentSkillsRootForTesting(root)
  await ensureAgentSkills()
  log.warn = warn
})

afterAll(async () => {
  _setChannelsForTesting([])
  setAgentSkillsRootForTesting(null)
  if (root) await rm(root, { recursive: true, force: true })
  await closeDb()
})

async function catalog(): Promise<Record<string, AgentSkillSummary>> {
  const response = await app.handle(
    new Request('http://localhost/api/agent/skills?mode=image', {
      headers: { [DEVICE_ID_HEADER]: DEVICE },
    }),
  )
  expect(response.status).toBe(200)
  const { skills } = (await response.json()) as { skills: AgentSkillSummary[] }
  return Object.fromEntries(skills.map((one) => [one.name, one]))
}

describe('GET /api/agent/skills 的素材位与起手句', () => {
  it('返回声明的素材位、场景与合法的起手句', async () => {
    const skills = await catalog()
    expect(skills['main-image']).toMatchObject({
      inputs: [PRODUCT_INPUT],
      scene: 'ecommerce',
      starters: [
        {
          text: {
            'zh-CN': '为 {product} 出一张白底主图',
            en: 'Make a white main image for {product}',
          },
          highlight: { 'zh-CN': '白底', en: 'white' },
        },
        { text: { 'zh-CN': '给 {product} 换个角度' } },
        { text: { 'zh-CN': '为 {product} 出图' } },
      ],
    })
  })

  it('丢掉引用未声明素材位的起手句时打日志', () => {
    expect(warnings.some((line) => line.includes('agent.skill_starter_dropped'))).toBe(true)
    expect(warnings.some((line) => line.includes('ghost'))).toBe(true)
  })

  it('预置模板没写素材位时由 slotCount 派生', async () => {
    const skills = await catalog()
    expect(skills['pinned-look']?.inputs).toEqual([
      { key: 'asset1', label: { 'zh-CN': '素材', en: 'Asset' }, required: true, multiple: true },
      { key: 'asset2', label: { 'zh-CN': '素材', en: 'Asset' }, required: true, multiple: true },
    ])
    expect(skills['pinned-look']?.starters).toHaveLength(1)
  })

  it('meta.json 写坏的技能照常在，只是没有素材位与起手句', async () => {
    const skills = await catalog()
    expect(skills['broken-meta']).toMatchObject({ inputs: [], starters: [], verified: false })
    expect(skills['broken-meta']?.scene).toBeUndefined()
    expect(skills['odd-fields']).toMatchObject({ inputs: [], starters: [], verified: false })
    expect(skills['odd-fields']?.scene).toBeUndefined()
  })
})

describe('GET /api/agent/skills 的已验证', () => {
  it('记录的模型就是这条技能会用的模型时为 true', async () => {
    const skills = await catalog()
    expect(skills['main-image']?.verified).toBe(true)
    expect(skills['pinned-look']?.verified).toBe(true)
  })

  it('模板钉死的模型与记录不一致即为 false', async () => {
    expect((await catalog())['stale-look']?.verified).toBe(false)
  })

  it('部署的出图模型一换，非模板技能翻成 false，模板不受影响', async () => {
    _setChannelsForTesting([imageChannel('another-image-model')])
    try {
      const skills = await catalog()
      expect(skills['main-image']?.verified).toBe(false)
      expect(skills['pinned-look']?.verified).toBe(true)
    } finally {
      _setChannelsForTesting([imageChannel(VERIFIED_MODEL)])
    }
  })

  it('不把验证记录本身发给界面', async () => {
    const body = JSON.stringify(await catalog())
    expect(body).not.toContain('2026-10-02')
    expect(body).not.toContain('2.7')
  })
})

describe('新字段不进给模型的文本', () => {
  it('系统提示词与技能全文里都没有素材位、起手句与场景', () => {
    const { systemPrompt } = turnInitialState([], 'image')
    const invocation = agentSkillInvocation(findAgentSkill('image', 'main-image')!, '')
    for (const text of [systemPrompt, invocation]) {
      expect(text).not.toContain('白底主图')
      expect(text).not.toContain('商品素材')
      expect(text).not.toContain('ecommerce')
      expect(text).not.toContain(VERIFIED_MODEL)
    }
  })
})
