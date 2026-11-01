import assert from 'node:assert/strict'
import { test } from 'node:test'

const { parseShard, selectShard } = await import(new URL('../test-shard.ts', import.meta.url).href)

const files = Array.from({ length: 287 }, (_, index) => `src/__tests__/${String(index).padStart(3, '0')}.test.ts`)

test('the shards together run every file exactly once', () => {
  for (const total of [1, 2, 3, 4, 7]) {
    const seen = []
    for (let index = 1; index <= total; index++) seen.push(...selectShard(files, { index, total }))
    assert.deepEqual([...seen].sort(), files, `${total} shards`)
  }
})

test('shards differ in size by at most one file', () => {
  const sizes = [1, 2, 3].map((index) => selectShard(files, { index, total: 3 }).length)
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, String(sizes))
})

test('no shard means the whole list', () => {
  assert.deepEqual(selectShard(files, undefined), files)
})

test('parseShard rejects malformed or out-of-range values', () => {
  assert.deepEqual(parseShard('2/3'), { index: 2, total: 3 })
  for (const bad of ['', '3', '0/3', '4/3', '1/0', 'a/b', '1/3/2']) {
    assert.throws(() => parseShard(bad), /--shard/, bad)
  }
})
