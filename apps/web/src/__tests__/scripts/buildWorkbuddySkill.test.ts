import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, posix, resolve } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  createDoubaoSkillZip,
  createGenericSkillZip,
  createWorkBuddySkillZip,
} from '../../../scripts/build-workbuddy-skill.mjs'

describe('WorkBuddy Skill package', () => {
  it('imports as one skill with WorkBuddy metadata and complete local references', () => {
    const files = unzipSync(createWorkBuddySkillZip())
    const skill = strFromU8(files['muvloom/SKILL.md'])
    const frontmatter = skill.match(/^---\n([\s\S]+?)\n---\n/)?.[1] ?? ''
    for (const key of [
      'name',
      'display_name',
      'display_name_en',
      'description',
      'description_zh',
      'description_en',
      'version',
      'author',
    ]) {
      expect(frontmatter).toMatch(new RegExp(`^${key}: .+`, 'm'))
    }
    expect(Object.keys(files).filter((name) => name.endsWith('/SKILL.md'))).toEqual([
      'muvloom/SKILL.md',
    ])
    expect(files['muvloom/references/workbuddy.md']).toBeDefined()
    expect(skill).toContain('[WorkBuddy setup](references/workbuddy.md)')
    for (const [name, bytes] of Object.entries(files)) {
      expect(name.startsWith('muvloom/')).toBe(true)
      if (!name.endsWith('.md')) continue
      for (const match of strFromU8(bytes).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = match[1].split('#')[0]
        if (!href || /^[a-z]+:/i.test(href)) continue
        const target = posix.normalize(posix.join(posix.dirname(name), href))
        expect(target.startsWith('muvloom/')).toBe(true)
        expect(files[target], `${name} links to missing ${target}`).toBeDefined()
      }
    }
  })

  // 用户点完授权就应该自动继续，不该再回一句：智能体在前台等待，而不是结束回合。
  it('tells the agent to wait for the approval in the foreground instead of handing the turn back', () => {
    const files = unzipSync(createWorkBuddySkillZip())
    const guide = strFromU8(files['muvloom/references/workbuddy.md'])
    expect(guide).toContain('前台运行 `muvloom auth login`')
    expect(guide).toContain('系统默认浏览器')
    expect(guide).toContain('不要指定 Chrome')
    expect(guide).not.toContain('muvloom auth login --timeout 60')
    expect(guide).toContain('不会再打开新页面')
    expect(guide).toContain('AUTH_PENDING')
    expect(guide).toContain('不需要回复我')
    const skill = strFromU8(files['muvloom/SKILL.md'])
    expect(skill).toContain('keep the turn open')
    expect(skill).not.toContain('end the turn before continuing')
    expect(guide).not.toContain('立即结束这一回合')
    expect(guide).not.toContain('不要循环等待')
    // The old behaviour stays as the fallback when the host keeps interrupting the wait.
    expect(guide).toContain('连续两次')
  })

  it('produces identical bytes from the same checked-in source', () => {
    expect(createWorkBuddySkillZip()).toEqual(createWorkBuddySkillZip())
  })

  it('rejects a source whose workflow heading no longer accepts the WorkBuddy instructions', () => {
    const sourceDirectory = mkdtempSync(join(tmpdir(), 'workbuddy-skill-source-'))
    try {
      writeFileSync(
        join(sourceDirectory, 'SKILL.md'),
        '---\nname: muvloom\ndescription: Fixture\n---\n\n## Renamed workflow\n\nGenerate an image.\n',
      )
      expect(() => createWorkBuddySkillZip({ sourceDirectory })).toThrow(
        'Missing required Skill Flow section',
      )
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true })
    }
  })
})

describe('Doubao Skill package', () => {
  it('imports as one skill with Doubao metadata and complete local references', () => {
    const files = unzipSync(createDoubaoSkillZip())
    const skill = strFromU8(files['muvloom/SKILL.md'])
    const frontmatter = skill.match(/^---\n([\s\S]+?)\n---\n/)?.[1] ?? ''
    expect(frontmatter).toMatch(/^name: muvloom$/m)
    expect(frontmatter).toMatch(/^description: .+/m)
    expect(Object.keys(files).filter((name) => name.endsWith('/SKILL.md'))).toEqual([
      'muvloom/SKILL.md',
    ])
    expect(files['muvloom/references/doubao.md']).toBeDefined()
    expect(skill).toContain('[Doubao Work setup](references/doubao.md)')
    for (const [name, bytes] of Object.entries(files)) {
      expect(name.startsWith('muvloom/')).toBe(true)
      if (!name.endsWith('.md')) continue
      for (const match of strFromU8(bytes).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = match[1].split('#')[0]
        if (!href || /^[a-z]+:/i.test(href)) continue
        const target = posix.normalize(posix.join(posix.dirname(name), href))
        expect(target.startsWith('muvloom/')).toBe(true)
        expect(files[target], `${name} links to missing ${target}`).toBeDefined()
      }
    }
  })

  it('tells the agent to use the system default browser and not to hunt for Chrome', () => {
    const files = unzipSync(createDoubaoSkillZip())
    const guide = strFromU8(files['muvloom/references/doubao.md'])
    expect(guide).toContain('系统默认浏览器')
    expect(guide).toContain('不要指定 Chrome')
    expect(guide).toContain('Start-Process')
    expect(guide).toContain('操作电脑')
    expect(guide).toContain('附属浏览器')
    expect(guide).toContain('verification_uri_complete')
    expect(guide).toContain('AUTH_PENDING')
    expect(guide).toContain('MUVLOOM_NO_BROWSER=1')
    expect(guide).not.toContain('muvloom skill install --host doubao')
    expect(guide).toContain('/muv')
  })

  it('produces identical bytes from the same checked-in source', () => {
    expect(createDoubaoSkillZip()).toEqual(createDoubaoSkillZip())
  })
})

describe('generic Skill package', () => {
  it('ships the official SKILL.md pack under a muvloom/ root', () => {
    const files = unzipSync(createGenericSkillZip())
    expect(strFromU8(files['muvloom/SKILL.md'])).toContain('name: muvloom')
    expect(files['muvloom/references/workbuddy.md']).toBeUndefined()
    expect(files['muvloom/references/doubao.md']).toBeUndefined()
    expect(Object.keys(files).every((name) => name.startsWith('muvloom/'))).toBe(true)
  })
})

it('Docker 构建上下文放行技能包要读的宿主说明', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../')
  const ignore = readFileSync(resolve(repoRoot, '.dockerignore'), 'utf8')
  for (const directory of ['apps/web/workbuddy-skill', 'apps/web/doubao-skill']) {
    expect(ignore).toContain(`!${directory}/`)
    expect(ignore).toContain(`!${directory}/**`)
  }
})
