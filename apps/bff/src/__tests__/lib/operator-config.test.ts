import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CapabilityKey } from '@image-playground/shared'
import { evaluateCapability, hasCapability, loadOperatorConfig } from '../../lib/operator-config'

const appRoot = resolve(import.meta.dir, '../../..')
const sampleFile = join(appRoot, 'operator-config.example.json')
const temporaryDirectories: string[] = []

function temporaryFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'image-playground-operator-config-'))
  temporaryDirectories.push(directory)
  const file = join(directory, 'operator.json')
  writeFileSync(file, contents)
  return file
}

async function configModuleExitCode(operatorConfigFile: string): Promise<number> {
  const child = Bun.spawn([process.execPath, '--eval', "await import('./src/config.ts')"], {
    cwd: appRoot,
    env: {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/image_playground_test',
      OPERATOR_CONFIG_FILE: operatorConfigFile,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return child.exited
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('operator config', () => {
  it('starts with closed defaults when the configured file is missing', async () => {
    const missing = join(tmpdir(), `missing-operator-config-${crypto.randomUUID()}.json`)
    const resolved = loadOperatorConfig(missing)
    expect(resolved.loaded).toBe(false)

    expect(Object.values(resolved.capabilities).every((value) => value === false)).toBe(true)
    expect(resolved.quotas['sync:asset-image-bytes']).toBe(10 * 1024 * 1024)
    expect(resolved.quotas['sync:user-asset-bytes']).toBe(500 * 1024 * 1024)
    expect(Object.values(resolved.quotaSources).every((source) => source === 'default')).toBe(true)
    expect(Object.values(resolved.capabilitySources).every((source) => source === 'default')).toBe(
      true,
    )
    expect(await configModuleExitCode(missing)).toBe(0)
  })

  it('expands the selected preset, applies file overrides, and discards preset state', () => {
    const resolved = loadOperatorConfig(sampleFile)
    expect(resolved.loaded).toBe(true)

    expect(resolved.capabilities['accounts:login']).toBe(true)
    expect(resolved.capabilitySources['accounts:login']).toBe('preset:authenticated-example')
    expect(resolved.capabilities['billing:credits']).toBe(false)
    expect(resolved.capabilitySources['billing:credits']).toBe('file')
    expect(resolved.quotas['generation:daily-images']).toBe(0)
    expect(resolved.quotaSources['generation:daily-images']).toBe('file')
    expect(resolved.quotas['sync:asset-image-bytes']).toBe(10 * 1024 * 1024)
    expect(resolved.quotas['sync:user-asset-bytes']).toBe(500 * 1024 * 1024)
    expect(resolved.channelsFile).toBe('/run/operator/channels.json')
    expect(resolved).not.toHaveProperty('preset')
    expect(resolved).not.toHaveProperty('presets')
  })

  it('fails startup when a present file is malformed or schema-invalid', async () => {
    const malformed = temporaryFile('{')
    const invalid = temporaryFile(
      JSON.stringify({ config: { channelsFile: '/tmp/channels.json' } }),
    )

    expect(() => loadOperatorConfig(malformed)).toThrow()
    expect(() => loadOperatorConfig(invalid)).toThrow()
    expect(await configModuleExitCode(malformed)).not.toBe(0)
    expect(await configModuleExitCode(invalid)).not.toBe(0)
  })

  it('rejects billing without login or with BYOK enabled', () => {
    const withoutLogin = temporaryFile(
      JSON.stringify({
        capabilities: {
          'accounts:login': false,
          'billing:credits': true,
          'generation:byok': false,
        },
      }),
    )
    const withByok = temporaryFile(
      JSON.stringify({
        capabilities: {
          'accounts:login': true,
          'billing:credits': true,
          'generation:byok': true,
        },
      }),
    )
    const registrationWithoutLogin = temporaryFile(
      JSON.stringify({
        capabilities: {
          'accounts:login': false,
          'accounts:self-register': true,
        },
      }),
    )

    expect(() => loadOperatorConfig(registrationWithoutLogin)).toThrow(
      'accounts:self-register requires accounts:login',
    )
    expect(() => loadOperatorConfig(withoutLogin)).toThrow(
      'billing:credits requires accounts:login',
    )
    expect(() => loadOperatorConfig(withByok)).toThrow(
      'billing:credits requires generation:byok=false',
    )
  })

  it('treats accounts:sync as off when login is off', () => {
    const syncWithoutLogin = temporaryFile(
      JSON.stringify({
        capabilities: {
          'accounts:login': false,
          'accounts:sync': true,
        },
      }),
    )
    const syncWithLogin = temporaryFile(
      JSON.stringify({
        capabilities: {
          'accounts:login': true,
          'accounts:sync': true,
        },
      }),
    )

    expect(loadOperatorConfig(syncWithoutLogin).capabilities['accounts:sync']).toBe(false)
    expect(loadOperatorConfig(syncWithLogin).capabilities['accounts:sync']).toBe(true)
  })

  it('ignores retired capabilities left in an older file but still rejects unknown ones', async () => {
    const retired = temporaryFile(
      JSON.stringify({
        capabilities: {
          'quota:daily': true,
          'generation:storyboard': true,
          'matte:server': true,
          'remix:analyze': false,
          'remix:listing': true,
        },
      }),
    )
    const resolved = loadOperatorConfig(retired)
    expect(resolved.capabilities['quota:daily']).toBe(true)
    expect(evaluateCapability(resolved, 'matte:server')).toBe(false)
    expect(evaluateCapability(resolved, 'generation:storyboard')).toBe(false)
    expect(resolved.capabilities).not.toHaveProperty('matte:server')
    expect(await configModuleExitCode(retired)).toBe(0)

    const unknown = temporaryFile(JSON.stringify({ capabilities: { 'made:up': true } }))
    expect(() => loadOperatorConfig(unknown)).toThrow('unknown capability: made:up')
  })

  // 配额退役时生产配置文件里那个键还在，跳不掉就是 BFF 起不来——这条路以前没有测试。
  it('ignores retired quotas left in an older file but still rejects unknown ones', () => {
    const retired = temporaryFile(
      JSON.stringify({
        quotas: { 'agent:compaction-max-folds': 5, 'agent:compaction-keep-tokens': 6_000 },
      }),
    )
    const resolved = loadOperatorConfig(retired)
    expect(resolved.quotas['agent:compaction-keep-tokens']).toBe(6_000)
    expect(resolved.quotas).not.toHaveProperty('agent:compaction-max-folds')

    const unknown = temporaryFile(JSON.stringify({ quotas: { 'made:up': 1 } }))
    expect(() => loadOperatorConfig(unknown)).toThrow('unknown quota: made:up')
  })

  it('keeps known keys typed while evaluating runtime unknown keys as false', () => {
    const known: CapabilityKey = 'accounts:login'
    const resolved = loadOperatorConfig(sampleFile)

    expect(hasCapability(resolved, known)).toBe(true)
    expect(() => evaluateCapability(resolved, 'unknown:capability')).not.toThrow()
    expect(evaluateCapability(resolved, 'unknown:capability')).toBe(false)
  })
})
