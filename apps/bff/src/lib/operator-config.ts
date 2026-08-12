import { readFileSync } from 'node:fs'
import {
  CAPABILITIES,
  type CapabilityKey,
  type CapabilityValues,
  type ClientCapabilityKey,
  type ClientCapabilityManifest,
  QUOTAS,
  type QuotaKey,
  type QuotaValues,
} from '@image-playground/shared'
import { isObject } from './type-guards'

export type OperatorValueSource = 'default' | 'file' | `preset:${string}`

export interface ResolvedOperatorConfig {
  readonly capabilities: CapabilityValues
  readonly capabilitySources: Readonly<Record<CapabilityKey, OperatorValueSource>>
  readonly quotas: QuotaValues
  readonly quotaSources: Readonly<Record<QuotaKey, OperatorValueSource>>
  readonly channelsFile: string | null
  readonly file: string | null
  readonly loaded: boolean
}

type ParsedCapabilityValues = Partial<Record<CapabilityKey, boolean>>
type ParsedQuotaValues = Partial<Record<QuotaKey, number>>

interface ParsedPreset {
  readonly capabilities: ParsedCapabilityValues
}

interface ParsedOperatorConfig {
  readonly preset?: string
  readonly presets: Readonly<Record<string, ParsedPreset>>
  readonly capabilities: ParsedCapabilityValues
  readonly quotas: ParsedQuotaValues
  readonly channelsFile: string | null
}

const capabilityKeys = Object.keys(CAPABILITIES) as CapabilityKey[]
const clientCapabilityKeys = capabilityKeys.filter(
  (key): key is ClientCapabilityKey => CAPABILITIES[key].clientExposed,
)
const quotaKeys = Object.keys(QUOTAS) as QuotaKey[]

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${at} contains unknown key: ${key}`)
  }
}

function parseCapabilities(value: unknown, at: string): ParsedCapabilityValues {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error(`${at} must be an object`)

  const parsed: ParsedCapabilityValues = {}
  for (const [key, enabled] of Object.entries(value)) {
    if (!Object.hasOwn(CAPABILITIES, key))
      throw new Error(`${at} contains unknown capability: ${key}`)
    if (typeof enabled !== 'boolean') throw new Error(`${at}.${key} must be a boolean`)
    parsed[key as CapabilityKey] = enabled
  }
  return parsed
}

function parseQuotas(value: unknown): ParsedQuotaValues {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error('operator config quotas must be an object')

  const parsed: ParsedQuotaValues = {}
  for (const [key, quota] of Object.entries(value)) {
    if (!Object.hasOwn(QUOTAS, key))
      throw new Error(`operator config quotas contains unknown quota: ${key}`)
    if (typeof quota !== 'number' || !Number.isSafeInteger(quota) || quota < 0) {
      throw new Error(`operator config quotas.${key} must be a non-negative safe integer`)
    }
    parsed[key as QuotaKey] = quota
  }
  return parsed
}

function parsePresets(value: unknown): Readonly<Record<string, ParsedPreset>> {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error('operator config presets must be an object')

  const presets: Record<string, ParsedPreset> = {}
  for (const [name, preset] of Object.entries(value)) {
    if (!name.trim()) throw new Error('operator config preset names must not be empty')
    if (!isObject(preset)) throw new Error(`operator config presets.${name} must be an object`)
    assertOnlyKeys(preset, ['capabilities'], `operator config presets.${name}`)
    presets[name] = {
      capabilities: parseCapabilities(
        preset.capabilities,
        `operator config presets.${name}.capabilities`,
      ),
    }
  }
  return presets
}

function parseOperatorConfig(value: unknown): ParsedOperatorConfig {
  if (!isObject(value)) throw new Error('operator config must be a JSON object')
  assertOnlyKeys(
    value,
    ['preset', 'presets', 'capabilities', 'quotas', 'channelsFile'],
    'operator config',
  )

  if (value.preset !== undefined && (typeof value.preset !== 'string' || !value.preset.trim())) {
    throw new Error('operator config preset must be a non-empty string')
  }
  if (
    value.channelsFile !== undefined &&
    (typeof value.channelsFile !== 'string' || !value.channelsFile.trim())
  ) {
    throw new Error('operator config channelsFile must be a non-empty string')
  }

  const presets = parsePresets(value.presets)
  const preset = value.preset as string | undefined
  if (preset !== undefined && !Object.hasOwn(presets, preset)) {
    throw new Error(`operator config selects unknown preset: ${preset}`)
  }

  return {
    preset,
    presets,
    capabilities: parseCapabilities(value.capabilities, 'operator config capabilities'),
    quotas: parseQuotas(value.quotas),
    channelsFile: typeof value.channelsFile === 'string' ? value.channelsFile.trim() : null,
  }
}

function defaults(file: string | null = null): ResolvedOperatorConfig {
  const capabilities = {} as Record<CapabilityKey, boolean>
  const capabilitySources = {} as Record<CapabilityKey, OperatorValueSource>
  for (const key of capabilityKeys) {
    capabilities[key] = CAPABILITIES[key].defaultValue
    capabilitySources[key] = 'default'
  }

  const quotas = {} as Record<QuotaKey, number>
  const quotaSources = {} as Record<QuotaKey, OperatorValueSource>
  for (const key of quotaKeys) {
    quotas[key] = QUOTAS[key].defaultValue
    quotaSources[key] = 'default'
  }

  return {
    capabilities,
    capabilitySources,
    quotas,
    quotaSources,
    channelsFile: null,
    file,
    loaded: false,
  }
}

function assertCapabilityCompatibility(capabilities: CapabilityValues): void {
  if (capabilities['accounts:self-register'] && !capabilities['accounts:login']) {
    throw new Error('accounts:self-register requires accounts:login')
  }
  if (!capabilities['billing:credits']) return
  if (!capabilities['accounts:login']) {
    throw new Error('billing:credits requires accounts:login')
  }
  if (capabilities['generation:byok']) {
    throw new Error('billing:credits requires generation:byok=false')
  }
}

function resolveParsedConfig(parsed: ParsedOperatorConfig, file: string): ResolvedOperatorConfig {
  const resolved = defaults(file)
  const capabilities = { ...resolved.capabilities }
  const capabilitySources = { ...resolved.capabilitySources }
  const quotas = { ...resolved.quotas }
  const quotaSources = { ...resolved.quotaSources }

  if (parsed.preset !== undefined) {
    for (const [key, enabled] of Object.entries(parsed.presets[parsed.preset]!.capabilities)) {
      capabilities[key as CapabilityKey] = enabled
      capabilitySources[key as CapabilityKey] = `preset:${parsed.preset}`
    }
  }
  for (const [key, enabled] of Object.entries(parsed.capabilities)) {
    capabilities[key as CapabilityKey] = enabled
    capabilitySources[key as CapabilityKey] = 'file'
  }
  for (const [key, quota] of Object.entries(parsed.quotas)) {
    quotas[key as QuotaKey] = quota
    quotaSources[key as QuotaKey] = 'file'
  }

  assertCapabilityCompatibility(capabilities)
  return {
    capabilities,
    capabilitySources,
    quotas,
    quotaSources,
    channelsFile: parsed.channelsFile,
    file,
    loaded: true,
  }
}

export function loadOperatorConfig(file: string | null): ResolvedOperatorConfig {
  if (!file) return defaults()

  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return defaults(file)
    throw new Error(`Cannot read operator config ${file}`, { cause: error })
  }

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Operator config ${file} is not valid JSON`, { cause: error })
  }

  try {
    return resolveParsedConfig(parseOperatorConfig(value), file)
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : ''
    throw new Error(`Operator config ${file} is invalid${reason}`, { cause: error })
  }
}

export function evaluateCapability(config: ResolvedOperatorConfig, key: string): boolean {
  return Object.hasOwn(CAPABILITIES, key) ? config.capabilities[key as CapabilityKey] : false
}

export function hasCapability(config: ResolvedOperatorConfig, key: CapabilityKey): boolean {
  return evaluateCapability(config, key)
}

export function clientCapabilityManifest(config: ResolvedOperatorConfig): ClientCapabilityManifest {
  const manifest = {} as Record<ClientCapabilityKey, boolean>
  for (const key of clientCapabilityKeys) manifest[key] = config.capabilities[key]
  return manifest
}
