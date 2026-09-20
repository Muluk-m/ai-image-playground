import { readFileSync } from 'node:fs'

export interface DomainHandoffConfig {
  sourceOrigin: string
  targetOrigin: string
  sourceApiOrigin: string
  targetApiOrigin: string
}
function loadDomainHandoffConfig(): DomainHandoffConfig | null {
  const path = process.env.DOMAIN_HANDOFF_CONFIG_FILE?.trim()
  if (!path) return null
  const value = JSON.parse(readFileSync(path, 'utf8')) as DomainHandoffConfig
  for (const key of [
    'sourceOrigin',
    'targetOrigin',
    'sourceApiOrigin',
    'targetApiOrigin',
  ] as const) {
    const url = new URL(value[key])
    if (url.protocol !== 'https:' || url.origin !== value[key])
      throw new Error('Invalid domain handoff origin')
  }
  if (value.sourceOrigin === value.targetOrigin || value.sourceApiOrigin === value.targetApiOrigin)
    throw new Error('Domain handoff origins must differ')
  return value
}

const loaded = loadDomainHandoffConfig()
export const domainHandoffConfig = () => loaded
