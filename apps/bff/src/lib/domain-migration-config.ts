import { readFileSync } from 'node:fs'

export interface DomainMigrationConfig {
  sourceOrigin: string
  targetOrigin: string
  sourceApi: string
  targetApi: string
}

export function domainMigrationConfig(): DomainMigrationConfig | null {
  const file = process.env.DOMAIN_MIGRATION_CONFIG_FILE
  if (!file) return null
  const input = JSON.parse(readFileSync(file, 'utf8')) as DomainMigrationConfig
  for (const key of ['sourceOrigin', 'targetOrigin', 'sourceApi', 'targetApi'] as const) {
    const url = new URL(input[key])
    if (url.origin !== input[key] || url.protocol !== 'https:') {
      throw new Error(`Invalid domain migration ${key}`)
    }
  }
  if (input.sourceOrigin === input.targetOrigin) throw new Error('Migration origins must differ')
  return {
    sourceOrigin: input.sourceOrigin,
    targetOrigin: input.targetOrigin,
    sourceApi: input.sourceApi,
    targetApi: input.targetApi,
  }
}
