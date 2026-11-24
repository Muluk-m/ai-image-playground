// PR 描述与改动范围的机器检查，由 dangerfile.js 在每个 PR 上调用（.github/workflows/danger.yml）。
// 规则来源：AGENTS.md「合并门槛」「关键流程证据」「成本与影响说明」与 PR 模板。
// 纯函数，输入改动文件与 PR 描述，输出 fails / warns / 标签，单测在 scripts/__tests__/pr-rules.test.mjs。
import { costFiles } from './cost-impact.mjs'

/**
 * 注册登录、支付计费、生成提交的入口：改到这些路径必须附测试环境走通的证据。测试目录不算。
 * 只覆盖入口，不是完整定义：清单外的流程改动同样要附（AGENTS.md「关键流程证据」）。
 * Admin 鉴权不在内：测试环境没有 Admin 站点，走不了测试账号流程。
 */
export const CRITICAL_FLOWS = {
  注册登录: [
    /^apps\/bff\/src\/routes\/(auth|oauth|account|cli)\.ts$/,
    /^apps\/bff\/src\/lib\/(auth-origin-config|auth-origin-policy|password-reset|registration-verification|user-auth|user-session)\.ts$/,
    /^apps\/bff\/src\/lib\/oauth\//,
    /^apps\/bff\/src\/modules\/identity\//,
    /^apps\/web\/src\/lib\/(authClient|authScope|sessionRefreshJournal)\.ts$/,
    /^apps\/web\/src\/auth\/(AuthGate|LoginDialog|LoginMethodsPanel|RegistrationPanel)\.tsx$/,
    /^apps\/web\/src\/auth\/(loginPrompt|pendingSubmission|resumePendingSubmission)\.ts$/,
    /^apps\/website\/src\/components\/SiteAuth\.tsx$/,
  ],
  支付计费: [
    /^apps\/bff\/src\/lib\/(private-overlay|billing-hooks|billing-ports)\.ts$/,
    /^apps\/bff\/src\/modules\/billing\//,
    /^apps\/bff\/src\/modules\/execution\/(task-lifecycle-bus|task-transitions|task-submission|task-submission-plugins|submission-admission|submission-idempotency|submission-tier)\.ts$/,
    /^apps\/bff\/src\/bootstrap\/(task-lifecycle|task-submission)\.ts$/,
    /^apps\/web\/src\/features\/(pricing|billing)\//,
    /^apps\/web\/src\/components\/(Credits|SubmissionBillingAction)\.tsx$/,
  ],
  生成: [
    /^apps\/bff\/src\/routes\/(submit|cancel|result|generations|production-generations|agent-batches)\.ts$/,
    /^apps\/bff\/src\/lib\/generations\.ts$/,
    /^apps\/bff\/src\/lib\/agent\/production-generation\.ts$/,
    /^apps\/bff\/src\/modules\/execution\/(task-lifecycle-bus|task-submission|task-outcome|submission-admission|submission-tier|submission-prepare|submission-idempotency|task-submission-plugins|task-execution-hooks)\.ts$/,
    /^apps\/bff\/src\/bootstrap\/(task-lifecycle|task-submission|task-execution)\.ts$/,
    /^apps\/bff\/src\/workers\/(task-execution|task-runner|task-scheduler|agent-batch-loop|runnable-tasks)\.ts$/,
    /^apps\/web\/src\/lib\/(generationJob|batchGenerate|placeCloudGeneration)\.ts$/,
  ],
}

/** 发到 test.muvloom.online 的界面：工作台与官网（同一份 Pages 产物）。 */
const UI_FILE = /^apps\/(web|website)\/src\/.*\.(tsx|css)$/
/** Admin 没有测试环境：要截图，但不要求来自 test.muvloom.online。 */
const ADMIN_UI_FILE = /^apps\/admin\/src\/.*\.(tsx|css)$/

/** 不计入 PR 行数的生成物与数据（REVIEW.md「可以跳过的文件」）。 */
const GENERATED = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /^scripts\/design-baseline\.json$/,
  /^packages\/db\/drizzle(?:-billing)?\/meta\//,
  /\.snap$/,
  /\.gen\.ts$/,
  /^apps\/web\/public\//,
]

export const LARGE_PR_LINES = 1000

const MIGRATION = /^packages\/db\/drizzle\/(\d{4}_[^/]+)\.sql$/

const notTest = (file) => !file.split('/').includes('__tests__')

/** 去掉 HTML 注释：模板注释里本身就写着 test.muvloom.online 和示例。 */
export function stripComments(body) {
  // 没闭合的 `<!--` 一直删到结尾，与 GitHub 渲染一致。
  return (body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '')
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

/** 真实附件：Markdown 图片、img / video 标签或 GitHub 上传链接。正文里的文件名不算。 */
const hasMedia = (text) =>
  /!\[[^\]]*\]\([^)\s]+|<img\s[^>]*src=|<video\s[^>]*src=|https:\/\/github\.com\/user-attachments\//i.test(
    text,
  )

/** 「不涉及」「无」「N/A」这类不说明原因的套话。 */
const BOILERPLATE = /^[（(]?(不涉及|无|暂无|没有|n\/?a|none|-+)[）)]?[，,。.：:；;\s]*(见上|同上)?[。.]?$/i
const MIN_REASON = 10
const explained = (text) => text.trim().length >= MIN_REASON && !BOILERPLATE.test(text.trim())

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
  const adminUi = paths.filter((p) => notTest(p) && ADMIN_UI_FILE.test(p))
  if (adminUi.length && !hasMedia(clean)) {
    fails.push(
      `改了 Admin 界面（${adminUi.length} 个文件，如 \`${adminUi[0]}\`），描述里需要附截图并写明环境（Admin 没有测试环境）。`,
    )
  }
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
    // 理由可以写在勾选行后面，也可以另起一行；模板自带的说明文字不算。
    const reason = evidence
      .split('\n')
      .map((line) =>
        line
          .replace(/^\s*-\s*\[[xX]\]\s*本 PR 不涉及上述关键流程(（[^）]*）)?[：:，,]?\s*/, '')
          .trim(),
      )
      .filter((line) => line && !/^\s*-\s*\[[ xX]\]/.test(line) && !/^改到注册\/登录/.test(line))
      .join(' ')
      .trim()
    const waived = /-\s*\[[xX]\]\s*本 PR 不涉及/.test(evidence) && explained(reason)
    // 证据要写明环境、账号类型与提交；模板复选框自带的文字不算。
    const written = withoutCheckboxes(evidence)
    // 只在找提交 SHA 时去掉链接：附件 URL 里的 UUID 会被当成 SHA，环境却常写成完整链接。
    const withoutUrls = written.replace(/\bhttps?:\/\/\S+/g, ' ')
    const missing = [
      !written.includes('test.muvloom.online') && '环境（test.muvloom.online）',
      !/账号/.test(written) && '账号类型',
      !/\b[0-9a-f]{7,40}\b/i.test(withoutUrls) && '提交 SHA',
    ].filter(Boolean)
    if (checked && hasMedia(evidence) && !missing.length) {
      // 证据齐全
    } else if (checked && hasMedia(evidence)) {
      fails.push(`改到关键流程：${list.join('、')}。「关键流程证据」有截图，但没写明${missing.join('、')}。`)
    } else if (waived) {
      warns.push(`改到关键流程：${list.join('、')}，作者声明不涉及流程行为：「${reason.slice(0, 120)}」。请评审确认。`)
    } else {
      fails.push(
        `改到关键流程：${list.join('、')}。在「关键流程证据」这一节里勾选「已附测试账号…」并贴截图或录屏，写明账号类型、环境和提交（AGENTS.md「关键流程证据」）；确实不改流程行为的，勾「不涉及」并写明理由（至少 ${MIN_REASON} 个字，不能只写「不涉及」）。`,
      )
    }
  }

  const cost = [...new Set(costFiles(paths))]
  if (cost.length) {
    const text = section(body, '成本与影响') ?? ''
    if (!explained(text)) {
      fails.push(
        `改到可能影响成本的文件（${cost.length} 个，如 \`${cost[0]}\`），「成本与影响」需要写清改了什么、成本怎么变，不涉及也要写明为什么（至少 ${MIN_REASON} 个字）；涉及结算的在标题或正文标明「涉及结算」并在汇报里重点提示。`,
      )
    }
  }

  const lines = files
    .filter((f) => !GENERATED.some((re) => re.test(f.filename)))
    .reduce((sum, f) => sum + (f.additions ?? 0) + (f.deletions ?? 0), 0)
  if (lines > LARGE_PR_LINES) {
    warns.push(`改动 ${lines} 行（不含 lockfile、快照等生成物），超过 ${LARGE_PR_LINES} 行，考虑按「一件事一个 PR」拆分。`)
  }

  // 合并后仍在的文件：删掉的不算，改名只认新路径。
  const present = new Set(files.filter((f) => f.status !== 'removed').map((f) => f.filename))
  for (const f of files) {
    const m = f.status === 'added' && MIGRATION.exec(f.filename)
    if (!m) continue
    const rollback = `packages/db/drizzle/rollback/${m[1]}.down.sql`
    if (!present.has(rollback)) {
      warns.push(`新迁移 \`${m[1]}\` 没有回滚 SQL \`${rollback}\`；「怎么回滚」里写清不可回滚的原因或补上它。`)
    }
  }

  return { fails, warns, costFiles: cost }
}
