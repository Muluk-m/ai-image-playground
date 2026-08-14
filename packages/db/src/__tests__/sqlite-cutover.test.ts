import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSqliteCutover } from '../sqlite-cutover'

const sourcePath = join(tmpdir(), `image-playground-cutover-${crypto.randomUUID()}.sqlite`)
const backupPath = `${sourcePath}.readonly-backup`

function createSource(status: 'queued' | 'in_progress' | 'completed'): void {
  const db = new Database(sourcePath, { create: true })
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL)')
  db.query('INSERT INTO tasks (id, status) VALUES (?, ?)').run('task-1', status)
  db.close()
}

afterEach(() => {
  for (const path of [sourcePath, backupPath]) {
    try {
      unlinkSync(path)
    } catch {}
  }
})

describe('prepareSqliteCutover', () => {
  it('refuses cutover while a task is queued or in progress', () => {
    createSource('queued')

    expect(() => prepareSqliteCutover(sourcePath, backupPath)).toThrow(
      'SQLite cutover blocked by 1 unfinished task',
    )
    expect(existsSync(backupPath)).toBe(false)
  })

  it('creates a consistent read-only backup without importing history', () => {
    createSource('completed')

    expect(prepareSqliteCutover(sourcePath, backupPath)).toEqual({
      backupPath,
      totalTasks: 1,
      unfinishedTasks: 0,
    })

    expect(statSync(backupPath).mode & 0o222).toBe(0)
    const backup = new Database(backupPath, { readonly: true, strict: true })
    expect(backup.query('SELECT id, status FROM tasks').all()).toEqual([
      { id: 'task-1', status: 'completed' },
    ])
    backup.close()
  })
})
