import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(__dirname, '../../../../../scripts/segmenter-deploy.sh')
const shared = 'image-playground-segmenter'
const label = 'online.muvloom.segmenter.version'
let root: string
let log: string
let state: string

interface Container {
  networks: string[]
  version: string
  healthy: boolean
  running: boolean
  answers: boolean
}
type State = { containers: Record<string, Container>; networks: string[] }

/**
 * A fake docker that keeps containers and networks in a JSON file, so the script's moves can be
 * checked by where every network ends up. `run` creates the candidate as $NEXT_* describe;
 * $FAIL_CONNECT=<network> makes connecting that network fail.
 */
const FAKE = `#!${process.execPath}
const fs = require('node:fs')
const [cmd, ...args] = process.argv.slice(2)
fs.appendFileSync(process.env.CALL_LOG, [cmd, ...args].join(' ') + '\\n')
const s = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'))
const save = () => fs.writeFileSync(process.env.STATE, JSON.stringify(s))
const c = (name) => s.containers[name]
const fmt = args[args.indexOf('--format') + 1] ?? ''
switch (cmd) {
  case 'inspect': {
    const one = c(args[0])
    if (!one) process.exit(1)
    if (fmt.includes('Networks')) process.stdout.write(one.networks.map((n) => n + ' ').join(''))
    else if (fmt.includes('Health')) process.stdout.write(one.running && one.healthy ? 'healthy' : 'unhealthy')
    else if (fmt.includes('Labels')) process.stdout.write(one.version)
    else if (fmt.includes('Running')) process.stdout.write(String(one.running))
    break
  }
  case 'network': {
    const [sub, ...rest] = args
    if (sub === 'inspect') process.exit(s.networks.includes(rest[0]) ? 0 : 1)
    if (sub === 'create') s.networks.push(rest[rest.length - 1])
    if (sub === 'connect') {
      const [net, name] = rest.slice(-2)
      if (process.env.FAIL_CONNECT === net + ':' + name) process.exit(1)
      c(name).networks.push(net)
    }
    if (sub === 'disconnect') c(rest[1]).networks = c(rest[1]).networks.filter((n) => n !== rest[0])
    save()
    break
  }
  case 'run': {
    const name = args[args.indexOf('--name') + 1]
    s.containers[name] = {
      networks: [args[args.indexOf('--network') + 1]],
      version: args[args.indexOf('--label') + 1].split('=')[1],
      healthy: process.env.NEXT_HEALTHY !== '0',
      running: process.env.NEXT_RUNNING !== '0',
      answers: process.env.NEXT_HEALTHY !== '0',
    }
    save()
    break
  }
  case 'exec':
    process.exit(c(args[0])?.answers ? 0 : 1)
  case 'stop':
    c(args[0]).running = false
    save()
    break
  case 'rm':
    delete s.containers[args[args.length - 1]]
    save()
    break
  case 'rename':
    s.containers[args[1]] = c(args[0])
    delete s.containers[args[0]]
    save()
    break
}
`

function run(args: string[], extra: Record<string, string> = {}) {
  return spawnSync('sh', [script, ...args], {
    env: {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
      CALL_LOG: log,
      STATE: state,
      SEGMENTER_START_TIMEOUT: '4',
      ...extra,
    },
    encoding: 'utf8',
  })
}
const read = (): State => JSON.parse(readFileSync(state, 'utf8'))
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
const container = (over: Partial<Container> = {}): Container => ({
  networks: [shared],
  version: '',
  healthy: true,
  running: true,
  answers: true,
  ...over,
})
const seed = (containers: Record<string, Container>) =>
  writeFileSync(state, JSON.stringify({ containers, networks: [shared] }))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'segmenter-deploy-'))
  log = join(root, 'calls.log')
  state = join(root, 'state.json')
  writeFileSync(log, '')
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/docker'), FAKE)
  chmodSync(join(root, 'bin/docker'), 0o755)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('segmenter-deploy.sh (one shared, versioned container)', () => {
  const apps = ['image-playground-internal_application', 'image-playground-test_application']

  it('leaves the running segmenter alone when it already runs that version', () => {
    seed({ [shared]: container({ networks: [shared, ...apps], version: '3' }) })
    const result = run(['up', 'ai-image-playground:segmenter-3-abc', '3'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('already running')
    expect(calls().join('\n')).not.toMatch(/^(run|stop|rm|rename|network) /m)
  })

  it('starts a new version next to the old one, moves every app network once it is healthy, and keeps the old one stopped', () => {
    // The container that exists today has no version label.
    seed({ [shared]: container({ networks: [shared, ...apps] }) })
    const result = run(['up', 'ai-image-playground:segmenter-4-abc', '4'])
    expect(result.status, result.stderr).toBe(0)
    const s = read()
    expect(s.containers[shared]).toMatchObject({ version: '4', running: true })
    expect(s.containers[shared]?.networks.sort()).toEqual([shared, ...apps].sort())
    expect(s.containers[`${shared}-prev`]).toMatchObject({ version: '', running: false })
    expect(s.containers[`${shared}-prev`]?.networks).toEqual([shared])
    expect(s.containers[`${shared}-next`]).toBeUndefined()
    const all = calls()
    // The old one served until the new one answered.
    const answered = all.findIndex((c) => c.startsWith(`exec ${shared}-next `))
    expect(answered).toBeGreaterThan(-1)
    expect(answered).toBeLessThan(all.findIndex((c) => c.startsWith('network connect')))
    expect(answered).toBeLessThan(all.indexOf(`stop ${shared}`))
    expect(all.join('\n')).not.toMatch(new RegExp(`^rm( -f)? ${shared}$`, 'm'))
  })

  it('removes only its own candidate and leaves the old one untouched when the new version never gets healthy', () => {
    seed({ [shared]: container({ networks: [shared, ...apps], version: '3' }) })
    const result = run(['up', 'ai-image-playground:segmenter-4-abc', '4'], {
      NEXT_HEALTHY: '0',
      SEGMENTER_START_TIMEOUT: '0',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('the running one was left untouched')
    const s = read()
    expect(s.containers[shared]).toMatchObject({ version: '3', running: true })
    expect(s.containers[shared]?.networks).toEqual([shared, ...apps])
    expect(Object.keys(s.containers)).toEqual([shared])
  })

  it('gives every network back to the old container when the move fails halfway', () => {
    seed({ [shared]: container({ networks: [shared, ...apps], version: '3' }) })
    const result = run(['up', 'ai-image-playground:segmenter-4-abc', '4'], {
      FAIL_CONNECT: `${apps[1]}:${shared}-next`,
    })
    expect(result.status).not.toBe(0)
    const s = read()
    expect(s.containers[shared]).toMatchObject({ version: '3', running: true })
    expect(s.containers[shared]?.networks.sort()).toEqual([shared, ...apps].sort())
    expect(s.containers[`${shared}-next`]?.networks).toEqual([shared])
  })

  it('starts the first one when there is none yet', () => {
    seed({})
    expect(run(['up', 'ai-image-playground:segmenter-1-abc', '1']).status).toBe(0)
    expect(read().containers[shared]).toMatchObject({ version: '1', running: true })
  })

  it('attaches an app to the shared container and stops a per-environment instance left on that network', () => {
    seed({
      [shared]: container({ version: '1' }),
      [`${shared}-test`]: container({ networks: [`${shared}-test`, apps[1]!] }),
    })
    expect(run(['attach', 'image-playground-test']).status).toBe(0)
    const s = read()
    expect(s.containers[shared]?.networks).toEqual([shared, apps[1]])
    expect(s.containers[`${shared}-test`]).toMatchObject({
      running: false,
      networks: [`${shared}-test`],
    })
    expect(calls().join('\n')).not.toMatch(/^rm /m)
  })

  it('reports health and version, and refuses anything else', () => {
    seed({ [shared]: container({ version: '2' }) })
    expect(run(['healthy']).status).toBe(0)
    expect(run(['current', '2']).status).toBe(0)
    expect(run(['current', '3']).status).not.toBe(0)
    expect(run(['up', 'img', 'latest']).status).toBe(2)
    expect(run(['up', 'test', 'img']).status).toBe(2)
    expect(run(['attach', 'test', 'image-playground-test']).status).toBe(2)
  })
})
