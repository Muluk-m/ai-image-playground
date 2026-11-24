/**
 * 配置中心命令行（ADR 0035）。发布时用要上线的镜像执行，所以清单和代码版本一致：
 *
 *   bun run apps/bff/src/deploy-config-cli.ts check
 *   bun run apps/bff/src/deploy-config-cli.ts secrets <prod|test>
 *   bun run apps/bff/src/deploy-config-cli.ts render <prod|test> --out <dir> [--secrets-file <file>]
 *
 * render 的密钥来源：`--secrets-file`（`NAME=value`，不带部署前缀），或者 Config Worker
 * （`CONFIG_CENTER_URL` + `CONFIG_ACCESS_CLIENT_ID` / `CONFIG_ACCESS_CLIENT_SECRET`）。
 * 输出目录先写到同级临时目录再整体换上去；任何一项校验不过就不动现有目录。不回显任何值。
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  catalogProblems,
  DEPLOYMENT_NAMES,
  type Deployment,
  type DeploymentName,
  formatEnvFile,
  parseDeployment,
  renderDeployment,
  SECRETS,
} from '@image-playground/shared/deploy-config'

const descriptorsDir = resolve(import.meta.dir, '../../../deploy/deployments')

export async function loadDeployment(
  name: DeploymentName,
  dir = descriptorsDir,
): Promise<Deployment> {
  const path = join(dir, `${name}.json`)
  const deployment = parseDeployment(JSON.parse(await readFile(path, 'utf8')), path)
  if (deployment.name !== name) throw new Error(`${path}: name must be ${name}`)
  return deployment
}

/** `NAME=value` 一行一个；`#` 开头和空行跳过；值按字面，不去引号。 */
export function parseSecretsFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) throw new Error(`secrets file line ${index + 1} is not NAME=value`)
    const name = line.slice(0, at).trim()
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`secrets file line ${index + 1}: bad name`)
    if (name in values) throw new Error(`secrets file: ${name} appears twice`)
    values[name] = line.slice(at + 1)
  }
  return values
}

async function fetchSecrets(name: DeploymentName): Promise<Record<string, string>> {
  const base = process.env.CONFIG_CENTER_URL?.replace(/\/+$/, '')
  const id = process.env.CONFIG_ACCESS_CLIENT_ID
  const secret = process.env.CONFIG_ACCESS_CLIENT_SECRET
  if (!base || !id || !secret) {
    throw new Error(
      'No secrets source: pass --secrets-file, or set CONFIG_CENTER_URL, CONFIG_ACCESS_CLIENT_ID and CONFIG_ACCESS_CLIENT_SECRET',
    )
  }
  const response = await fetch(`${base}/v1/${name}/secrets`, {
    headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Config Worker answered HTTP ${response.status}`)
  const body = (await response.json()) as { secrets?: unknown }
  const secrets = body.secrets
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
    throw new Error('Config Worker response has no secrets object')
  }
  for (const value of Object.values(secrets)) {
    if (typeof value !== 'string') throw new Error('Config Worker returned a non-string secret')
  }
  return secrets as Record<string, string>
}

/** 原子替换：写到 `<out>.next`，校验通过后把旧目录挪到 `<out>.prev` 再换上。 */
async function writeRendered(out: string, files: Record<string, string>) {
  const next = `${out}.next`
  const prev = `${out}.prev`
  await rm(next, { recursive: true, force: true })
  await mkdir(next, { recursive: true, mode: 0o700 })
  for (const [relative, content] of Object.entries(files)) {
    const target = join(next, relative)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, content, { mode: 0o600 })
    await chmod(target, 0o600)
  }
  await chmod(next, 0o700)
  await rm(prev, { recursive: true, force: true })
  await rename(out, prev).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  await rename(next, out)
  await rm(prev, { recursive: true, force: true })
}

/**
 * 从旧布局（`apps/<project>/app.env`、`migrate.env`、`cloudflared/credentials.json`）取出清单里的密钥。
 * 只在迁移到 Secrets Store 时用一次（ADR 0035 P2）。数据库密码从连接串里拆出来。
 */
export function secretsFromLegacy(input: {
  appEnv: string
  migrateEnv: string
  tunnelCredentials?: string
}): { secrets: Record<string, string>; ignored: string[] } {
  const app = parseLegacyEnv(input.appEnv)
  const migrate = parseLegacyEnv(input.migrateEnv)
  const secrets: Record<string, string> = {}
  const wanted = new Set(SECRETS.map((one) => one.name))
  for (const [name, value] of Object.entries(app)) {
    if (wanted.has(name) && value !== '') secrets[name] = value
  }
  const password = (url: string | undefined) => {
    if (!url) return undefined
    const parsed = new URL(url)
    return parsed.password ? decodeURIComponent(parsed.password) : undefined
  }
  const fromUrls: Array<[string, string | undefined]> = [
    ['POSTGRES_APP_PASSWORD', password(app.APP_DATABASE_URL)],
    ['POSTGRES_ADMIN_PASSWORD', password(app.ADMIN_DATABASE_URL)],
    ['POSTGRES_MIGRATOR_PASSWORD', password(migrate.MIGRATOR_DATABASE_URL)],
  ]
  for (const [name, value] of fromUrls) if (value) secrets[name] = value
  if (input.tunnelCredentials)
    secrets.TUNNEL_CREDENTIALS = JSON.stringify(JSON.parse(input.tunnelCredentials))
  const ignored = Object.keys(app).filter((name) => !wanted.has(name))
  return { secrets, ignored }
}

/** 旧 env 文件：允许 `export ` 前缀和成对引号。 */
function parseLegacyEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    let value = match[2]!
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    values[match[1]!] = value
  }
  return values
}

function deploymentName(value: string | undefined): DeploymentName {
  if (!DEPLOYMENT_NAMES.includes(value as DeploymentName)) {
    throw new Error(`deployment must be one of ${DEPLOYMENT_NAMES.join(', ')}`)
  }
  return value as DeploymentName
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  if (command === 'check') {
    const problems = catalogProblems()
    for (const name of DEPLOYMENT_NAMES) {
      try {
        await loadDeployment(name)
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error))
      }
    }
    for (const problem of problems) console.error(problem)
    if (problems.length === 0) console.log(`catalog and ${DEPLOYMENT_NAMES.join(', ')} are valid`)
    return problems.length === 0 ? 0 : 1
  }
  if (command === 'secrets') {
    const deployment = await loadDeployment(deploymentName(args[0]))
    for (const one of SECRETS) {
      const need = one.required(deployment) ? 'required' : 'optional'
      console.log(`${one.name}\t${need}\t${one.doc}`)
    }
    return 0
  }
  if (command === 'render') {
    const name = deploymentName(args[0])
    const out = option(args, '--out')
    if (!out) throw new Error('render needs --out <dir>')
    const deployment = await loadDeployment(name)
    const secretsFile = option(args, '--secrets-file')
    const secrets = secretsFile
      ? parseSecretsFile(await readFile(secretsFile, 'utf8'))
      : await fetchSecrets(name)
    const { rendered, problems } = renderDeployment(deployment, secrets)
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem)
      console.error(`render ${name}: ${problems.length} problem(s); ${out} left unchanged`)
      return 1
    }
    const files: Record<string, string> = { ...rendered.files }
    for (const [service, values] of Object.entries(rendered.env)) {
      files[`env/${service}.env`] = formatEnvFile(values)
    }
    await writeRendered(resolve(out), files)
    const counts = Object.entries(rendered.env).map(
      ([service, values]) => `${service}=${Object.keys(values).length}`,
    )
    console.log(`rendered ${name} into ${out}: ${counts.join(' ')}`)
    return 0
  }
  if (command === 'import-legacy') {
    const from = option(args, '--from')
    const out = option(args, '--out')
    if (!from || !out)
      throw new Error('import-legacy needs --from <legacy project dir> --out <secrets file>')
    const read = (path: string) => readFile(join(from, path), 'utf8')
    const tunnel = await read('cloudflared/credentials.json').catch(() => undefined)
    const { secrets, ignored } = secretsFromLegacy({
      appEnv: await read('app.env'),
      migrateEnv: await read('migrate.env'),
      tunnelCredentials: tunnel,
    })
    await writeFile(out, formatEnvFile(secrets), { mode: 0o600, flag: 'wx' })
    console.log(`wrote ${Object.keys(secrets).length} secrets to ${out}`)
    console.log(`not secrets (now in the deployment file or derived): ${ignored.sort().join(' ')}`)
    return 0
  }
  console.error(
    'usage: deploy-config-cli.ts check | secrets <deployment> | render <deployment> --out <dir> [--secrets-file <file>] | import-legacy --from <dir> --out <file>',
  )
  return 2
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
