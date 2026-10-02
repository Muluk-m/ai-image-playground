/**
 * 生成并排对比页：`bun run scripts/skill-verification/review.ts [跑图目录]`
 * 缺省取 `.verification-runs/` 下最新的一次。页面写到跑图目录的 `review.html`。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { type ReviewSkill, renderReviewPage } from '../../src/lib/skill-verification/review-page'
import { RUNS_ROOT } from './common'

/** 每条技能跑完写的那份清单：输入、发出的话、每次的结果。 */
export const RUN_MANIFEST = 'runs.json'

/** 把 `record.ts` 打包成浏览器脚本，页面上的判定与回填工具用同一个函数。 */
async function judgeScript(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'judge-entry.ts')],
    target: 'browser',
    format: 'iife',
    minify: true,
  })
  if (!built.success) throw new AggregateError(built.logs, '打包判定脚本失败')
  return built.outputs[0]!.text()
}

export async function writeReviewPage(runDir: string): Promise<string> {
  const skills = readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(runDir, entry.name, RUN_MANIFEST)))
    .map(
      (entry) =>
        JSON.parse(readFileSync(join(runDir, entry.name, RUN_MANIFEST), 'utf8')) as ReviewSkill,
    )
  if (skills.length === 0) throw new Error(`${runDir} 里没有跑图结果`)
  const page = join(runDir, 'review.html')
  writeFileSync(page, renderReviewPage(basename(runDir), skills, await judgeScript()))
  return page
}

function latestRunDir(): string {
  const runs = existsSync(RUNS_ROOT)
    ? readdirSync(RUNS_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : []
  if (runs.length === 0) throw new Error(`${RUNS_ROOT} 下没有跑图目录`)
  return join(RUNS_ROOT, runs.at(-1)!)
}

if (import.meta.main) {
  const target = process.argv[2] ? resolve(process.argv[2]) : latestRunDir()
  console.log(await writeReviewPage(target))
}
