import { describe, expect, it } from 'bun:test'
import { OPS_THRESHOLDS, type OpsBackups } from '@image-playground/shared'
import {
  BackupWatchDeferred,
  createBackupWatch,
  isBackupWatchDeferred,
} from '../../ops/backup-watch'

const interval = OPS_THRESHOLDS.BACKUP_WATCH_INTERVAL_MS
const backup = (modifiedAt: number): OpsBackups => ({
  latest: { key: 'pg/2026-11-19T00.dump', size_bytes: 1, modified_at: modifiedAt },
  previous: null,
})

describe('createBackupWatch', () => {
  it('lists once, then reuses the result until the interval elapses', async () => {
    let lists = 0
    const watch = createBackupWatch({
      intervalMs: interval,
      readBackups: async () => {
        lists++
        return backup(lists)
      },
      readRestoreDrill: async () => null,
    })
    const first = await watch.readBackups(1_000)
    expect(first.latest?.modified_at).toBe(1)
    expect(await watch.readBackups(1_000 + interval - 1)).toEqual(first)
    expect(lists).toBe(1)
    const next = await watch.readBackups(1_000 + interval)
    expect(next.latest?.modified_at).toBe(2)
    expect(lists).toBe(2)
  })

  it('does not retry a failed list until the interval elapses, and does not reuse the old cache', async () => {
    const calls: string[] = []
    const watch = createBackupWatch({
      intervalMs: interval,
      readBackups: async () => {
        calls.push('list')
        if (calls.length === 1) return backup(1)
        throw new Error('object store unreachable')
      },
      readRestoreDrill: async () => null,
    })
    expect((await watch.readBackups(0)).latest?.modified_at).toBe(1)
    await expect(watch.readBackups(interval)).rejects.toThrow('object store unreachable')
    await expect(watch.readBackups(interval + 1)).rejects.toBeInstanceOf(BackupWatchDeferred)
    expect(calls).toEqual(['list', 'list'])
    await expect(watch.readBackups(interval * 2)).rejects.toThrow('object store unreachable')
    expect(calls).toEqual(['list', 'list', 'list'])
  })

  it('defers when the first list failed and the interval has not elapsed', async () => {
    let lists = 0
    const watch = createBackupWatch({
      intervalMs: interval,
      readBackups: async () => backup(1),
      readRestoreDrill: async () => {
        lists++
        throw new Error('object store unreachable')
      },
    })
    await expect(watch.readRestoreDrill(0)).rejects.toThrow('object store unreachable')
    try {
      await watch.readRestoreDrill(interval - 1)
      throw new Error('expected deferral')
    } catch (error) {
      expect(isBackupWatchDeferred(error)).toBe(true)
    }
    expect(lists).toBe(1)
  })

  it('retries after a synchronous throw once the interval elapses', async () => {
    let lists = 0
    const watch = createBackupWatch({
      intervalMs: interval,
      readBackups: () => {
        lists++
        if (lists === 1) throw new Error('sync fail')
        return Promise.resolve(backup(lists))
      },
      readRestoreDrill: async () => null,
    })
    await expect(watch.readBackups(0)).rejects.toThrow('sync fail')
    await expect(watch.readBackups(1)).rejects.toBeInstanceOf(BackupWatchDeferred)
    expect(lists).toBe(1)
    const recovered = await watch.readBackups(interval)
    expect(recovered.latest?.modified_at).toBe(2)
    expect(lists).toBe(2)
  })
})
