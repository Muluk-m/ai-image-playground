import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * 测试环境 workflow 的第一道闸：test 落后 main 就不给构建。
 * 这里用真实 git 历史，只看退出码与它打印出来的那份缺失提交清单。
 */
const script = resolve(__dirname, '../../../../../scripts/ci-check-test-branch.sh')
let root: string
let repo: string

function git(...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-C', repo, ...args],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function commit(file: string, body: string, message: string): string {
  writeFileSync(join(repo, file), body)
  git('add', file)
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}

function check(): { status: number | null; log: string } {
  const result = spawnSync('sh', [script, 'origin'], { cwd: repo, encoding: 'utf8' })
  return { status: result.status, log: result.stdout }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-check-test-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  commit('base.txt', 'base\n', 'base')
  // origin/main without a second repository: the script only reads the ref.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('checkout', '-q', '-b', 'test')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ci-check-test-branch.sh', () => {
  it('passes when test already contains main, even with work of its own on top', () => {
    commit('only-on-test.txt', 'x\n', 'test-only work')

    expect(check().status).toBe(0)
  })

  it('passes on a merge commit that brought main in', () => {
    commit('only-on-test.txt', 'x\n', 'test-only work')
    git('checkout', '-q', 'main')
    const mainOnly = commit('only-on-main.txt', 'y\n', 'main-only work')
    git('update-ref', 'refs/remotes/origin/main', mainOnly)
    git('checkout', '-q', 'test')
    git('merge', '--no-edit', '--no-ff', '-m', 'merge main', mainOnly)

    expect(check().status).toBe(0)
  })

  it('fails and names the missing commits when test is behind', () => {
    commit('only-on-test.txt', 'x\n', 'test-only work')
    git('checkout', '-q', 'main')
    commit('first.txt', 'y\n', 'first main commit')
    const mainOnly = commit('second.txt', 'z\n', 'second main commit')
    git('update-ref', 'refs/remotes/origin/main', mainOnly)
    git('checkout', '-q', 'test')

    const { status, log } = check()

    expect(status).not.toBe(0)
    expect(log).toContain('::error::')
    expect(log).toContain('behind origin/main by 2 commit')
    // 清单要能直接告诉人少了哪几条，而不是只报一个数字。
    expect(log).toContain('first main commit')
    expect(log).toContain('second main commit')
    // 只读：分支原样不动。
    expect(git('status', '--porcelain')).toBe('')
  })
})
