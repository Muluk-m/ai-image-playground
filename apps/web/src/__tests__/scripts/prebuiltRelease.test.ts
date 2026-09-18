import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const source = resolve(__dirname, '../../../../..')
const sha = 'a'.repeat(40)
const imageId = `sha256:${'b'.repeat(64)}`
let root: string
let release: string
let log: string
let env: NodeJS.ProcessEnv
const repo = 'ghcr.io/muluk-m/ai-image-playground'
const digest = (d: string) => `${repo}@sha256:${d.repeat(64)}`
const short = sha.slice(0, 12)
const registryManifest = [
  `internal\tai-image-playground:vps-main-${short}\t${imageId}\t${sha}\t${sha}\t${digest('1')}`,
  `paid\tai-image-playground:paid-${short}-${short}\t${imageId}\t${sha}\t${sha}\t${digest('2')}`,
  `backup\tai-image-playground:backup-${short}\t${imageId}\t${sha}\t-\t${digest('3')}`,
]
/** Every file in the release except SHA256SUMS itself, as the builder lists them. */
function releaseFiles(dir = ''): string[] {
  return readdirSync(join(release, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? releaseFiles(join(dir, e.name)) : [join(dir, e.name)]))
    .filter((f) => f !== 'SHA256SUMS')
    .sort()
}
/** Turns the fixture into a registry release: digests in the manifest and no image archive. */
function registryRelease() {
  rmSync(join(release, 'images.tar.gz'))
  writeFileSync(join(release, 'images.tsv'), `${registryManifest.join('\n')}\n`)
  checksums()
}
function checksums() {
  writeFileSync(
    join(release, 'SHA256SUMS'),
    releaseFiles()
      .map(
        (f) =>
          `${createHash('sha256')
            .update(readFileSync(join(release, f)))
            .digest('hex')}  ${f}`,
      )
      .join('\n') + '\n',
  )
}
function run() {
  return spawnSync('sh', [join(release, 'scripts/vps-deploy.sh'), 'all', release], {
    env,
    encoding: 'utf8',
    timeout: 10000,
  })
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-receiver-'))
  release = join(root, 'release')
  log = join(root, 'calls')
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(release, 'scripts/lib'), { recursive: true })
  mkdirSync(join(release, 'deploy'), { recursive: true })
  cpSync(join(source, 'scripts/vps-deploy.sh'), join(release, 'scripts/vps-deploy.sh'))
  cpSync(
    join(source, 'scripts/lib/deploy-common.sh'),
    join(release, 'scripts/lib/deploy-common.sh'),
  )
  writeFileSync(
    join(release, 'scripts/app-compose.sh'),
    '#!/bin/sh\nprintf "rollout %s %s\\n" "$2" "$APP_IMAGE" >> "$CALL_LOG"\n',
  )
  chmodSync(join(release, 'scripts/app-compose.sh'), 0o755)
  cpSync(join(source, 'scripts/rollout-runtime.sh'), join(release, 'scripts/rollout-runtime.sh'))
  writeFileSync(join(release, 'deploy/compose.app.yaml'), 'services: {}\n')
  writeFileSync(join(release, 'images.tar.gz'), 'fake image archive')
  writeFileSync(
    join(release, 'images.tsv'),
    `internal\tai-image-playground:vps-main-${sha.slice(0, 12)}\t${imageId}\t${sha}\t${sha}\npaid\tai-image-playground:paid-${sha.slice(0, 12)}-${sha.slice(0, 12)}\t${imageId}\t${sha}\t${sha}\nbackup\tai-image-playground:backup-${sha.slice(0, 12)}\t${imageId}\t${sha}\t-\n`,
  )
  const docker = `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  'info --format') printf '/\\n' ;;
  'login ghcr.io')
    if [ "$3" = -u ]; then
      cat > "$TEST_ROOT/login-stdin"
      echo 'Login Succeeded'
      exit 0
    fi
    [ -f "$TEST_ROOT/logged-in" ] ;;
  pull*) exit "\${TEST_PULL_EXIT:-0}" ;;
  'image inspect')
    case "$5" in
      '{{.Id}}') echo "\${TEST_IMAGE_ID:-${imageId}}" ;;
      '{{.Os}}/{{.Architecture}}') echo "\${TEST_PLATFORM:-linux/amd64}" ;;
      *) case "$3" in *:paid-*) echo 'APP_VERSION=${sha}+${sha}' ;; *) echo 'APP_VERSION=${sha}' ;; esac ;;
    esac ;;
  'run --rm') exit "\${TEST_NATIVE_EXIT:-0}" ;;
  'load -i') exit "\${TEST_LOAD_EXIT:-0}" ;;
  'ps --format'|'images --format'|'tag '*) ;;
  *) exit 91 ;;
esac
`
  writeFileSync(join(root, 'bin/docker'), docker)
  chmodSync(join(root, 'bin/docker'), 0o755)
  // Receiver uses Linux sha256sum; the shim keeps this script test portable on macOS.
  writeFileSync(join(root, 'bin/sha256sum'), '#!/bin/sh\nshift\nexec shasum -a 256 "$@"\n')
  chmodSync(join(root, 'bin/sha256sum'), 0o755)
  mkdirSync(join(root, 'config/ai-image-playground'), { recursive: true })
  writeFileSync(join(root, 'config/ai-image-playground/deploy.env'), 'DEPLOY_MIN_FREE_GB=0\n')
  env = {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    XDG_CONFIG_HOME: join(root, 'config'),
    CALL_LOG: log,
    TEST_ROOT: root,
  }
  checksums()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
describe('prebuilt VPS receiver', () => {
  it('loads and verifies all images before rolling services, without compiling or fetching source', () => {
    const result = run()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const calls = readFileSync(log, 'utf8')
    expect(calls.indexOf('paid-', calls.indexOf('image inspect'))).toBeLessThan(
      calls.indexOf('rollout'),
    )
    expect(calls.indexOf('--entrypoint pg_dump')).toBeLessThan(calls.indexOf('rollout'))
    expect(calls).toContain('rollout image-playground-paid')
    expect(calls).not.toMatch(/build|pull/)
  })
  it('rejects a release without a prebuilt backup image', () => {
    writeFileSync(
      join(release, 'images.tsv'),
      readFileSync(join(release, 'images.tsv'), 'utf8').replace(/^backup.*\n/m, ''),
    )
    checksums()
    expect(run().status).not.toBe(0)
    expect(() => readFileSync(log)).toThrow()
  })
  it('rejects a corrupted archive before loading or changing services', () => {
    writeFileSync(join(release, 'images.tar.gz'), 'corrupt')
    expect(run().status).not.toBe(0)
    expect(() => readFileSync(log)).toThrow()
  })
  it('does not roll any service if the loaded platform is wrong', () => {
    env.TEST_PLATFORM = 'linux/arm64'
    expect(run().status).not.toBe(0)
    expect(readFileSync(log, 'utf8')).not.toContain('rollout')
  })
  it('does not roll services after docker load fails', () => {
    env.TEST_LOAD_EXIT = '1'
    expect(run().status).not.toBe(0)
    expect(readFileSync(log, 'utf8')).not.toContain('rollout')
  })
  it('does not roll services when target native dependencies fail', () => {
    env.TEST_NATIVE_EXIT = '1'
    expect(run().status).not.toBe(0)
    expect(readFileSync(log, 'utf8')).not.toContain('rollout')
  })
  it('refuses a concurrent rollout before loading the archive', () => {
    const lock = join(root, 'config/ai-image-playground/deploy.lock')
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner'), `pid=${process.pid}\ntoken=-\n`)
    expect(run().status).not.toBe(0)
    expect(() => readFileSync(log)).toThrow()
  })

  it('refuses an image archive that the checksums do not cover', () => {
    registryRelease()
    writeFileSync(join(release, 'images.tar.gz'), 'smuggled archive')
    expect(run().status).not.toBe(0)
    expect(() => readFileSync(log)).toThrow()
  })
})

describe('registry release receiver', () => {
  const deployLog = () =>
    readFileSync(join(root, 'config/ai-image-playground/deployments.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.replace(/^\S+ /, ''))
  it('records the CI run as the deployer when DEPLOY_ACTOR is set', () => {
    registryRelease()
    writeFileSync(join(root, 'logged-in'), '')
    env.DEPLOY_ACTOR = 'github-actions/run-12345'
    expect(run().status).toBe(0)
    expect(deployLog()).toEqual([
      `internal public=${sha} private=${sha} image=ai-image-playground:vps-main-${short} by=github-actions/run-12345 result=ok`,
      `paid public=${sha} private=${sha} image=ai-image-playground:paid-${short}-${short} by=github-actions/run-12345 result=ok`,
    ])
  })
  it('keeps the by= field a single word whatever DEPLOY_ACTOR holds', () => {
    registryRelease()
    writeFileSync(join(root, 'logged-in'), '')
    env.DEPLOY_ACTOR = 'github actions run 1'
    expect(run().status).toBe(0)
    expect(deployLog()[0]).toContain(' by=github-actions-run-1 result=ok')
  })
  const pulled = (d: string) => `pull ${digest(d)}`
  it('pulls every image by digest, tags it locally and verifies it before rolling services', () => {
    registryRelease()
    writeFileSync(join(root, 'logged-in'), '')
    const result = run()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const calls = readFileSync(log, 'utf8').split('\n')
    for (const [d, image] of [
      ['1', `ai-image-playground:vps-main-${short}`],
      ['2', `ai-image-playground:paid-${short}-${short}`],
      ['3', `ai-image-playground:backup-${short}`],
    ]) {
      expect(calls).toContain(pulled(d))
      expect(calls.indexOf(`tag ${digest(d)} ${image}`)).toBeGreaterThan(calls.indexOf(pulled(d)))
      expect(calls.indexOf(`tag ${digest(d)} ${image}`)).toBeLessThan(
        calls.indexOf(`image inspect ${image} --format {{.Id}}`),
      )
    }
    const rollout = calls.findIndex((c) => c.startsWith('rollout'))
    expect(calls.findIndex((c) => c.includes('--entrypoint pg_dump'))).toBeLessThan(rollout)
    expect(calls.some((c) => c.startsWith('load'))).toBe(false)
    expect(calls).not.toContain('login ghcr.io -u Muluk-m --password-stdin')
    expect(calls).toContain(
      'rollout image-playground-paid ai-image-playground:paid-aaaaaaaaaaaa-aaaaaaaaaaaa',
    )
  })
  it('logs in with the pull token file through stdin when not logged in yet', () => {
    registryRelease()
    const token = 'ghp_pull_token_value'
    writeFileSync(join(root, 'config/ai-image-playground/ghcr-pull-token'), `${token}\n`, {
      mode: 0o600,
    })
    const result = run()
    expect(result.status).toBe(0)
    const calls = readFileSync(log, 'utf8').split('\n')
    expect(calls.indexOf('login ghcr.io -u Muluk-m --password-stdin')).toBeLessThan(
      calls.indexOf(pulled('1')),
    )
    expect(readFileSync(join(root, 'login-stdin'), 'utf8')).toBe(`${token}\n`)
    expect(`${result.stdout}${result.stderr}${calls.join('\n')}`).not.toContain(token)
  })
  it('stops before pulling when not logged in and there is no pull token', () => {
    registryRelease()
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ghcr-pull-token')
    expect(readFileSync(log, 'utf8')).not.toMatch(/pull|rollout/)
  })
  it('does not roll services when a pull fails', () => {
    registryRelease()
    writeFileSync(join(root, 'logged-in'), '')
    env.TEST_PULL_EXIT = '1'
    expect(run().status).not.toBe(0)
    expect(readFileSync(log, 'utf8')).not.toContain('rollout')
  })
  it('does not roll services when the pulled image is not the one that was built', () => {
    registryRelease()
    writeFileSync(join(root, 'logged-in'), '')
    env.TEST_IMAGE_ID = `sha256:${'c'.repeat(64)}`
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Image ID mismatch')
    expect(readFileSync(log, 'utf8')).not.toContain('rollout')
  })
  it('rejects a release with neither an image archive nor digests', () => {
    rmSync(join(release, 'images.tar.gz'))
    checksums()
    writeFileSync(join(root, 'logged-in'), '')
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('neither an image archive nor registry digests')
    expect(readFileSync(log, 'utf8')).not.toMatch(/pull|rollout/)
  })
  it('rejects a digest from another registry repository', () => {
    registryRelease()
    writeFileSync(
      join(release, 'images.tsv'),
      `${registryManifest.join('\n').replace(`${repo}@`, 'ghcr.io/someone-else/app@')}\n`,
    )
    checksums()
    writeFileSync(join(root, 'logged-in'), '')
    const result = run()
    expect(result.stderr).toContain('Invalid image manifest')
    expect(result.status).not.toBe(0)
    expect(() => readFileSync(log)).toThrow()
  })
  it('loads the archive, and pulls nothing, when an archive release also carries digests', () => {
    writeFileSync(join(release, 'images.tsv'), `${registryManifest.join('\n')}\n`)
    checksums()
    const result = run()
    expect(result.status).toBe(0)
    const calls = readFileSync(log, 'utf8')
    expect(calls).toContain(`load -i ${release}/images.tar.gz`)
    expect(calls).not.toMatch(/pull|login/)
  })
})
