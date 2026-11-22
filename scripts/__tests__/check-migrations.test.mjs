import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkMigrations, supersededTags } from '../check-migrations.mjs'

const entry = (idx, tag, when) => ({ idx, tag, when })
// The real journal has an inverted stamp too (0092 > 0093), so the newest is not always last.
const base = [entry(0, '0000_a', 100), entry(1, '0002_b', 300), entry(2, '0003_c', 200)]
const sql =
  (overrides = {}) =>
  (tag) =>
    tag in overrides ? overrides[tag] : `-- ${tag}`
const files = (entries) => entries.map((e) => `${e.tag}.sql`)

const run = (head, { against = base, headSql = sql(), superseded, sqlFiles = files(head) } = {}) =>
  checkMigrations({ head, base: against ?? undefined, headSql, baseSql: sql(), sqlFiles, superseded }).join('\n')

test('accepts the existing irregular history and an appended migration', () => {
  assert.equal(run([...base, entry(3, '0004_d', 400)]), '')
})

test('accepts a tree that is behind main', () => {
  assert.equal(run(base.slice(0, 2)), '')
  assert.equal(run(base, { against: [...base, entry(3, '0004_main', 400)] }), '')
})

test('rejects renumbering, retiming or editing a migration already on main', () => {
  assert.match(run([base[0], entry(1, '0001_b', 300), base[2]]), /main has 0002_b/)
  assert.match(run([base[0], entry(1, '0002_b', 301), base[2]]), /main has 0002_b/)
  assert.match(run(base, { headSql: sql({ '0002_b': 'ALTER' }) }), /0002_b.sql: edited/)
})

test('compares a new stamp with the newest on main, not the last entry', () => {
  assert.match(run([...base, entry(3, '0004_d', 250)]), /not later than the newest migration on main \(300\)/)
})

test('allows an older stamp only for an audited supersession original', () => {
  const head = [...base, entry(3, '0004_original', 250), entry(4, '0005_forward', 400)]
  assert.match(run(head), /0004_original: when 250/)
  assert.equal(run(head, { superseded: new Set(['0004_original']) }), '')
})

test('rejects a branch whose migration collides with one main added meanwhile', () => {
  const onMain = [...base, entry(3, '0004_main', 400)]
  assert.match(run([...base, entry(3, '0004_branch', 500)], { against: onMain }), /main has 0004_main/)
})

test('rejects orphan sql files and entries without sql, also without a base', () => {
  const head = [...base, entry(3, '0004_d', 400)]
  const problems = run(head, {
    against: null,
    headSql: sql({ '0004_d': undefined }),
    sqlFiles: [...files(base), '0005_orphan.sql'],
  })
  assert.match(problems, /0004_d: journal entry without/)
  assert.match(problems, /0005_orphan.sql: not in meta/)
})

test('reads supersession originals from migrate.ts', () => {
  const source = `const migrationSupersessions = [
  { original: { tag: '0079_task_metering', when: 1 }, forward: { tag: '0085_x', when: 2 } },
  {
    original: {
      tag: '0081_cli_device_oauth',`
  assert.deepEqual([...supersededTags(source)], ['0079_task_metering', '0081_cli_device_oauth'])
})
