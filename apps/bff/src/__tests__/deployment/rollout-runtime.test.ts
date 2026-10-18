import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

type Role = 'bff' | 'worker' | 'router' | 'cloudflared'
type Reply = 'normal' | 'unavailable' | 'timeout' | 'malformed' | 'string-safe' | 'missing-safe'
interface Container {
  name: string
  id: string
  role: Role
  image: string
  running: boolean
  status: string
  started: string
  restart: string
  managed: boolean
  draining: boolean
  active: number
  failed: boolean
  reply: Reply
  inspectFailure?: boolean
  changeProcessAfterProof?: boolean
  changeIdentityAfterProof?: boolean
  safeOverride?: boolean
  rejectDrain?: boolean
  healthy?: boolean
}
interface FixtureState {
  containers: Record<string, Container>
  events: { args: string[]; target?: string }[]
  clock: number
  nextId: number
  candidateActive: number
  candidateReply: Reply
  failResume: boolean
  failAncillary: boolean
  crashAfterRoute: boolean
  failMarkerRemoval?: string
}

const project = 'fixture'
const currentBff = 'fixture-r100-1-bff'
const currentWorker = 'fixture-r100-1-worker'
const temporary: string[] = []
setDefaultTimeout(60_000)
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})

const dockerStub = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.env.FIXTURE_STATE;
const state = JSON.parse(readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const find = (name) => state.containers[name] || Object.values(state.containers).find(c => c.id === name);
const target = args.map(find).find(Boolean);
state.events.push({ args: args.map((v, i) => args[i - 1] === '-e' && args[0] === 'exec' ? '<control>' : v), target: target?.name });
const save = () => writeFileSync(path, JSON.stringify(state));
const finish = (text = '', code = 0) => { save(); if (text) console.log(text); process.exit(code); };
const imageId = image => 'sha256:' + image;
if (args[0] === 'image') finish(value('--format').includes('app.execution-protocol') ? '1' : imageId(args.at(-1)));
if (args[0] === 'ps') {
  let all = Object.values(state.containers);
  if (!args.includes('-a') && !args.includes('--all')) all = all.filter(c => c.running);
  args.forEach((arg, i) => {
    if (arg !== '--filter') return;
    const filter = args[i + 1];
    if (filter.startsWith('label=app.runtime.project=')) all = all.filter(c => c.managed);
    if (filter.startsWith('label=app.runtime.role=')) all = all.filter(c => c.role === filter.split('=').at(-1));
    if (filter.startsWith('name=^/')) all = all.filter(c => c.name === filter.slice(7, -1));
  });
  const format = value('--format');
  finish(all.map(c => format.includes('.ID') ? c.id + '\t' + c.name : c.name).join('\n'));
}
if (args[0] === 'inspect') {
  if (!target || target.inspectFailure) finish('', 1);
  const format = args.includes('--format') ? value('--format') : '';
  if (format.startsWith('{{.Id}} ')) {
    if (target.changeProcessAfterProof === 'ready') {
      target.started = '2026-10-18T01:00:01Z';
      target.changeProcessAfterProof = false;
    }
    if (target.changeIdentityAfterProof === 'ready') {
      target.id = 'e'.repeat(64);
      target.changeIdentityAfterProof = false;
    }
    finish([target.id, target.status, String(target.running), target.started, target.restart,
      imageId(target.image), '/' + target.name, target.managed ? 'fixture' : '-',
      target.managed ? target.role : '-', target.managed ? '-' : 'fixture',
      target.managed ? '-' : target.role, target.managed ? target.name.replace(/-(bff|worker)$/, '') : '-'].join(' '));
  }
  if (format === '{{.Image}}') finish(imageId(target.image));
  if (format === '{{.Config.Image}}') finish(target.image);
  if (format === '{{.State.Running}}') finish(String(target.running));
  finish('{}');
}
if (args[0] === 'update') {
  const policy = args.find(arg => arg.startsWith('--restart='))?.split('=')[1];
  for (const arg of args.slice(1)) {
    const c = find(arg);
    if (c) c.restart = policy;
  }
  finish();
}
if (args[0] === 'stop') {
  if (!target) finish('', 1);
  target.running = false;
  target.status = 'exited';
  finish();
}
if (args[0] === 'rm') {
  if (!target || (target.running && !args.includes('-f'))) finish('', 1);
  delete state.containers[target.name];
  finish();
}
if (args[0] === 'start' || args[0] === 'restart') {
  if (!target) finish('', 1);
  target.running = true;
  target.status = 'running';
  finish();
}
if (args[0] === 'rename') {
  if (!target) finish('', 1);
  delete state.containers[target.name];
  target.name = args[2];
  state.containers[target.name] = target;
  finish();
}
if (args[0] === 'network') finish();
if (args[0] === 'run' || args[0] === 'create') {
  const name = value('--name');
  if (name.endsWith('-migrate')) finish();
  const role = name.endsWith('-worker') ? 'worker' : name.endsWith('-bff') ? 'bff' : 'router';
  const image = args.find(arg => ['old', 'new', 'third'].includes(arg));
  state.containers[name] = { name, id: (++state.nextId).toString(16).padStart(64, '0'), role, image,
    running: args[0] === 'run', status: args[0] === 'run' ? 'running' : 'created',
    started: '2026-10-18T01:00:00Z', restart: 'unless-stopped', managed: role !== 'router',
    draining: role === 'worker', active: role === 'bff' ? state.candidateActive : 0,
    failed: false, reply: role === 'router' ? 'normal' : state.candidateReply };
  finish(name);
}
if (args[0] === 'compose') {
  if (args.includes('config')) finish('new');
  if (args.includes('admin') && state.failAncillary) {
    state.failAncillary = false;
    finish('', 1);
  }
  finish();
}
if (args[0] === 'exec') {
  if (!target || !target.running) finish('', 1);
  const [port, method, endpoint, field] = args.slice(-4);
  let status = 200;
  let payload;
  if (endpoint === '/health') payload = { ok: target.healthy ?? true };
  else if (target.reply === 'unavailable') { status = 404; payload = { error: 'not_found' }; }
  else if (target.reply === 'timeout') finish('', 124);
  else if (endpoint.endsWith('/resume')) {
    target.draining = false;
    if (target.name !== 'fixture-r100-1-worker' && state.failResume) {
      target.active = 1;
      payload = { ok: false };
    } else payload = { ok: true };
  } else {
    if (method === 'POST' && !target.rejectDrain) target.draining = true;
    payload = { draining: target.draining, active: target.active, failed: target.failed,
      safeToStop: target.safeOverride ?? (target.draining && target.active === 0 && !target.failed) };
    if (target.reply === 'string-safe') payload.safeToStop = 'true';
    if (target.reply === 'missing-safe') delete payload.safeToStop;
    if (target.changeProcessAfterProof && field === 'retirement' && method === 'GET') target.changeProcessAfterProof = 'ready';
    if (target.changeIdentityAfterProof && field === 'retirement' && method === 'GET') target.changeIdentityAfterProof = 'ready';
  }
  const body = target.reply === 'malformed' && endpoint.includes('/drain') ? '{' : JSON.stringify(payload);
  save();
  globalThis.fetch = async () => new Response(body, { status });
  await new Function('return (async () => {' + value('-e') + '})()')();
  process.exit(0);
}
finish('Unsupported docker command: ' + args.join(' '), 2);
`

function container(name: string, role: Role, overrides: Partial<Container> = {}): Container {
  return {
    name,
    id: (name.endsWith('worker') ? '2' : '1').repeat(64),
    role,
    image: 'old',
    running: true,
    status: 'running',
    started: '2026-10-18T00:00:00Z',
    restart: 'unless-stopped',
    managed: name.includes('-r100-'),
    draining: false,
    active: 0,
    failed: false,
    reply: 'normal',
    ...overrides,
  }
}

async function fixture(overrides: Partial<FixtureState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aip-rollout-'))
  temporary.push(root)
  const bin = join(root, 'bin')
  const scripts = join(root, 'scripts')
  const config = join(root, 'config')
  const releases = join(config, 'releases')
  const statePath = join(root, 'state.json')
  for (const dir of [bin, join(scripts, 'lib'), join(releases, 'activated'), join(config, 'cloudflared')])
    await mkdir(dir, { recursive: true })
  for (const file of ['rollout-runtime.sh', 'app-compose.sh', 'lib/deploy-common.sh'])
    await copyFile(resolve(import.meta.dir, '../../../../../scripts', file), join(scripts, file))
  await writeFile(join(config, 'app.env'), '')
  await writeFile(join(config, 'migrate.env'), '')
  await writeFile(join(config, 'cloudflared/config.yml'), 'service: http://release-router:37377\n')
  await writeFile(join(config, 'cloudflared/credentials.json'), '{}')
  await writeFile(join(releases, 'route.json'), JSON.stringify({ origin: `http://${currentBff}:37377` }))
  await writeFile(join(releases, 'current'), `${currentBff} ${currentWorker}\n`)
  await writeFile(join(releases, 'ingress-ready'), '')
  await writeFile(join(releases, 'activated', currentWorker), '')
  const state: FixtureState = {
    containers: {
      [currentBff]: container(currentBff, 'bff'),
      [currentWorker]: container(currentWorker, 'worker'),
      'fixture-release-router': container('fixture-release-router', 'router', { id: '3'.repeat(64) }),
      'fixture-cloudflared-1': container('fixture-cloudflared-1', 'cloudflared', { id: '4'.repeat(64) }),
    },
    events: [],
    clock: 1_000,
    nextId: 10,
    candidateActive: 0,
    candidateReply: 'normal',
    failResume: false,
    failAncillary: false,
    crashAfterRoute: false,
    ...overrides,
  }
  await writeFile(statePath, JSON.stringify(state))
  const executable = async (name: string, code: string) =>
    writeFile(join(bin, name), `#!${process.execPath}\n${code}`, { mode: 0o755 })
  await executable('docker', dockerStub)
  await executable('timeout', `const p = Bun.spawn(process.argv.slice(3), { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }); process.exit(await p.exited);`)
  await executable('date', String.raw`
const path = process.env.FIXTURE_STATE;
const state = await Bun.file(path).json();
if (process.argv.at(-1) === '+%s') { state.clock += 100; await Bun.write(path, JSON.stringify(state)); console.log(state.clock); }
else console.log('20261018000000');
`)
  await executable('sleep', '')
  await executable('rm', String.raw`
const args = process.argv.slice(2);
const state = await Bun.file(process.env.FIXTURE_STATE).json();
if (state.failMarkerRemoval && args.some(arg => arg.endsWith('/activated/' + state.failMarkerRemoval))) process.exit(1);
const p = Bun.spawn(['/bin/rm', ...args], { stdout: 'inherit', stderr: 'inherit' });
process.exit(await p.exited);
`)
  await executable('mv', String.raw`
const args = process.argv.slice(2);
const p = Bun.spawn(['/bin/mv', ...args], { stdout: 'inherit', stderr: 'inherit' });
const code = await p.exited;
const state = await Bun.file(process.env.FIXTURE_STATE).json();
if (code === 0 && args.at(-1).endsWith('/route.json') && state.crashAfterRoute) {
  state.crashAfterRoute = false;
  await Bun.write(process.env.FIXTURE_STATE, JSON.stringify(state));
  process.kill(process.ppid, 'SIGKILL');
}
process.exit(code);
`)
  return { root, bin, config, releases, scripts, statePath }
}

async function readState(f: Awaited<ReturnType<typeof fixture>>): Promise<FixtureState> {
  return JSON.parse(await readFile(f.statePath, 'utf8'))
}

async function editState(
  f: Awaited<ReturnType<typeof fixture>>,
  edit: (state: FixtureState) => void,
) {
  const state = await readState(f)
  edit(state)
  await writeFile(f.statePath, JSON.stringify(state))
}

async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  image = 'new',
  entry: 'rollout' | 'up' | 'down' | 'rollback' = 'rollout',
) {
  const args =
    entry === 'rollout'
      ? ['rollout-runtime.sh', project, image]
      : entry === 'rollback'
        ? ['app-compose.sh', entry, project, image, join(f.config, 'app.env')]
        : ['app-compose.sh', entry, project, join(f.config, 'app.env')]
  const proc = Bun.spawn(['sh', join(f.scripts, args[0]), ...args.slice(1)], {
    env: {
      PATH: `${f.bin}:${process.env.PATH}`,
      HOME: f.root,
      XDG_CONFIG_HOME: join(f.root, 'xdg'),
      APP_CONFIG_DIR: f.config,
      APP_IMAGE: image,
      DEPLOY_DRAIN_DEADLINE_SECONDS: '0',
      DEPLOY_RETIRE_LEGACY: '1',
      FIXTURE_STATE: f.statePath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill(), 20_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function destructiveEvents(state: FixtureState, name: string) {
  return state.events.filter(
    (event) => event.target === name && ['stop', 'rm', 'kill'].includes(event.args[0]),
  )
}

function creations(state: FixtureState) {
  return state.events.filter((event) => ['create', 'run'].includes(event.args[0]))
}

async function addRetained(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<Container>) {
  const name = 'fixture-r99-1-worker'
  await editState(f, (state) => {
    state.containers[name] = container(name, 'worker', {
      id: '5'.repeat(64),
      managed: true,
      ...overrides,
    })
  })
  return name
}

describe('executor-preserving rollout', () => {
  it('retires idle executors only after disabling restart and validating the drain', async () => {
    const f = await fixture()
    const result = await run(f)
    expect(result.code).toBe(0)
    const state = await readState(f)
    for (const name of [currentBff, currentWorker]) {
      expect(state.containers[name]).toBeUndefined()
      expect(destructiveEvents(state, name).map((event) => event.args[0])).toEqual(['stop', 'rm'])
      const stopIndex = state.events.findIndex((event) => event.target === name && event.args[0] === 'stop')
      expect(state.events.slice(0, stopIndex).some((event) => event.target === name && event.args.includes('--restart=no'))).toBe(true)
      expect(destructiveEvents(state, name).every((event) => !event.args.includes('-f'))).toBe(true)
    }
    expect(state.events.some((event) => event.args[0] === 'compose' && event.args.includes('admin'))).toBe(true)
  })

  it('keeps busy old work across the deadline and blocks a third generation before migration', async () => {
    const f = await fixture()
    await editState(f, (state) => { state.containers[currentWorker].active = 1 })
    expect((await run(f)).code).toBe(0)
    const first = await readState(f)
    expect(first.containers[currentWorker].running).toBe(true)
    expect(destructiveEvents(first, currentWorker)).toEqual([])
    const second = await run(f, 'third')
    expect(second.code).not.toBe(0)
    expect(second.stderr).toContain('deployment_capacity_blocked')
    const blocked = await readState(f)
    expect(creations(blocked)).toEqual(creations(first))
    expect(destructiveEvents(blocked, currentWorker)).toEqual([])
    await editState(f, (state) => { state.containers[currentWorker].active = 0 })
    expect((await run(f, 'third')).code).toBe(0)
    expect((await readState(f)).containers[currentWorker]).toBeUndefined()
  })

  for (const [label, overrides] of Object.entries({
    busy: { active: 1 },
    unavailable: { reply: 'unavailable' },
    timeout: { reply: 'timeout' },
    malformed: { reply: 'malformed' },
    'string boolean': { reply: 'string-safe' },
    'missing field': { reply: 'missing-safe' },
    'inconsistent safe status': { active: 1, safeOverride: true },
    'inspect failure': { inspectFailure: true },
    restarting: { status: 'restarting' },
    'process changed': { changeProcessAfterProof: true },
    'container changed': { changeIdentityAfterProof: true },
  } satisfies Record<string, Partial<Container>>)) {
    it(`preserves a retained executor with ${label} without creating another generation`, async () => {
      const f = await fixture()
      const name = await addRetained(f, overrides)
      expect((await run(f)).code).not.toBe(0)
      const state = await readState(f)
      expect(state.containers[name].running).toBe(true)
      expect(destructiveEvents(state, name)).toEqual([])
      expect(creations(state)).toEqual([])
    })
  }

  it('preserves a worker when its activation marker cannot be removed', async () => {
    const f = await fixture()
    const name = await addRetained(f, {})
    await writeFile(join(f.releases, 'activated', name), '')
    await editState(f, (state) => { state.failMarkerRemoval = name })
    const result = await run(f)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('activation marker could not be removed')
    const state = await readState(f)
    expect(state.containers[name].running).toBe(true)
    expect(destructiveEvents(state, name)).toEqual([])
    expect(creations(state)).toEqual([])
    expect(await readFile(join(f.releases, 'activated', name), 'utf8')).toBe('')
  })

  it('preserves failed finalization even when an old BFF reports safeToStop', async () => {
    const f = await fixture()
    await editState(f, (state) => {
      state.containers[currentBff].failed = true
      state.containers[currentBff].safeOverride = true
    })
    expect((await run(f)).code).toBe(0)
    const state = await readState(f)
    expect(state.containers[currentBff].running).toBe(true)
    expect(destructiveEvents(state, currentBff)).toEqual([])
  })

  it('removes a proven stopped leftover with plain rm and allows rollout', async () => {
    const f = await fixture()
    const name = await addRetained(f, { running: false, status: 'exited' })
    expect((await run(f)).code).toBe(0)
    const state = await readState(f)
    expect(destructiveEvents(state, name).map((event) => event.args[0])).toEqual(['rm'])
    expect(state.containers[name]).toBeUndefined()
  })

  it('preserves active candidates after activation failure and restores current admission', async () => {
    const f = await fixture({ candidateActive: 1, failResume: true })
    expect((await run(f)).code).not.toBe(0)
    const state = await readState(f)
    const candidates = Object.values(state.containers).filter((c) => c.managed && ![currentBff, currentWorker].includes(c.name))
    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) {
      expect(candidate.running).toBe(true)
      expect(candidate.draining).toBe(true)
      expect(destructiveEvents(state, candidate.name)).toEqual([])
    }
    expect(state.containers[currentWorker].draining).toBe(false)
    expect(state.containers[currentWorker].restart).toBe('unless-stopped')
    expect(await readFile(join(f.releases, 'activated', currentWorker), 'utf8')).toBe('')
    expect(await readFile(join(f.releases, 'current'), 'utf8')).toBe(`${currentBff} ${currentWorker}\n`)
  })

  it('refuses cutover without the old worker drain acknowledgement', async () => {
    const f = await fixture()
    await editState(f, (state) => { state.containers[currentWorker].rejectDrain = true })
    expect((await run(f)).code).not.toBe(0)
    expect(await readFile(join(f.releases, 'current'), 'utf8')).toBe(`${currentBff} ${currentWorker}\n`)
    const state = await readState(f)
    expect(state.containers[currentWorker].draining).toBe(false)
    expect(destructiveEvents(state, currentWorker)).toEqual([])
  })

  it('preserves unknown candidates when activation fails', async () => {
    const f = await fixture({ candidateReply: 'unavailable' })
    expect((await run(f)).code).not.toBe(0)
    const state = await readState(f)
    const candidates = Object.values(state.containers).filter(
      (c) => c.managed && ![currentBff, currentWorker].includes(c.name),
    )
    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) {
      expect(candidate.running).toBe(true)
      expect(destructiveEvents(state, candidate.name)).toEqual([])
    }
    expect(state.containers[currentWorker].draining).toBe(false)
  })

  it('does not call an unhealthy current generation a successful same-image retry', async () => {
    const f = await fixture()
    await editState(f, (state) => { state.containers[currentWorker].healthy = false })
    expect((await run(f, 'old')).code).not.toBe(0)
    const state = await readState(f)
    expect(creations(state)).toEqual([])
    expect(destructiveEvents(state, currentWorker)).toEqual([])
  })

  it('recovers a route commit interrupted before current and converges the same image', async () => {
    const f = await fixture({ crashAfterRoute: true })
    await editState(f, (state) => { state.containers[currentWorker].active = 1 })
    expect((await run(f)).code).not.toBe(0)
    const route = JSON.parse(await readFile(join(f.releases, 'route.json'), 'utf8'))
    expect(route.origin).not.toBe(`http://${currentBff}:37377`)
    expect(await readFile(join(f.releases, 'current'), 'utf8')).toBe(`${currentBff} ${currentWorker}\n`)
    const interrupted = await readState(f)
    expect((await run(f)).code).toBe(0)
    const state = await readState(f)
    expect(creations(state)).toEqual(creations(interrupted))
    expect(await readFile(join(f.releases, 'current'), 'utf8')).toBe(`${route.origin.slice(7, -6)} ${route.worker}\n`)
    expect(destructiveEvents(state, route.worker)).toEqual([])
  })

  it('restores a paused current worker before a re-entry capacity refusal', async () => {
    const f = await fixture()
    await addRetained(f, { active: 1 })
    await editState(f, (state) => {
      state.containers[currentWorker].draining = true
      state.containers[currentWorker].restart = 'no'
    })
    await rm(join(f.releases, 'activated', currentWorker))
    expect((await run(f)).code).not.toBe(0)
    const state = await readState(f)
    expect(state.containers[currentWorker].draining).toBe(false)
    expect(state.containers[currentWorker].restart).toBe('unless-stopped')
    expect(await readFile(join(f.releases, 'activated', currentWorker), 'utf8')).toBe('')
  })

  it('retries ancillary failure without creating a generation and applies the cap to rollback', async () => {
    const f = await fixture({ failAncillary: true })
    await editState(f, (state) => { state.containers[currentWorker].active = 1 })
    expect((await run(f)).code).not.toBe(0)
    const failed = await readState(f)
    expect((await run(f)).code).toBe(0)
    expect(creations(await readState(f))).toEqual(creations(failed))
    expect((await run(f, 'old', 'rollback')).code).not.toBe(0)
    expect(creations(await readState(f))).toEqual(creations(failed))
  })

  it('uses route and inventory to keep app-compose up/down on the managed path', async () => {
    const f = await fixture()
    await rm(join(f.releases, 'current'))
    expect((await run(f, 'old', 'up')).code).toBe(0)
    await rm(join(f.releases, 'current'))
    await rm(join(f.releases, 'route.json'))
    expect((await run(f, 'old', 'down')).code).not.toBe(0)
    expect((await run(f, 'old', 'up')).code).not.toBe(0)
    const state = await readState(f)
    expect(state.events.some((event) => event.args[0] === 'compose' && (event.args.includes('down') || event.args.includes('bff')))).toBe(false)
    expect(creations(state)).toEqual([])
  })

  it('fails closed on malformed route without retiring any executor', async () => {
    const f = await fixture()
    await writeFile(join(f.releases, 'route.json'), '{broken')
    expect((await run(f)).code).not.toBe(0)
    const state = await readState(f)
    expect(state.events.filter((event) => ['stop', 'rm', 'kill'].includes(event.args[0]))).toEqual([])
    expect(creations(state)).toEqual([])
  })

  it('keeps legacy executors without drain proof even with the legacy retirement flag', async () => {
    const f = await fixture()
    const names = ['fixture-bff-1', 'fixture-worker-1']
    await editState(f, (state) => {
      state.containers[names[0]] = container(names[0], 'bff', { id: '6'.repeat(64), reply: 'unavailable' })
      state.containers[names[1]] = container(names[1], 'worker', { id: '7'.repeat(64), reply: 'unavailable' })
    })
    await writeFile(join(f.releases, 'legacy-origin'), 'http://fixture-bff-1:37377\n')
    expect((await run(f)).code).not.toBe(0)
    const state = await readState(f)
    for (const name of names) {
      expect(state.containers[name].running).toBe(true)
      expect(destructiveEvents(state, name)).toEqual([])
    }
    expect(creations(state)).toEqual([])
    expect(await readFile(join(f.releases, 'legacy-origin'), 'utf8')).toBe('http://fixture-bff-1:37377\n')
  })

  it('refuses the first pre-protocol Compose handover before migration or worker stop', async () => {
    const f = await fixture()
    await rm(join(f.releases, 'current'))
    await rm(join(f.releases, 'route.json'))
    await editState(f, (state) => {
      delete state.containers[currentBff]
      delete state.containers[currentWorker]
      state.containers['fixture-bff-1'] = container('fixture-bff-1', 'bff', {
        reply: 'unavailable',
      })
      state.containers['fixture-worker-1'] = container('fixture-worker-1', 'worker', {
        reply: 'unavailable',
      })
    })
    expect((await run(f)).code).not.toBe(0)
    const state = await readState(f)
    expect(creations(state)).toEqual([])
    expect(destructiveEvents(state, 'fixture-bff-1')).toEqual([])
    expect(destructiveEvents(state, 'fixture-worker-1')).toEqual([])
  })
})
