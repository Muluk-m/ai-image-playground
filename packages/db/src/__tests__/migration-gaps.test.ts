import { expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import journal from '../../drizzle/meta/_journal.json'

const packageRoot = join(import.meta.dir, '../..')

it('keeps migration idx 13 and 80 absent and documents why', () => {
  const indexes = journal.entries.map((entry) => entry.idx)
  expect(indexes).not.toContain(13)
  expect(indexes).not.toContain(80)
  expect(journal.entries.find((entry) => entry.idx === 12)?.tag).toBe('0012_flowery_viper')
  expect(journal.entries.find((entry) => entry.idx === 14)?.tag).toBe('0014_agent_task_link')
  expect(journal.entries.find((entry) => entry.idx === 79)?.tag).toBe('0079_task_metering')
  expect(journal.entries.find((entry) => entry.idx === 81)?.tag).toBe('0081_cli_device_oauth')

  const tags = journal.entries.map((entry) => entry.tag)
  expect(tags.some((tag) => tag.startsWith('0013_') || tag.startsWith('0080_'))).toBe(false)
  const files = readdirSync(join(packageRoot, 'drizzle'))
  expect(files.some((name) => name.startsWith('0013_') || name.startsWith('0080_'))).toBe(false)

  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8')
  expect(readme).toContain('13 和 80')
  expect(readme).toContain('0012_flowery_viper')
  expect(readme).toContain('0014_agent_task_link')
  expect(readme).toContain('0079_task_metering')
  expect(readme).toContain('0081_cli_device_oauth')
  expect(readme).toContain('不要补')
})
