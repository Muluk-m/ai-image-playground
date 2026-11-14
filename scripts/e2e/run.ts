import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Browser,
  loadPlaywright,
  openSession,
  type Scenario,
  type ScenarioContext,
} from './kit.ts'
import { type MockUpstream, startMockUpstream } from './mock-upstream.ts'
import { accountIsolation } from './scenarios/account-isolation.ts'
import { brokenReference } from './scenarios/broken-reference.ts'
import { chunkFailureTwice } from './scenarios/chunk-failure-twice.ts'
import { concurrentTabRefresh } from './scenarios/concurrent-tab-refresh.ts'
import { cookieBlockedSession } from './scenarios/cookie-blocked-session.ts'
import { deleteThenRefresh } from './scenarios/delete-then-refresh.ts'
import { referenceEdit } from './scenarios/reference-edit.ts'
import { refreshResponseLost } from './scenarios/refresh-response-lost.ts'
import { refreshWhileGenerating } from './scenarios/refresh-while-generating.ts'
import { regenerateSamePrompt } from './scenarios/regenerate-same-prompt.ts'
import { staleTabRelease } from './scenarios/stale-tab-release.ts'
import { startStack, stopAllStacks } from './stack.ts'

/**
 * 浏览器场景套件入口（#1847）。用法见 docs/agents/browser-scenarios.md。
 *
 *   sh scripts/e2e-scenarios.sh [--only name,name] [--shard i/n]
 *
 * 前置：apps/web 已 `build:static-host`；PostgreSQL 可用（E2E_DATABASE_URL，缺省取 TEST_DATABASE_URL）。
 */

const SCENARIOS: readonly Scenario[] = [
  refreshWhileGenerating,
  referenceEdit,
  brokenReference,
  staleTabRelease,
  chunkFailureTwice,
  deleteThenRefresh,
  refreshResponseLost,
  concurrentTabRefresh,
  cookieBlockedSession,
  regenerateSamePrompt,
  accountIsolation,
]

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outDir = resolve(process.env.E2E_OUT_DIR ?? join(repoRoot, 'artifacts/e2e'))
const adminDatabaseUrl = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!adminDatabaseUrl) {
  console.error('E2E_DATABASE_URL (or TEST_DATABASE_URL) is required')
  process.exit(2)
}
const onlyIndex = process.argv.indexOf('--only')
const only = onlyIndex >= 0 ? (process.argv[onlyIndex + 1] ?? '').split(',') : null
const byName = only ? SCENARIOS.filter((scenario) => only.includes(scenario.name)) : SCENARIOS
// --shard i/n：按登记顺序轮转分给 n 个并行的 job，第 i 个（从 1 起）只跑自己那份。
const shardIndex = process.argv.indexOf('--shard')
const shard = shardIndex >= 0 ? /^(\d+)\/(\d+)$/.exec(process.argv[shardIndex + 1] ?? '') : null
if (shardIndex >= 0 && (!shard || Number(shard[1]) < 1 || Number(shard[1]) > Number(shard[2]))) {
  console.error('--shard expects i/n with 1 <= i <= n')
  process.exit(2)
}
const selected = shard
  ? byName.filter((_, index) => index % Number(shard[2]) === Number(shard[1]) - 1)
  : byName
if (selected.length === 0) {
  console.error(`no scenario matches ${only?.join(',')}`)
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })

let mock: MockUpstream | undefined
let browser: Browser | undefined

async function shutdown(): Promise<void> {
  await browser?.close().catch(() => {})
  // 栈在启动途中被打断时还没返回，所以统一由 stack 模块收尾。
  await stopAllStacks()
  await mock?.close().catch(() => {})
}

// Ctrl-C / CI 取消：先收掉浏览器、子进程和临时库，再退出。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  })
}

const failures: string[] = []
try {
  mock = await startMockUpstream()
  const upstream = mock
  const running = await startStack({
    repoRoot,
    mock: upstream,
    outDir,
    adminDatabaseUrl,
    webDist: resolve(process.env.E2E_WEB_DIST ?? join(repoRoot, 'apps/web/dist')),
  })
  browser = await loadPlaywright().chromium.launch()
  const launched = browser

  for (const scenario of selected) {
    upstream.reset()
    const sessions: Awaited<ReturnType<typeof openSession>>[] = []
    const base: Omit<ScenarioContext, 'newSession'> = {
      browser: launched,
      stack: running,
      mock: upstream,
      outDir,
    }
    const started = Date.now()
    let failed = false
    try {
      await Promise.race([
        running.infraFailure,
        scenario.run({
          ...base,
          newSession: async (label) => {
            const session = await openSession(base, label)
            sessions.push(session)
            return session
          },
        }),
      ])
      console.log(`PASS ${scenario.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    } catch (error) {
      failed = true
      failures.push(scenario.name)
      console.error(`FAIL ${scenario.name}: ${error instanceof Error ? error.stack : error}`)
      writeFileSync(
        join(outDir, `${scenario.name}.upstream.json`),
        JSON.stringify(upstream.requests(), null, 2),
      )
    }
    for (const [index, session] of sessions.entries()) {
      const prefix = join(outDir, `${scenario.name}-${index}`)
      if (failed) {
        await session.page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => {})
        await session.context.tracing.stop({ path: `${prefix}.trace.zip` }).catch(() => {})
      } else {
        await session.context.tracing.stop().catch(() => {})
      }
      await session.context.close().catch(() => {})
    }
    // 失败的场景可能还有上游请求在途：等它们结束再进下一个，别让它们撞进别的场景的记录里。
    await upstream.settle().catch((error: unknown) => console.error(`  ${error}`))
  }
  // 最后一个场景之后才崩的 BFF / worker：场景竞速已经结束，这里补查一次并计入退出码。
  try {
    running.assertAlive()
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}`)
    failures.push('infrastructure')
  }
} catch (error) {
  console.error(`suite setup failed: ${error instanceof Error ? error.stack : error}`)
  failures.push('setup')
} finally {
  await shutdown()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log(`\n${selected.length} scenario(s) passed`)
process.exit(0)
