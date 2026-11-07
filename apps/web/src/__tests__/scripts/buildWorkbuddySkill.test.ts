import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createWorkBuddySkillZip } from '../../../scripts/build-workbuddy-skill.mjs'

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
