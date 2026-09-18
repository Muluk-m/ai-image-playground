import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
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
const files = [
  'images.tar.gz',
  'images.tsv',
  'scripts/vps-deploy.sh',
  'scripts/app-compose.sh',
  'scripts/lib/deploy-common.sh',
  'deploy/compose.app.yaml',
]
function checksums() {
  writeFileSync(
    join(release, 'SHA256SUMS'),
    files
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
  writeFileSync(join(release, 'deploy/compose.app.yaml'), 'services: {}\n')
  writeFileSync(join(release, 'images.tar.gz'), 'fake image archive')
  writeFileSync(
    join(release, 'images.tsv'),
    `internal\tai-image-playground:vps-main-${sha.slice(0, 12)}\t${imageId}\t${sha}\t${sha}\npaid\tai-image-playground:paid-${sha.slice(0, 12)}-${sha.slice(0, 12)}\t${imageId}\t${sha}\t${sha}\n`,
  )
  const docker = `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  'info --format') printf '/\\n' ;;
  'image inspect')
    case "$5" in
      '{{.Id}}') echo '${imageId}' ;;
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
  }
  checksums()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
describe('prebuilt VPS receiver', () => {
  it('loads and verifies both images before rolling services, without compiling or fetching source', () => {
    const result = run()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const calls = readFileSync(log, 'utf8')
    expect(calls.indexOf('paid-', calls.indexOf('image inspect'))).toBeLessThan(
      calls.indexOf('rollout'),
    )
    expect(calls).toContain('rollout image-playground-paid')
    expect(calls).not.toMatch(/build|pull/)
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
})
