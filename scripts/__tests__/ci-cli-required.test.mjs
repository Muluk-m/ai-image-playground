import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { changedPaths, cliRequired, isCliInput } from '../ci-cli-required.mjs'

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const push = { before: base, after: head }
const pr = { pull_request: { base: { sha: base }, head: { sha: head } } }

test('ordinary web and backend changes do not run the native CLI matrix', () => {
  for (const [eventName, event] of [['push', push], ['pull_request', pr]]) {
    assert.equal(cliRequired(eventName, event, () => ['apps/web/src/main.tsx', 'apps/bff/src/app.ts']), false)
  }
})

test('CLI code, embedded Skills, installers, workflows and routing changes run the full matrix', () => {
  for (const path of [
    'cli-go/go.mod',
    'cli-go/internal/cli/app.go',
    'cli-go/internal/skill/assets/SKILL.md',
    'cli-go/install/install.ps1',
    '.github/workflows/cli-checks.yml',
    '.github/workflows/cli-release.yml',
    '.github/workflows/web.yml',
    '.github/actions/setup/action.yml',
    'scripts/ci-cli-required.mjs',
    'scripts/__tests__/ci-cli-required.test.mjs',
    'go.work',
    'go.work.sum',
  ]) {
    assert.equal(cliRequired('push', push, () => [path]), true, path)
  }
})

test('manual runs, unknown events, incomplete history and errors run all checks', () => {
  for (const name of ['workflow_dispatch', 'unknown']) {
    assert.equal(cliRequired(name, {}, () => []), true)
  }
  for (const event of [{}, { ...push, before: '0'.repeat(40) }, { ...push, after: 'invalid' }]) {
    assert.equal(cliRequired('push', event, () => []), true)
  }
  assert.equal(cliRequired('pull_request', pr, () => { throw new Error('missing base') }), true)
})

test('PRs compare from the merge base; pushes cover every commit since before', () => {
  for (const [name, event, mergeBase] of [['pull_request', pr, true], ['push', push, false]]) {
    cliRequired(name, event, (...args) => {
      assert.deepEqual(args, [base, head, mergeBase])
      return []
    })
  }
})

test('a rename out of cli-go still detects the removed CLI input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aip-cli-diff-'))
  const cwd = process.cwd()
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  try {
    git('init', '-q')
    git('config', 'user.name', 'test')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    mkdirSync(join(dir, 'cli-go'))
    writeFileSync(join(dir, 'cli-go', 'go.mod'), 'fixture\n')
    git('add', 'cli-go/go.mod')
    git('commit', '-qm', 'base')
    const before = git('rev-parse', 'HEAD')
    git('mv', 'cli-go/go.mod', 'notes.txt')
    git('commit', '-qm', 'move')
    const after = git('rev-parse', 'HEAD')
    process.chdir(dir)
    const paths = changedPaths(before, after, false)
    assert.deepEqual(paths, ['cli-go/go.mod', 'notes.txt'])
    assert.equal(paths.some(isCliInput), true)
  } finally {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  }
})
