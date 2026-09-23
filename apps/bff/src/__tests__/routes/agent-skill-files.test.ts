import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import { Elysia } from 'elysia'

process.env.DATABASE_URL = await resetTestDatabase('agent_skill_files_c41d')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.LOG_LEVEL = 'silent'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-skills-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { ensureAgentSkills, setAgentSkillsRootForTesting } = await import('../../lib/agent/skills')
const { close: closeDb } = await import('../../db/client')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
/** 封面的字节；路由只管原样发出去，所以内容是什么无所谓，长度与首字节要对得上。 */
const COVER = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01])

let root = ''

async function get(path: string) {
  return app.handle(
    new Request(`http://localhost${path}`, { headers: { [DEVICE_ID_HEADER]: DEVICE } }),
  )
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aip-skill-files-'))
  const dir = join(root, 'image', 'scene-look')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    '---\nname: scene-look\ndescription: 何时用：场景图。不处理：白底图。\n---\n\n# 岩壁场景\n\n## 1. 一句话目标\n把素材放进岩壁场景。\n',
    'utf8',
  )
  await writeFile(join(dir, 'cover.webp'), COVER)
  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify({
      icon: 'mountain',
      summary: '岩壁场景',
      template: {
        purpose: 'scene',
        model: 'gpt-image-2.5-sunburst',
        size: '3:4',
        slotCount: 1,
        cover: 'cover.webp',
        references: ['cover.webp'],
      },
    }),
    'utf8',
  )
  await writeFile(join(root, 'outside.webp'), COVER)
  setAgentSkillsRootForTesting(root)
  await ensureAgentSkills()
})

afterAll(async () => {
  setAgentSkillsRootForTesting(null)
  if (root) await rm(root, { recursive: true, force: true })
  await closeDb()
})

describe('预置模板随技能清单发出去', () => {
  it('图片给的是地址，正文跟着发', async () => {
    const response = await get('/api/agent/skills?mode=image')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      skills: [
        {
          name: 'scene-look',
          title: '岩壁场景',
          description: '何时用：场景图。不处理：白底图。',
          icon: 'mountain',
          summary: '岩壁场景',
          template: {
            purpose: 'scene',
            model: 'gpt-image-2.5-sunburst',
            size: '3:4',
            slotCount: 1,
            body: '# 岩壁场景\n\n## 1. 一句话目标\n把素材放进岩壁场景。',
            coverUrl: '/api/agent/skills/scene-look/files/cover.webp',
            referenceUrls: ['/api/agent/skills/scene-look/files/cover.webp'],
          },
        },
      ],
    })
  })
})

describe('GET /api/agent/skills/:name/files/:file', () => {
  it('发的是图片本身，清单上那条地址直接取得到', async () => {
    const response = await get('/api/agent/skills/scene-look/files/cover.webp')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(COVER)
  })

  it('给模型读的正文不从这条路发', async () => {
    expect((await get('/api/agent/skills/scene-look/files/SKILL.md')).status).toBe(404)
  })

  it('穿不出这个技能自己的目录', async () => {
    // `%2F` 会被解码成路径分隔符：路径守卫要在解码之后仍然成立。
    expect((await get('/api/agent/skills/scene-look/files/..%2F..%2Foutside.webp')).status).toBe(
      404,
    )
  })

  it('认不出的技能是 404，不是一份空图片', async () => {
    expect((await get('/api/agent/skills/nope/files/cover.webp')).status).toBe(404)
  })
})
