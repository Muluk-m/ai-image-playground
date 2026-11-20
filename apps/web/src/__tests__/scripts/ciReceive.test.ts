import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
/** A stand-in for the public repository: main carries a runtime, `side` a commit that is not on main. */
let origin: string
let mainCommit: string
let sideCommit: string

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** Commits a runtime whose vps-deploy.sh logs like the fixed one, tagged with `label`. */
function commitRuntime(label: string): string {
  const deploy = join(origin, 'scripts', 'vps-deploy.sh')
  mkdirSync(join(origin, 'scripts'), { recursive: true })
  mkdirSync(join(origin, 'deploy'), { recursive: true })
  writeFileSync(join(origin, 'deploy', 'compose.app.yaml'), `# ${label}\n`)
  writeFileSync(
    deploy,
    `#!/bin/sh\nprintf "%s actor=%s runtime=${label}\\n" "$*" "$DEPLOY_ACTOR" >> "$CALL_LOG"\nexit "\${TEST_DEPLOY_EXIT:-0}"\n`,
  )
  chmodSync(deploy, 0o755)
  git(origin, 'add', '-A')
  git(origin, 'commit', '-q', '-m', label)
  return git(origin, 'rev-parse', 'HEAD')
}

function tarOf(args: string[]): Buffer {
  const result = spawnSync('tar', ['-czf', '-', ...args], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  if (result.status !== 0) throw new Error(String(result.stderr))
  return result.stdout
}

/** images.tsv as build-vps-release.sh writes it: target, tag, image id, public and private commit, digest. */
function manifest(target = 'paid', commit = mainCommit): string {
  return `${target}\tai-image-playground:${target}-x\tsha256:${'c'.repeat(64)}\t${commit}\t${'d'.repeat(40)}\tghcr.io/x@sha256:${'e'.repeat(64)}\n`
}

/** A data-only release directory as the workflow packs it: `tar -C "$out" -czf - .` */
function releaseTar(images = manifest()): Buffer {
  const dir = join(root, 'src')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'images.tsv'), images)
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
  origin = join(root, 'origin')
  mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'main')
  mainCommit = commitRuntime('main')
  git(origin, 'checkout', '-q', '-b', 'side')
  sideCommit = commitRuntime('side')
  git(origin, 'checkout', '-q', 'main')
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
    AIP_RUNTIME_GIT_URL: origin,
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
    const result = receive(`deploy ${id} paid 12345`)
    expect(result.status).toBe(0)
    expect(readFileSync(join(releases, id, 'images.tsv'), 'utf8')).toBe(manifest())
    expect(readFileSync(log, 'utf8')).toBe(
      `paid ${releases}/${id} actor=github-actions/run-12345 runtime=main\n`,
    )
    expect(readdirSync(releases)).toEqual([id])
  })

  it('passes the receiver exit status back to the workflow', () => {
    const result = receive(`deploy ${id} paid 7`, releaseTar(), { TEST_DEPLOY_EXIT: '3' })
    expect(result.status).toBe(3)
    expect(readFileSync(log, 'utf8')).toBe(
      `paid ${releases}/${id} actor=github-actions/run-7 runtime=main\n`,
    )
  })

  it('moves a failed release aside so the same commit can be retried', () => {
    expect(receive(`deploy ${id} paid 7`, releaseTar(), { TEST_DEPLOY_EXIT: '1' }).status).toBe(1)
    const kept = readdirSync(releases)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatch(new RegExp(`^${id}\\.failed-run-7$`))
    expect(receive(`deploy ${id} paid 8`).status).toBe(0)
    expect(readdirSync(releases).sort()).toEqual([id, `${id}.failed-run-7`])
  })

  it('drops the release when the host deploy lock was busy, so the same run can be retried', () => {
    const busy = receive(`deploy ${id} test 7`, releaseTar(), { TEST_DEPLOY_EXIT: '75' }, 'test')
    expect(busy.status).toBe(75)
    expect(busy.stderr).toContain('Deploy lock busy')
    expect(readdirSync(releases)).toEqual([])
    expect(receive(`deploy ${id} test 7`, releaseTar(), {}, 'test').status).toBe(0)
    expect(readdirSync(releases)).toEqual([id])
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

  it('cleans up the data package when the fixed test runtime is absent', () => {
    rmSync(join(home, 'deploy-runtime'), { recursive: true })
    const result = receive(`deploy ${id} test 8`, releaseTar(manifest('test')), {}, 'test')
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
    `deploy ${id} paid`,
    `deploy ${id} paid 1 extra`,
    `deploy ${id} prod 1`,
    `deploy ${id} paid 1x`,
    `deploy ${id} paid 1;id`,
    `deploy ../${id} paid 1`,
    `deploy aip-${'a'.repeat(12)}-${'b'.repeat(11)} paid 1`,
    `deploy aip-${'A'.repeat(12)}-${'b'.repeat(12)} paid 1`,
    'deploy aip-* paid 1',
    `rollback ${id} paid 1`,
    'sh -c id',
  ])('rejects %j without touching the releases directory', (command) => {
    const result = receive(command)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Rejected')
    expect(readdirSync(releases)).toEqual([])
    expect(existsSync(log)).toBe(false)
  })

  it('lets the test key deploy only test, and the release key deploy only paid', () => {
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

  it.each(['internal', 'all'])('refuses retired target %s even with the release key', (target) => {
    expect(receive(`deploy ${id} ${target} 1`).status).toBe(2)
    expect(readdirSync(releases)).toEqual([])
    expect(existsSync(log)).toBe(false)
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
    const result = receive(`deploy ${id} paid 42`)
    expect(result.status).toBe(0)
    expect(readdirSync(join(releases, id))).toEqual(['marker'])
    expect(readFileSync(join(releases, `${id}.run-42`, 'images.tsv'), 'utf8')).toBe(manifest())
    expect(readFileSync(log, 'utf8')).toBe(
      `paid ${releases}/${id}.run-42 actor=github-actions/run-42 runtime=main\n`,
    )
  })

  it('refuses when even the run-specific directory already exists', () => {
    mkdirSync(join(releases, id))
    mkdirSync(join(releases, `${id}.run-42`))
    const result = receive(`deploy ${id} paid 42`)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('already exists')
    expect(existsSync(log)).toBe(false)
  })

  it('rejects an archive that climbs out of the release directory', () => {
    const inner = join(root, 'inner')
    mkdirSync(inner)
    writeFileSync(join(root, 'outside.txt'), 'escape')
    const result = receive(`deploy ${id} paid 1`, tarOf(['-P', '-C', inner, '../outside.txt']))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsafe archive')
    expect(existsSync(join(home, 'outside.txt'))).toBe(false)
    expect(readdirSync(releases)).toEqual([])
    expect(existsSync(log)).toBe(false)
  })

  it('rejects an archive with absolute paths', () => {
    writeFileSync(join(root, 'absolute.txt'), 'absolute')
    const result = receive(`deploy ${id} paid 1`, tarOf(['-P', join(root, 'absolute.txt')]))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsafe archive')
    expect(readdirSync(releases)).toEqual([])
    expect(existsSync(log)).toBe(false)
  })

  it('rejects an archive carrying a symlink', () => {
    const dir = join(root, 'linked')
    mkdirSync(dir)
    symlinkSync('/etc', join(dir, 'etc'))
    const result = receive(`deploy ${id} paid 1`, tarOf(['-C', dir, '.']))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsafe archive')
    expect(readdirSync(releases)).toEqual([])
  })

  it('leaves nothing behind when stdin is not an archive', () => {
    const result = receive(`deploy ${id} paid 1`, Buffer.from('not a tarball'))
    expect(result.status).toBe(1)
    expect(readdirSync(releases)).toEqual([])
    expect(existsSync(log)).toBe(false)
  })

  describe('paid runs the deployment code of the commit it deploys', () => {
    const runtimes = () => join(home, 'deploy-runtimes')

    it('unpacks that commit from main and runs it, leaving current-paid pointing at it', () => {
      const result = receive(`deploy ${id} paid 1`)
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(log, 'utf8')).toBe(
        `paid ${releases}/${id} actor=github-actions/run-1 runtime=main\n`,
      )
      expect(readFileSync(join(runtimes(), mainCommit, '.commit'), 'utf8')).toBe(`${mainCommit}\n`)
      expect(readFileSync(join(runtimes(), mainCommit, 'deploy', 'compose.app.yaml'), 'utf8')).toBe(
        '# main\n',
      )
      expect(readlinkSync(join(runtimes(), 'current-paid'))).toBe(join(runtimes(), mainCommit))
      expect(result.stderr).toContain(
        `Deployment runtime: ${join(runtimes(), mainCommit)} (${mainCommit})`,
      )
    })

    it('refuses a commit that is not on main, and leaves no release behind', () => {
      const result = receive(`deploy ${id} paid 1`, releaseTar(manifest('paid', sideCommit)))
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`${sideCommit} is not on main`)
      expect(existsSync(log)).toBe(false)
      expect(readdirSync(releases)).toEqual([])
      expect(existsSync(join(runtimes(), sideCommit))).toBe(false)
    })

    it('refuses a manifest that names no commit instead of falling back to the fixed runtime', () => {
      const result = receive(`deploy ${id} paid 1`, releaseTar('manifest\n'))
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('names no public commit')
      expect(existsSync(log)).toBe(false)
      expect(readdirSync(releases)).toEqual([])
    })

    it('redeploys a commit it verified before when the repository cannot be reached, never a new one', () => {
      expect(receive(`deploy ${id} paid 1`).status).toBe(0)
      const offline = { AIP_RUNTIME_GIT_URL: join(root, 'unreachable') }
      const again = receive(`deploy ${id} paid 2`, releaseTar(), offline)
      expect(again.status, again.stderr).toBe(0)
      expect(again.stderr).toContain('could not fetch main')
      const newer = commitRuntime('newer')
      const refused = receive(`deploy ${id} paid 3`, releaseTar(manifest('paid', newer)), offline)
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain('not deploying with an unverified runtime')
      expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2)
    })

    it('picks up a later commit on main without anyone touching the server', () => {
      expect(receive(`deploy ${id} paid 1`).status).toBe(0)
      const next = commitRuntime('next')
      const later = `aip-${'f'.repeat(12)}-${'b'.repeat(12)}`
      expect(receive(`deploy ${later} paid 2`, releaseTar(manifest('paid', next))).status).toBe(0)
      expect(readFileSync(log, 'utf8')).toContain(
        `paid ${releases}/${later} actor=github-actions/run-2 runtime=next`,
      )
      expect(readlinkSync(join(runtimes(), 'current-paid'))).toBe(join(runtimes(), next))
    })

    it('keeps the five most recent runtimes besides the one in use', () => {
      for (let n = 0; n < 8; n++) {
        const commit = commitRuntime(`r${n}`)
        const release = `aip-${n.toString(16).repeat(12)}-${'b'.repeat(12)}`
        expect(
          receive(`deploy ${release} paid ${n + 10}`, releaseTar(manifest('paid', commit))).status,
        ).toBe(0)
      }
      const kept = readdirSync(runtimes()).filter((name) => /^[0-9a-f]{40}$/.test(name))
      expect(kept.length).toBeLessThanOrEqual(6)
      expect(kept).toContain(git(origin, 'rev-parse', 'HEAD'))
    })
  })

  it('warns when the fixed test runtime lags behind the release it deploys', () => {
    writeFileSync(join(home, 'deploy-runtime', '.commit'), `${'0'.repeat(40)}\n`)
    const result = receive(`deploy ${id} test 1`, releaseTar(manifest('test')), {}, 'test')
    expect(result.status).toBe(0)
    expect(result.stderr).toContain(`is at ${'0'.repeat(40)}, this release is ${mainCommit}`)
    expect(readFileSync(log, 'utf8')).toBe(`test ${releases}/${id} actor=github-actions/run-1\n`)
  })
})
