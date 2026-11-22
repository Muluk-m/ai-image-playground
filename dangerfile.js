// PR 规则检查（.github/workflows/danger.yml）。规则本身在 scripts/pr-rules.mjs，这里只取数据、报结果、同步标签。
// workflow 只执行目标分支（base）上的本文件，从不执行 PR 带来的代码。
import { danger, fail, markdown, schedule, warn } from 'danger'
import { evaluatePr } from './scripts/pr-rules.mjs'

const COST_LABEL = 'cost-impact'

async function run() {
  const { owner, repo, number } = danger.github.thisPR
  const api = danger.github.api
  const files = await api.paginate(api.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 })
  const result = evaluatePr({ files, body: danger.github.pr.body })

  for (const message of result.fails) fail(message)
  for (const message of result.warns) warn(message)

  const labels = (danger.github.issue.labels ?? []).map((label) => label.name)
  if (result.costFiles.length) {
    markdown(`### 可能影响成本\n\n${result.costFiles.map((f) => `- \`${f}\``).join('\n')}`)
    if (!labels.includes(COST_LABEL)) {
      await api.issues.addLabels({ owner, repo, issue_number: number, labels: [COST_LABEL] })
    }
  } else if (labels.includes(COST_LABEL)) {
    await api.issues.removeLabel({ owner, repo, issue_number: number, name: COST_LABEL })
  }
}

schedule(run())
