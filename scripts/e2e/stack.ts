import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MockUpstream } from './mock-upstream.ts'

/**
 * 本地栈：PostgreSQL 里的一个临时库 + BFF + worker（都是真实进程，跑仓库里的源码）+ apps/web/dist
 * 的一份副本（由 BFF 同源托管）。上游与对象存储指向 mock，BFF 的鉴权、提交、队列、归档
 * 一行不改，只有「外面的世界」被换掉。
 *
 * 子进程只拿到白名单环境变量加下面显式设置的几个，宿主上的上游、存储、邮件等凭据一概不透传。
 */

export interface Stack {
  /** 浏览器访问的 origin，也是前端的 BFF 地址（同源）。 */
  readonly origin: string
  readonly modelLabel: string
  /** BFF 托管的前端目录（dist 的副本）。场景可以改它来模拟发版，见 kit.ts 的 publishNewRelease。 */
  readonly webRoot: string
  /** 运行期间任一子进程意外退出时 reject；场景要和它竞速，基础设施故障立即报出而不是等场景超时。 */
  readonly infraFailure: Promise<never>
  stop(): Promise<void>
}

export interface StackOptions {
  readonly repoRoot: string
  readonly mock: MockUpstream
  /** 日志目录（会作为 CI artifact 上传，别往里放大文件）。 */
  readonly outDir: string
  /** 能创建数据库的 PostgreSQL 连接串（CI 的 TEST_DATABASE_URL）。 */
  readonly adminDatabaseUrl: string
  readonly webDist: string
}

export const E2E_CHANNEL_ID = 'e2e-images'
export const E2E_MODEL_ID = 'e2e-image'
const E2E_MODEL_LABEL = 'E2E Image'

/** 子进程允许继承的宿主变量：只有找得到可执行文件、家目录和临时目录所需的。 */
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'USER'] as const

function psql(url: string, sql: string): void {
  const result = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`psql failed (${result.status}): ${result.stderr || result.error?.message}`)
  }
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

/** 让系统挑一个空闲端口。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** 端口上已经有东西在听就报错：绝不能把场景连到别人的 BFF 上。 */
function assertPortUnused(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error(`port ${port} is already in use; refusing to reuse an existing server`))
    })
    socket.once('error', () => resolve())
  })
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

/** 子进程已经退出（含被信号杀掉）。 */
function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function assertAlive(children: ChildProcess[]) {
  for (const child of children) {
    if (exited(child)) {
      throw new Error(
        `infrastructure failure: ${child.spawnargs.join(' ')} exited (code ${child.exitCode}, signal ${child.signalCode})`,
      )
    }
  }
}

/** BFF 和 worker 的 /health 都要答 200；等待期间任一进程退出直接报错。 */
async function waitForHealth(urls: string[], children: ChildProcess[]) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    assertAlive(children)
    if ((await Promise.all(urls.map(isHealthy))).every(Boolean)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${urls.join(' and ')} did not become healthy within 90s`)
}

function terminate(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (exited(child)) return resolve()
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

/** 还没清理的栈。收到 SIGINT/SIGTERM 时由入口统一收尾，免得留下临时库和子进程。 */
const active = new Set<() => Promise<void>>()

export async function stopAllStacks(): Promise<void> {
  await Promise.allSettled([...active].map((stop) => stop()))
}

export async function startStack(options: StackOptions): Promise<Stack> {
  const { repoRoot, mock, outDir, webDist } = options
  if (!existsSync(join(webDist, 'index.html'))) {
    throw new Error(
      `web dist not found at ${webDist}; build it first (pnpm --dir apps/web build:static-host)`,
    )
  }
  mkdirSync(outDir, { recursive: true })

  const port = await freePort()
  const workerPort = await freePort()
  await assertPortUnused(port)
  const origin = `http://127.0.0.1:${port}`

  // 前端要同源访问 BFF：改的是 dist 的副本，不动构建产物本身。
  const staticDir = mkdtempSync(join(tmpdir(), 'aip-e2e-web-'))
  cpSync(webDist, staticDir, { recursive: true })
  writeFileSync(
    join(staticDir, 'runtime-config.json'),
    `${JSON.stringify({ bff: { enabled: true, baseUrl: origin } })}\n`,
  )

  const channelsFile = join(outDir, 'channels.json')
  writeFileSync(
    channelsFile,
    JSON.stringify({
      channels: [
        {
          id: E2E_CHANNEL_ID,
          kind: 'openai-queue',
          label: 'E2E',
          // 没登记路由风格的渠道一律走 UPSTREAM_BASE_URL 通用网关，这里只是名义地址。
          baseUrl: `${mock.url}/v1`,
          auth: { type: 'bearer', secretRef: 'E2E_UPSTREAM_KEY' },
          models: [
            {
              id: E2E_MODEL_ID,
              label: E2E_MODEL_LABEL,
              capabilities: ['generate', 'edit', 'size'],
              etaSeconds: 5,
            },
          ],
          defaults: { apiMode: 'images', timeout: 600 },
          allowedPaths: ['images/generations', 'images/edits'],
        },
      ],
    }),
  )
  const operatorFile = join(outDir, 'operator-config.json')
  writeFileSync(
    operatorFile,
    JSON.stringify({
      capabilities: {
        'accounts:login': true,
        'accounts:self-register': true,
        'accounts:email-verification': false,
        'billing:credits': false,
        'generation:byok': false,
        'operator:console': false,
        'quota:daily': false,
      },
      quotas: { 'generation:daily-images': 0 },
      channelsFile,
    }),
  )

  const databaseName = `aip_e2e_${randomBytes(4).toString('hex')}`
  const databaseUrl = withDatabase(options.adminDatabaseUrl, databaseName)
  const children: ChildProcess[] = []
  let databaseCreated = false
  let stopped = false
  let failInfra: (error: Error) => void = () => {}
  const infraFailure = new Promise<never>((_, reject) => {
    failInfra = reject
  })
  infraFailure.catch(() => {})
  const stop = async () => {
    if (stopped) return
    stopped = true
    active.delete(stop)
    await Promise.all(children.map(terminate))
    if (databaseCreated) {
      try {
        psql(options.adminDatabaseUrl, `drop database if exists ${databaseName} with (force)`)
      } catch (error) {
        console.error(`could not drop ${databaseName}: ${error}`)
      }
    }
    rmSync(staticDir, { recursive: true, force: true })
  }
  active.add(stop)

  try {
    psql(options.adminDatabaseUrl, `create database ${databaseName}`)
    databaseCreated = true

    const env: Record<string, string> = {}
    for (const name of INHERITED_ENV) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
    Object.assign(env, {
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      STATIC_DIR: staticDir,
      OPERATOR_CONFIG_FILE: operatorFile,
      // 每个浏览器会话带自己的 x-forwarded-for（见 kit.ts openSession），注册限流按会话分桶，场景数量不受每小时 5 次的限制。
      CLIENT_IP_SOURCE: 'x-forwarded-for',
      UPSTREAM_BASE_URL: mock.url,
      UPSTREAM_API_KEY: 'e2e-upstream-key',
      E2E_UPSTREAM_KEY: 'e2e-upstream-key',
      S3_ENDPOINT: mock.s3Url,
      S3_BUCKET: mock.bucket,
      S3_ACCESS_KEY_ID: 'e2e',
      S3_SECRET_ACCESS_KEY: 'e2e-secret',
      INTERNAL_API_TOKEN: randomBytes(16).toString('hex'),
      CORS_ALLOWED_ORIGINS: origin,
      AUTH_FRONTEND_ORIGIN: origin,
      WORKER_HEALTH_PORT: String(workerPort),
      WORKER_POLL_INTERVAL_MS: '300',
      LOG_LEVEL: 'info',
    })
    const bffDir = join(repoRoot, 'apps/bff')

    const migrate = spawnSync('bun', ['run', 'src/db/migrate.ts'], {
      cwd: bffDir,
      env,
      encoding: 'utf8',
    })
    if (migrate.status !== 0) {
      throw new Error(`migration failed (${migrate.status}): ${migrate.stdout}${migrate.stderr}`)
    }

    const launch = (name: string, entry: string, extra: Record<string, string> = {}) => {
      const log = createWriteStream(join(outDir, `${name}.log`))
      const child = spawn('bun', ['run', entry], {
        cwd: bffDir,
        env: { ...env, ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.pipe(log)
      child.stderr.pipe(log)
      children.push(child)
      child.once('exit', (code, signal) => {
        if (!stopped) {
          failInfra(
            new Error(`infrastructure failure: ${name} exited (code ${code}, signal ${signal})`),
          )
        }
      })
    }
    launch('bff', 'src/index.ts')
    launch('worker', 'src/worker-index.ts', { APP_ROLE: 'worker' })
    await waitForHealth([`${origin}/health`, `http://127.0.0.1:${workerPort}/health`], children)
  } catch (error) {
    await stop()
    throw error
  }

  return { origin, modelLabel: E2E_MODEL_LABEL, webRoot: staticDir, infraFailure, stop }
}
