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
    expect(resolved).not.toHaveProperty('preset')
    expect(resolved).not.toHaveProperty('presets')
  })

  it('fails startup when a present file is malformed or schema-invalid', async () => {
    const malformed = temporaryFile('{')
    const invalid = temporaryFile(JSON.stringify({ capabilities: { 'accounts:login': 'yes' } }))

    expect(() => loadOperatorConfig(malformed)).toThrow()
    expect(() => loadOperatorConfig(invalid)).toThrow()
    expect(await configModuleExitCode(malformed)).not.toBe(0)
    expect(await configModuleExitCode(invalid)).not.toBe(0)
  })

  it('keeps known keys typed while evaluating runtime unknown keys as false', () => {
    const known: CapabilityKey = 'accounts:login'
    const resolved = loadOperatorConfig(sampleFile)

    expect(hasCapability(resolved, known)).toBe(true)
    expect(() => evaluateCapability(resolved, 'unknown:capability')).not.toThrow()
    expect(evaluateCapability(resolved, 'unknown:capability')).toBe(false)
  })
})
