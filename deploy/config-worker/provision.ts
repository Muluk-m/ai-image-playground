#!/usr/bin/env bun
/**
 * Config Worker 的开通与维护（ADR 0035），可重复执行。需要 Nain 个人 Cloudflare 账号的 API token：
 *   CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID
 *
 *   provision.ts secrets push <prod|test|host> <file>   把 NAME=value 文件写进 Secrets Store（新增或覆盖）
 *   provision.ts secrets list                            只列名字
 *   provision.ts access <prod|test|host> --token-out <file>   确保 service token 和 Access 应用存在；
 *                                                        新建 token 时把 client id/secret 写进 file（0600）
 *   provision.ts deploy                                  按 Secrets Store 现有名字生成 wrangler.jsonc 并部署
 *
 * 任何时候都不打印密钥值。
 */
import { open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HOSTNAME = 'config.nainma.online'
export const TEAM_DOMAIN = 'nain-ma.cloudflareaccess.com'
const WORKER_NAME = 'aip-config-center'
const SCOPES = ['prod', 'test', 'host'] as const
type Scope = (typeof SCOPES)[number]

const token = process.env.CLOUDFLARE_API_TOKEN
const account = process.env.CLOUDFLARE_ACCOUNT_ID

interface ApiResult<T> {
  success: boolean
  errors?: Array<{ code: number; message: string }>
  result: T
  result_info?: { total_pages?: number }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!token || !account) throw new Error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID')
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const parsed = (await response.json()) as ApiResult<T>
  if (!parsed.success) {
    // 只报错误码和说明；请求体里可能有密钥，不回显。
    const errors = (parsed.errors ?? []).map((one) => `${one.code} ${one.message}`).join('; ')
    throw new Error(`${method} ${path.replace(/\/secrets\/[^/]+$/, '/secrets/<id>')}: HTTP ${response.status} ${errors}`)
  }
  return parsed.result
}

/** Access 的列表接口分页；按名字查找前取全。 */
async function listAll<T>(path: string): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; ; page += 1) {
    const batch = await api<T[]>('GET', `${path}?per_page=100&page=${page}`)
    all.push(...batch)
    if (batch.length < 100) return all
  }
}

async function storeId(): Promise<string> {
  const stores = await api<Array<{ id: string; name: string }>>('GET', '/secrets_store/stores')
  const store = stores[0]
  if (!store) throw new Error('No Secrets Store in this account')
  return store.id
}

interface StoredSecret {
  id: string
  name: string
}

async function listSecrets(store: string): Promise<StoredSecret[]> {
  const all: StoredSecret[] = []
  for (let page = 1; ; page += 1) {
    const batch = await api<StoredSecret[]>('GET', `/secrets_store/stores/${store}/secrets?per_page=100&page=${page}`)
    all.push(...batch)
    if (batch.length < 100) return all
  }
}

/** `NAME=value`，一行一个，值按字面。 */
function parseEnvFile(text: string): Array<[string, string]> {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=')
      const name = line.slice(0, at)
      if (at <= 0 || !/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('secrets file has a malformed line')
      return [name, line.slice(at + 1)] as [string, string]
    })
}

async function pushSecrets(scope: Scope, file: string) {
  const store = await storeId()
  const existing = new Map((await listSecrets(store)).map((one) => [one.name, one.id]))
  const entries = parseEnvFile(await readFile(file, 'utf8'))
  let created = 0
  let updated = 0
  for (const [name, value] of entries) {
    if (!value) continue
    const full = `${scope.toUpperCase()}__${name}`
    const id = existing.get(full)
    if (id) {
      await api('PATCH', `/secrets_store/stores/${store}/secrets/${id}`, { value })
      updated += 1
    } else {
      await api('POST', `/secrets_store/stores/${store}/secrets`, [
        { name: full, value, scopes: ['workers'], comment: 'ADR 0035 config center' },
      ])
      created += 1
    }
    console.log(`${id ? 'updated' : 'created'} ${full}`)
  }
  console.log(`${scope}: ${created} created, ${updated} updated`)
}

interface ServiceToken {
  id: string
  name: string
  client_id: string
  client_secret?: string
}

interface AccessApp {
  id: string
  name: string
  domain: string
  aud: string
}

async function ensureAccess(deployment: 'prod' | 'test' | 'host', tokenOut: string | undefined) {
  // host 的密钥给 prod 的 token：管这台机器的就是生产部署。
  const tokenName = `aip-config-${deployment === 'host' ? 'prod' : deployment}`
  const tokens = await listAll<ServiceToken>('/access/service_tokens')
  let serviceToken = tokens.find((one) => one.name === tokenName)
  if (!serviceToken) {
    if (!tokenOut) throw new Error(`${tokenName} does not exist yet; pass --token-out <file> to create it`)
    // client_secret 只在创建时返回一次：先占住输出文件，写不了就不创建。
    const file = await open(tokenOut, 'wx', 0o600)
    try {
      serviceToken = await api<ServiceToken>('POST', '/access/service_tokens', {
        name: tokenName,
        duration: 'forever',
      })
      // 键名与 bootstrap.env 一致（deploy-config-cli.ts 的 bootstrapFor）。
      const prefix = (deployment === 'host' ? 'prod' : deployment).toUpperCase()
      await file.writeFile(
        `${prefix}_CONFIG_ACCESS_CLIENT_ID=${serviceToken.client_id}\n${prefix}_CONFIG_ACCESS_CLIENT_SECRET=${serviceToken.client_secret}\n`,
      )
    } finally {
      await file.close()
    }
    console.log(`created service token ${tokenName}; credentials written to ${tokenOut}`)
  } else {
    console.log(`service token ${tokenName} exists`)
  }
  const appName = `aip-config ${deployment}`
  const domain = `${HOSTNAME}/v1/${deployment}`
  const policies = [
    {
      name: `${tokenName} only`,
      decision: 'non_identity',
      include: [{ service_token: { token_id: serviceToken.id } }],
      precedence: 1,
    },
  ]
  const apps = await listAll<AccessApp>('/access/apps')
  const current = apps.find((one) => one.name === appName)
  const body = { name: appName, type: 'self_hosted', domain, session_duration: '5m', policies }
  const app = current
    ? await api<AccessApp>('PUT', `/access/apps/${current.id}`, body)
    : await api<AccessApp>('POST', '/access/apps', body)
  console.log(`access app "${appName}" ${current ? 'updated' : 'created'}: ${domain} aud=${app.aud}`)
  return app.aud
}

async function audienceOf(deployment: 'prod' | 'test' | 'host'): Promise<string> {
  const apps = await listAll<AccessApp>('/access/apps')
  const app = apps.find((one) => one.name === `aip-config ${deployment}`)
  if (!app) throw new Error(`Access app for ${deployment} is missing; run access ${deployment} first`)
  return app.aud
}

async function deploy() {
  const store = await storeId()
  const names = (await listSecrets(store))
    .map((one) => one.name)
    .filter((name) => /^(PROD|TEST|HOST)__[A-Z][A-Z0-9_]*$/.test(name))
    .sort()
  const config = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: WORKER_NAME,
    main: 'src/index.ts',
    compatibility_date: '2026-11-01',
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: HOSTNAME, custom_domain: true }],
    vars: {
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_AUD_PROD: await audienceOf('prod'),
      ACCESS_AUD_TEST: await audienceOf('test'),
      ACCESS_AUD_HOST: await audienceOf('host'),
    },
    secrets_store_secrets: names.map((name) => ({ binding: name, store_id: store, secret_name: name })),
  }
  const target = join(import.meta.dir, 'wrangler.jsonc')
  await writeFile(
    target,
    `// 由 provision.ts deploy 生成：binding 与 Secrets Store 里 PROD__/TEST__/HOST__ 开头的名字一一对应。\n${JSON.stringify(config, null, 2)}\n`,
  )
  console.log(`wrote ${target} with ${names.length} bindings`)
  const child = Bun.spawn(['npx', '--yes', 'wrangler@4', 'deploy', '--config', target], {
    cwd: import.meta.dir,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account },
  })
  if ((await child.exited) !== 0) throw new Error('wrangler deploy failed')
}

async function main(argv: string[]) {
  const [command, sub, ...rest] = argv
  if (command === 'secrets' && sub === 'push') {
    const [scope, file] = rest
    if (!SCOPES.includes(scope as Scope) || !file) throw new Error('secrets push <prod|test|host> <file>')
    return pushSecrets(scope as Scope, file)
  }
  if (command === 'secrets' && sub === 'list') {
    const names = (await listSecrets(await storeId())).map((one) => one.name).sort()
    for (const name of names) console.log(name)
    return
  }
  if (command === 'access' && (sub === 'prod' || sub === 'test' || sub === 'host')) {
    const at = rest.indexOf('--token-out')
    await ensureAccess(sub, at === -1 ? undefined : rest[at + 1])
    return
  }
  if (command === 'deploy') return deploy()
  throw new Error('usage: provision.ts secrets push <scope> <file> | secrets list | access <prod|test|host> [--token-out <file>] | deploy')
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
