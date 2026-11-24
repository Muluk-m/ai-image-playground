#!/usr/bin/env bun
/**
 * 限流、幂等回填 `tasks` 冷载荷列至 `task_payloads`，并支持一致性校验。
 *
 * 用法：
 *   DATABASE_URL=... bun run scripts/backfill-task-payloads.ts [--batch-size=1000] [--delay-ms=50] [--repair] [--verify-only]
 */
import { SQL } from 'bun'
import {
  backfillTaskPayloads,
  verifyTaskPayloadsConsistency,
} from '../packages/db/src/backfill-task-payloads'

const USAGE =
  'Usage: DATABASE_URL=... bun run scripts/backfill-task-payloads.ts [--batch-size=1000] [--delay-ms=50] [--repair] [--verify-only] [--help]'

interface CliOptions {
  readonly help: boolean
  readonly verifyOnly: boolean
  readonly repairMismatches: boolean
  readonly batchSize: number
  readonly delayMs: number
}

function parseNonEmptyNumber(raw: string, flag: string): number {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`Missing numeric value for ${flag}`)
  const value = Number(trimmed)
  if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for ${flag}: ${raw}`)
  return value
}

function parseArgs(args: readonly string[]): CliOptions {
  let help = false
  let verifyOnly = false
  let repairMismatches = false
  let batchSize = 1000
  let delayMs = 50
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--verify-only') {
      verifyOnly = true
      continue
    }
    if (arg === '--repair') {
      repairMismatches = true
      continue
    }
    if (arg.startsWith('--batch-size=')) {
      batchSize = parseNonEmptyNumber(arg.slice('--batch-size='.length), '--batch-size')
      continue
    }
    if (arg.startsWith('--delay-ms=')) {
      delayMs = parseNonEmptyNumber(arg.slice('--delay-ms='.length), '--delay-ms')
      continue
    }
    throw new Error(`Unknown argument: ${arg}\n${USAGE}`)
  }
  return { help, verifyOnly, repairMismatches, batchSize, delayMs }
}

async function main(): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  if (options.help) {
    console.log(USAGE)
    return
  }

  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }

  const client = new SQL(databaseUrl, { max: 1 })
  try {
    await client`SET application_name = 'backfill-task-payloads'`
    await client`SET lock_timeout = '5000ms'`
    if (!options.verifyOnly) {
      const result = await backfillTaskPayloads(client, {
        batchSize: options.batchSize,
        delayMs: options.delayMs,
        repairMismatches: options.repairMismatches,
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
