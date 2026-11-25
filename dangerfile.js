// PR 规则检查（.github/workflows/danger.yml）。规则本身在 scripts/pr-rules.mjs，这里只取数据、报结果、同步标签。
// workflow 只执行目标分支（base）上的本文件，从不执行 PR 带来的代码。
import { danger, fail, markdown, schedule, warn } from 'danger'
import { evaluatePr, hydrateMigrationContents } from './scripts/pr-rules.mjs'

const COST_LABEL = 'cost-impact'

async function fetchMigrationContent(api, { owner, repo, ref }, file) {
  if (file.sha) {
    try {
      const { data } = await api.git.getBlob({ owner, repo, file_sha: file.sha })
      if (data?.encoding === 'base64' && typeof data.content === 'string') {
        return Buffer.from(data.content, 'base64').toString('utf8')
      }
    } catch {
      // 回退到 repos.getContent
    }
  }
  const { data } = await api.repos.getContent({ owner, repo, path: file.filename, ref })
  if (
    !Array.isArray(data) &&
    data?.type === 'file' &&
    data?.encoding === 'base64' &&
    typeof data.content === 'string'
  ) {
    return Buffer.from(data.content, 'base64').toString('utf8')
  }
  return undefined
}

async function syncCostLabel(api, issue, wanted) {
  const labels = (danger.github.issue.labels ?? []).map((label) => label.name)
  try {
    if (wanted && !labels.includes(COST_LABEL))
      await api.issues.addLabels({ ...issue, labels: [COST_LABEL] })
    else if (!wanted && labels.includes(COST_LABEL))
      await api.issues.removeLabel({ ...issue, name: COST_LABEL })
  } catch (error) {
    // 标签只是提示；写失败不能顶掉规则结论。
    warn(`没能同步 \`${COST_LABEL}\` 标签：${error?.status ?? ''} ${error?.message ?? error}`)
  }
}

async function run() {
  const { owner, repo, number } = danger.github.thisPR
  const api = danger.github.api
  const headSha = process.env.EVENT_HEAD_SHA || danger.github.pr.head.sha
  const rawFiles = await api.paginate(api.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 })
  const files = await hydrateMigrationContents(rawFiles, (f) =>
    fetchMigrationContent(api, { owner, repo, ref: headSha }, f),
  )
  const result = evaluatePr({ files, body: danger.github.pr.body })

  for (const message of result.fails) fail(message)
  for (const message of result.warns) warn(message)
  if (result.costFiles.length)
    markdown(`### 可能影响成本\n\n${result.costFiles.map((f) => `- \`${f}\``).join('\n')}`)

  // 跑的期间 PR 又推了新提交：标签留给新提交那次运行，避免旧结果后写覆盖新结果。
  // 现取最新 head，Danger 初始化时的 PR 快照看不到之后的推送。
  const eventHead = process.env.EVENT_HEAD_SHA
  if (eventHead) {
    const { data: latest } = await api.pulls.get({ owner, repo, pull_number: number })
    if (latest.head.sha !== eventHead) return
  }
  await syncCostLabel(api, { owner, repo, issue_number: number }, result.costFiles.length > 0)
}

schedule(run())
