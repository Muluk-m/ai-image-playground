import { describe, expect, it } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const SERVER_DIR = new URL('../../../server/', import.meta.url).pathname

async function serverSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await serverSources(full)))
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

/**
 * 对话轮也是 tasks 里的一行。后台一律读 `queue_tasks` 视图，读到裸表就会把它露出去——
 * 真要读对话轮，改这条测试，别偷偷绕过去。
 */
describe('运营后台只读 queue_tasks 视图', () => {
  it('server 下没有任何地方直接读 tasks 表', async () => {
    const offenders: string[] = []
    for (const file of await serverSources(SERVER_DIR)) {
      const source = await readFile(file, 'utf8')
      if (/FROM tasks\b/i.test(source) || /schema\.tasks\b/.test(source)) {
        offenders.push(file.slice(SERVER_DIR.length))
      }
    }
    expect(offenders).toEqual([])
  })
})
