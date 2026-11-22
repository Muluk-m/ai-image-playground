import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkMigrations } from '../check-migrations.mjs'

const entry = (idx, tag, when) => ({ idx, tag, when })
const base = [entry(0, '0000_a', 100), entry(1, '0002_b', 300), entry(2, '0003_c', 200)]
const sql = (overrides = {}) => (tag) => (tag in overrides ? overrides[tag] : `-- ${tag}`)
const files = (entries) => entries.map((e) => `${e.tag}.sql`)

const run = (head, { headSql = sql(), baseSql = sql(), withBase = true, sqlFiles = files(head) } = {}) =>
  checkMigrations({ head, base: withBase ? base : undefined, headSql, baseSql, sqlFiles })

test('accepts the existing irregular history and an appended migration', () => {
  assert.deepEqual(run([...base, entry(3, '0004_d', 400)]), [])
})

test('rejects renumbering, retiming or editing a migration already on main', () => {
  const renumbered = [base[0], entry(1, '0001_b', 300), base[2]]
  assert.match(run(renumbered).join('\n'), /0002_b: changed from main/)
  const retimed = [base[0], entry(1, '0002_b', 301), base[2]]
  assert.match(run(retimed).join('\n'), /0002_b: changed from main/)
  assert.match(run(base, { headSql: sql({ '0002_b': 'ALTER' }) }).join('\n'), /0002_b.sql: edited/)
})

test('rejects an appended migration that is not later than main', () => {
  assert.match(run([...base, entry(3, '0004_d', 200)]).join('\n'), /not later than 0003_c/)
})

test('rejects a branch that collides with a migration main added meanwhile', () => {
  const onMain = [...base, entry(3, '0004_main', 400)]
  const problems = checkMigrations({
    head: [...base, entry(3, '0004_branch', 500)],
    base: onMain,
    headSql: sql(),
    baseSql: sql(),
    sqlFiles: files([...base, entry(3, '0004_branch', 500)]),
  })
  assert.match(problems.join('\n'), /0004_main: changed from main/)
})

test('rejects orphan sql files and entries without sql, also without a base', () => {
  const head = [...base, entry(3, '0004_d', 400)]
  const problems = run(head, {
    withBase: false,
    headSql: sql({ '0004_d': undefined }),
    sqlFiles: [...files(base), '0005_orphan.sql'],
  })
  assert.match(problems.join('\n'), /0004_d: journal entry without/)
  assert.match(problems.join('\n'), /0005_orphan.sql: not in meta/)
})
