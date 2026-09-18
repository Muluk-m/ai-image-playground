import { spawnSync } from 'node:child_process'
import {
  chmodSync,
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
 * 2026-09-18 两次付费版发布失败：旧执行器「排空前永不停止」，一代代堆在一台小 VPS 上，
 * 两套版本共用的 PostgreSQL 连接被占满。现在的规则是「有限排空，到点强停」（ADR 0009 补充）。
 * 这里用假的 docker 与 sleep 跑真实的 rollout-runtime.sh，只看它发出的 docker 命令、退出码与状态文件。
 */
const repo = resolve(__dirname, '../../../../..')
const script = join(repo, 'scripts/rollout-runtime.sh')
const composeScript = join(repo, 'scripts/app-compose.sh')

const FAKE_DOCKER = `#!/bin/sh
M=$MOCK_ROOT
C=$M/containers
cmd=$1
shift
if [ "$cmd" = exec ]; then
  name=$1
  while [ $# -gt 4 ]; do shift; done
  port=$1 method=$2 path=$3 field=$4
  printf 'exec %s %s %s %s\\n' "$name" "$method" "$path" "$field" >> "$M/log"
  [ "$(cat "$C/$name/state" 2>/dev/null)" = running ] || { echo "container $name is not running" >&2; exit 1; }
  drain=$(cat "$C/$name/drain" 2>/dev/null || echo idle)
  case "$path" in
    /health) [ "$(cat "$C/$name/health" 2>/dev/null || echo true)" = true ] && echo true && exit 0; exit 1 ;;
    /internal/deployment/drain)
      case "$drain" in missing) exit 44 ;; dead) exit 1 ;; esac
      case "$field" in
        safeToStop) if [ "$drain" = busy ]; then echo false; else echo true; fi ;;
        failed) cat "$C/$name/failed" 2>/dev/null || echo false ;;
        *) echo true ;;
      esac ;;
    /internal/deployment/legacy-drain)
      if [ "$method" = GET ] && [ -f "$M/legacy-busy" ]; then echo false; else echo true; fi ;;
    /internal/deployment/resume)
      [ -f "$C/$name/resume-fails" ] && exit 1
      echo true ;;
    *) echo true ;;
  esac
  exit 0
fi
printf '%s %s\\n' "$cmd" "$*" >> "$M/log"
case "$cmd" in
  image) echo 1 ;;
  ps)
    all=false project= role=
    while [ $# -gt 0 ]; do
      case "$1" in
        -a|--all) all=true ;;
        --filter)
          shift
          case "$1" in
            label=app.runtime.project=*) project=\${1#label=app.runtime.project=} ;;
            label=app.runtime.role=*) role=\${1#label=app.runtime.role=} ;;
          esac ;;
      esac
      shift
    done
    for dir in "$C"/*; do
      [ -d "$dir" ] || continue
      if [ -n "$project" ]; then [ "$(cat "$dir/project" 2>/dev/null)" = "$project" ] || continue; fi
      if [ -n "$role" ]; then [ "$(cat "$dir/role" 2>/dev/null)" = "$role" ] || continue; fi
      if [ "$all" = false ]; then [ "$(cat "$dir/state")" = running ] || continue; fi
      basename "$dir"
    done ;;
  inspect)
    format=
    while [ $# -gt 1 ]; do
      case "$1" in --format) shift; format=$1 ;; esac
      shift
    done
    [ -d "$C/$1" ] || exit 1
    case "$format" in
      *Config.Image*) cat "$C/$1/image" ;;
      *State.Running*) if [ "$(cat "$C/$1/state")" = running ]; then echo true; else echo false; fi ;;
    esac ;;
  create|run)
    name= project= role= image=
    rm_flag=false
    while [ $# -gt 0 ]; do
      case "$1" in
        --rm) rm_flag=true ;;
        --name) shift; name=$1 ;;
        --label)
          shift
          case "$1" in
            app.runtime.project=*) project=\${1#app.runtime.project=} ;;
            app.runtime.role=*) role=\${1#app.runtime.role=} ;;
          esac ;;
        fixture:*) image=$1 ;;
      esac
      shift
    done
    if [ "$rm_flag" = true ]; then
      [ -f "$M/migrate-fails" ] && exit 1
      exit 0
    fi
    mkdir "$C/$name" || exit 1
    echo "$image" > "$C/$name/image"
    [ -n "$project" ] && echo "$project" > "$C/$name/project"
    [ -n "$role" ] && echo "$role" > "$C/$name/role"
    [ -f "$M/new-$role-health" ] && cp "$M/new-$role-health" "$C/$name/health"
    [ -f "$M/new-$role-resume-fails" ] && touch "$C/$name/resume-fails"
    if [ "$cmd" = run ]; then echo running > "$C/$name/state"; else echo created > "$C/$name/state"; fi ;;
  start) [ -d "$C/$1" ] && echo running > "$C/$1/state" ;;
  stop)
    [ "$1" = -t ] && shift 2
    for name in "$@"; do [ -d "$C/$name" ] && echo exited > "$C/$name/state"; done
    exit 0 ;;
  rm)
    [ "$1" = -f ] && shift
    for name in "$@"; do rm -rf "$C/$name"; done ;;
  rename) mv "$C/$1" "$C/$2" ;;
  *) : ;;
esac
exit 0
`

let root: string
let config: string
let xdg: string

function write(path: string, content: string) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

interface ContainerSpec {
  role?: 'bff' | 'worker'
  labelled?: boolean
  state?: 'running' | 'exited'
  image?: string
  drain?: 'idle' | 'busy' | 'dead' | 'missing'
  failed?: boolean
}

function container(name: string, spec: ContainerSpec = {}) {
  const dir = join(root, 'containers', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state'), `${spec.state ?? 'running'}\n`)
  writeFileSync(join(dir, 'image'), `${spec.image ?? 'fixture:old'}\n`)
  if (spec.role) writeFileSync(join(dir, 'role'), `${spec.role}\n`)
  if (spec.labelled ?? spec.role !== undefined) writeFileSync(join(dir, 'project'), 'fixture\n')
  if (spec.drain) writeFileSync(join(dir, 'drain'), `${spec.drain}\n`)
  if (spec.failed) writeFileSync(join(dir, 'failed'), 'true\n')
}

function exists(name: string) {
  return existsSync(join(root, 'containers', name))
}

function stateOf(name: string) {
  return readFileSync(join(root, 'containers', name, 'state'), 'utf8').trim()
}

function releases(path: string) {
  return join(config, 'releases', path)
}

/** The generation serving before the rollout: routed, recorded and activated. */
function currentGeneration(bff: ContainerSpec = {}, worker: ContainerSpec = {}) {
  container('fixture-rold-bff', { role: 'bff', ...bff })
  container('fixture-rold-worker', { role: 'worker', ...worker })
  container('fixture-release-router', { image: 'fixture:new' })
  write(releases('current'), 'fixture-rold-bff fixture-rold-worker\n')
  write(releases('route.json'), '{"origin":"http://fixture-rold-bff:37377"}\n')
  write(releases('activated/fixture-rold-worker'), '')
  write(releases('ingress-ready'), '')
  write(
    join(config, 'cloudflared/config.yml'),
    'ingress:\n  - service: http://release-router:37377\n',
  )
}

function legacyExecutor() {
  container('fixture-bff-1', { drain: 'missing' })
  container('fixture-worker-1', { state: 'exited' })
  write(releases('legacy-origin'), 'http://fixture-bff-1:37377\n')
}

function run(env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('sh', [script, 'fixture', 'fixture:new'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      MOCK_ROOT: root,
      APP_CONFIG_DIR: config,
      XDG_CONFIG_HOME: xdg,
      DEPLOY_DRAIN_DEADLINE_SECONDS: '',
      DEPLOY_STOP_GRACE_SECONDS: '',
      DEPLOY_RETIRE_LEGACY: '',
      ...env,
    },
  })
  return { ...result, log: logLines() }
}

function logLines(): string[] {
  const path = join(root, 'log')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : []
}

function indexOf(log: string[], pattern: RegExp) {
  return log.findIndex((line) => pattern.test(line))
}

function created(log: string[]) {
  return log
    .filter((line) => line.startsWith('create '))
    .map((line) => /--name (\S+)/.exec(line)![1]!)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-rollout-'))
  config = join(root, 'config')
  xdg = join(root, 'xdg')
  mkdirSync(join(root, 'containers'), { recursive: true })
  write(join(config, 'app.env'), '')
  write(join(config, 'migrate.env'), '')
  write(join(root, 'bin/docker'), FAKE_DOCKER)
  write(join(root, 'bin/sleep'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(root, 'bin/docker'), 0o755)
  chmodSync(join(root, 'bin/sleep'), 0o755)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('rollout-runtime.sh: finite drain', () => {
  it('drains the previous generation, then stops and removes it and updates the ancillary services', () => {
    currentGeneration()
    const result = run()

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const [bff, worker] = readFileSync(releases('current'), 'utf8').trim().split(' ')
    expect(bff).toMatch(/^fixture-r\d{14}-\d+-bff$/)
    expect(readFileSync(releases('route.json'), 'utf8')).toBe(`{"origin":"http://${bff}:37377"}\n`)
    expect(readdirSync(releases('activated'))).toEqual([worker])
    // The old worker stops claiming before the new one starts.
    expect(
      indexOf(result.log, /^exec fixture-rold-worker POST \/internal\/deployment\/drain/),
    ).toBeLessThan(
      indexOf(result.log, new RegExp(`^exec ${worker} POST /internal/deployment/resume`)),
    )
    for (const old of ['fixture-rold-bff', 'fixture-rold-worker']) {
      expect(indexOf(result.log, new RegExp(`^exec ${old} GET .*safeToStop`))).toBeLessThan(
        indexOf(result.log, new RegExp(`^stop -t 75 .*${old}`)),
      )
      expect(exists(old)).toBe(false)
    }
    expect(stateOf(bff!)).toBe('running')
    expect(stateOf(worker!)).toBe('running')
    expect(result.stdout).toContain(
      'Previous executors: 2 drained cleanly, 0 stopped after the 300s drain deadline, 0 already down.',
    )
    expect(result.log).toContainEqual(
      expect.stringMatching(/^compose .* up --detach --no-deps admin host-collector pg-backup$/),
    )
  })

  it('stops a busy previous generation at the drain deadline instead of retaining it', () => {
    currentGeneration({ drain: 'busy' })
    const result = run({ DEPLOY_DRAIN_DEADLINE_SECONDS: '20', DEPLOY_STOP_GRACE_SECONDS: '30' })

    expect(result.status).toBe(0)
    const probes = result.log.filter(
      (line) => line === 'exec fixture-rold-bff GET /internal/deployment/drain safeToStop',
    )
    // Probed at 0, 5, 10, 15 and 20 seconds, then stopped.
    expect(probes).toHaveLength(5)
    expect(result.log).toContainEqual(expect.stringMatching(/^stop -t 30 .*fixture-rold-bff/))
    expect(exists('fixture-rold-bff')).toBe(false)
    expect(exists('fixture-rold-worker')).toBe(false)
    expect(result.stdout).toContain(
      'Previous executors: 1 drained cleanly, 1 stopped after the 20s drain deadline, 0 already down.',
    )
    expect(result.stderr).toContain('Drain deadline (20s) reached; stopping fixture-rold-bff')
    expect(result.log).toContainEqual(
      expect.stringMatching(/^compose .* up --detach --no-deps admin/),
    )
  })

  it('warns about a retired BFF that recorded a failed settlement but still stops it', () => {
    currentGeneration({ failed: true })
    const result = run()

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('fixture-rold-bff recorded a failed durable settlement')
    expect(exists('fixture-rold-bff')).toBe(false)
  })

  it('does not let an unresponsive previous executor abort the rollout', () => {
    currentGeneration({}, { drain: 'dead' })
    const result = run({ DEPLOY_DRAIN_DEADLINE_SECONDS: '10' })

    expect(result.status).toBe(0)
    const [bff] = readFileSync(releases('current'), 'utf8').trim().split(' ')
    expect(readFileSync(releases('route.json'), 'utf8')).toContain(bff!)
    expect(exists('fixture-rold-worker')).toBe(false)
    expect(result.stdout).toContain('1 drained cleanly, 1 stopped after the 10s drain deadline')
    expect(result.log).toContainEqual(
      expect.stringMatching(/^compose .* up --detach --no-deps admin/),
    )
  })

  it('counts a previous executor that already exited as down rather than drained', () => {
    currentGeneration({}, { state: 'exited' })
    const result = run()

    expect(result.status).toBe(0)
    expect(exists('fixture-rold-worker')).toBe(false)
    expect(result.stdout).toContain(
      '1 drained cleanly, 0 stopped after the 300s drain deadline, 1 already down.',
    )
  })

  it('removes leftover generations and stale state before starting a new one', () => {
    currentGeneration()
    container('fixture-rgone-bff', { role: 'bff', state: 'exited' })
    container('fixture-rgone-worker', { role: 'worker', state: 'exited' })
    container('fixture-rstale-bff', { role: 'bff', drain: 'dead' })
    container('fixture-rstale-worker', { role: 'worker' })
    write(releases('retained'), 'fixture-rgone-bff fixture-rgone-worker\n')
    write(releases('activated/fixture-rstale-worker'), '')
    const result = run()

    expect(result.status).toBe(0)
    const firstCreate = indexOf(result.log, /^create /)
    for (const leftover of [
      'fixture-rgone-bff',
      'fixture-rgone-worker',
      'fixture-rstale-bff',
      'fixture-rstale-worker',
    ]) {
      expect(indexOf(result.log, new RegExp(`^rm -f .*${leftover}`))).toBeGreaterThan(-1)
      expect(indexOf(result.log, new RegExp(`^rm -f .*${leftover}`))).toBeLessThan(firstCreate)
      expect(exists(leftover)).toBe(false)
    }
    expect(indexOf(result.log, /^stop -t 75 .*fixture-rstale-worker/)).toBeLessThan(firstCreate)
    // Nobody drains or probes a leftover: a dead one cannot abort the rollout.
    expect(result.log.some((line) => line.startsWith('exec fixture-rstale-'))).toBe(false)
    expect(existsSync(releases('retained'))).toBe(false)
    expect(existsSync(releases('activated/fixture-rstale-worker'))).toBe(false)
  })
})

describe('rollout-runtime.sh: release containers', () => {
  /** A service's `DATABASE_POOL_MAX` from deploy/compose.app.yaml, read without a YAML parser. */
  function composePoolSize(service: string): string {
    const compose = readFileSync(join(repo, 'deploy/compose.app.yaml'), 'utf8')
    const block = new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`).exec(
      compose,
    )
    const size = /DATABASE_POOL_MAX: "?(\d+)"?/.exec(block?.[1] ?? '')?.[1]
    if (!size) throw new Error(`no DATABASE_POOL_MAX for ${service}`)
    return size
  }

  it('gives release executors the pool sizes Compose gives the same roles', () => {
    currentGeneration()
    const result = run()

    expect(result.status).toBe(0)
    for (const role of ['bff', 'worker']) {
      const size = composePoolSize(role)
      expect(size).toMatch(/^[1-9][0-9]*$/)
      const line = result.log.find(
        (one) => one.startsWith('create ') && one.includes(`role=${role} `),
      )
      expect(line).toContain(`-e DATABASE_POOL_MAX=${size} `)
    }
  })
})

describe('rollout-runtime.sh: failure before cutover', () => {
  it('removes the new BFF and keeps the previous generation serving when it never becomes healthy', () => {
    currentGeneration()
    write(join(root, 'new-bff-health'), 'false\n')
    const result = run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('did not become healthy')
    expect(result.stderr).toContain('Rollout failed before cutover')
    const [newBff] = created(result.log)
    expect(exists(newBff!)).toBe(false)
    expect(readFileSync(releases('current'), 'utf8')).toBe('fixture-rold-bff fixture-rold-worker\n')
    expect(readFileSync(releases('route.json'), 'utf8')).toBe(
      '{"origin":"http://fixture-rold-bff:37377"}\n',
    )
    expect(result.log.some((line) => line.startsWith('exec fixture-rold-worker POST'))).toBe(false)
    expect(readdirSync(releases('activated'))).toEqual(['fixture-rold-worker'])
    expect(stateOf('fixture-rold-bff')).toBe('running')
    expect(result.log.some((line) => line.startsWith('compose '))).toBe(false)
  })

  it('removes both new instances when the new worker never becomes healthy', () => {
    currentGeneration()
    write(join(root, 'new-worker-health'), 'false\n')
    const result = run()

    expect(result.status).not.toBe(0)
    const names = created(result.log)
    expect(names).toHaveLength(2)
    for (const name of names) expect(exists(name)).toBe(false)
    expect(result.log.some((line) => line.startsWith('exec fixture-rold-worker POST'))).toBe(false)
    expect(stateOf('fixture-rold-worker')).toBe('running')
  })

  it('checks the tunnel before draining anything and cleans up when it points elsewhere', () => {
    currentGeneration()
    rmSync(releases('ingress-ready'))
    write(join(config, 'cloudflared/config.yml'), 'ingress:\n  - service: http://elsewhere:80\n')
    const result = run()

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unknown tunnel origin')
    for (const name of created(result.log)) expect(exists(name)).toBe(false)
    expect(result.log.some((line) => line.startsWith('exec fixture-rold-worker POST'))).toBe(false)
    expect(readFileSync(releases('current'), 'utf8')).toBe('fixture-rold-bff fixture-rold-worker\n')
  })

  it('resumes the drained previous worker when the new worker cannot be activated', () => {
    currentGeneration()
    write(join(root, 'new-worker-resume-fails'), '')
    const result = run()

    expect(result.status).not.toBe(0)
    const drained = indexOf(
      result.log,
      /^exec fixture-rold-worker POST \/internal\/deployment\/drain/,
    )
    const resumed = indexOf(
      result.log,
      /^exec fixture-rold-worker POST \/internal\/deployment\/resume/,
    )
    expect(drained).toBeGreaterThan(-1)
    expect(resumed).toBeGreaterThan(drained)
    expect(readdirSync(releases('activated'))).toEqual(['fixture-rold-worker'])
    for (const name of created(result.log)) expect(exists(name)).toBe(false)
    expect(readFileSync(releases('current'), 'utf8')).toBe('fixture-rold-bff fixture-rold-worker\n')
  })

  it('reopens the legacy claim gate before removing the new BFF when legacy work outlives the deadline', () => {
    container('fixture-bff-1', { drain: 'missing' })
    container('fixture-worker-1')
    write(join(config, 'cloudflared/config.yml'), 'ingress:\n  - service: http://bff:37377\n')
    write(join(root, 'legacy-busy'), '')
    const result = run({ DEPLOY_DRAIN_DEADLINE_SECONDS: '10' })

    expect(result.status).not.toBe(0)
    const [newBff] = created(result.log)
    const reopened = indexOf(
      result.log,
      new RegExp(`^exec ${newBff} POST /internal/deployment/legacy-resume`),
    )
    expect(reopened).toBeGreaterThan(-1)
    expect(reopened).toBeLessThan(indexOf(result.log, new RegExp(`^rm -f .*${newBff}`)))
    expect(exists(newBff!)).toBe(false)
    expect(stateOf('fixture-bff-1')).toBe('running')
    expect(stateOf('fixture-worker-1')).toBe('running')
    expect(existsSync(releases('current'))).toBe(false)
    expect(existsSync(releases('legacy-origin'))).toBe(false)
  })
})

describe('rollout-runtime.sh: release router', () => {
  it('replaces a router running an older image with one on the release image', () => {
    currentGeneration()
    container('fixture-release-router', { image: 'fixture:first' })
    const result = run()

    expect(result.status).toBe(0)
    const renamed = indexOf(
      result.log,
      /^rename fixture-release-router fixture-release-router-retiring$/,
    )
    const started = indexOf(result.log, /^run -d --name fixture-release-router .*fixture:new/)
    const retired = indexOf(result.log, /^stop -t \d+ fixture-release-router-retiring$/)
    expect(renamed).toBeGreaterThan(-1)
    expect(started).toBeGreaterThan(renamed)
    expect(retired).toBeGreaterThan(started)
    expect(readFileSync(join(root, 'containers/fixture-release-router/image'), 'utf8')).toBe(
      'fixture:new\n',
    )
    expect(exists('fixture-release-router-retiring')).toBe(false)
  })

  it('leaves a router already on the release image alone', () => {
    currentGeneration()
    const result = run()

    expect(result.status).toBe(0)
    expect(
      result.log.some((line) => /^(rename|run -d --name fixture-release-router)/.test(line)),
    ).toBe(false)
  })

  it('puts the old router back when the replacement never becomes healthy', () => {
    currentGeneration()
    container('fixture-release-router', { image: 'fixture:first' })
    // The replacement router has no role label; the fake gives it the health in `new--health`.
    write(join(root, 'new--health'), 'false\n')
    const result = run()

    expect(result.status).not.toBe(0)
    expect(readFileSync(join(root, 'containers/fixture-release-router/image'), 'utf8')).toBe(
      'fixture:first\n',
    )
    expect(stateOf('fixture-release-router')).toBe('running')
    expect(exists('fixture-release-router-retiring')).toBe(false)
  })
})

describe('rollout-runtime.sh: legacy executor', () => {
  it('keeps forwarding to the legacy executor unless its retirement is requested', () => {
    currentGeneration()
    legacyExecutor()
    const result = run()

    expect(result.status).toBe(0)
    for (const line of result.log.filter((one) => one.startsWith('create '))) {
      expect(line).toContain('-e LEGACY_EXECUTOR_ORIGIN=http://fixture-bff-1:37377 ')
    }
    expect(stateOf('fixture-bff-1')).toBe('running')
    expect(readFileSync(releases('legacy-origin'), 'utf8')).toBe('http://fixture-bff-1:37377\n')
  })

  it('retires the legacy executor once: the new generation owns generation 0 and the marker goes', () => {
    currentGeneration()
    legacyExecutor()
    const result = run({ DEPLOY_RETIRE_LEGACY: '1' })

    expect(result.status).toBe(0)
    const creates = result.log.filter((one) => one.startsWith('create '))
    expect(creates).toHaveLength(2)
    for (const line of creates) expect(line).toContain('-e LEGACY_EXECUTOR_ORIGIN= ')
    const [, worker] = readFileSync(releases('current'), 'utf8').trim().split(' ')
    const activated = indexOf(
      result.log,
      new RegExp(`^exec ${worker} POST /internal/deployment/resume`),
    )
    const stopped = indexOf(result.log, /^stop -t 75 fixture-bff-1 fixture-worker-1$/)
    expect(stopped).toBeGreaterThan(activated)
    // The previous generation, which still forwarded to the legacy executor, is drained first.
    expect(stopped).toBeGreaterThan(indexOf(result.log, /^stop -t 75 .*fixture-rold-bff/))
    expect(exists('fixture-bff-1')).toBe(false)
    expect(exists('fixture-worker-1')).toBe(false)
    expect(existsSync(releases('legacy-origin'))).toBe(false)
    expect(result.stdout).toContain('Legacy executor fixture-bff-1 retired')
  })

  it('keeps the legacy executor and its marker when the retiring rollout fails before cutover', () => {
    currentGeneration()
    legacyExecutor()
    write(join(root, 'new-bff-health'), 'false\n')
    const result = run({ DEPLOY_RETIRE_LEGACY: '1' })

    expect(result.status).not.toBe(0)
    expect(stateOf('fixture-bff-1')).toBe('running')
    expect(readFileSync(releases('legacy-origin'), 'utf8')).toBe('http://fixture-bff-1:37377\n')
  })

  it('says there is nothing to retire when no legacy executor is recorded', () => {
    currentGeneration()
    const result = run({ DEPLOY_RETIRE_LEGACY: '1' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No legacy executor recorded for fixture; nothing to retire.')
  })
})

describe('app-compose.sh up', () => {
  it('keeps using the release rollout after the compose BFF has been retired', () => {
    config = join(xdg, 'ai-image-playground/apps/fixture')
    write(join(config, 'app.env'), 'APP_IMAGE=fixture:new\n')
    write(join(config, 'migrate.env'), '')
    write(join(config, 'cloudflared/credentials.json'), '{}')
    currentGeneration()
    const result = spawnSync('sh', [composeScript, 'up', 'fixture'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        MOCK_ROOT: root,
        XDG_CONFIG_HOME: xdg,
        APP_IMAGE: 'fixture:new',
        APP_CONFIG_DIR: '',
      },
    })

    expect(result.status).toBe(0)
    const log = logLines()
    expect(log.some((line) => line.startsWith('create '))).toBe(true)
    expect(log.some((line) => /up --detach --wait .*dependency-check bff worker/.test(line))).toBe(
      false,
    )
  })
})
