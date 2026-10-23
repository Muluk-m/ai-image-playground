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
    if (sub === 'inspect') {
      if (!s.networks.includes(rest[0])) process.exit(1)
      if (fmt.includes('Containers'))
        process.stdout.write(String(Object.values(s.containers).filter((one) => one.networks.includes(rest[0])).length))
      process.exit(0)
    }
    if (sub === 'create') s.networks.push(rest[rest.length - 1])
    if (sub === 'rm') {
      if (Object.values(s.containers).some((one) => one.networks.includes(rest[0]))) process.exit(1)
      s.networks = s.networks.filter((n) => n !== rest[0])
    }
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
  case 'start':
    c(args[0]).running = true
    save()
    break
  case 'stop':
    c(args[0]).running = false
    save()
    break
  case 'rm':
    if (process.env.FAIL_RM === args[args.length - 1]) process.exit(1)
    // Like Docker: a running container needs -f.
    if (c(args[args.length - 1])?.running && !args.includes('-f')) process.exit(1)
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

  it('rolls back to the previous version only once it answers, swapping the names so it can roll forward again', () => {
    seed({
      [shared]: container({ networks: [shared, ...apps], version: '4' }),
      [`${shared}-prev`]: container({ version: '3', running: false }),
    })
    const result = run(['rollback'])
    expect(result.status, result.stderr).toBe(0)
    let s = read()
    expect(s.containers[shared]).toMatchObject({ version: '3', running: true })
    expect(s.containers[shared]?.networks.sort()).toEqual([shared, ...apps].sort())
    expect(s.containers[`${shared}-prev`]).toMatchObject({ version: '4', running: false })
    expect(s.containers[`${shared}-prev`]?.networks).toEqual([shared])
    const all = calls()
    expect(all.findIndex((c) => c.startsWith(`exec ${shared}-prev `))).toBeLessThan(
      all.findIndex((c) => c.startsWith('network connect')),
    )
    expect(run(['rollback']).status).toBe(0)
    s = read()
    expect(s.containers[shared]).toMatchObject({ version: '4', running: true })
    expect(s.containers[`${shared}-prev`]).toMatchObject({ version: '3', running: false })
  })

  it('leaves the current one serving when the previous version does not answer', () => {
    seed({
      [shared]: container({ networks: [shared, ...apps], version: '4' }),
      [`${shared}-prev`]: container({ version: '3', running: false, answers: false }),
    })
    const result = run(['rollback'], { SEGMENTER_START_TIMEOUT: '0' })
    expect(result.status).not.toBe(0)
    const s = read()
    expect(s.containers[shared]).toMatchObject({ version: '4', running: true })
    expect(s.containers[shared]?.networks).toEqual([shared, ...apps])
    expect(s.containers[`${shared}-prev`]).toMatchObject({ running: false, networks: [shared] })
    seed({ [shared]: container({ version: '4' }) })
    expect(run(['rollback']).status).not.toBe(0)
  })

  it('upgrades from a hand rollback that left -prev serving, without removing it while it serves', () => {
    seed({
      [shared]: container({ networks: [shared], version: '4', running: false }),
      [`${shared}-prev`]: container({ networks: [shared, ...apps], version: '3' }),
    })
    const result = run(['up', 'ai-image-playground:segmenter-5-abc', '5'])
    expect(result.status, result.stderr).toBe(0)
    const s = read()
    expect(s.containers[shared]).toMatchObject({ version: '5', running: true })
    expect(s.containers[shared]?.networks.sort()).toEqual([shared, ...apps].sort())
    // The version that was serving is the rollback copy; the rolled-back one is gone.
    expect(s.containers[`${shared}-prev`]).toMatchObject({ version: '3', running: false })
    expect(s.containers[`${shared}-prev`]?.networks).toEqual([shared])
    expect(Object.keys(s.containers).sort()).toEqual([shared, `${shared}-prev`].sort())
    const all = calls()
    const lastDisconnect =
      all.length -
      1 -
      [...all].reverse().findIndex((c: string) => c.startsWith('network disconnect'))
    expect(all.indexOf(`stop ${shared}-prev`)).toBeGreaterThan(lastDisconnect)
  })

  it('starts the first one when there is none yet', () => {
    seed({})
    expect(run(['up', 'ai-image-playground:segmenter-1-abc', '1']).status).toBe(0)
    expect(read().containers[shared]).toMatchObject({ version: '1', running: true })
  })

  it('attaches an app to the shared container and removes a per-environment instance left on that network, with its own network', () => {
    seed({
      [shared]: container({ version: '1' }),
      [`${shared}-test`]: container({ networks: [`${shared}-test`, apps[1]!] }),
    })
    writeFileSync(
      state,
      JSON.stringify({ ...read(), networks: [shared, `${shared}-test`, apps[1]] }),
    )
    const result = run(['attach', 'image-playground-test'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`removed ${shared}-test`)
    expect(result.stdout).toContain(`removed network ${shared}-test`)
    const s = read()
    expect(s.containers[shared]?.networks).toEqual([shared, apps[1]])
    expect(Object.keys(s.containers)).toEqual([shared])
    expect(s.networks).toEqual([shared, apps[1]])
    // The shared container and its own network are never touched.
    expect(calls().join('\n')).not.toMatch(new RegExp(`^(rm|stop)( -f)? ${shared}$`, 'm'))
    expect(calls().join('\n')).not.toMatch(new RegExp(`^network rm ${shared}$`, 'm'))
  })

  it('removes an already stopped leftover and a network left without its container', () => {
    seed({
      [shared]: container({ version: '1' }),
      [`${shared}-test`]: container({ networks: [`${shared}-test`], running: false }),
    })
    writeFileSync(
      state,
      JSON.stringify({ ...read(), networks: [shared, `${shared}-test`, `${shared}-prod`] }),
    )
    expect(run(['attach', 'image-playground-test']).status).toBe(0)
    const s = read()
    expect(Object.keys(s.containers)).toEqual([shared])
    expect(s.networks).toEqual([shared])
  })

  it('keeps a leftover that still serves another app network, and its network', () => {
    seed({
      [shared]: container({ version: '1' }),
      [`${shared}-prod`]: container({ networks: [`${shared}-prod`, apps[1]!, apps[0]!] }),
    })
    writeFileSync(state, JSON.stringify({ ...read(), networks: [shared, `${shared}-prod`] }))
    expect(run(['attach', 'image-playground-test']).status).toBe(0)
    const s = read()
    expect(s.containers[`${shared}-prod`]).toMatchObject({
      running: true,
      networks: [`${shared}-prod`, apps[0]],
    })
    expect(s.networks).toContain(`${shared}-prod`)
    expect(calls().join('\n')).not.toMatch(/^(rm|stop|network rm) /m)
  })

  it('still succeeds, with a warning, when a leftover cannot be removed', () => {
    seed({
      [shared]: container({ version: '1' }),
      [`${shared}-test`]: container({ networks: [`${shared}-test`, apps[1]!] }),
    })
    writeFileSync(state, JSON.stringify({ ...read(), networks: [shared, `${shared}-test`] }))
    const result = run(['attach', 'image-playground-test'], { FAIL_RM: `${shared}-test` })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain(`could not remove ${shared}-test`)
    const s = read()
    expect(s.containers[shared]?.networks).toEqual([shared, apps[1]])
    expect(s.containers[`${shared}-test`]?.networks).toEqual([`${shared}-test`])
    expect(s.networks).toContain(`${shared}-test`)
  })

  it('is a no-op when attached again with nothing left over', () => {
    seed({ [shared]: container({ version: '1', networks: [shared, apps[1]!] }) })
    expect(run(['attach', 'image-playground-test']).status).toBe(0)
    expect(run(['attach', 'image-playground-test']).status).toBe(0)
    expect(read().containers[shared]?.networks).toEqual([shared, apps[1]])
    expect(calls().join('\n')).not.toMatch(
      /^(rm|stop|run|network (rm|connect|disconnect|create)) /m,
    )
  })

  it('counts a container that answers as serving while Docker still reports it starting', () => {
    // Right after `up` replaced it: Docker's first health check is up to 30 s away.
    seed({ [shared]: container({ version: '2', healthy: false }) })
    expect(run(['healthy']).status).toBe(0)
    expect(run(['current', '2']).status).toBe(0)
    seed({ [shared]: container({ version: '2', healthy: false, answers: false }) })
    expect(run(['healthy']).status).not.toBe(0)
    seed({ [shared]: container({ version: '2', healthy: false, running: false }) })
    expect(run(['healthy']).status).not.toBe(0)
    expect(run(['current', '2']).status).not.toBe(0)
  })

  it('detaches an edition that is not to use it, idempotently, and never touches the container', () => {
    seed({ [shared]: container({ version: '1', networks: [shared, ...apps] }) })
    expect(run(['detach', 'image-playground-test']).status).toBe(0)
    expect(read().containers[shared]?.networks).toEqual([shared, apps[0]])
    expect(run(['detach', 'image-playground-test']).status).toBe(0)
    expect(read().containers[shared]?.networks).toEqual([shared, apps[0]])
    seed({})
    expect(run(['detach', 'image-playground-test']).status).toBe(0)
    expect(calls().filter((c) => c.startsWith('network disconnect'))).toHaveLength(1)
    expect(calls().join('\n')).not.toMatch(/^(rm|stop|run|rename) /m)
  })

  it('reports health and version, and refuses anything else', () => {
    seed({ [shared]: container({ version: '2' }) })
    expect(run(['healthy']).status).toBe(0)
    expect(run(['current', '2']).status).toBe(0)
    expect(run(['current', '3']).status).not.toBe(0)
    expect(run(['up', 'img', 'latest']).status).toBe(2)
    expect(run(['up', 'test', 'img']).status).toBe(2)
    expect(run(['attach', 'test', 'image-playground-test']).status).toBe(2)
    expect(run(['detach']).status).toBe(2)
    expect(run(['rollback', '3']).status).toBe(2)
  })
})
