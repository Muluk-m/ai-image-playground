#!/usr/bin/env bun
/**
 * 配置中心的一致性检查（ADR 0035），在 `pnpm lint` 里跑：
 * 1. 清单自洽，`deploy/deployments/*.json` 和 `deploy/host.json` 通过校验；
 * 2. 两份 JSON Schema 是由清单生成的最新版本（`--write` 重新生成）；
 * 3. 运行时代码读到的每个变量都登记在清单里，或在 NOT_DEPLOYMENT_CONFIG 里写明由谁提供。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  catalogProblems,
  DEPLOYMENT_NAMES,
  NOT_DEPLOYMENT_CONFIG,
  parseDeployment,
  parseHost,
  renderDeploymentSchema,
  renderHostSchema,
  SECRETS,
  SETTINGS,
} from '../packages/shared/src/deploy-config'

const root = join(import.meta.dir, '..')
const write = process.argv.includes('--write')
const problems: string[] = [...catalogProblems()]

const read = (path: string) => readFileSync(join(root, path), 'utf8')
for (const name of DEPLOYMENT_NAMES) {
  const path = `deploy/deployments/${name}.json`
  try {
    const deployment = parseDeployment(JSON.parse(read(path)), path)
    if (deployment.name !== name) problems.push(`${path}: name must be ${name}`)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
}
try {
  parseHost(JSON.parse(read('deploy/host.json')), 'deploy/host.json')
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error))
}

for (const [path, content] of [
  ['deploy/deployments/deployment.schema.json', renderDeploymentSchema()],
  ['deploy/host.schema.json', renderHostSchema()],
] as const) {
  if (write) writeFileSync(join(root, path), content)
  else if (read(path) !== content)
    problems.push(`${path} is stale; run bun run scripts/check-deploy-config.ts --write`)
}

const known = new Set<string>([
  ...SETTINGS.map((one) => one.env),
  ...SECRETS.map((one) => one.name),
  ...Object.keys(NOT_DEPLOYMENT_CONFIG),
])
const READS = [
  /(?:process\.env|Bun\.env)\.([A-Z][A-Z0-9_]+)/g,
  /(?:process\.env|Bun\.env)\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
  /\b\w*[Ee]nv\w*\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /\benv:\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /\b(?:clientId|clientSecret):\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /"(?:secretRef|baseUrlRef)":\s*"([A-Z][A-Z0-9_]+)"/g,
]
const RUNTIME_DIRS = [
  'apps/bff/src',
  'apps/admin/server',
  'packages/db/src',
  'packages/node-kit/src',
]
const files = [
  'apps/bff/channels.json',
  ...RUNTIME_DIRS.flatMap((dir) =>
    [...new Bun.Glob('**/*.ts').scanSync({ cwd: join(root, dir) })]
      .filter((path) => !path.includes('__tests__/') && !/\.test\.ts$/.test(path))
      .map((path) => `${dir}/${path}`),
  ),
]
const unknown = new Map<string, string>()
for (const file of files) {
  const text = read(file)
  for (const pattern of READS) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1]!
      if (!known.has(name) && !unknown.has(name))
        unknown.set(name, relative(root, join(root, file)))
    }
  }
}
for (const [name, file] of unknown) {
  problems.push(
    `${file} reads ${name}, which is not in packages/shared/src/deploy-config/catalog.ts; register it (or list it in NOT_DEPLOYMENT_CONFIG)`,
  )
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}
console.log(`deploy config ok: ${known.size} variables, ${files.length} runtime files`)
