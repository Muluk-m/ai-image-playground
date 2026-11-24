#!/usr/bin/env bun
/**
 * 限流、幂等回填 `tasks` 冷载荷列至 `task_payloads`，并支持一致性校验。
 *
 * 用法：
 *   DATABASE_URL=... bun run scripts/backfill-task-payloads.ts [--batch-size=1000] [--delay-ms=50] [--repair] [--verify-only]
 */
import { SQL } from 'bun'
import { backfillTaskPayloads, verifyTaskPayloadsConsistency } from '../packages/db/src/index'

function parseFlagNumber(args: readonly string[], name: string, fallback: number): number {
  const prefix = `--${name}=`
  const matched = args.find((arg) => arg.startsWith(prefix))
  if (!matched) return fallback
  const value = Number(matched.slice(prefix.length))
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for --${name}: ${matched}`)
  return value
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }
  const verifyOnly = args.includes('--verify-only')
  const repairMismatches = args.includes('--repair')
  const batchSize = parseFlagNumber(args, 'batch-size', 1000)
  const delayMs = parseFlagNumber(args, 'delay-ms', 50)

  const client = new SQL(databaseUrl, { max: 1 })
  try {
    if (!verifyOnly) {
      const result = await backfillTaskPayloads(client, {
        batchSize,
        delayMs,
        repairMismatches,
        onBatch: (batch) => {
          console.log(
            `[backfill-task-payloads] batch=${batch.batchNumber} scanned=${batch.scanned} written=${batch.written} lastId=${batch.lastId ?? 'none'}`,
          )
        },
      })
      console.log(
        `[backfill-task-payloads] done batches=${result.batches} scanned=${result.scanned} written=${result.written} completed=${result.completed}`,
      )
    }
    const report = await verifyTaskPayloadsConsistency(client)
    console.log(JSON.stringify(report, null, 2))
    if (report.missingCount > 0 || report.mismatchCount > 0) {
      process.exitCode = 1
    }
  } finally {
    await client.close()
  }
}

await main()
