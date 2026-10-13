import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/** MAJOR.MINOR live in package.json. PATCH is the next free tag on that line. */
const script = resolve(__dirname, '../../../../../scripts/next-release-version.sh')
let repo: string

function git(...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-C', repo, ...args],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function next() {
  const result = spawnSync('sh', [script, repo], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  return result.stdout.trim()
}

afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('next-release-version.sh', () => {
  it('starts a new major.minor at patch 0', () => {
    repo = mkdtempSync(join(tmpdir(), 'aip-release-'))
    writeFileSync(join(repo, 'package.json'), '{"version":"0.4.0"}\n')
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'base')
    git('tag', 'v0.3.9')
    expect(next()).toBe('0.4.0')
  })

  it('increments the highest patch on the current line and ignores other tags', () => {
    repo = mkdtempSync(join(tmpdir(), 'aip-release-'))
    writeFileSync(join(repo, 'package.json'), '{"version":"0.4.0"}\n')
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'base')
    git('tag', 'v0.4.0')
    git('tag', 'v0.4.2')
    git('tag', 'v0.4.10')
    git('tag', 'v0.4.2-rc1')
    git('tag', 'v0.5.4')
    expect(next()).toBe('0.4.11')
  })

  it('resets the patch when the owner moves major or minor', () => {
    repo = mkdtempSync(join(tmpdir(), 'aip-release-'))
    writeFileSync(join(repo, 'package.json'), '{"version":"1.2.0"}\n')
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'base')
    git('tag', 'v0.4.8')
    git('tag', 'v1.1.6')
    expect(next()).toBe('1.2.0')
  })
})
