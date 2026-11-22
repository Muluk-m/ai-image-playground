// PR 描述与改动范围的机器检查，由 dangerfile.ts 在每个 PR 上调用（.github/workflows/danger.yml）。
// 规则来源：AGENTS.md「合并门槛」「关键流程证据」「成本与影响说明」与 PR 模板。
// 纯函数，输入改动文件与 PR 描述，输出 fails / warns / 标签，单测在 scripts/__tests__/pr-rules.test.mjs。
import { costFiles } from './cost-impact.mjs'

/** 注册登录、支付计费、生成提交：改到这些路径必须附测试环境走通的证据。测试目录不算。 */
export const CRITICAL_FLOWS = {
  注册登录: [
    /^apps\/bff\/src\/routes\/(auth|oauth|account)\.ts$/,
    /^apps\/bff\/src\/lib\/(auth-origin-config|auth-origin-policy|password-reset|user-auth|user-session)\.ts$/,
    /^apps\/bff\/src\/lib\/oauth\//,
    /^apps\/web\/src\/lib\/(authClient|authScope|sessionRefreshJournal)\.ts$/,
  ],
  支付计费: [
    /^private\.lock$/,
    /^apps\/bff\/src\/lib\/(private-overlay|private-host)\.ts$/,
    /^apps\/bff\/src\/db\/task-transitions\.ts$/,
    /^apps\/web\/src\/features\/pricing\//,
    /^apps\/web\/src\/components\/(Credits|SubmissionBillingAction)\.tsx$/,
  ],
  生成: [
    /^apps\/bff\/src\/routes\/(submit|cancel|result)\.ts$/,
    /^apps\/bff\/src\/lib\/taskSubmission\.ts$/,
    /^apps\/bff\/src\/workers\/(task-execution|task-runner|task-scheduler|runnable-tasks)\.ts$/,
    /^apps\/web\/src\/lib\/(generationJob|batchGenerate|placeCloudGeneration)\.ts$/,
  ],
}

/** 界面文件：Web 与 Admin 的组件和样式。官网（apps/website）不发到测试环境，不算。 */
const UI_FILE = /^apps\/(web|admin)\/src\/.*\.(tsx|css)$/

/** 不计入 PR 行数的生成物与数据（REVIEW.md「可以跳过的文件」）。 */
const GENERATED = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /^scripts\/design-baseline\.json$/,
  /^packages\/db\/drizzle\/meta\//,
  /\.snap$/,
]

export const LARGE_PR_LINES = 1000

const MIGRATION = /^packages\/db\/drizzle\/(\d{4}_[^/]+)\.sql$/

const notTest = (file) => !file.split('/').includes('__tests__')

/** 去掉 HTML 注释：模板注释里本身就写着 test.muvloom.online 和示例。 */
export function stripComments(body) {
  return (body ?? '').replace(/<!--[\s\S]*?-->/g, '')
}

/** `## 标题` 到下一个二级标题之间的正文。 */
export function section(body, title) {
  const lines = stripComments(body).split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${title}`)
  if (start < 0) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s/.test(line))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

const withoutCheckboxes = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*-\s*\[[ xX]\]/.test(line))
    .join('\n')

const hasMedia = (text) =>
  /!\[[^\]]*\]\(|<img\s|<video\s|github\.com\/user-attachments\/|\.(png|jpe?g|gif|webp|mp4|mov|webm)\b/i.test(
    text,
  )

/**
 * @param {{ files: { filename: string, status?: string, additions?: number, deletions?: number,
 *   previous_filename?: string }[], body: string | null }} pr
 * @returns {{ fails: string[], warns: string[], costFiles: string[] }}
 */
export function evaluatePr({ files, body }) {
  const fails = []
  const warns = []
  const paths = [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))]
  const clean = stripComments(body)

  const ui = paths.filter((p) => notTest(p) && UI_FILE.test(p))
  if (ui.length) {
    const what = `改了界面（${ui.length} 个文件，如 \`${ui[0]}\`）`
    const rule = '（AGENTS.md「先验证再开 PR」第 2 条，只有本地截图不算）'
    if (!hasMedia(clean)) fails.push(`${what}，描述里需要附测试环境 test.muvloom.online 的截图${rule}。`)
    // 模板的复选框文字里也有 test.muvloom.online，不算作者写明的环境。
    else if (!withoutCheckboxes(clean).includes('test.muvloom.online'))
      fails.push(`${what}，描述里有截图但没写明来自测试环境 test.muvloom.online${rule}。`)
  }

  const flows = Object.entries(CRITICAL_FLOWS)
    .map(([name, patterns]) => [name, paths.filter((p) => notTest(p) && patterns.some((re) => re.test(p)))])
    .filter(([, hit]) => hit.length)
  if (flows.length) {
    const evidence = section(body, '关键流程证据') ?? ''
    const checked = /-\s*\[[xX]\]\s*已附测试账号/.test(evidence)
    const list = flows.map(([name, hit]) => `${name}（\`${hit[0]}\`${hit.length > 1 ? ` 等 ${hit.length} 个` : ''}）`)
    // 只改类型、重构等不改流程行为的 PR：勾「不涉及」并写理由，降为警告，由评审确认理由成立。
    const reason = evidence
      .split('\n')
      .filter((line) => !/^\s*-\s*\[[ xX]\]/.test(line) && !/^改到注册\/登录/.test(line.trim()))
      .join(' ')
      .trim()
    const waived = /-\s*\[[xX]\]\s*本 PR 不涉及/.test(evidence) && reason.length >= 4
    if (checked && hasMedia(evidence)) {
      // 证据齐全
    } else if (waived) {
      warns.push(`改到关键流程：${list.join('、')}，作者声明不涉及流程行为：「${reason.slice(0, 120)}」。请评审确认。`)
    } else {
      fails.push(
        `改到关键流程：${list.join('、')}。「关键流程证据」需要勾选「已附测试账号…」并附截图或录屏，写明账号类型、环境和提交（AGENTS.md「关键流程证据」）；确实不改流程行为的，勾「不涉及」并写一句理由。`,
      )
    }
  }

  const cost = [...new Set(costFiles(paths))]
  if (cost.length) {
    const text = section(body, '成本与影响') ?? ''
    if (!text || /^不涉及[。.]?$/.test(text.trim())) {
      fails.push(
        `改到可能影响成本的文件（${cost.length} 个，如 \`${cost[0]}\`），「成本与影响」需要写清改了什么、成本怎么变；涉及结算的在标题或正文标明「涉及结算，需 Nain 亲自审」。`,
      )
    }
  }

  const lines = files
    .filter((f) => !GENERATED.some((re) => re.test(f.filename)))
    .reduce((sum, f) => sum + (f.additions ?? 0) + (f.deletions ?? 0), 0)
  if (lines > LARGE_PR_LINES) {
    warns.push(`改动 ${lines} 行（不含 lockfile、快照等生成物），超过 ${LARGE_PR_LINES} 行，考虑按「一件事一个 PR」拆分。`)
  }

  for (const f of files) {
    const m = f.status === 'added' && MIGRATION.exec(f.filename)
    if (!m) continue
    const rollback = `packages/db/drizzle/rollback/${m[1]}.down.sql`
    if (!paths.includes(rollback)) {
      warns.push(`新迁移 \`${m[1]}\` 没有回滚 SQL \`${rollback}\`；「怎么回滚」里写清不可回滚的原因或补上它。`)
    }
  }

  return { fails, warns, costFiles: cost }
}
