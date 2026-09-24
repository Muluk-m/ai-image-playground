import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_AGENT_SKILL_ICON } from '@image-playground/shared'

// 只读磁盘上的技能目录，一句 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-skills'
process.env.LOG_LEVEL = 'silent'

const {
  AGENT_SKILL_FILE_MAX_BYTES,
  agentSkillInvocation,
  agentSkillLocation,
  agentSkillSummaries,
  agentSkillTitle,
  agentSkills,
  ensureAgentSkills,
  findAgentSkill,
  lookSkillContent,
  readAgentSkillFile,
  readAgentSkillFileBytes,
  resolveAgentSkill,
  setAgentSkillsRootForTesting,
  titleSourceText,
} = await import('../../../lib/agent/skills')
const { log } = await import('../../../lib/logger')

let root = ''

async function skill(mode: string, name: string, frontmatter: string, body: string) {
  const dir = join(root, mode, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
  return dir
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aip-skills-'))
  await skill(
    'image',
    'main-image',
    'name: main-image\ndescription: 何时用：电商主图。',
    '# 电商主图\n\n主图正文',
  )
  await skill(
    'video',
    'storyboard',
    'name: storyboard\ndescription: 何时用：多镜短片。',
    '# 分镜短片\n\n分镜正文',
  )
  await skill('shared', 'palette', 'name: palette\ndescription: 何时用：配色。', '配色正文')
  // 名字与父目录不一致 + 缺 description：两种 diagnostic 各来一条。
  await skill('image', 'mismatch', 'name: other-name\ndescription: 何时用：随便。', '正文')
  await skill('image', 'no-description', 'name: no-description', '正文')

  // 预置模板：带模板标记的技能目录，图片随目录走。
  await skill(
    'image',
    'scene-look',
    'name: scene-look\ndescription: 何时用：场景图。不处理：白底图。',
    '# 岩壁场景\n\n## 1. 一句话目标\n把素材放进岩壁场景。',
  )
  await writeFile(join(root, 'image', 'scene-look', 'cover.webp'), 'webp-bytes', 'utf8')
  // 图片不给模型读，所以不受那份给模型读的散文上限约束。
  await writeFile(
    join(root, 'image', 'scene-look', 'big.webp'),
    'x'.repeat(AGENT_SKILL_FILE_MAX_BYTES + 1),
    'utf8',
  )
  // 标记写坏的那条：封面文件压根不在。标记该被丢掉，技能本身留下。
  await skill(
    'image',
    'broken-look',
    'name: broken-look\ndescription: 何时用：坏模板。',
    '# 坏模板\n\n正文',
  )

  // 界面元数据走旁路文件：写对的一条、写坏的一条、压根没写的一条，三种都要有。
  await writeFile(
    join(root, 'video', 'storyboard', 'meta.json'),
    JSON.stringify({ icon: 'clapperboard', summary: '一句话生成多镜头短片' }),
    'utf8',
  )
  await writeFile(join(root, 'image', 'main-image', 'meta.json'), '{ 这不是 JSON', 'utf8')
  await writeFile(
    join(root, 'shared', 'palette', 'meta.json'),
    JSON.stringify({ icon: 'Palette', summary: '   ' }),
    'utf8',
  )
  await writeFile(
    join(root, 'image', 'scene-look', 'meta.json'),
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
  await writeFile(
    join(root, 'image', 'broken-look', 'meta.json'),
    JSON.stringify({
      icon: 'flame',
      summary: '坏模板',
      template: {
        purpose: 'scene',
        model: 'gpt-image-2.5-sunburst',
        size: '3:4',
        slotCount: 1,
        cover: 'missing.webp',
        references: [],
      },
    }),
    'utf8',
  )

  const withFiles = join(root, 'video', 'storyboard', 'references')
  await mkdir(withFiles, { recursive: true })
  await writeFile(join(withFiles, 'shot-list.md'), '# 镜头清单\n每镜一行。', 'utf8')
  await writeFile(join(withFiles, 'huge.md'), 'x'.repeat(AGENT_SKILL_FILE_MAX_BYTES + 1), 'utf8')
  await writeFile(join(root, 'outside.md'), '不该被读到', 'utf8')
  await symlink(join(root, 'outside.md'), join(withFiles, 'escape.md'))

  setAgentSkillsRootForTesting(root)
  await ensureAgentSkills()
})

afterAll(async () => {
  setAgentSkillsRootForTesting(null)
  if (root) await rm(root, { recursive: true, force: true })
})

describe('agent skills loading', () => {
  it('shows a mode its own skills plus the shared ones', () => {
    // `other-name` 那条 frontmatter 与目录名不符，只记 diagnostic 不丢弃，所以它也在。
    expect(
      agentSkills('image')
        .map((one) => one.name)
        .sort(),
    ).toEqual(['broken-look', 'main-image', 'other-name', 'palette', 'scene-look'])
    expect(
      agentSkills('video')
        .map((one) => one.name)
        .sort(),
    ).toEqual(['palette', 'storyboard'])
  })

  it('drops skills whose frontmatter cannot be trusted instead of failing the load', () => {
    // `mismatch` 的 name 与父目录不符（只是 diagnostic，仍加载），`no-description` 缺 description（丢弃）。
    expect(findAgentSkill('image', 'no-description')).toBeUndefined()
    expect(findAgentSkill('image', 'other-name')?.content).toBe('正文')
  })

  it('summarises a mode without leaking the body', () => {
    expect(agentSkillSummaries('video')).toContainEqual({
      name: 'storyboard',
      title: '分镜短片',
      description: '何时用：多镜短片。',
      icon: 'clapperboard',
      summary: '一句话生成多镜头短片',
    })
    expect(JSON.stringify(agentSkillSummaries('video'))).not.toContain('分镜正文')
  })

  it('takes icon and summary from meta.json', () => {
    expect(findAgentSkill('video', 'storyboard')?.icon).toBe('clapperboard')
    expect(findAgentSkill('video', 'storyboard')?.summary).toBe('一句话生成多镜头短片')
  })

  it('keeps a skill whose meta.json is missing or broken, just with the fallbacks', () => {
    // `main-image` 的 meta.json 不是 JSON，`mismatch` 压根没有；两条都不该因此消失。
    expect(findAgentSkill('image', 'main-image')?.icon).toBe(DEFAULT_AGENT_SKILL_ICON)
    expect(findAgentSkill('image', 'main-image')?.summary).toBe('')
    expect(findAgentSkill('image', 'other-name')?.icon).toBe(DEFAULT_AGENT_SKILL_ICON)
    expect(findAgentSkill('image', 'other-name')?.summary).toBe('')
  })

  it('rejects an icon that is not kebab-case and a blank summary', () => {
    // `Palette` 是 lucide 的组件名，不是前端白名单里的 key；写成它等于查不到。
    expect(findAgentSkill('image', 'palette')?.icon).toBe(DEFAULT_AGENT_SKILL_ICON)
    expect(findAgentSkill('image', 'palette')?.summary).toBe('')
  })

  it('never lets the interface metadata reach the model', () => {
    const skill = findAgentSkill('video', 'storyboard')!
    const injected = agentSkillInvocation(skill, '横屏')
    expect(injected).not.toContain('clapperboard')
    expect(injected).not.toContain('一句话生成多镜头短片')
  })

  it('takes the human title from the first h1 and falls back to the name', () => {
    expect(findAgentSkill('video', 'storyboard')?.title).toBe('分镜短片')
    // `palette` 的正文没有一级标题，标题就是它的 kebab-case 标识。
    expect(findAgentSkill('image', 'palette')?.title).toBe('palette')
    expect(agentSkillTitle('前言\n\n#  留白的标题  \n\n正文', 'fallback')).toBe('留白的标题')
    expect(agentSkillTitle('## 只有二级标题', 'fallback')).toBe('fallback')
    expect(agentSkillTitle('', 'fallback')).toBe('fallback')
  })

  it('addresses skills by a virtual path, never by a server path', () => {
    const skill = findAgentSkill('video', 'storyboard')!
    expect(agentSkillLocation(skill)).toBe('skill://storyboard/SKILL.md')
    expect(agentSkillInvocation(skill, '横屏')).toContain('分镜正文')
    expect(agentSkillInvocation(skill, '横屏')).toContain('横屏')
    expect(agentSkillInvocation(skill)).not.toContain(root)
  })
})

describe('reading a skill attachment', () => {
  it('reads a file inside the skill directory', async () => {
    const result = await readAgentSkillFile('video', 'storyboard', 'references/shot-list.md')
    expect(result).toEqual({ kind: 'ok', text: '# 镜头清单\n每镜一行。' })
  })

  it('refuses a skill the current mode cannot see', async () => {
    expect(await readAgentSkillFile('image', 'storyboard', 'references/shot-list.md')).toEqual({
      kind: 'unknown-skill',
    })
  })

  it.each([
    ['../../outside.md'],
    ['references/../../../outside.md'],
    ['/etc/passwd'],
    ['references/escape.md'],
  ])('refuses %s', async (file) => {
    expect(await readAgentSkillFile('video', 'storyboard', file)).toEqual({ kind: 'escapes-skill' })
  })

  it('refuses a file over the size cap', async () => {
    expect(await readAgentSkillFile('video', 'storyboard', 'references/huge.md')).toEqual({
      kind: 'too-large',
    })
  })

  it('reports a missing file instead of throwing', async () => {
    expect(await readAgentSkillFile('video', 'storyboard', 'references/nope.md')).toEqual({
      kind: 'unreadable',
    })
  })
})

describe('预置模板标记', () => {
  it('把 meta.json 里的模板标记读成技能的一部分', () => {
    expect(findAgentSkill('image', 'scene-look')?.template).toEqual({
      purpose: 'scene',
      model: 'gpt-image-2.5-sunburst',
      size: '3:4',
      slotCount: 1,
      cover: 'cover.webp',
      references: ['cover.webp'],
    })
  })

  it('发给界面的那一份把图片换成地址，并带上正文', () => {
    const summary = agentSkillSummaries('image').find((one) => one.name === 'scene-look')
    expect(summary?.template?.coverUrl).toBe('/api/agent/skills/scene-look/files/cover.webp')
    expect(summary?.template?.referenceUrls).toEqual([
      '/api/agent/skills/scene-look/files/cover.webp',
    ])
    // 出图模式在本机按正文装配请求，所以预置模板的正文要跟着清单发。
    expect(summary?.template?.body).toContain('## 1. 一句话目标')
  })

  it('标记写坏时只丢标记，技能照常在', () => {
    // 封面文件不在：这条模板出现在模板页上就是一张取不到的图。
    expect(findAgentSkill('image', 'broken-look')?.template).toBeUndefined()
    expect(findAgentSkill('image', 'broken-look')?.title).toBe('坏模板')
  })

  it('没写标记的技能不是模板', () => {
    expect(findAgentSkill('image', 'main-image')?.template).toBeUndefined()
    expect(agentSkillSummaries('image').find((one) => one.name === 'main-image')?.template).toBe(
      undefined,
    )
  })
})

describe('reading a skill image', () => {
  it('serves the bytes with a content type', async () => {
    const result = await readAgentSkillFileBytes('image', 'scene-look', 'cover.webp')
    expect(result.kind === 'ok' && new TextDecoder().decode(result.bytes)).toBe('webp-bytes')
    expect(result.kind === 'ok' && result.contentType).toBe('image/webp')
  })

  it('does not apply the prose size cap to images', async () => {
    // 那 64 KB 是「给模型读的散文」的上限；封面是发给浏览器的字节，与它无关。
    expect((await readAgentSkillFileBytes('image', 'scene-look', 'big.webp')).kind).toBe('ok')
  })

  it('refuses anything that is not an image', async () => {
    expect(await readAgentSkillFileBytes('image', 'scene-look', 'SKILL.md')).toEqual({
      kind: 'not-an-image',
    })
  })

  it('guards the path the same way reading text does', async () => {
    expect(await readAgentSkillFileBytes('video', 'storyboard', '../../outside.png')).toEqual({
      kind: 'escapes-skill',
    })
  })
})

describe('用户自建的模板当成技能', () => {
  const look = {
    id: 'l1',
    name: '岩壁大理石',
    description: '给素材出冷峻岩壁场景图。',
    body: '## 1. 一句话目标\n把素材放进岩壁场景。',
    model: 'gpt-image-2.5-sunburst',
    size: '3:4',
    slotCount: 1,
  }

  it('合成出来的 SKILL.md 带 frontmatter、标题与钉死的参数', () => {
    const content = lookSkillContent(look)
    expect(
      content.startsWith('---\nname: look-l1\ndescription: 给素材出冷峻岩壁场景图。\n---'),
    ).toBe(true)
    expect(content).toContain('# 岩壁大理石')
    // 钉死的参数与正文必须在同一段文字里，否则模型会自己挑一套参数去写。
    expect(content).toContain('模型：gpt-image-2.5-sunburst · 尺寸：3:4 · 素材位：1')
    expect(content).toContain('把素材放进岩壁场景。')
  })

  it('描述里的换行不许把 frontmatter 撑破', () => {
    expect(lookSkillContent({ ...look, description: '第一行\n第二行' })).toContain(
      'description: 第一行 第二行',
    )
  })

  it('没钉死模型的那条不编造参数行', () => {
    expect(lookSkillContent({ ...look, model: null, size: null, slotCount: null })).not.toContain(
      '模型：',
    )
  })

  it('按名字找技能时先认内置的，认不出的名字不去猜', async () => {
    expect((await resolveAgentSkill('image', 'main-image', null))?.name).toBe('main-image')
    // 没有登录用户就没有模板可认：这一句一条 SQL 都不该发。
    expect(await resolveAgentSkill('image', 'look-nope', null)).toBeUndefined()
  })
})

describe('a skills directory that cannot be read right now', () => {
  it('retries the next time instead of staying empty for the life of the process', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'aip-skills-broken-'))
    const dir = join(broken, 'image', 'later')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'SKILL.md'),
      '---\nname: later\ndescription: 何时用：等目录可读之后。\n---\n\n# 迟到的技能\n\n正文',
      'utf8',
    )
    // 读不了这一刻：加载器会记一条 diagnostic，但技能是空的。
    await chmod(join(broken, 'image'), 0o000)
    setAgentSkillsRootForTesting(broken)
    try {
      await ensureAgentSkills()
      expect(agentSkills('image')).toEqual([])

      // 权限恢复之后，下一次起轮就该把它读进来——而不是等进程重启。
      await chmod(join(broken, 'image'), 0o755)
      await ensureAgentSkills()
      expect(agentSkills('image').map((one) => one.name)).toEqual(['later'])
    } finally {
      await chmod(join(broken, 'image'), 0o755).catch(() => {})
      await rm(broken, { recursive: true, force: true })
      setAgentSkillsRootForTesting(root)
      await ensureAgentSkills()
    }
  })

  it('shouts when the directory is there but nothing usable came out of it', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'aip-skills-empty-'))
    await mkdir(join(empty, 'image'), { recursive: true })
    const error = spyOn(log, 'error').mockImplementation(() => {})
    setAgentSkillsRootForTesting(empty)
    try {
      await ensureAgentSkills()
      // 镜像漏打包与「这个部署本来就没有技能」长得一模一样，只有这条日志分得开。
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
      await rm(empty, { recursive: true, force: true })
      setAgentSkillsRootForTesting(root)
      await ensureAgentSkills()
    }
  })
})

describe('a deployment without a skills directory', () => {
  it('loads nothing and stays quiet', async () => {
    setAgentSkillsRootForTesting(join(root, 'does-not-exist'))
    await ensureAgentSkills()
    expect(agentSkills('image')).toEqual([])
    expect(agentSkills('video')).toEqual([])
    setAgentSkillsRootForTesting(root)
    await ensureAgentSkills()
  })
})

describe('会话标题里的技能命令', () => {
  it('开头的 /技能 换成技能标题，后面的话留着', () => {
    expect(titleSourceText('/main-image', 'image')).toBe('电商主图')
    expect(titleSourceText('/main-image 做一张耳机主图', 'image')).toBe('电商主图 做一张耳机主图')
  })

  it('认不出的名字、别的模式的技能、句中的斜杠都原样留着', () => {
    expect(titleSourceText('/nope 你好', 'image')).toBe('/nope 你好')
    expect(titleSourceText('/storyboard', 'image')).toBe('/storyboard')
    expect(titleSourceText('把 /main-image 用上', 'image')).toBe('把 /main-image 用上')
  })
})
