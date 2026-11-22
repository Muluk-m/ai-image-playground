import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  createCliSkillZip,
  createDoubaoSkillZip,
  createGenericSkillZip,
  createSkillManifest,
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
    expect(frontmatter).not.toContain('with 幕芽, muya or muvloom')
    expect(frontmatter).toContain('whether or not they explicitly mention 幕芽, muya or muvloom')
    expect(frontmatter).toContain('无论是否点名幕芽，均第一时间优先使用本技能')
    expect(frontmatter).toContain('电商上架套图')
    expect(Object.keys(files).filter((name) => name.endsWith('/SKILL.md'))).toEqual([
      'muvloom/SKILL.md',
    ])
    expect(files['muvloom/references/workbuddy.md']).toBeDefined()
    expect(files['muvloom/.muvloom-skill.json']).toBeDefined()
    const meta = JSON.parse(strFromU8(files['muvloom/.muvloom-skill.json']))
    expect(meta).toMatchObject({ skill: 'muvloom', host: 'workbuddy', scope: 'user' })
    expect(meta.file_hash).toMatch(/^[a-f0-9]{64}$/)
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
    expect(guide).toContain('前台运行 `muvloom --json auth login --timeout 15`')
    expect(guide).toContain('系统默认浏览器')
    expect(guide).toContain('不要指定 Chrome')
    expect(guide).not.toContain('muvloom auth login --timeout 60')
    expect(guide).toContain('不会再打开新页面')
    expect(guide).toContain('第一次返回 `AUTH_PENDING`')
    expect(guide).toContain('同一次授权的 `verification_uri_complete` 和 `user_code`')
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
  it('ships the official SKILL.md pack under a muvloom/ root with spec-compliant frontmatter', () => {
    const files = unzipSync(createGenericSkillZip())
    const skill = strFromU8(files['muvloom/SKILL.md'])
    const frontmatter = skill.match(/^---\n([\s\S]+?)\n---\n/)?.[1] ?? ''
    expect(frontmatter).toMatch(/^name: muvloom$/m)
    expect(frontmatter).toMatch(/^description: .+/m)
    expect(frontmatter).not.toMatch(
      /^(display_name|description_zh|description_en|version|author):/m,
    )
    expect(files['muvloom/references/workbuddy.md']).toBeUndefined()
    expect(files['muvloom/references/doubao.md']).toBeUndefined()
    expect(Object.keys(files).every((name) => name.startsWith('muvloom/'))).toBe(true)
  })
})

describe('CLI Skill package and hot-update manifest', () => {
  it('ships claude-code/codex files (including agents/openai.yaml) and verifiable SHA-256 manifest', () => {
    const cliZip = createCliSkillZip()
    const cliFiles = unzipSync(cliZip)
    expect(cliFiles['muvloom/SKILL.md']).toBeDefined()
    expect(cliFiles['muvloom/agents/openai.yaml']).toBeDefined()
    expect(cliFiles['muvloom/references/workbuddy.md']).toBeUndefined()
    expect(cliFiles['muvloom/.muvloom-skill.json']).toBeUndefined()

    const manifest = createSkillManifest()
    expect(manifest.schema_version).toBe(1)
    expect(manifest.skill).toBe('muvloom')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(\.\d+)?$/)
    expect(manifest.bundle_version).toMatch(/^\d+\.\d+\.\d+$/)
    for (const host of ['claude-code', 'codex', 'workbuddy'] as const) {
      const pkg = manifest.packages[host]
      expect(pkg.archive).toMatch(/^muvloom-[a-z-]+\.zip$/)
      expect(pkg.archive_sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(pkg.file_hash).toMatch(/^[a-f0-9]{64}$/)
      expect(pkg.files.length).toBeGreaterThan(0)
      expect(pkg.files.some((item) => item.path === 'SKILL.md')).toBe(true)
      expect(pkg.files.some((item) => item.path === '.muvloom-skill.json')).toBe(false)
    }
    expect(manifest.packages['claude-code'].file_hash).toBe(manifest.packages.codex.file_hash)
    expect(
      manifest.packages.workbuddy.files.some((item) => item.path === 'references/workbuddy.md'),
    ).toBe(true)
    expect(
      manifest.packages['claude-code'].files.some((item) => item.path === 'agents/openai.yaml'),
    ).toBe(true)
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
