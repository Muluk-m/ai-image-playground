/**
 * 回填 `verified`：`bun run scripts/skill-verification/backfill.ts <技能名>...`，
 * 不给技能名则处理所有写了 `verification/record.json` 的图片技能。
 * 过线写入 `meta.json` 的 `verified`（日期、模型、平均分）；不过线删掉它并打印原因，退出码 1。
 */
import { backfillSkillDirectory } from '../../src/lib/skill-verification/backfill'
import { imageSkillDirectory, parseArgs, skillsWithRecords } from './common'

const { positional } = parseArgs(process.argv.slice(2))
const skills = positional.length > 0 ? positional : skillsWithRecords()
if (skills.length === 0) throw new Error('没有找到任何 verification/record.json')

let failed = 0
for (const skill of skills) {
  const verdict = backfillSkillDirectory(imageSkillDirectory(skill))
  if (verdict.passed) {
    const { date, model, score } = verdict.verified
    console.log(
      `✓ ${skill}：过线，写入 verified { date: ${date}, model: ${model}, score: ${score} }`,
    )
  } else {
    failed++
    console.log(`✗ ${skill}：未过线，已移除 verified`)
    for (const reason of verdict.reasons) console.log(`    - ${reason}`)
  }
}
process.exitCode = failed > 0 ? 1 : 0
