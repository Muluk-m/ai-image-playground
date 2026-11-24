#!/usr/bin/env bun
/**
 * 限流、幂等零搬运回填：`user_asset_objects` -> `media_objects(storage_scope='object')`，
 * 并补齐活跃 `user_assets`、`user_looks` 与 `cli_reference_media` 的 `media_references` 引用计数。
 *
 * 用法：
 *   DATABASE_URL=... bun run scripts/backfill-asset-media.ts [--batch-size=1000] [--delay-ms=50] [--max-batches=N] [--verify-only]
 */
import { SQL } from 'bun'
import {
  backfillAssetMedia,
  verifyAssetMediaConsistency,
} from '../packages/db/src/backfill-asset-media'

const USAGE =
  'Usage: DATABASE_URL=... bun run scripts/backfill-asset-media.ts [--batch-size=1000] [--delay-ms=50] [--max-batches=N] [--verify-only] [--help]'

interface CliOptions {
  readonly help: boolean
  readonly verifyOnly: boolean
  readonly batchSize: number
  readonly delayMs: number
  readonly maxBatches?: number
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
  let batchSize = 1000
  let delayMs = 50
  let maxBatches: number | undefined
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--verify-only') {
      verifyOnly = true
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
    if (arg.startsWith('--max-batches=')) {
      maxBatches = parseNonEmptyNumber(arg.slice('--max-batches='.length), '--max-batches')
      continue
    }
    throw new Error(`Unknown argument: ${arg}\n${USAGE}`)
  }
  return { help, verifyOnly, batchSize, delayMs, maxBatches }
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
    await client`SET application_name = 'backfill-asset-media'`
    await client`SET lock_timeout = '5000ms'`
    if (!options.verifyOnly) {
      const result = await backfillAssetMedia(client, {
        batchSize: options.batchSize,
        delayMs: options.delayMs,
        maxBatches: options.maxBatches,
        onBatch: (batch) => {
          console.log(
            `[backfill-asset-media] phase=${batch.phase} batch=${batch.batchNumber} scanned=${batch.scanned} written=${batch.written}`,
          )
        },
      })
      console.log(
        `[backfill-asset-media] done batches=${result.batches} objects=${result.objectsWritten}/${result.objectsScanned} assetRefs=${result.assetRefsWritten}/${result.assetRefsScanned} lookRefs=${result.lookRefsWritten}/${result.lookRefsScanned} cliRefs=${result.cliRefsWritten}/${result.cliRefsScanned} staleRefsPruned=${result.staleRefsPruned} completed=${result.completed}`,
      )
      if (!result.completed) {
        console.log(
          '[backfill-asset-media] slice paused; re-run to resume remaining rows (skipping full-table consistency scan until completed or --verify-only)',
        )
        return
      }
    }
    const report = await verifyAssetMediaConsistency(client)
    console.log(JSON.stringify(report, null, 2))
    if (
      report.missingAssetMediaCount > 0 ||
      report.missingAssetRefCount > 0 ||
      report.missingLookRefCount > 0 ||
      report.missingCliRefCount > 0 ||
      report.staleSyncedRefCount > 0
    ) {
      process.exitCode = 1
    }
  } finally {
    await client.close()
  }
}

await main()
