import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * GitHub Actions 通过一把受限 SSH key 发布：authorized_keys 里 `command="…",restrict` 把这把 key
 * 钉死在 scripts/ci-receive.sh 上。它只认 `deploy <release-id> <internal|paid|all> <run-id>`，
 * 把 stdin 的 tar 解到 ~/releases/<release-id>，再跑包里的 vps-deploy.sh。这里用假的
 * vps-deploy.sh 与真实 tar，只看退出码、落盘的文件与接收脚本收到的参数。
 */
const script = resolve(__dirname, '../../../../../scripts/ci-receive.sh')
const id = `aip-${'a'.repeat(12)}-${'b'.repeat(12)}`
let root: string
let home: string
let releases: string
let log: string

function tarOf(args: string[]): Buffer {
  const result = spawnSync('tar', ['-czf', '-', ...args], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  if (result.status !== 0) throw new Error(String(result.stderr))
  return result.stdout
}

/** A release directory as the workflow packs it: `tar -C "$out" -czf - .` */
function releaseTar(): Buffer {
  const dir = join(root, 'src')
  mkdirSync(join(dir, 'scripts/lib'), { recursive: true })
  writeFileSync(
    join(dir, 'scripts/vps-deploy.sh'),
    '#!/bin/sh\nprintf "%s actor=%s\\n" "$*" "$DEPLOY_ACTOR" >> "$CALL_LOG"\nexit "${TEST_DEPLOY_EXIT:-0}"\n',
  )
  chmodSync(join(dir, 'scripts/vps-deploy.sh'), 0o755)
  writeFileSync(join(dir, 'scripts/lib/deploy-common.sh'), '# lib\n')
  writeFileSync(join(dir, 'images.tsv'), 'manifest\n')
  return tarOf(['-C', dir, '.'])
}

function receive(command: string | undefined, input: Buffer = releaseTar(), extra = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CALL_LOG: log, ...extra }
  if (command === undefined) delete env.SSH_ORIGINAL_COMMAND
  else env.SSH_ORIGINAL_COMMAND = command
  return spawnSync('sh', [script], { env, input, encoding: 'utf8', timeout: 20000 })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-ci-receive-'))
  home = join(root, 'home')
  releases = join(home, 'releases')
  log = join(root, 'calls')
  mkdirSync(releases, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('ci-receive.sh', () => {
  it('unpacks the release and runs its receiver as the GitHub Actions run', () => {
    const result = receive(`deploy ${id} all 12345`)
    expect(result.status).toBe(0)
    expect(readFileSync(join(releases, id, 'images.tsv'), 'utf8')).toBe('manifest\n')
    expect(readFileSync(log, 'utf8')).toBe(`all ${releases}/${id} actor=github-actions/run-12345\n`)
    expect(readdirSync(releases)).toEqual([id])
  })

  it('passes the receiver exit status back to the workflow', () => {
    const result = receive(`deploy ${id} paid 7`, releaseTar(), { TEST_DEPLOY_EXIT: '3' })
    expect(result.status).toBe(3)
    expect(readFileSync(log, 'utf8')).toBe(`paid ${releases}/${id} actor=github-actions/run-7\n`)
  })

  it.each([
    undefined,
    '',
    'deploy',
    `deploy ${id} all`,
    `deploy ${id} all 1 extra`,
    `deploy ${id} prod 1`,
    `deploy ${id} all 1x`,
    `deploy ${id} all 1;id`,
    `deploy ../${id} all 1`,
    `deploy aip-${'a'.repeat(12)}-${'b'.repeat(11)} all 1`,
    `deploy aip-${'A'.repeat(12)}-${'b'.repeat(12)} all 1`,
    'deploy aip-* all 1',
    `rollback ${id} all 1`,
    'sh -c id',
  ])('rejects %j without touching the releases directory', (command) => {
    const result = receive(command)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Rejected')
    expect(readdirSync(releases)).toEqual([])
    expect(existsSync(log)).toBe(false)
  })

  it('refuses a release directory that already exists', () => {
    mkdirSync(join(releases, id))
    writeFileSync(join(releases, id, 'marker'), 'kept')
    const result = receive(`deploy ${id} all 1`)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('already exists')
    expect(readdirSync(join(releases, id))).toEqual(['marker'])
    expect(existsSync(log)).toBe(false)
  })

  it('rejects an archive that climbs out of the release directory', () => {
    const inner = join(root, 'inner')
    mkdirSync(inner)
    writeFileSync(join(root, 'outside.txt'), 'escape')
    const result = receive(`deploy ${id} all 1`, tarOf(['-P', '-C', inner, '../outside.txt']))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsafe archive')
    expect(existsSync(join(home, 'outside.txt'))).toBe(false)
    expect(readdirSync(releases)).toEqual([])
    expect(existsSync(log)).toBe(false)
  })

  it('rejects an archive with absolute paths', () => {
    writeFileSync(join(root, 'absolute.txt'), 'absolute')
    const result = receive(`deploy ${id} all 1`, tarOf(['-P', join(root, 'absolute.txt')]))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsafe archive')
    expect(readdirSync(releases)).toEqual([])
    expect(existsSync(log)).toBe(false)
  })

  it('rejects an archive carrying a symlink', () => {
    const dir = join(root, 'linked')
    mkdirSync(dir)
    symlinkSync('/etc', join(dir, 'etc'))
    const result = receive(`deploy ${id} all 1`, tarOf(['-C', dir, '.']))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsafe archive')
    expect(readdirSync(releases)).toEqual([])
  })

  it('leaves nothing behind when stdin is not an archive', () => {
    const result = receive(`deploy ${id} all 1`, Buffer.from('not a tarball'))
    expect(result.status).toBe(1)
    expect(readdirSync(releases)).toEqual([])
    expect(existsSync(log)).toBe(false)
  })
})
