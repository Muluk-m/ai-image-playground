import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** Ships a release to the VPS receiver; waits on the lock only behind the other environment's CI deploy. */
const script = resolve(__dirname, '../../../../../scripts/ci-ship-release.sh')
const releaseId = `aip-${'a'.repeat(12)}-${'b'.repeat(12)}`
let root: string
let release: string
let fakeSsh: string
let calls: string

function busyBy(what: string): string {
  return [
    'Refusing to start: another rollout holds /home/deploy/.config/ai-image-playground/deploy.lock.',
    '  pid=4242',
    `  what=${what}`,
    'Nothing was changed.',
  ].join('\n')
}

/** Each call consumes the next `exit|stderr` line from the plan file; the last line repeats. */
function planSsh(steps: Array<{ exit: number; stderr?: string }>) {
  writeFileSync(
    join(root, 'plan'),
    steps.map((step) => `${step.exit}|${(step.stderr ?? '').replace(/\n/g, '\\n')}`).join('\n'),
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-ci-ship-'))
  release = join(root, releaseId)
  mkdirSync(release)
  writeFileSync(join(release, 'images.tsv'), 'manifest\n')
  calls = join(root, 'calls')
  fakeSsh = join(root, 'ssh')
  writeFileSync(
    fakeSsh,
    `#!/usr/bin/env bash
cat > /dev/null
n=$(( $(wc -l < "${calls}" 2>/dev/null || echo 0) + 1 ))
printf '%s\\n' "\${@: -1}" >> "${calls}"
total=$(wc -l < "${join(root, 'plan')}"); total=$((total + 1))
line=$(sed -n "$(( n < total ? n : total ))p" "${join(root, 'plan')}")
printf '%b' "\${line#*|}" >&2
exit "\${line%%|*}"
`,
  )
  chmodSync(fakeSsh, 0o755)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function ship(target: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [script, release, target, '777'], {
    env: {
      ...process.env,
      AIP_SHIP_SSH: fakeSsh,
      DEPLOY_LOCK_RETRY_SECONDS: '0',
      DEPLOY_LOCK_WAIT_SECONDS: '5',
      ...env,
    },
    encoding: 'utf8',
    timeout: 20000,
  })
}

function callCount(): number {
  return readFileSync(calls, 'utf8').trim().split('\n').length
}

describe('ci-ship-release.sh', () => {
  it('ships once and passes the receiver command through', () => {
    planSsh([{ exit: 0 }])
    const result = ship('paid')
    expect(result.status).toBe(0)
    expect(readFileSync(calls, 'utf8').trim()).toBe(`deploy ${releaseId} paid 777`)
  })

  it('production waits while the test CI deploy holds the lock, then rolls out', () => {
    planSsh([
      { exit: 75, stderr: busyBy('receive test /home/deploy/releases/aip-x') },
      { exit: 75, stderr: busyBy('receive test /home/deploy/releases/aip-x') },
      { exit: 0 },
    ])
    const result = ship('paid')
    expect(result.status).toBe(0)
    expect(callCount()).toBe(3)
    expect(result.stdout).toContain('The test deploy holds the VPS deploy lock')
  })

  it('test waits while the production CI deploy holds the lock', () => {
    planSsh([{ exit: 75, stderr: busyBy('receive paid /home/deploy/releases/aip-y') }, { exit: 0 }])
    const result = ship('test')
    expect(result.status).toBe(0)
    expect(callCount()).toBe(2)
  })

  it.each([
    'app-compose rollback image-playground',
    'runtime image-playground ai-image-playground:paid-abc',
    'receive paid /home/deploy/releases/aip-z',
  ])('production fails at once when %s holds the lock', (holder) => {
    planSsh([{ exit: 75, stderr: busyBy(holder) }, { exit: 0 }])
    const result = ship('paid')
    expect(result.status).toBe(75)
    expect(callCount()).toBe(1)
    expect(result.stdout).toContain('not the test CI deploy')
  })

  it('fails at once when the holder has not written its owner file yet', () => {
    planSsh([
      { exit: 75, stderr: '  (no owner file yet: the other rollout is still taking the lock)\n' },
    ])
    const result = ship('paid')
    expect(result.status).toBe(75)
    expect(callCount()).toBe(1)
  })

  it('gives up with 75 after the wait limit', () => {
    planSsh([{ exit: 75, stderr: busyBy('receive test /home/deploy/releases/aip-x') }])
    const result = ship('paid', { DEPLOY_LOCK_RETRY_SECONDS: '1', DEPLOY_LOCK_WAIT_SECONDS: '2' })
    expect(result.status).toBe(75)
    expect(callCount()).toBe(3)
    expect(result.stdout).toContain('still holds the VPS deploy lock after 2s')
  })

  it('passes other failures through without retrying', () => {
    planSsh([{ exit: 1, stderr: 'rollout failed\n' }])
    const result = ship('paid')
    expect(result.status).toBe(1)
    expect(callCount()).toBe(1)
  })
})
