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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real shell subprocesses have a 20-second budget, including cleanup under concurrent CI load.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const repo = resolve(__dirname, '../../../../..')
const script = join(repo, 'scripts/rollout-runtime.sh')
const composeScript = join(repo, 'scripts/app-compose.sh')
const currentBff = 'fixture-r100-1-bff'
const currentWorker = 'fixture-r100-1-worker'
const newImage = 'sha256:fixture:new'

const FAKE_DOCKER = String.raw`#!/bin/sh
M=$MOCK_ROOT
C=$M/containers
find_name() {
  if [ -d "$C/$1" ]; then printf '%s\n' "$1"; return 0; fi
  for dir in "$C"/*; do
    [ -d "$dir" ] || continue
    if [ "$(cat "$dir/id")" = "$1" ]; then basename "$dir"; return 0; fi
  done
  return 1
}
cmd=$1
shift
if [ "$cmd" = exec ]; then
  name=$(find_name "$1") || exit 1
  while [ $# -gt 4 ]; do shift; done
  port=$1 method=$2 path=$3 field=$4
  printf 'exec %s %s %s %s\n' "$name" "$method" "$path" "$field" >> "$M/log"
  [ "$(cat "$C/$name/state")" = running ] || exit 1
  case "$path" in
    /health)
      [ "$(cat "$C/$name/health" 2>/dev/null || echo true)" = true ] && echo true && exit 0
      exit 1 ;;
    /internal/deployment/drain)
      drain=$(cat "$C/$name/drain")
      case "$drain" in missing) exit 44 ;; dead) exit 1 ;; esac
      [ "$method" != POST ] || echo true > "$C/$name/draining"
      case "$field" in
        retirement)
          if [ "$(cat "$C/$name/failed")" = true ]; then echo failed_finalization
          elif [ "$(cat "$C/$name/draining")" = true ] && [ "$drain" = idle ]; then echo idle
          else echo busy; fi ;;
        draining) cat "$C/$name/draining" ;;
        *) exit 1 ;;
      esac ;;
    /internal/deployment/resume)
      [ ! -f "$C/$name/resume-fails" ] || exit 1
      echo false > "$C/$name/draining"
      echo true ;;
    *) exit 1 ;;
  esac
  exit 0
fi
printf '%s %s\n' "$cmd" "$*" >> "$M/log"
case "$cmd" in
  image)
    while [ $# -gt 1 ]; do shift; done
    case "$1" in sha256:*) image=$1 ;; *) image=sha256:$1 ;; esac
    printf '%s 1\n' "$image" ;;
  ps)
    all=false project= role= named= format=
    while [ $# -gt 0 ]; do
      case "$1" in
        -a|--all) all=true ;;
        --format) shift; format=$1 ;;
        --filter)
          shift
          case "$1" in
            label=app.runtime.project=*) project=${'${'}1#label=app.runtime.project=} ;;
            label=app.runtime.role=*) role=${'${'}1#label=app.runtime.role=} ;;
            name=*) named=${'${'}1#name=}; named=${'${'}named#^/}; named=${'${'}named%\$} ;;
          esac ;;
      esac
      shift
    done
    for dir in "$C"/*; do
      [ -d "$dir" ] || continue
      name=$(basename "$dir")
      [ -z "$named" ] || [ "$name" = "$named" ] || continue
      [ -z "$project" ] || [ "$(cat "$dir/project")" = "$project" ] || continue
      [ -z "$role" ] || [ "$(cat "$dir/role")" = "$role" ] || continue
      [ "$all" = true ] || [ "$(cat "$dir/state")" = running ] || continue
      case "$format" in
        *'.ID'*) printf '%s\t%s\n' "$(cat "$dir/id")" "$name" ;;
        *) printf '%s\n' "$name" ;;
      esac
    done ;;
  inspect)
    format=
    while [ $# -gt 1 ]; do
      case "$1" in --format) shift; format=$1 ;; esac
      shift
    done
    name=$(find_name "$1") || exit 1
    dir=$C/$name
    state=$(cat "$dir/state")
    running=false
    [ "$state" != running ] || running=true
    case "$format" in
      '{{.Id}} '*)
        printf '%s %s %s %s %s %s /%s %s %s %s %s %s\n' \
          "$(cat "$dir/id")" "$state" "$running" "$(cat "$dir/started")" \
          "$(cat "$dir/restart")" "$(cat "$dir/image")" "$name" \
          "$(cat "$dir/project")" "$(cat "$dir/role")" \
          "$(cat "$dir/compose-project")" "$(cat "$dir/compose-service")" \
          "$(cat "$dir/generation")" ;;
      '{{.Image}}'|'{{.Config.Image}}') cat "$dir/image" ;;
      '{{.State.Running}}') echo "$running" ;;
    esac ;;
  update)
    restart=${'${'}1#--restart=}
    shift
    for target in "$@"; do
      name=$(find_name "$target") || exit 1
      echo "$restart" > "$C/$name/restart"
    done ;;
  create|run)
    name= project=- role=- generation=- image= restart=unless-stopped
    rm_flag=false
    while [ $# -gt 0 ]; do
      case "$1" in
        --rm) rm_flag=true ;;
        --name) shift; name=$1 ;;
        --restart) shift; restart=$1 ;;
        --label)
          shift
          case "$1" in
            app.runtime.project=*) project=${'${'}1#app.runtime.project=} ;;
            app.runtime.role=*) role=${'${'}1#app.runtime.role=} ;;
            app.runtime.generation=*) generation=${'${'}1#app.runtime.generation=} ;;
          esac ;;
        sha256:*|fixture:*) image=$1 ;;
      esac
      shift
    done
    [ -n "$image" ] || exit 1
    if [ "$rm_flag" = true ]; then
      [ ! -f "$M/migrate-fails" ] || exit 1
      exit 0
    fi
    mkdir "$C/$name" || exit 1
    next=$(($(cat "$M/next-id") + 1))
    echo "$next" > "$M/next-id"
    printf '%064x\n' "$next" > "$C/$name/id"
    echo "$image" > "$C/$name/image"
    echo "$project" > "$C/$name/project"
    echo "$role" > "$C/$name/role"
    echo "$generation" > "$C/$name/generation"
    echo - > "$C/$name/compose-project"
    echo - > "$C/$name/compose-service"
    echo "$restart" > "$C/$name/restart"
    echo 2026-10-18T00:00:00Z > "$C/$name/started"
    echo idle > "$C/$name/drain"
    echo false > "$C/$name/draining"
    echo false > "$C/$name/failed"
    [ ! -f "$M/new-$role-health" ] || cp "$M/new-$role-health" "$C/$name/health"
    [ ! -f "$M/new-$role-resume-fails" ] || touch "$C/$name/resume-fails"
    if [ "$cmd" = run ]; then echo running > "$C/$name/state"; else echo created > "$C/$name/state"; fi ;;
  start|restart)
    name=$(find_name "$1") || exit 1
    echo running > "$C/$name/state" ;;
  stop)
    [ "$1" != -t ] || shift 2
    for target in "$@"; do
      name=$(find_name "$target") || exit 1
      echo exited > "$C/$name/state"
    done ;;
  rm)
    force=false
    if [ "$1" = -f ]; then force=true; shift; fi
    for target in "$@"; do
      name=$(find_name "$target") || exit 1
      [ ! -f "$M/remove-fails-$name" ] || exit 1
      [ "$force" = true ] || [ "$(cat "$C/$name/state")" != running ] || exit 1
      rm -rf "$C/$name"
    done ;;
  rename) mv "$C/$1" "$C/$2" ;;
  compose)
    case " $* " in *' config --images '*) echo fixture:new ;; esac ;;
  network) : ;;
  *) exit 2 ;;
esac
exit 0
`

let root: string
let config: string
let xdg: string
let containerIds: Map<string, string>

function write(path: string, content: string) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

type Role = 'bff' | 'worker'
interface ContainerSpec {
  role?: Role
  ownership?: 'runtime' | 'compose'
  state?: 'running' | 'exited'
  image?: string
  drain?: 'idle' | 'busy' | 'dead' | 'missing'
  draining?: boolean
  failed?: boolean
  restart?: 'unless-stopped' | 'no'
}

function container(name: string, spec: ContainerSpec = {}) {
  const dir = join(root, 'containers', name)
  mkdirSync(dir, { recursive: true })
  const next = Number(readFileSync(join(root, 'next-id'), 'utf8')) + 1
  const id = next.toString(16).padStart(64, '0')
  writeFileSync(join(root, 'next-id'), `${next}\n`)
  containerIds.set(name, id)
  const image = spec.image ?? 'fixture:old'
  const runtime = spec.role !== undefined && (spec.ownership ?? 'runtime') === 'runtime'
  const compose = spec.role !== undefined && spec.ownership === 'compose'
  const fields = {
    id,
    state: spec.state ?? 'running',
    image: image.startsWith('sha256:') ? image : `sha256:${image}`,
    project: runtime ? 'fixture' : '-',
    role: runtime ? spec.role : '-',
    generation: runtime ? name.replace(/-(bff|worker)$/, '') : '-',
    'compose-project': compose ? 'fixture' : '-',
    'compose-service': compose ? spec.role : '-',
    started: '2026-10-18T00:00:00Z',
    restart: spec.restart ?? 'unless-stopped',
    drain: spec.drain ?? 'idle',
    draining: String(spec.draining ?? false),
    failed: String(spec.failed ?? false),
  }
  for (const [field, value] of Object.entries(fields)) writeFileSync(join(dir, field), `${value}\n`)
}

function exists(name: string) {
  return existsSync(join(root, 'containers', name))
}

function fieldOf(name: string, field: string) {
  return readFileSync(join(root, 'containers', name, field), 'utf8').trim()
}

function releases(path: string) {
  return join(config, 'releases', path)
}

function currentGeneration(bff: ContainerSpec = {}, worker: ContainerSpec = {}) {
  container(currentBff, { role: 'bff', ...bff })
  container(currentWorker, { role: 'worker', ...worker })
  container('fixture-release-router', { image: newImage })
  write(releases('current'), `${currentBff} ${currentWorker}\n`)
  write(releases('route.json'), routeFor(currentBff, currentWorker))
  write(releases(`activated/${currentWorker}`), '')
  write(releases('ingress-ready'), '')
  write(
    join(config, 'cloudflared/config.yml'),
    'ingress:\n  - service: http://release-router:37377\n',
  )
}

function routeFor(bff: string, worker: string) {
  return `${JSON.stringify({ origin: `http://${bff}:37377`, worker })}\n`
}

function currentPair(): [string, string] {
  const [bff, worker] = readFileSync(releases('current'), 'utf8').trim().split(' ')
  if (!bff || !worker) throw new Error('current must record both executor names')
  return [bff, worker]
}

function legacyExecutor(drain: ContainerSpec['drain'] = 'missing') {
  container('fixture-bff-1', { role: 'bff', ownership: 'compose', drain })
  container('fixture-worker-1', { role: 'worker', ownership: 'compose', drain })
  write(releases('legacy-origin'), 'http://fixture-bff-1:37377\n')
}

function run(env: NodeJS.ProcessEnv = {}, image = 'fixture:new') {
  const result = spawnSync('sh', [script, 'fixture', image], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      MOCK_ROOT: root,
      APP_CONFIG_DIR: config,
      XDG_CONFIG_HOME: xdg,
      DEPLOY_DRAIN_DEADLINE_SECONDS: '0',
      DEPLOY_STOP_GRACE_SECONDS: '',
      DEPLOY_RETIRE_LEGACY: '',
      ...env,
    },
  })
  return { ...result, log: logLines() }
}

function logLines(): string[] {
  const path = join(root, 'log')
  const content = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
  return content ? content.split('\n') : []
}

function indexOf(log: string[], pattern: RegExp) {
  return log.findIndex((line) => pattern.test(line))
}

function created(log: string[]) {
  return log
    .filter((line) => line.startsWith('create '))
    .map((line) => {
      const name = /--name (\S+)/.exec(line)?.[1]
      if (!name) throw new Error(`create command has no container name: ${line}`)
      return name
    })
}

function destructive(log: string[], name: string) {
  const id = containerIds.get(name)
  return log.filter((line) => {
    const [command, ...args] = line.split(' ')
    return (
      ['stop', 'rm', 'kill'].includes(command ?? '') &&
      args.some((arg) => arg === name || arg === id)
    )
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-rollout-'))
  config = join(root, 'config')
  xdg = join(root, 'xdg')
  containerIds = new Map()
  mkdirSync(join(root, 'containers'), { recursive: true })
  write(join(root, 'next-id'), '0\n')
  write(join(root, 'clock'), '1000\n')
  write(join(config, 'app.env'), '')
  write(join(config, 'migrate.env'), '')
  const executables = {
    docker: FAKE_DOCKER,
    timeout: '#!/bin/sh\nshift\nexec "$@"\n',
    date: '#!/bin/sh\nif [ "$1" = +%s ]; then cat "$MOCK_ROOT/clock"; else echo 20261018000000; fi\n',
    sleep: '#!/bin/sh\nnow=$(cat "$MOCK_ROOT/clock")\necho $((now + $1)) > "$MOCK_ROOT/clock"\n',
  }
  for (const [name, source] of Object.entries(executables)) {
    write(join(root, 'bin', name), source)
    chmodSync(join(root, 'bin', name), 0o755)
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('rollout-runtime.sh: safe retirement', () => {
  it('exposes a direct ingestion alias only on compatible runtime generations', () => {
    currentGeneration()
    const result = run()
    expect(result.status).toBe(0)
    for (const role of ['bff', 'worker']) {
      expect(
        result.log.find((line) => line.startsWith('create ') && line.includes(`APP_ROLE=${role} `)),
      ).toContain(`--network-alias ${role}-logs`)
    }
    expect(readFileSync(join(repo, 'deploy/compose.app.yaml'), 'utf8')).toContain(
      'host: ${LOG_INGEST_HOST:-bff-logs}',
    )
  })

  it('preserves a socket path with spaces as one Docker argument', () => {
    currentGeneration()
    const docker = join(root, 'bin/docker')
    writeFileSync(
      docker,
      readFileSync(docker, 'utf8').replace(
        'cmd=$1',
        'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$MOCK_ROOT/args"; done\ncmd=$1',
      ),
    )
    const socketDir = join(root, 'path with spaces')
    expect(run({ LOG_FORWARD_DIR: socketDir }).status).toBe(0)
    const args = readFileSync(join(root, 'args'), 'utf8').split('\n')
    expect(
      args.filter((arg) => arg === `fluentd-address=unix://${socketDir}/forward.sock`),
    ).toHaveLength(3)
    expect(args).not.toContain(`fluentd-address=unix://${root}/path`)
  })

  it('does not leave a rollout lock when its log directory cannot be created', () => {
    currentGeneration()
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'file')
    expect(run({ LOG_FORWARD_DIR: join(blocked, 'child') }).status).not.toBe(0)
    expect(existsSync(releases('lock'))).toBe(false)
    expect(run().status).toBe(0)
  })

  it('retires the drained previous generation before updating ancillary services', () => {
    currentGeneration()
    const result = run()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const [bff, worker] = currentPair()
    expect(bff).toMatch(/^fixture-r\d{14}-\d+-bff$/)
    expect(readFileSync(releases('route.json'), 'utf8')).toBe(routeFor(bff, worker))
    expect(readdirSync(releases('activated'))).toEqual([worker])
    expect(
      indexOf(result.log, new RegExp(`^exec ${currentWorker} POST /internal/deployment/drain`)),
    ).toBeLessThan(
      indexOf(result.log, new RegExp(`^exec ${worker} POST /internal/deployment/resume`)),
    )
    for (const old of [currentBff, currentWorker]) {
      const id = containerIds.get(old)
      const retired = destructive(result.log, old)
      expect(retired).toEqual([`stop -t 75 ${id}`, `rm ${id}`])
      expect(indexOf(result.log, new RegExp(`^update --restart=no ${id}$`))).toBeLessThan(
        indexOf(result.log, new RegExp(`^stop -t 75 ${id}$`)),
      )
      expect(indexOf(result.log, new RegExp(`^exec ${old} GET .*retirement$`))).toBeLessThan(
        indexOf(result.log, new RegExp(`^stop -t 75 ${id}$`)),
      )
      expect(exists(old)).toBe(false)
      expect(result.stdout).toContain(`Retired ${old}: drained`)
    }
    expect(fieldOf(bff, 'state')).toBe('running')
    expect(fieldOf(worker, 'state')).toBe('running')
    expect(result.log).toContainEqual(
      expect.stringMatching(/^compose .* up --detach --no-deps --wait admin$/),
    )
    expect(result.log).toContainEqual(
      expect.stringMatching(/^compose .* up --detach --no-deps cloudflared$/),
    )
    const socket = `fluentd-address=unix://${xdg}/ai-image-playground/log-forward/fixture/forward.sock`
    const launches = result.log.filter((line) => /^(create|run) /.test(line))
    expect(launches).toHaveLength(3)
    for (const line of launches) {
      expect(line).toContain('--log-driver fluentd')
      expect(line).toContain(socket)
      expect(line).toContain('fluentd-async=true')
      expect(line).toContain(newImage)
    }
  })

  it('retains busy work after the deadline and blocks a third generation before migration', () => {
    currentGeneration({ drain: 'busy' })
    const result = run({ DEPLOY_DRAIN_DEADLINE_SECONDS: '20', DEPLOY_STOP_GRACE_SECONDS: '30' })
    expect(result.status).toBe(0)
    expect(
      result.log.filter(
        (line) => line === `exec ${currentBff} GET /internal/deployment/drain retirement`,
      ),
    ).toHaveLength(6)
    expect(destructive(result.log, currentBff)).toEqual([])
    expect(fieldOf(currentBff, 'state')).toBe('running')
    expect(fieldOf(currentBff, 'restart')).toBe('no')
    expect(exists(currentWorker)).toBe(false)
    expect(result.stderr).toContain(`Retained ${currentBff}: busy`)
    const [bff, worker] = currentPair()
    expect(readFileSync(releases('route.json'), 'utf8')).toBe(routeFor(bff, worker))
    write(join(root, 'log'), '')
    const blocked = run({}, 'fixture:third')
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('deployment_capacity_blocked')
    expect(blocked.log.some((line) => /^(create|run) /.test(line))).toBe(false)
    expect(destructive(blocked.log, currentBff)).toEqual([])
    expect(currentPair()).toEqual([bff, worker])
  })

  it('retains a BFF that recorded failed finalization', () => {
    currentGeneration({ failed: true })
    const result = run()
    expect(result.status).toBe(0)
    expect(result.stderr).toContain(`Retained ${currentBff}: failed_finalization`)
    expect(fieldOf(currentBff, 'state')).toBe('running')
    expect(destructive(result.log, currentBff)).toEqual([])
  })

  it('refuses a rollout when the current executor cannot establish its drain protocol', () => {
    currentGeneration({}, { drain: 'dead' })
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Cannot establish current worker drain protocol')
    expect(created(result.log)).toEqual([])
    for (const name of [currentBff, currentWorker]) {
      expect(fieldOf(name, 'state')).toBe('running')
      expect(destructive(result.log, name)).toEqual([])
    }
  })

  it('updates admin with compose and leaves a running tunnel up', () => {
    currentGeneration()
    container('fixture-cloudflared-1')
    const result = run()
    expect(result.status).toBe(0)
    expect(result.log).toContainEqual(
      expect.stringMatching(/^compose .* up --detach --no-deps --wait admin$/),
    )
    expect(result.log).not.toContainEqual(
      expect.stringMatching(/^compose .* up --detach --no-deps cloudflared$/),
    )
  })

  it('removes leftover admin containers only after compose admin is ready', () => {
    currentGeneration()
    const stale = [
      'fixture-admin-proxy',
      'fixture-admin-proxy-next',
      'fixture-admin-proxy-previous',
      'fixture-admin-proxy-dead',
      'fixture-r20260101010101-1-admin',
    ]
    for (const name of stale) container(name)
    write(releases('admin-proxy/nginx.conf'), 'set $upstream old;\n')
    for (const marker of ['admin-pending', 'admin-upstream', 'admin-retire'])
      write(releases(marker), 'old\n')
    const result = run()
    expect(result.status).toBe(0)
    const composed = indexOf(result.log, /^compose .* up --detach --no-deps --wait admin$/)
    expect(composed).toBeGreaterThan(-1)
    for (const name of stale) {
      expect(indexOf(result.log, new RegExp(`^stop -t 30 ${name}$`))).toBeGreaterThan(composed)
      expect(exists(name)).toBe(false)
    }
    for (const marker of ['admin-proxy', 'admin-pending', 'admin-upstream', 'admin-retire'])
      expect(existsSync(releases(marker))).toBe(false)
  })

  it('reports a stale admin container that could not be removed without rolling back the committed route', () => {
    currentGeneration()
    container('fixture-admin-proxy')
    write(join(root, 'remove-fails-fixture-admin-proxy'), '')
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Could not remove stale admin container fixture-admin-proxy')
    expect(result.stderr).toContain('Cutover committed')
    const [bff, worker] = currentPair()
    expect(bff).not.toBe(currentBff)
    expect(readFileSync(releases('route.json'), 'utf8')).toBe(routeFor(bff, worker))
    expect(fieldOf(bff, 'state')).toBe('running')
    expect(fieldOf(worker, 'state')).toBe('running')
  })

  it('removes proven stopped leftovers with plain rm before starting another generation', () => {
    currentGeneration()
    const leftovers = ['fixture-r98-1-bff', 'fixture-r98-1-worker']
    for (const name of leftovers)
      container(name, { role: name.endsWith('worker') ? 'worker' : 'bff', state: 'exited' })
    write(releases(`activated/${leftovers[1]}`), '')
    const result = run()
    expect(result.status).toBe(0)
    for (const name of leftovers) {
      const id = containerIds.get(name)
      expect(destructive(result.log, name)).toEqual([`rm ${id}`])
      expect(indexOf(result.log, new RegExp(`^rm ${id}$`))).toBeLessThan(
        indexOf(result.log, /^create /),
      )
      expect(exists(name)).toBe(false)
    }
    expect(existsSync(releases(`activated/${leftovers[1]}`))).toBe(false)
  })

  it('preserves an unresponsive leftover and refuses capacity before starting a migration', () => {
    currentGeneration()
    const retained = 'fixture-r99-1-worker'
    container(retained, { role: 'worker', drain: 'dead' })
    write(releases(`activated/${retained}`), '')
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('deployment_capacity_blocked')
    expect(result.stderr).toContain(`Retained ${retained}: unknown drain acknowledgement`)
    expect(destructive(result.log, retained)).toEqual([])
    expect(result.log.some((line) => /^(create|run) /.test(line))).toBe(false)
    expect(fieldOf(retained, 'state')).toBe('running')
    expect(fieldOf(retained, 'restart')).toBe('no')
    expect(existsSync(releases(`activated/${retained}`))).toBe(false)
  })
})

describe('rollout-runtime.sh: release containers', () => {
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
      expect(
        result.log.find((line) => line.startsWith('create ') && line.includes(`role=${role} `)),
      ).toContain(`-e DATABASE_POOL_MAX=${size} `)
    }
  })
})

describe('rollout-runtime.sh: failure before cutover', () => {
  it('removes an idle unhealthy candidate BFF and keeps the previous generation serving', () => {
    currentGeneration()
    write(join(root, 'new-bff-health'), 'false\n')
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('did not become healthy')
    expect(result.stderr).toContain('Rollout failed before cutover')
    expect(created(result.log)).toHaveLength(1)
    for (const name of created(result.log)) expect(exists(name)).toBe(false)
    expect(currentPair()).toEqual([currentBff, currentWorker])
    expect(readFileSync(releases('route.json'), 'utf8')).toBe(routeFor(currentBff, currentWorker))
    expect(result.log).not.toContain(
      `exec ${currentWorker} POST /internal/deployment/drain draining`,
    )
    expect(readdirSync(releases('activated'))).toEqual([currentWorker])
    expect(fieldOf(currentBff, 'state')).toBe('running')
    expect(result.log.some((line) => line.startsWith('compose '))).toBe(false)
  })

  it('removes both idle candidates when the new worker never becomes healthy', () => {
    currentGeneration()
    write(join(root, 'new-worker-health'), 'false\n')
    const result = run()
    expect(result.status).not.toBe(0)
    const names = created(result.log)
    expect(names).toHaveLength(2)
    for (const name of names) expect(exists(name)).toBe(false)
    expect(result.log).not.toContain(
      `exec ${currentWorker} POST /internal/deployment/drain draining`,
    )
    expect(fieldOf(currentWorker, 'state')).toBe('running')
  })

  it('checks the tunnel before draining the current worker and cleans up when it points elsewhere', () => {
    currentGeneration()
    rmSync(releases('ingress-ready'))
    write(join(config, 'cloudflared/config.yml'), 'ingress:\n  - service: http://elsewhere:80\n')
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unknown tunnel origin')
    for (const name of created(result.log)) expect(exists(name)).toBe(false)
    expect(result.log).not.toContain(
      `exec ${currentWorker} POST /internal/deployment/drain draining`,
    )
    expect(currentPair()).toEqual([currentBff, currentWorker])
  })

  it('restores admission and restart policy when the new worker cannot be activated', () => {
    currentGeneration()
    write(join(root, 'new-worker-resume-fails'), '')
    const result = run()
    expect(result.status).not.toBe(0)
    const drained = indexOf(
      result.log,
      new RegExp(`^exec ${currentWorker} POST /internal/deployment/drain`),
    )
    expect(drained).toBeGreaterThan(-1)
    expect(result.log.slice(drained + 1)).toContain(
      `exec ${currentWorker} POST /internal/deployment/resume ok`,
    )
    expect(readdirSync(releases('activated'))).toEqual([currentWorker])
    expect(fieldOf(currentWorker, 'restart')).toBe('unless-stopped')
    expect(fieldOf(currentWorker, 'draining')).toBe('false')
    for (const name of created(result.log)) expect(exists(name)).toBe(false)
    expect(currentPair()).toEqual([currentBff, currentWorker])
  })

  it('refuses the first pre-protocol Compose handover before migration or worker stop', () => {
    container('fixture-bff-1', { role: 'bff', ownership: 'compose', drain: 'missing' })
    container('fixture-worker-1', { role: 'worker', ownership: 'compose' })
    write(join(config, 'cloudflared/config.yml'), 'ingress:\n  - service: http://bff:37377\n')
    const result = run({ DEPLOY_RETIRE_LEGACY: '1' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Cannot establish current BFF drain protocol')
    expect(result.log.some((line) => /^(create|run) /.test(line))).toBe(false)
    for (const name of ['fixture-bff-1', 'fixture-worker-1']) {
      expect(fieldOf(name, 'state')).toBe('running')
      expect(destructive(result.log, name)).toEqual([])
    }
    expect(currentPair()).toEqual(['fixture-bff-1', 'fixture-worker-1'])
  })
})

describe('rollout-runtime.sh: release router', () => {
  it('replaces a router running an older image with one on the immutable release image', () => {
    currentGeneration()
    container('fixture-release-router', { image: 'fixture:first' })
    const result = run()
    expect(result.status).toBe(0)
    const renamed = indexOf(
      result.log,
      /^rename fixture-release-router fixture-release-router-retiring$/,
    )
    const started = indexOf(
      result.log,
      /^run .* -d --name fixture-release-router .*sha256:fixture:new/,
    )
    const retired = indexOf(result.log, /^stop -t \d+ fixture-release-router-retiring$/)
    expect(renamed).toBeGreaterThan(-1)
    expect(started).toBeGreaterThan(renamed)
    expect(retired).toBeGreaterThan(started)
    expect(fieldOf('fixture-release-router', 'image')).toBe(newImage)
    expect(exists('fixture-release-router-retiring')).toBe(false)
  })

  it('leaves a router already on the release image alone', () => {
    currentGeneration()
    const result = run()
    expect(result.status).toBe(0)
    expect(
      result.log.some((line) => /^(rename|run .*--name fixture-release-router)/.test(line)),
    ).toBe(false)
  })

  it('puts the old router back when the replacement never becomes healthy', () => {
    currentGeneration()
    container('fixture-release-router', { image: 'fixture:first' })
    write(join(root, 'new---health'), 'false\n')
    const result = run()
    expect(result.status).not.toBe(0)
    expect(fieldOf('fixture-release-router', 'image')).toBe('sha256:fixture:first')
    expect(fieldOf('fixture-release-router', 'state')).toBe('running')
    expect(exists('fixture-release-router-retiring')).toBe(false)
  })
})

describe('rollout-runtime.sh: legacy executor', () => {
  it.each([
    '',
    '1',
  ])('preserves legacy executors without drain proof with retirement flag %j', (flag) => {
    currentGeneration()
    legacyExecutor()
    const result = run({ DEPLOY_RETIRE_LEGACY: flag })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('deployment_capacity_blocked')
    expect(result.log.some((line) => /^(create|run) /.test(line))).toBe(false)
    for (const name of ['fixture-bff-1', 'fixture-worker-1']) {
      expect(fieldOf(name, 'state')).toBe('running')
      expect(destructive(result.log, name)).toEqual([])
    }
    expect(readFileSync(releases('legacy-origin'), 'utf8')).toBe('http://fixture-bff-1:37377\n')
  })

  it('retires protocol-capable idle legacy executors before creating a new generation', () => {
    currentGeneration()
    legacyExecutor('idle')
    const result = run()
    expect(result.status).toBe(0)
    for (const name of ['fixture-bff-1', 'fixture-worker-1']) {
      expect(exists(name)).toBe(false)
      const id = containerIds.get(name)
      expect(destructive(result.log, name)).toEqual([`stop -t 75 ${id}`, `rm ${id}`])
      expect(indexOf(result.log, new RegExp(`^rm ${id}$`))).toBeLessThan(
        indexOf(result.log, /^create /),
      )
    }
    expect(existsSync(releases('legacy-origin'))).toBe(false)
    for (const line of result.log.filter((one) => one.startsWith('create ')))
      expect(line).toContain('-e LEGACY_EXECUTOR_ORIGIN= ')
  })

  it('refuses an unknown legacy origin without touching executors', () => {
    currentGeneration()
    legacyExecutor()
    write(releases('legacy-origin'), 'http://elsewhere:37377\n')
    const result = run({ DEPLOY_RETIRE_LEGACY: '1' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unknown legacy origin')
    expect(result.log.some((line) => /^(stop|rm|create|run) /.test(line))).toBe(false)
    expect(readFileSync(releases('legacy-origin'), 'utf8')).toBe('http://elsewhere:37377\n')
  })

  it('passes the segmenter address to new executors when the deploy started one', () => {
    currentGeneration()
    const result = run({ AGENT_SEGMENTER_URL: 'http://segmenter:8080' })
    expect(result.status).toBe(0)
    const creates = result.log.filter((one) => one.startsWith('create '))
    expect(creates).toHaveLength(2)
    for (const line of creates)
      expect(line).toMatch(
        /-e AGENT_SEGMENTER_URL=http:\/\/segmenter:8080 -e AGENT_SEGMENTER_NAMESPACE=\S+ /,
      )
  })

  it('leaves the segmenter address out entirely when there is none, so app.env stays in charge', () => {
    currentGeneration()
    const result = run({ AGENT_SEGMENTER_URL: '' })
    expect(result.status).toBe(0)
    for (const line of result.log.filter((one) => one.startsWith('create ')))
      expect(line).not.toContain('AGENT_SEGMENTER_')
  })

  it('tolerates a legacy flag when there is no legacy executor recorded', () => {
    currentGeneration()
    const result = run({ DEPLOY_RETIRE_LEGACY: '1' })
    expect(result.status).toBe(0)
    expect(existsSync(releases('legacy-origin'))).toBe(false)
    expect(created(result.log)).toHaveLength(2)
  })
})

describe('app-compose.sh up', () => {
  it('uses the committed route after current and the compose BFF have disappeared', () => {
    config = join(xdg, 'ai-image-playground/apps/fixture')
    write(join(config, 'app.env'), 'APP_IMAGE=fixture:new\n')
    write(join(config, 'migrate.env'), '')
    write(join(config, 'cloudflared/credentials.json'), '{}')
    currentGeneration()
    rmSync(releases('current'))
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
        DEPLOY_DRAIN_DEADLINE_SECONDS: '0',
      },
    })
    expect(result.status).toBe(0)
    const log = logLines()
    expect(created(log)).toHaveLength(2)
    const collector = indexOf(log, /^compose .* up --detach --no-deps log-collector$/)
    expect(collector).toBeGreaterThan(-1)
    expect(collector).toBeLessThan(indexOf(log, /^create /))
    expect(log.some((line) => /up --detach --wait .*dependency-check bff worker/.test(line))).toBe(
      false,
    )
    const [bff, worker] = currentPair()
    expect(readFileSync(releases('route.json'), 'utf8')).toBe(routeFor(bff, worker))
  })

  it('repairs stale current from the route and re-enters the same image without creating executors', () => {
    currentGeneration({ image: newImage }, { image: newImage, draining: true, restart: 'no' })
    write(releases('current'), 'fixture-r99-1-bff fixture-r99-1-worker\n')
    rmSync(releases(`activated/${currentWorker}`))
    const result = run()
    expect(result.status).toBe(0)
    expect(created(result.log)).toEqual([])
    expect(result.log.some((line) => /^(run|stop|rm) /.test(line))).toBe(false)
    expect(currentPair()).toEqual([currentBff, currentWorker])
    expect(fieldOf(currentWorker, 'draining')).toBe('false')
    expect(fieldOf(currentWorker, 'restart')).toBe('unless-stopped')
    expect(existsSync(releases(`activated/${currentWorker}`))).toBe(true)
    expect(result.log).toContainEqual(
      expect.stringMatching(/^compose .* up --detach --no-deps --wait admin$/),
    )
  })
})
