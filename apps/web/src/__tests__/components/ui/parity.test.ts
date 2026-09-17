import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const webUi = resolve(here, '../../../components/ui')
const adminUi = resolve(here, '../../../../../admin/src/components/ui')

function read(directory: string, file: string): string | null {
  try {
    return readFileSync(join(directory, file), 'utf8')
  } catch {
    return null
  }
}

// 两个 app 的 shadcn 原语是同一份复制过来的——shadcn 的模型就是「组件是你自己的代码」，
// 抽成公共包要连 tailwind 配置、token 和别名一起搬，现在不划算。代价是同步全靠自觉，
// 所以让测试来记账：两边都有的文件必须一模一样，改一边就会在这里失败。
it('keeps the shadcn primitives identical to the ones in apps/admin', () => {
  const shared = readdirSync(webUi).filter((file) => read(adminUi, file) !== null)
  expect(shared.length).toBeGreaterThan(0)

  const drifted = shared.filter((file) => read(webUi, file) !== read(adminUi, file))
  expect(drifted).toEqual([])
})
