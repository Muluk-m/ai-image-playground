import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(__dirname, '../../../../../scripts/test-sync.sh')
let root: string
let origin: string
let clone: string

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.test',
}
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}
function commit(cwd: string, file: string, content: string, message: string) {
  writeFileSync(join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', message)
}
function sync(...branches: string[]) {
  return spawnSync('sh', [script, ...branches], { cwd: clone, encoding: 'utf8', env })
}
const remoteHead = (branch: string) => git(origin, 'rev-parse', branch)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-test-sync-'))
  origin = join(root, 'origin.git')
  clone = join(root, 'clone')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, clone)
  commit(clone, 'a.txt', 'base\n', 'base')
  git(clone, 'push', '-q', 'origin', 'HEAD:main', 'HEAD:test')
  // Someone else's work already on test.
  git(clone, 'switch', '-q', '-c', 'other', 'origin/test')
  commit(clone, 'other.txt', 'other\n', 'other session')
  git(clone, 'push', '-q', 'origin', 'HEAD:test')
  git(clone, 'switch', '-q', '-C', 'main', 'origin/main')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('test-sync.sh', () => {
  it('merges main and the given branch into test, keeping what is already there', () => {
    commit(clone, 'main.txt', 'main\n', 'main moves')
    git(clone, 'push', '-q', 'origin', 'HEAD:main')
    git(clone, 'switch', '-q', '-c', 'feature', 'origin/main')
    commit(clone, 'feature.txt', 'feature\n', 'feature')
    git(clone, 'push', '-q', 'origin', 'feature')

    const result = sync('feature')
    expect(result.status, result.stderr).toBe(0)
    const test = remoteHead('test')
    for (const ref of ['main', 'feature'])
      expect(
        spawnSync('git', ['merge-base', '--is-ancestor', remoteHead(ref), test], { cwd: origin })
          .status,
      ).toBe(0)
    expect(git(origin, 'show', `${test}:other.txt`)).toBe('other')
    // No worktree is left behind.
    expect(git(clone, 'worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('pushes nothing when a merge conflicts', () => {
    commit(clone, 'other.txt', 'main version\n', 'conflicting main')
    git(clone, 'push', '-q', 'origin', 'HEAD:main')
    const before = remoteHead('test')
    const result = sync()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('conflicts; nothing was pushed')
    expect(remoteHead('test')).toBe(before)
    expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe('base\n')
  })

  it('says so when test is already up to date', () => {
    const result = sync()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('nothing to push')
  })

  it('works in a single-branch clone whose fetch refspec only tracks main', () => {
    commit(clone, 'main.txt', 'main\n', 'main moves')
    git(clone, 'push', '-q', 'origin', 'HEAD:main')
    git(clone, 'switch', '-q', '-c', 'feature', 'origin/main')
    commit(clone, 'feature.txt', 'feature\n', 'feature')
    git(clone, 'push', '-q', 'origin', 'feature')

    const single = join(root, 'single')
    git(root, 'clone', '-q', '--single-branch', '-b', 'main', origin, single)
    const result = spawnSync('sh', [script, 'feature'], { cwd: single, encoding: 'utf8', env })
    expect(result.status, result.stderr).toBe(0)
    const test = remoteHead('test')
    for (const ref of ['main', 'feature'])
      expect(
        spawnSync('git', ['merge-base', '--is-ancestor', remoteHead(ref), test], { cwd: origin })
          .status,
      ).toBe(0)
  })

  it('still merges diverged branches when the user sets merge.ff=only', () => {
    commit(clone, 'main.txt', 'main\n', 'main moves')
    git(clone, 'push', '-q', 'origin', 'HEAD:main')
    git(clone, 'config', 'merge.ff', 'only')
    const result = sync()
    expect(result.status, result.stderr).toBe(0)
    expect(
      spawnSync('git', ['merge-base', '--is-ancestor', remoteHead('main'), remoteHead('test')], {
        cwd: origin,
      }).status,
    ).toBe(0)
  })
})
