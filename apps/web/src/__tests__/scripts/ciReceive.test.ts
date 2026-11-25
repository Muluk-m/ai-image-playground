import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
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

/** GitHub Actions uploads data only; deployment code comes from main in ~/deploy-runtimes. */
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
  mkdirSync(join(origin, 'scripts', 'lib'), { recursive: true })
  for (const helper of ['rollout-runtime.sh', 'app-compose.sh', 'lib/deploy-common.sh'])
    writeFileSync(join(origin, 'scripts', helper), `# ${label}\n`)
  writeFileSync(
    deploy,
    `#!/bin/sh\neval "\${TEST_DEPLOY_HOOK:-:}"\nprintf "%s actor=%s runtime=${label}\\n" "$*" "$DEPLOY_ACTOR" >> "$CALL_LOG"\nexit "\${TEST_DEPLOY_EXIT:-0}"\n`,
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
  origin = join(root, 'origin')
  mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'main')
  // Like GitHub: honour --filter=blob:none, so file contents are fetched lazily at unpack time.
  git(origin, 'config', 'uploadpack.allowFilter', 'true')
  git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
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
    AIP_RUNTIME_GIT_URL: `file://${origin}`,
    CALL_LOG: log,
    ...extra,
  }
  if (command === undefined) delete env.SSH_ORIGINAL_COMMAND
  else env.SSH_ORIGINAL_COMMAND = command
  return spawnSync('sh', [script, scope], { env, input, encoding: 'utf8', timeout: 20000 })
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

/**
 * The receiver serialises deploys with flock(1), which only Linux hosts have (the VPS and CI).
 * Without it the lock tests cannot mean anything, so the suite is skipped there instead of failing.
 */
const hasFlock = spawnSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).status === 0

describe.skipIf(!hasFlock)('ci-receive.sh', { timeout: 20_000 }, () => {
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
    const busy = receive(
      `deploy ${id} test 7`,
      releaseTar(manifest('test')),
      { TEST_DEPLOY_EXIT: '75' },
      'test',
    )
    expect(busy.status).toBe(75)
    expect(busy.stderr).toContain('Deploy lock busy')
    expect(readdirSync(releases)).toEqual([])
    expect(receive(`deploy ${id} test 7`, releaseTar(manifest('test')), {}, 'test').status).toBe(0)
    expect(readdirSync(releases)).toEqual([id])
  })

  it('cleans up incomplete data before invoking the runtime', () => {
    const dir = join(root, 'incomplete')
    mkdirSync(dir)
    writeFileSync(join(dir, 'images.tsv'), 'manifest\n')
    const result = receive(`deploy ${id} paid 8`, tarOf(['-C', dir, '.']))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Incomplete release')
    expect(existsSync(join(releases, id))).toBe(false)
    expect(existsSync(log)).toBe(false)
  })

  it('cleans up the data package when test cannot prepare a verified runtime', () => {
    const result = receive(
      `deploy ${id} test 8`,
      releaseTar(manifest('test')),
      { AIP_RUNTIME_GIT_URL: `file://${join(root, 'unreachable')}` },
      'test',
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('not deploying with an unverified runtime')
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
    expect(receive(`deploy ${id} test 1`, releaseTar(manifest('test')), {}, 'release').status).toBe(
      2,
    )
    expect(readdirSync(releases)).toEqual([])
    expect(existsSync(log)).toBe(false)
    expect(receive(`deploy ${id} test 1`, releaseTar(manifest('test')), {}, 'test').status).toBe(0)
    expect(readFileSync(log, 'utf8')).toBe(
      `test ${releases}/${id} actor=github-actions/run-1 runtime=main\n`,
    )
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

    it('refuses a manifest that names no commit instead of falling back to an unverified runtime', () => {
      const result = receive(`deploy ${id} paid 1`, releaseTar('manifest\n'))
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('names no public commit')
      expect(existsSync(log)).toBe(false)
      expect(readdirSync(releases)).toEqual([])
    })

    it('redeploys a commit it verified before when the repository cannot be reached, never a new one', () => {
      expect(receive(`deploy ${id} paid 1`).status).toBe(0)
      const offline = { AIP_RUNTIME_GIT_URL: `file://${join(root, 'unreachable')}` }
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
      expect(kept).toHaveLength(6)
      expect(kept).toContain(git(origin, 'rev-parse', 'HEAD'))
      expect(existsSync(join(runtimes(), '.mirror.git'))).toBe(true)
      expect(readlinkSync(join(runtimes(), 'current-paid'))).toBe(
        join(runtimes(), git(origin, 'rev-parse', 'HEAD')),
      )
    })
  })

  describe('the installed receiver keeps itself current from main', () => {
    const installed = () => join(home, 'bin', 'aip-ci-receive')
    /** The receiver as installed on the host, run through its fixed path like the forced command. */
    function receiveInstalled(target = 'test') {
      mkdirSync(join(home, 'bin'), { recursive: true })
      if (!existsSync(installed())) {
        copyFileSync(script, installed())
        chmodSync(installed(), 0o755)
      }
      return spawnSync('sh', [installed(), target === 'paid' ? 'release' : 'test'], {
        env: {
          ...process.env,
          HOME: home,
          AIP_RUNTIME_GIT_URL: `file://${origin}`,
          CALL_LOG: log,
          SSH_ORIGINAL_COMMAND: `deploy ${id} ${target} 1`,
        },
        input: releaseTar(manifest(target, mainCommit)),
        encoding: 'utf8',
        timeout: 20000,
      })
    }
    function commitReceiver(content: string) {
      writeFileSync(join(origin, 'scripts', 'ci-receive.sh'), content)
      git(origin, 'add', '-A')
      git(origin, 'commit', '-q', '-m', 'receiver')
      mainCommit = git(origin, 'rev-parse', 'HEAD')
    }

    it("installs main's receiver after the deploy, keeping the previous one", () => {
      commitReceiver('#!/bin/sh\n# receiver from main\nexit 0\n')
      const result = receiveInstalled()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).toContain('Receiver updated from main')
      expect(readFileSync(installed(), 'utf8')).toBe('#!/bin/sh\n# receiver from main\nexit 0\n')
      const backups = readdirSync(join(home, 'bin')).filter((name) => name.includes('.bak-'))
      expect(backups).toHaveLength(1)
      expect(readFileSync(join(home, 'bin', backups[0] ?? ''), 'utf8')).toBe(
        readFileSync(script, 'utf8'),
      )
    })

    it("keeps the installed receiver when main's does not parse", () => {
      commitReceiver('#!/bin/sh\nif then fi (\n')
      const result = receiveInstalled()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).toContain('fails a syntax check')
      expect(readFileSync(installed(), 'utf8')).toBe(readFileSync(script, 'utf8'))
    })

    it('never rewrites a receiver run from anywhere but the installed path', () => {
      commitReceiver('#!/bin/sh\nexit 0\n')
      const result = receive(
        `deploy ${id} test 1`,
        releaseTar(manifest('test', mainCommit)),
        {},
        'test',
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).not.toContain('Receiver updated')
    })
  })

  describe('test runs main deployment runtime without a hand-maintained copy', () => {
    const runtimes = () => join(home, 'deploy-runtimes')

    it('follows main automatically and never executes unmerged scripts from the test branch', () => {
      const nextMain = commitRuntime('main-v2')
      // Deploy sideCommit (whose own scripts would log runtime=side) to test: must run main-v2.
      const result = receive(
        `deploy ${id} test 1`,
        releaseTar(manifest('test', sideCommit)),
        {},
        'test',
      )
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(log, 'utf8')).toBe(
        `test ${releases}/${id} actor=github-actions/run-1 runtime=main-v2\n`,
      )
      expect(readlinkSync(join(runtimes(), 'current-test'))).toBe(join(runtimes(), nextMain))
      expect(existsSync(join(runtimes(), sideCommit))).toBe(false)
      expect(result.stderr).toContain(
        `deploy/ or scripts/ changes in ${sideCommit} do not apply until merged to main`,
      )
    })

    it('stays quiet when a test branch commit only changes application files', () => {
      git(origin, 'checkout', '-q', '-b', 'test', mainCommit)
      mkdirSync(join(origin, 'apps/web'), { recursive: true })
      writeFileSync(join(origin, 'apps/web/index.ts'), 'export const x = 1\n')
      git(origin, 'add', 'apps/web/index.ts')
      git(origin, 'commit', '-q', '-m', 'app change only')
      const appOnlyCommit = git(origin, 'rev-parse', 'HEAD')
      git(origin, 'checkout', '-q', 'main')

      const result = receive(
        `deploy ${id} test 1`,
        releaseTar(manifest('test', appOnlyCommit)),
        {},
        'test',
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).not.toContain('Warning:')
      expect(readFileSync(log, 'utf8')).toBe(
        `test ${releases}/${id} actor=github-actions/run-1 runtime=main\n`,
      )
    })

    it('falls back to a previously verified main runtime when the repository cannot be reached', () => {
      expect(receive(`deploy ${id} paid 1`).status).toBe(0)
      const later = `aip-${'f'.repeat(12)}-${'b'.repeat(12)}`
      const offline = { AIP_RUNTIME_GIT_URL: `file://${join(root, 'unreachable')}` }
      const result = receive(
        `deploy ${later} test 2`,
        releaseTar(manifest('test', sideCommit)),
        offline,
        'test',
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).toContain(`could not fetch main`)
      expect(result.stderr).toContain(`using runtime ${mainCommit} verified on`)
      expect(readFileSync(log, 'utf8')).toContain(
        `test ${releases}/${later} actor=github-actions/run-2 runtime=main`,
      )
    })

    it('preserves both current-paid and current-test across runtime pruning', () => {
      expect(receive(`deploy ${id} paid 1`).status).toBe(0)
      for (let n = 0; n < 8; n++) {
        const mCommit = commitRuntime(`m${n}`)
        const release = `aip-${n.toString(16).repeat(12)}-${'c'.repeat(12)}`
        expect(
          receive(
            `deploy ${release} test ${n + 10}`,
            releaseTar(manifest('test', mCommit)),
            {},
            'test',
          ).status,
        ).toBe(0)
      }
      const head = git(origin, 'rev-parse', 'HEAD')
      expect(readlinkSync(join(runtimes(), 'current-paid'))).toBe(join(runtimes(), mainCommit))
      expect(readlinkSync(join(runtimes(), 'current-test'))).toBe(join(runtimes(), head))
      expect(existsSync(join(runtimes(), mainCommit, 'scripts', 'vps-deploy.sh'))).toBe(true)
      expect(existsSync(join(runtimes(), head, 'scripts', 'vps-deploy.sh'))).toBe(true)
    })
  })

  describe('runtime safeguards', () => {
    const runtimes = () => join(home, 'deploy-runtimes')

    it('fetches commits only, so file contents come from the repository at unpack time', () => {
      expect(receive(`deploy ${id} paid 1`).status).toBe(0)
      expect(git(join(runtimes(), '.mirror.git'), 'config', 'remote.origin.promisor')).toBe('true')
    })

    it('moves current-paid only after a successful deploy', () => {
      expect(receive(`deploy ${id} paid 1`).status).toBe(0)
      const next = commitRuntime('next')
      const later = `aip-${'f'.repeat(12)}-${'b'.repeat(12)}`
      const failed = receive(`deploy ${later} paid 2`, releaseTar(manifest('paid', next)), {
        TEST_DEPLOY_EXIT: '1',
      })
      expect(failed.status).toBe(1)
      expect(readlinkSync(join(runtimes(), 'current-paid'))).toBe(join(runtimes(), mainCommit))
    })

    it('never prunes the runtime in production, however many deploys fail after it', () => {
      expect(receive(`deploy ${id} paid 1`).status).toBe(0)
      for (let n = 0; n < 7; n++) {
        const commit = commitRuntime(`failing${n}`)
        const release = `aip-${n.toString(16).repeat(12)}-${'b'.repeat(12)}`
        const failed = receive(
          `deploy ${release} paid ${n + 10}`,
          releaseTar(manifest('paid', commit)),
          {
            TEST_DEPLOY_EXIT: '1',
          },
        )
        expect(failed.status).toBe(1)
      }
      expect(readlinkSync(join(runtimes(), 'current-paid'))).toBe(join(runtimes(), mainCommit))
      expect(existsSync(join(runtimes(), mainCommit, 'scripts', 'vps-deploy.sh'))).toBe(true)
    })

    it('refuses a commit whose runtime lacks a file it needs, leaving nothing behind', () => {
      git(origin, 'rm', '-q', 'scripts/rollout-runtime.sh')
      git(origin, 'commit', '-q', '-m', 'broken')
      const broken = git(origin, 'rev-parse', 'HEAD')
      const result = receive(`deploy ${id} paid 1`, releaseTar(manifest('paid', broken)))
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('lacks scripts/rollout-runtime.sh')
      expect(existsSync(log)).toBe(false)
      expect(readdirSync(releases)).toEqual([])
      expect(readdirSync(runtimes()).filter((name) => !name.startsWith('.'))).toEqual([])
    })

    it('answers busy (75) and keeps nothing while another receiver holds the runtimes lock', async () => {
      mkdirSync(runtimes(), { recursive: true })
      const lock = join(runtimes(), '.lock')
      const holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' })
      try {
        // Wait until the holder has the lock.
        for (let tries = 0; tries < 50; tries++) {
          if (spawnSync('flock', ['-n', lock, 'true']).status !== 0) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const busy = receive(`deploy ${id} paid 1`)
        expect(busy.status).toBe(75)
        expect(busy.stderr).toContain('Deploy lock busy')
        expect(readdirSync(releases)).toEqual([])
        expect(existsSync(log)).toBe(false)
      } finally {
        holder.kill()
      }
    })

    it('reports the holding receiver target on lock contention so ci-ship-release can wait across environments', async () => {
      const marker = join(root, 'inside-deploy')
      const paidHolder = spawn('sh', [script, 'release'], {
        detached: true,
        env: {
          ...process.env,
          HOME: home,
          AIP_RUNTIME_GIT_URL: `file://${origin}`,
          CALL_LOG: log,
          MARKER: marker,
          SSH_ORIGINAL_COMMAND: `deploy ${id} paid 1`,
          TEST_DEPLOY_HOOK: 'touch "$MARKER" && exec sleep 30',
        },
        stdio: ['pipe', 'ignore', 'pipe'],
      })
      paidHolder.stdin.end(releaseTar())
      try {
        for (let tries = 0; tries < 100 && !existsSync(marker); tries++) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        expect(existsSync(marker)).toBe(true)
        const otherId = `aip-${'f'.repeat(12)}-${'b'.repeat(12)}`
        const busy = receive(`deploy ${otherId} test 2`, releaseTar(manifest('test')), {}, 'test')
        expect(busy.status).toBe(75)
        expect(busy.stderr).toMatch(/^ {2}what=receive paid /m)
        expect(existsSync(join(releases, otherId))).toBe(false)
      } finally {
        if (paidHolder.pid) {
          try {
            process.kill(-paidHolder.pid, 'SIGKILL')
          } catch {
            paidHolder.kill('SIGKILL')
          }
        }
      }
    })

    it('heals a mirror that was created without its remote', () => {
      mkdirSync(runtimes(), { recursive: true })
      git(runtimes(), 'init', '-q', '--bare', '.mirror.git')
      expect(receive(`deploy ${id} paid 1`).status).toBe(0)
    })

    it('ignores the test overrides when called over SSH', () => {
      const result = receive(`deploy ${id} paid 1`, releaseTar(), {
        SSH_CONNECTION: '203.0.113.1 50000 198.51.100.1 22',
        AIP_DEPLOY_RUNTIMES_ROOT: join(root, 'elsewhere'),
        // No network in tests: git refuses https outright, so the fixed URL fails to fetch.
        GIT_ALLOW_PROTOCOL: 'file',
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('github.com/Muluk-m/ai-image-playground')
      expect(existsSync(join(root, 'elsewhere'))).toBe(false)
      expect(existsSync(log)).toBe(false)
    })

    it("updates the installed receiver only from main's tip, never on a rollback to an older commit", () => {
      const bin = join(home, 'bin')
      const installed = join(bin, 'aip-ci-receive')
      mkdirSync(bin, { recursive: true })
      copyFileSync(script, installed)
      chmodSync(installed, 0o755)
      const run = (release: string, commit: string, runId: number) =>
        spawnSync('sh', [installed, 'release'], {
          env: {
            ...process.env,
            HOME: home,
            AIP_RUNTIME_GIT_URL: `file://${origin}`,
            CALL_LOG: log,
            SSH_ORIGINAL_COMMAND: `deploy ${release} paid ${runId}`,
          },
          input: releaseTar(manifest('paid', commit)),
          encoding: 'utf8',
          timeout: 20000,
        })

      copyFileSync(script, join(origin, 'scripts', 'ci-receive.sh'))
      git(origin, 'add', 'scripts/ci-receive.sh')
      git(origin, 'commit', '-q', '-m', 'matching receiver')
      const matching = git(origin, 'rev-parse', 'HEAD')
      const ok = run(id, matching, 1)
      expect(ok.status, ok.stderr).toBe(0)
      expect(ok.stderr).not.toContain('Receiver updated')

      const newer = `${readFileSync(script, 'utf8')}\n# newer receiver on main\n`
      writeFileSync(join(origin, 'scripts', 'ci-receive.sh'), newer)
      git(origin, 'add', 'scripts/ci-receive.sh')
      git(origin, 'commit', '-q', '-m', 'updated receiver')
      const updated = git(origin, 'rev-parse', 'HEAD')

      // Rolling back to the older commit while main is ahead: that runtime is not main's tip.
      const rollback = run(`aip-${'e'.repeat(12)}-${'b'.repeat(12)}`, matching, 2)
      expect(rollback.status, rollback.stderr).toBe(0)
      expect(rollback.stderr).not.toContain('Receiver updated')
      expect(readFileSync(installed, 'utf8')).toBe(readFileSync(script, 'utf8'))

      const current = run(`aip-${'f'.repeat(12)}-${'b'.repeat(12)}`, updated, 3)
      expect(current.status, current.stderr).toBe(0)
      expect(current.stderr).toContain(`Receiver updated from main (${updated})`)
      expect(readFileSync(installed, 'utf8')).toBe(newer)
    })

    it('waits briefly for a live holder to publish .lock.owner and ignores dead owner files', async () => {
      mkdirSync(runtimes(), { recursive: true })
      const lock = join(runtimes(), '.lock')
      const owner = join(runtimes(), '.lock.owner')
      const foreignTmp = join(runtimes(), '.lock.owner.tmp.424242')
      writeFileSync(owner, 'pid=999999\ntoken=-\nwhat=receive paid /stale\n')
      writeFileSync(foreignTmp, 'in-flight owner staging of another pid\n')

      // External holder delays writing its live .lock.owner for 120ms after taking flock.
      const delayedHolder = spawn(
        'flock',
        [
          lock,
          'sh',
          '-c',
          `sleep 0.12 && printf 'pid=%s\\ntoken=-\\nwhat=receive paid /delayed\\n' "$$" > "${owner}" && exec sleep 30`,
        ],
        { detached: true, stdio: 'ignore' },
      )
      try {
        for (let tries = 0; tries < 50; tries++) {
          if (spawnSync('flock', ['-n', lock, 'true']).status !== 0) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        const otherId = `aip-${'d'.repeat(12)}-${'b'.repeat(12)}`
        const busy = receive(`deploy ${otherId} test 2`, releaseTar(manifest('test')), {}, 'test')
        expect(busy.status).toBe(75)
        expect(busy.stderr).not.toContain('/stale')
        expect(busy.stderr).toMatch(/^ {2}what=receive paid \/delayed$/m)
        expect(existsSync(foreignTmp)).toBe(true)
      } finally {
        if (delayedHolder.pid) {
          try {
            process.kill(-delayedHolder.pid, 'SIGKILL')
          } catch {
            delayedHolder.kill('SIGKILL')
          }
        }
      }
    })

    it('caps runtime and drift fetches with timeout so a stalled remote never blocks deployment', () => {
      const binDir = join(root, 'bin')
      const timeoutLog = join(root, 'timeout-calls')
      mkdirSync(binDir, { recursive: true })
      writeFileSync(
        join(binDir, 'timeout'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${timeoutLog}"\n[ "$1" = -k ] && shift 2\nif [ "$1" = 10 ]; then exit 124; fi\nshift\nexec "$@"\n`,
      )
      chmodSync(join(binDir, 'timeout'), 0o755)

      const result = receive(
        `deploy ${id} test 1`,
        releaseTar(manifest('test', sideCommit)),
        { PATH: `${binDir}:${process.env.PATH}` },
        'test',
      )
      expect(result.status, result.stderr).toBe(0)
      const recorded = readFileSync(timeoutLog, 'utf8')
      expect(recorded).toMatch(/^-k 5 60 env .* fetch .* \+refs\/heads\/main:refs\/heads\/main$/m)
      expect(recorded).toMatch(/^-k 5 60 env .* archive /m)
      expect(recorded).toMatch(/^-k 5 10 env .* fetch .* /m)
      expect(result.stderr).toContain(`could not inspect ${sideCommit}`)
      expect(readFileSync(log, 'utf8')).toBe(
        `test ${releases}/${id} actor=github-actions/run-1 runtime=main\n`,
      )
    })
  })
})
