import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(__dirname, '../../../../../scripts/segmenter-deploy.sh')
let root: string
let log: string

/**
 * A fake docker: `inspect` answers the networks from $NETWORKS_<container> (dashes as underscores)
 * until compose recreated the instance, `compose up` exits $COMPOSE_EXIT, everything is logged.
 */
function run(args: string[], extra: Record<string, string> = {}) {
  return spawnSync('sh', [script, ...args], {
    env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, CALL_LOG: log, ...extra },
    encoding: 'utf8',
  })
}
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
const last = () => calls()[calls().length - 1]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'segmenter-deploy-'))
  log = join(root, 'calls.log')
  writeFileSync(log, '')
  mkdirSync(join(root, 'bin'))
  writeFileSync(
    join(root, 'bin/docker'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1" in
  inspect)
    # A recreated instance (after compose ran) is on its own network only, like the real one.
    case "$2" in image-playground-segmenter-*) [ -e "$CALL_LOG.recreated" ] && exit 0 ;; esac
    var=NETWORKS_$(printf '%s' "$2" | tr '-' '_')
    eval "printf '%s' \\"\\\${$var:-}\\""
    ;;
  ps) ;;
  compose)
    : > "$CALL_LOG.recreated"
    exit "\${COMPOSE_EXIT:-0}"
    ;;
esac
`,
  )
  chmodSync(join(root, 'bin/docker'), 0o755)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('segmenter-deploy.sh', () => {
  it('runs one compose project per line and reattaches its networks after an update', () => {
    const result = run(['up', 'prod', 'ai-image-playground:segmenter-abc'], {
      NETWORKS_image_playground_segmenter_prod:
        'image-playground-segmenter-prod image-playground-internal_application ',
    })
    expect(result.status, result.stderr).toBe(0)
    const all = calls()
    expect(all).toContain(
      `compose --project-name image-playground-segmenter-prod --file ${resolve(script, '../../deploy/compose.segmenter.yaml')} up --detach --wait`,
    )
    expect(all.join('\n')).toContain(
      'network connect --alias segmenter image-playground-internal_application image-playground-segmenter-prod',
    )
    expect(all.join('\n')).not.toContain('image-playground-segmenter-test')
  })

  it('reattaches the networks it had even when the start fails, and still fails', () => {
    const result = run(['up', 'prod', 'ai-image-playground:segmenter-abc'], {
      NETWORKS_image_playground_segmenter_prod: 'image-playground-paid_application ',
      COMPOSE_EXIT: '1',
    })
    expect(result.status).not.toBe(0)
    expect(last()).toBe(
      'network connect --alias segmenter image-playground-paid_application image-playground-segmenter-prod',
    )
  })

  it('takes the formerly shared instance off the test network before starting the test one', () => {
    const result = run(['up', 'test', 'ai-image-playground:segmenter-abc'], {
      NETWORKS_image_playground_segmenter:
        'image-playground-segmenter image-playground-test_application ',
    })
    expect(result.status, result.stderr).toBe(0)
    const all = calls()
    const detached = all.indexOf(
      'network disconnect image-playground-test_application image-playground-segmenter',
    )
    expect(detached).toBeGreaterThan(-1)
    expect(detached).toBeLessThan(all.findIndex((c) => c.startsWith('compose ')))
    expect(all.join('\n')).not.toMatch(/\brm\b.*image-playground-segmenter\b/)
  })

  it('never attaches a test network to production or a production network to test', () => {
    expect(run(['attach', 'prod', 'image-playground-test']).status).not.toBe(0)
    expect(run(['attach', 'test', 'image-playground-internal']).status).not.toBe(0)
    expect(calls().join('\n')).not.toContain('network connect')
    expect(run(['attach', 'test', 'image-playground-test']).status).toBe(0)
    expect(last()).toBe(
      'network connect --alias segmenter image-playground-test_application image-playground-segmenter-test',
    )
  })

  it('refuses an unknown instance', () => {
    expect(run(['up', 'shared', 'img']).status).toBe(2)
    expect(run(['healthy', '-']).status).toBe(2)
  })
})
