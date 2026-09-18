import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture(mode: string) {
  const root = await mkdtemp(join(tmpdir(), 'aip-rollout-'))
  temporary.push(root)
  const bin = join(root, 'bin')
  const config = join(root, 'config')
  await mkdir(bin)
  await mkdir(join(config, 'cloudflared'), { recursive: true })
  await writeFile(join(config, 'app.env'), '')
  await writeFile(join(config, 'migrate.env'), '')
  await writeFile(
    join(config, 'cloudflared/config.yml'),
    'ingress:\n  - service: http://bff:37377\n',
  )
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh
set -eu
case "$1" in
  image) echo 1 ;;
  inspect) [ -f "$MOCK_ROOT/router" ] ;;
  create) echo "$3" >> "$MOCK_ROOT/created" ;;
  run)
    case "$*" in *release-router*) touch "$MOCK_ROOT/router" ;; esac
    ;;
  exec)
    container=$2
    for value in "$@"; do field=$value; done
    case "$*" in
      *37377*GET*/internal/deployment/drain*)
        if [ "$MOCK_MODE" = legacy-busy ] && [ "$container" = fixture-bff-1 ]; then exit 44; fi ;;
    esac
    printf 'probe %s %s %s\\n' "$container" "$field" "$*" >> "$MOCK_ROOT/log"
    if [ "$field" = safeToStop ]; then
      case "$MOCK_MODE" in
        busy|legacy-busy) echo false; exit 0 ;;
      esac
    fi
    echo true
    ;;
  stop) printf 'stop %s\\n' "$*" >> "$MOCK_ROOT/log" ;;
  ps)
    case "$*" in
      *role=worker*) echo fixture-retained-worker ;;
      *role=bff*) echo fixture-retained-bff ;;
    esac
    ;;
  restart) echo restart >> "$MOCK_ROOT/log" ;;
  *) : ;;
esac
`,
  )
  await chmod(join(bin, 'docker'), 0o755)
  const proc = Bun.spawn(
    [
      'sh',
      resolve(import.meta.dir, '../../../../../scripts/rollout-runtime.sh'),
      'fixture',
      'fixture:release',
    ],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        APP_CONFIG_DIR: config,
        MOCK_ROOT: root,
        MOCK_MODE: mode,
        DEPLOY_DRAIN_WAIT_SECONDS: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { root, config, code, stdout, stderr, log: await readFile(join(root, 'log'), 'utf8') }
}

describe('executor-preserving rollout', () => {
  it('retains busy executors after cutover instead of forcing them to exit', async () => {
    const result = await fixture('busy')
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Retained without cancellation')
    expect(result.log).not.toContain('stop ')
    const [bff, worker] = (await readFile(join(result.config, 'releases/current'), 'utf8'))
      .trim()
      .split(' ')
    expect(await readFile(join(result.config, 'releases/route.json'), 'utf8')).toContain(bff!)
    expect(await Bun.file(join(result.config, 'releases/activated', worker!)).exists()).toBe(true)
  })

  it('does not stop or switch a legacy worker that is still executing', async () => {
    const result = await fixture('legacy-busy')
    expect(result.code).not.toBe(0)
    expect(result.log).not.toContain('stop ')
    expect(await Bun.file(join(result.config, 'releases/current')).exists()).toBe(false)
  })

  it('stops supported old instances only after observing safeToStop', async () => {
    const result = await fixture('idle')
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.log.indexOf('fixture-retained-worker draining')).toBeLessThan(
      result.log.indexOf('/internal/deployment/resume ok'),
    )
    for (const name of ['fixture-retained-worker', 'fixture-retained-bff']) {
      expect(result.log.indexOf(`probe ${name} safeToStop`)).toBeLessThan(
        result.log.indexOf(`stop stop ${name}`),
      )
    }
    expect(result.log).toContain('stop stop fixture-worker-1 fixture-bff-1')
  })
})
