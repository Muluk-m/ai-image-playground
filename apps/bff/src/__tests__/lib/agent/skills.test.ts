import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 只读磁盘上的技能目录，一句 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/agent-skills'
process.env.LOG_LEVEL = 'silent'

const {
  AGENT_SKILL_FILE_MAX_BYTES,
  agentSkillInvocation,
  agentSkillLocation,
  agentSkillSummaries,
  agentSkills,
  ensureAgentSkills,
  findAgentSkill,
  readAgentSkillFile,
  setAgentSkillsRootForTesting,
} = await import('../../../lib/agent/skills')

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
    '主图正文',
  )
  await skill(
    'video',
    'storyboard',
    'name: storyboard\ndescription: 何时用：多镜短片。',
    '分镜正文',
  )
  await skill('shared', 'palette', 'name: palette\ndescription: 何时用：配色。', '配色正文')
  // 名字与父目录不一致 + 缺 description：两种 diagnostic 各来一条。
  await skill('image', 'mismatch', 'name: other-name\ndescription: 何时用：随便。', '正文')
  await skill('image', 'no-description', 'name: no-description', '正文')

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
    ).toEqual(['main-image', 'other-name', 'palette'])
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
      description: '何时用：多镜短片。',
    })
    expect(JSON.stringify(agentSkillSummaries('video'))).not.toContain('分镜正文')
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
