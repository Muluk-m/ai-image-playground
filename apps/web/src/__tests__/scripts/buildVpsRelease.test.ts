import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
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

/**
 * 发布镜像改走私有 GHCR：构建端逐个推送镜像并把仓库 digest 记进 images.tsv，发布目录只剩脚本、
 * 清单与校验单；RELEASE_TRANSPORT=archive 仍打 images.tar.gz 兜底。这里在临时 Git 仓库里跑真实的
 * build-vps-release.sh，docker 是假的，只看它发出的 docker 命令、写出的文件与退出码；
 * 最后把产物交给真实的 vps-deploy.sh，确认接收端读得懂。
 */
const source = resolve(__dirname, '../../../../..')
const repoName = 'ghcr.io/muluk-m/ai-image-playground'
const imageId = `sha256:${'b'.repeat(64)}`
const pushed = (d: string) => `${repoName}@sha256:${d.repeat(64)}`
let root: string
let checkout: string
let out: string
let log: string
let env: NodeJS.ProcessEnv
let pub: string
let priv: string

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1" in
  buildx)
    case "$2" in build) exit "\${TEST_BUILD_EXIT:-0}" ;; esac ;;
  inspect) echo '6442450944 6442450944 400000' ;;
  login)
    if [ "$3" = -u ]; then
      cat > "$TEST_ROOT/login-stdin"
      touch "$TEST_ROOT/logged-in"
      echo 'Login Succeeded'
      exit 0
    fi
    [ -f "$TEST_ROOT/logged-in" ] ;;
  push)
    [ -f "$TEST_ROOT/logged-in" ] || { echo 'denied: not logged in' >&2; exit 1; }
    [ "\${TEST_PUSH_EXIT:-0}" = 0 ] || { echo 'unexpected status 503' >&2; exit 1; }
    case "$2" in *:internal-*) d=1 ;; *:paid-*) d=2 ;; *) d=3 ;; esac
    echo "The push refers to repository [${repoName}]"
    echo '5f70bf18a086: Pushed'
    echo "\${2##*:}: digest: sha256:$(printf '%064d' 0 | tr 0 "$d") size: 1234" ;;
  save) printf 'image archive' > "$3" ;;
  image)
    case "$5" in
      '{{.Id}}') echo '${imageId}' ;;
      '{{.Os}}/{{.Architecture}}') echo linux/amd64 ;;
      *) case "$3" in *:paid-*) echo "APP_VERSION=$TEST_PUB+$TEST_PRIV" ;; *) echo "APP_VERSION=$TEST_PUB" ;; esac ;;
    esac ;;
  info) echo / ;;
  tag|rmi|pull|run|load|ps|images) ;;
  *) exit 91 ;;
esac
`

function git(dir: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-C', dir, ...args],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function write(path: string, content: string, mode = 0o644) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content)
  chmodSync(path, mode)
}

function build(target = 'all') {
  return spawnSync('sh', [join(checkout, 'scripts/build-vps-release.sh'), target, out], {
    env,
    encoding: 'utf8',
    timeout: 20000,
  })
}

function calls() {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
}

function outputFiles(dir = ''): string[] {
  return readdirSync(join(out, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? outputFiles(join(dir, e.name)) : [join(dir, e.name)]))
    .sort()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-build-'))
  checkout = join(root, 'checkout')
  out = join(root, 'out')
  log = join(root, 'calls')
  for (const f of [
    'scripts/build-vps-release.sh',
    'scripts/vps-deploy.sh',
    'scripts/lib/deploy-common.sh',
  ]) {
    mkdirSync(resolve(join(checkout, f), '..'), { recursive: true })
    cpSync(join(source, f), join(checkout, f))
  }
  // The receiver hands each edition to app-compose.sh; the stub only records the rollout.
  write(
    join(checkout, 'scripts/app-compose.sh'),
    '#!/bin/sh\nprintf "rollout %s %s\\n" "$2" "$APP_IMAGE" >> "$CALL_LOG"\n',
    0o755,
  )
  write(join(checkout, 'scripts/rollout-runtime.sh'), '#!/bin/sh\nexit 0\n', 0o755)
  write(join(checkout, 'deploy/compose.app.yaml'), 'services: {}\n')
  write(join(checkout, 'deploy/buildkitd.toml'), '[worker.oci]\nmax-parallelism = 1\n')
  write(join(checkout, 'deploy/backup/Dockerfile'), 'FROM scratch\n')
  git(checkout, 'init', '-q')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-qm', 'public')
  write(join(checkout, 'private/overlay.txt'), 'overlay\n')
  git(join(checkout, 'private'), 'init', '-q')
  git(join(checkout, 'private'), 'add', '.')
  git(join(checkout, 'private'), 'commit', '-qm', 'private')
  pub = git(checkout, 'rev-parse', 'HEAD')
  priv = git(join(checkout, 'private'), 'rev-parse', 'HEAD')
  write(join(root, 'bin/docker'), FAKE_DOCKER, 0o755)
  write(join(root, 'bin/uname'), '#!/bin/sh\necho "${TEST_UNAME:-Darwin}"\n', 0o755)
  // The receiver runs Linux sha256sum; the shim keeps the round trip portable on macOS.
  write(join(root, 'bin/sha256sum'), '#!/bin/sh\nshift\nexec shasum -a 256 "$@"\n', 0o755)
  write(join(root, 'config/ai-image-playground/deploy.env'), 'DEPLOY_MIN_FREE_GB=0\n')
  env = {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    XDG_CONFIG_HOME: join(root, 'config'),
    CALL_LOG: log,
    TEST_ROOT: root,
    TEST_PUB: pub,
    TEST_PRIV: priv,
  }
  delete env.GITHUB_ACTIONS
  delete env.RELEASE_TRANSPORT
  delete env.GHCR_PUSH_TOKEN_FILE
  delete env.GHCR_PULL_TOKEN_FILE
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('build-vps-release.sh, registry transport (default)', () => {
  it('pushes every image to GHCR and records its repository digest in images.tsv', () => {
    writeFileSync(join(root, 'logged-in'), '')
    const result = build()
    expect(result.stderr).not.toContain('denied')
    expect(result.status).toBe(0)
    const p = pub.slice(0, 12)
    const q = priv.slice(0, 12)
    const all = calls()
    for (const [local, remote] of [
      [`ai-image-playground:vps-main-${p}`, `${repoName}:internal-${p}`],
      [`ai-image-playground:paid-${p}-${q}`, `${repoName}:paid-${p}-${q}`],
      [`ai-image-playground:backup-${p}`, `${repoName}:backup-${p}`],
    ]) {
      const built = all.findIndex(
        (c) => c.startsWith('buildx build') && c.includes(`--tag ${local}`),
      )
      expect(built).toBeGreaterThanOrEqual(0)
      expect(all.indexOf(`tag ${local} ${remote}`)).toBeGreaterThan(built)
      expect(all.indexOf(`push ${remote}`)).toBeGreaterThan(all.indexOf(`tag ${local} ${remote}`))
    }
    expect(readFileSync(join(out, 'images.tsv'), 'utf8')).toBe(
      [
        `internal\tai-image-playground:vps-main-${p}\t${imageId}\t${pub}\t${priv}\t${pushed('1')}`,
        `paid\tai-image-playground:paid-${p}-${q}\t${imageId}\t${pub}\t${priv}\t${pushed('2')}`,
        `backup\tai-image-playground:backup-${p}\t${imageId}\t${pub}\t-\t${pushed('3')}`,
        '',
      ].join('\n'),
    )
    expect(all.some((c) => c.startsWith('save'))).toBe(false)
    expect(all).not.toContain('login ghcr.io -u Muluk-m --password-stdin')
    expect(outputFiles()).toEqual([
      'SHA256SUMS',
      'deploy/compose.app.yaml',
      'images.tsv',
      'scripts/app-compose.sh',
      'scripts/lib/deploy-common.sh',
      'scripts/rollout-runtime.sh',
      'scripts/vps-deploy.sh',
    ])
  })

  it('checksums every file in the release, images.tsv included', () => {
    writeFileSync(join(root, 'logged-in'), '')
    expect(build().status).toBe(0)
    const listed = readFileSync(join(out, 'SHA256SUMS'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.replace(/^[0-9a-f]{64} {2}/, ''))
    expect(listed).toEqual(outputFiles().filter((f) => f !== 'SHA256SUMS'))
    const check = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], {
      cwd: out,
      encoding: 'utf8',
    })
    expect(check.status).toBe(0)
  })

  it('produces a release the receiver pulls by digest and rolls out', () => {
    writeFileSync(join(root, 'logged-in'), '')
    expect(build().status).toBe(0)
    rmSync(log)
    const received = spawnSync('sh', [join(out, 'scripts/vps-deploy.sh'), 'all', out], {
      env,
      encoding: 'utf8',
      timeout: 20000,
    })
    expect(received.stderr).toBe('')
    expect(received.status).toBe(0)
    const all = calls()
    expect(all).toContain(`pull ${pushed('1')}`)
    expect(all).toContain(`pull ${pushed('2')}`)
    expect(all).toContain(`pull ${pushed('3')}`)
    expect(all).toContain(
      `rollout image-playground-paid ai-image-playground:paid-${pub.slice(0, 12)}-${priv.slice(0, 12)}`,
    )
  })

  it('logs in with the push token file through stdin before building when not logged in yet', () => {
    const token = 'ghp_push_token_value'
    write(join(root, 'config/ai-image-playground/ghcr-push-token'), `${token}\n`, 0o600)
    const result = build()
    expect(result.status).toBe(0)
    const all = calls()
    expect(all.indexOf('login ghcr.io -u Muluk-m --password-stdin')).toBeLessThan(
      all.findIndex((c) => c.startsWith('buildx build')),
    )
    expect(readFileSync(join(root, 'login-stdin'), 'utf8')).toBe(`${token}\n`)
    expect(`${result.stdout}${result.stderr}${all.join('\n')}`).not.toContain(token)
  })

  it('stops before building when not logged in and there is no push token', () => {
    const result = build()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ghcr-push-token')
    expect(calls().some((c) => c.startsWith('buildx build') || c.startsWith('push'))).toBe(false)
  })

  it('leaves no checksums when a push fails', () => {
    writeFileSync(join(root, 'logged-in'), '')
    env.TEST_PUSH_EXIT = '1'
    const result = build()
    expect(result.status).not.toBe(0)
    expect(existsSync(join(out, 'SHA256SUMS'))).toBe(false)
  })

  it('builds on a GitHub Actions Linux runner, and nowhere else on Linux', () => {
    writeFileSync(join(root, 'logged-in'), '')
    env.TEST_UNAME = 'Linux'
    const refused = build()
    expect(refused.status).toBe(1)
    expect(calls()).toEqual([])
    env.GITHUB_ACTIONS = 'true'
    expect(build().status).toBe(0)
  })
})

describe('build-vps-release.sh, archive fallback', () => {
  it('saves images.tar.gz without logging in or pushing, and records no digests', () => {
    env.RELEASE_TRANSPORT = 'archive'
    const result = build('internal')
    expect(result.status).toBe(0)
    const p = pub.slice(0, 12)
    const all = calls()
    expect(all).toContain(
      `save -o ${out}/images.tar ai-image-playground:vps-main-${p} ai-image-playground:backup-${p}`,
    )
    expect(all.some((c) => /^(login|push)/.test(c) || c.includes(repoName))).toBe(false)
    expect(readFileSync(join(out, 'images.tsv'), 'utf8')).toBe(
      [
        `internal\tai-image-playground:vps-main-${p}\t${imageId}\t${pub}\t-\t-`,
        `backup\tai-image-playground:backup-${p}\t${imageId}\t${pub}\t-\t-`,
        '',
      ].join('\n'),
    )
    expect(readFileSync(join(out, 'SHA256SUMS'), 'utf8')).toMatch(/ {2}images\.tar\.gz\n/)
    rmSync(log)
    const received = spawnSync('sh', [join(out, 'scripts/vps-deploy.sh'), 'internal', out], {
      env,
      encoding: 'utf8',
      timeout: 20000,
    })
    expect(received.status).toBe(0)
    expect(calls()).toContain(`load -i ${out}/images.tar.gz`)
    expect(calls().some((c) => c.startsWith('pull'))).toBe(false)
  })

  it('rejects an unknown transport before touching Docker', () => {
    env.RELEASE_TRANSPORT = 'scp'
    const result = build()
    expect(result.status).toBe(2)
    expect(calls()).toEqual([])
    expect(existsSync(out)).toBe(false)
  })
})
