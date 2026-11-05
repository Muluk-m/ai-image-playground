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

/** GitHub Actions uploads data only; deployment code comes from the server-installed runtime. */
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

/** A data-only release directory as the workflow packs it: `tar -C "$out" -czf - .` */
function releaseTar(): Buffer {
  const dir = join(root, 'src')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'images.tsv'), 'manifest\n')
  const checksum = spawnSync('shasum', ['-a', '256', 'images.tsv'], { cwd: dir, encoding: 'utf8' })
  if (checksum.status !== 0) throw new Error(checksum.stderr)
  writeFileSync(join(dir, 'SHA256SUMS'), checksum.stdout)
  return tarOf(['-C', dir, '.'])
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-ci-receive-'))
  home = join(root, 'home')
  releases = join(home, 'releases')
  log = join(root, 'calls')
  mkdirSync(releases, { recursive: true })
  mkdirSync(join(home, 'deploy-runtime', 'scripts'), { recursive: true })
  writeFileSync(
    join(home, 'deploy-runtime', 'scripts', 'vps-deploy.sh'),
    '#!/bin/sh\nprintf "%s actor=%s\\n" "$*" "$DEPLOY_ACTOR" >> "$CALL_LOG"\nexit "${TEST_DEPLOY_EXIT:-0}"\n',
  )
  chmodSync(join(home, 'deploy-runtime', 'scripts', 'vps-deploy.sh'), 0o755)
})

function receive(
  command: string | undefined,
  input: Buffer = releaseTar(),
  extra = {},
  scope = 'release',
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    AIP_DEPLOY_RUNTIME_ROOT: join(home, 'deploy-runtime'),
    CALL_LOG: log,
    ...extra,
  }
  if (command === undefined) delete env.SSH_ORIGINAL_COMMAND
  else env.SSH_ORIGINAL_COMMAND = command
  return spawnSync('sh', [script, scope], { env, input, encoding: 'utf8', timeout: 20000 })
}

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

  it('moves a failed release aside so the same commit can be retried', () => {
    expect(receive(`deploy ${id} all 7`, releaseTar(), { TEST_DEPLOY_EXIT: '1' }).status).toBe(1)
    const kept = readdirSync(releases)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(new RegExp(`^${id}\\.failed-run-7$`))
    expect(receive(`deploy ${id} all 8`).status).toBe(0)
    expect(readdirSync(releases).sort()).toEqual([id, `${id}.failed-run-7`])
  })

  it('cleans up incomplete data before invoking the fixed runtime', () => {
    const dir = join(root, 'incomplete')
    mkdirSync(dir)
    writeFileSync(join(dir, 'images.tsv'), 'manifest\n')
    const result = receive(`deploy ${id} paid 8`, tarOf(['-C', dir, '.']))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Incomplete release')
    expect(existsSync(join(releases, id))).toBe(false)
    expect(existsSync(log)).toBe(false)
  })

  it('cleans up the data package when the fixed runtime is absent', () => {
    rmSync(join(home, 'deploy-runtime'), { recursive: true })
    const result = receive(`deploy ${id} paid 8`, releaseTar())
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Deployment runtime is not installed')
    expect(existsSync(join(releases, id))).toBe(false)
    expect(existsSync(log)).toBe(false)
  })
  it('rejects an archive containing deployment code before invoking the trusted runtime', () => {
    const dir = join(root, 'evil')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'images.tsv'), 'manifest\n')
    writeFileSync(join(dir, 'scripts', 'vps-deploy.sh'), 'echo hacked >> "$CALL_LOG"\n')
    const result = receive(`deploy ${id} test 8`, tarOf(['-C', dir, '.']), {}, 'test')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('only SHA256SUMS, images.tsv')
    expect(existsSync(log)).toBe(false)
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

  it('lets the test key deploy only test, and the release key everything but test', () => {
    for (const target of ['internal', 'paid', 'all', 'prod']) {
      const refused = receive(`deploy ${id} ${target} 1`, releaseTar(), {}, 'test')
      expect(refused.status).toBe(2)
    }
    expect(receive(`deploy ${id} test 1`, releaseTar(), {}, 'release').status).toBe(2)
    expect(readdirSync(releases)).toEqual([])
    expect(existsSync(log)).toBe(false)
    expect(receive(`deploy ${id} test 1`, releaseTar(), {}, 'test').status).toBe(0)
    expect(readFileSync(log, 'utf8')).toBe(`test ${releases}/${id} actor=github-actions/run-1\n`)
  })

  it.each([
    undefined,
    '',
    'all',
    'internal',
    'paid',
    'test ; id',
  ])('refuses everything when the key scope is %j', (scope) => {
    const result = spawnSync('sh', scope === undefined ? [script] : [script, scope], {
      env: {
        ...process.env,
        HOME: home,
        CALL_LOG: log,
        SSH_ORIGINAL_COMMAND: `deploy ${id} paid 1`,
      },
      input: releaseTar(),
      encoding: 'utf8',
      timeout: 20000,
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('no deploy scope')
    expect(readdirSync(releases)).toEqual([])
  })

  it('redeploys a commit already on the host into a run-specific directory', () => {
    mkdirSync(join(releases, id))
    writeFileSync(join(releases, id, 'marker'), 'kept')
    const result = receive(`deploy ${id} all 42`)
    expect(result.status).toBe(0)
    expect(readdirSync(join(releases, id))).toEqual(['marker'])
    expect(readFileSync(join(releases, `${id}.run-42`, 'images.tsv'), 'utf8')).toBe('manifest\n')
    expect(readFileSync(log, 'utf8')).toBe(
      `all ${releases}/${id}.run-42 actor=github-actions/run-42\n`,
    )
  })

  it('refuses when even the run-specific directory already exists', () => {
    mkdirSync(join(releases, id))
    mkdirSync(join(releases, `${id}.run-42`))
    const result = receive(`deploy ${id} all 42`)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('already exists')
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
