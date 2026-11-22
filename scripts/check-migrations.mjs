#!/usr/bin/env node
// Drizzle migrations are append-only relative to main: an applied migration that is renumbered,
// retimed or edited is skipped or rerun by `drizzle.__drizzle_migrations` (the 2026-10-27 test
// release broke this way), and runMigrations aborts a release on a new entry whose `when` is not
// later than the newest applied one. This catches both in the PR instead of at release time.
//
// Usage: node scripts/check-migrations.mjs [base-ref]   (default: MIGRATIONS_BASE_REF or origin/main)
// Without the base ref (shallow clone, no fetch) it only checks the working tree and says so.
// A branch behind main (main has migrations the tree lacks) is not a migration problem and passes.
// An older-stamped entry is allowed only as an audited `original` in migrate.ts migrationSupersessions.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MIGRATIONS_DIR = 'packages/db/drizzle'
const JOURNAL = `${MIGRATIONS_DIR}/meta/_journal.json`
const MIGRATE_SOURCE = 'packages/db/src/migrate.ts'

/** Tags migrate.ts lets run behind a newer applied migration (`original` of each supersession). */
export function supersededTags(source) {
  return new Set([...source.matchAll(/original:\s*\{\s*tag:\s*'([^']+)'/g)].map((m) => m[1]))
}

const tagNumber = (tag) => Number.parseInt(tag.slice(0, 4), 10)

/**
 * @param {{ head: {idx:number, tag:string, when:number}[], base?: {idx:number, tag:string, when:number}[],
 *   headSql: (tag: string) => string | undefined, baseSql?: (tag: string) => string | undefined,
 *   sqlFiles: string[], superseded?: Set<string> }} input
 * @returns {string[]} problems, empty when the migrations are fine
 */
export function checkMigrations({ head, base, headSql, baseSql, sqlFiles, superseded = new Set() }) {
  const problems = []
  const tags = new Set()
  for (const entry of head) {
    if (tags.has(entry.tag)) problems.push(`${entry.tag}: listed twice in the journal`)
    tags.add(entry.tag)
    if (headSql(entry.tag) === undefined) problems.push(`${entry.tag}: journal entry without ${entry.tag}.sql`)
  }
  for (const file of sqlFiles) {
    const tag = file.replace(/\.sql$/, '')
    if (!tags.has(tag)) problems.push(`${file}: not in meta/_journal.json, drizzle will never run it`)
  }
  if (!base) return problems

  // Only the shared prefix must match: main may be ahead of this tree (the tree is behind, fine),
  // and entries past main's end are this tree's new migrations.
  const shared = Math.min(base.length, head.length)
  for (let i = 0; i < shared; i++) {
    const old = base[i]
    const now = head[i]
    if (now.tag !== old.tag || now.when !== old.when || now.idx !== old.idx) {
      problems.push(
        `${old.tag}: main has ${old.tag} (idx ${old.idx}, when ${old.when}) where this tree has ${now.tag} ` +
          `(idx ${now.idx}, when ${now.when}); migrations on main may be applied — rebase on main and append after them`,
      )
    } else if (baseSql && baseSql(old.tag) !== headSql(old.tag)) {
      problems.push(`${old.tag}.sql: edited after it landed on main; its hash is recorded where it ran, append a new migration`)
    }
  }

  // runMigrations compares against the newest applied stamp, not the journal's last entry.
  const newestOnMain = Math.max(...base.map((e) => e.when))
  let prev = base.at(-1)
  for (const entry of head.slice(base.length)) {
    if (entry.when <= newestOnMain && !superseded.has(entry.tag)) {
      problems.push(
        `${entry.tag}: when ${entry.when} is not later than the newest migration on main (${newestOnMain}); ` +
          'runMigrations will abort the release. Give it a later timestamp',
      )
    }
    if (prev && entry.idx !== prev.idx + 1) problems.push(`${entry.tag}: idx ${entry.idx} should be ${prev.idx + 1}`)
    if (prev && tagNumber(entry.tag) <= tagNumber(prev.tag)) {
      problems.push(`${entry.tag}: number must be above ${prev.tag}`)
    }
    prev = entry
  }
  return problems
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function main() {
  const baseRef = process.argv[2] || process.env.MIGRATIONS_BASE_REF || 'origin/main'
  const head = JSON.parse(readFileSync(JOURNAL, 'utf8')).entries
  const headSql = (tag) => {
    const path = join(MIGRATIONS_DIR, `${tag}.sql`)
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  }
  const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))

  let base
  let baseSql
  try {
    git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])
    base = JSON.parse(git(['show', `${baseRef}:${JOURNAL}`])).entries
    baseSql = (tag) => {
      try {
        return git(['show', `${baseRef}:${MIGRATIONS_DIR}/${tag}.sql`])
      } catch {
        return undefined
      }
    }
  } catch {
    console.warn(`check-migrations: ${baseRef} not available, only checking the working tree`)
  }

  const superseded = supersededTags(readFileSync(MIGRATE_SOURCE, 'utf8'))
  const problems = checkMigrations({ head, base, headSql, baseSql, sqlFiles, superseded })
  if (problems.length) {
    console.error(`check-migrations: ${problems.length} problem(s) against ${baseRef}:`)
    for (const p of problems) console.error(`  - ${p}`)
    console.error('See AGENTS.md「改迁移编号前先查两个库已经跑过哪些迁移」.')
    process.exit(1)
  }
  console.log(`check-migrations: ${head.length} migrations ok${base ? ` (append-only against ${baseRef})` : ''}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()
