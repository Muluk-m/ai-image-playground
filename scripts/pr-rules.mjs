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
    /^apps\/bff\/src\/lib\/(auth-origin-config|auth-origin-policy|password-reset|registration-verification|user-auth|user-login|user-session)\.ts$/,
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
    /^apps\/bff\/src\/modules\/agent\/orchestration\/production\/(generation|stage-authorizations|stage-runs)\.ts$/,
    /^apps\/bff\/src\/modules\/agent\/orchestration\/batch\/(execution|plans|plan-primitives)\.ts$/,
    /^apps\/bff\/src\/modules\/execution\/(task-lifecycle-bus|task-queries|task-submission|task-outcome|submission-admission|submission-tier|submission-prepare|submission-idempotency|task-submission-plugins|task-execution-hooks)\.ts$/,
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
const ANY_MIGRATION = /^packages\/db\/drizzle(?:-billing)?\/(\d{4}_[^/]+)\.sql$/

/** 判断路径是否为需要检查的数据库 SQL 迁移文件。 */
export const isMigrationFile = (filename) => ANY_MIGRATION.test(filename)

/** 为未删除的迁移文件补齐完整新文件内容，避免 diff 截断或修改既有迁移时丢失 SQL 上下文。 */
export async function hydrateMigrationContents(files, fetchContent) {
  return Promise.all(
    files.map(async (f) => {
      if (f.status === 'removed' || !isMigrationFile(f.filename) || typeof f.content === 'string') {
        return f
      }
      try {
        const content = await fetchContent(f)
        return typeof content === 'string' ? { ...f, content } : f
      } catch {
        return f
      }
    }),
  )
}

/** 不可逆破坏性迁移检测：回滚 SQL 只能重建空结构，无法恢复原数据。 */
const DESTRUCTIVE_TAG = /(?:^|_)(?:drop|truncate)(?:_|$)/i
const UNMET_RETENTION_GATE =
  /(?:(?:尚未|暂未|还未|仍未|未)(?:到期|过期|满\s*\d+\s*[天日小时]|到.{0,24}(?:保留|留存|发布|执行|日期|时间|窗口|\d{4}[-/年]\d{1,2}|\d{1,2}[-/月]\d{1,2}))|待(?:到期|过期|满\s*\d+\s*[天日小时])|尚在.{0,12}(?:保留|留存|观察|窗口)期|(?:保留|留存|观察|窗口)期.{0,8}(?:尚未|暂未|还未|仍未|未)|(?:最早|最晚).{0,10}(?:发布|执行|删除).{0,24}(?:尚未|暂未|还未|仍未|未到|未满)|(?:待|尚未|暂未|还未|仍未|未)(?:核对|确认|验证|完成).{0,14}(?:留存|保留|日期|时间|回填|历史数据|备份)|(?:未|尚未|暂未|还未|仍未|没有|无)全量回填)/
const NON_AFFIRMATIVE_CLAUSE =
  /(?:尚未|暂未|还未|仍未|未(?:[能曾达满到过做经完核确验全备清回])|没有|无(?:法|备份|恢复|冷备|快照)|不可恢复|不能|并非|并不|不确保|不保证|不确定|未知|待(?:确认|核验|验证|完成|回填|备份|到期)|是否|计划|拟(?:于|在)?|预计|准备|打算|之后再|后再执行)/
const POSITIVE_RETENTION_CONFIRMATION =
  /(?:已过期|已到期|无日期限制|无时间限制|无需保留|确认无历史数据|已清空|(?:确认|核验)(?:该|目标)?表(?:为|已)空|已(?:完成)?全量回填|全量回填(?:已完成|通过|零差异)|已回填(?:完成|验收|并?零差异)|(?:完成|通过)回填(?:零差异)?验收|回填零差异(?:已)?(?:验收|通过|确认)|已备份|已有.{0,6}(?:可恢复|已验证)?备份|已验证.{0,8}(?:备份|恢复|冷备|快照)|冷备(?:已|完成)|(?:备份|冷备|恢复|PG)\s*快照(?:已|可用|可恢复|验证))/i

/**
 * 评估「怎么回滚」中的留存/时间闸门核验结论：
 * - `blocked`：任一子句明确说明留存期/最早可发布时间尚未到期或核验未完成（不得被其他子句的备份确认覆盖）；
 * - `confirmed`：无未到期阻断，且至少存在一条正向、非否定、非未来计划的留存/到期/回填/备份核验结论；
 * - `missing`：未提供有效核验结论。
 */
function evaluateRetentionNote(text) {
  if (!explained(text)) return 'missing'
  const clauses = text
    .split(/[。；;，,：:\n！？!?]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
  if (clauses.some((clause) => UNMET_RETENTION_GATE.test(clause))) return 'blocked'
  const affirmed = clauses.some(
    (clause) => !NON_AFFIRMATIVE_CLAUSE.test(clause) && POSITIVE_RETENTION_CONFIRMATION.test(clause),
  )
  return affirmed ? 'confirmed' : 'missing'
}

/** 紧跟在可执行代码块前导关键字后的字符串/美元块需递归提取内部 SQL（含 EXECUTE ('...') 等带括号表达式）。 */
const EXEC_CODE_PREFIX =
  /\b(?:EXECUTE\s+(?:(?:format\s*)?\(\s*)*|DO\s+(?:LANGUAGE\s+\S+\s+)?|AS\s*)$/i

/**
 * 轻量 PostgreSQL 词法剥离：
 * - 去掉 `--` 行注释与可嵌套的 `/* ... *\/` 块注释；
 * - 双引号标识符替换为 `_id_`（避免 `"truncate"` 误报，同时保留 `DROP IF EXISTS "col"` 的标识符位）；
 * - `E'...'` / `'...'` 字面量默认替换为 `_str_`，但 `EXECUTE [format(] '...'` 内的动态 SQL 递归保留检测；
 * - `$tag$...$tag$` 仅在 `DO` / `AS` 代码块后递归保留内部 SQL，其余当作普通字面量替换为 `_str_`。
 */
function extractExecutableSql(input) {
  let out = ''
  let i = 0
  const n = input.length

  while (i < n) {
    const ch = input[i]
    const next = input[i + 1]

    // -- 行注释
    if (ch === '-' && next === '-') {
      i += 2
      while (i < n && input[i] !== '\n') i += 1
      continue
    }

    // /* ... */ 块注释（PostgreSQL 支持嵌套）
    if (ch === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (input[i] === '/' && input[i + 1] === '*') {
          depth += 1
          i += 2
        } else if (input[i] === '*' && input[i + 1] === '/') {
          depth -= 1
          i += 2
        } else {
          i += 1
        }
      }
      out += ' '
      continue
    }

    // "..." 双引号标识符
    if (ch === '"') {
      i += 1
      while (i < n) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      out += ' _id_ '
      continue
    }

    // E'...' 或 '...' 单引号字符串
    const isEscapeString =
      (ch === 'E' || ch === 'e') && next === "'" && (i === 0 || !/[A-Za-z0-9_$]/.test(input[i - 1]))
    if (ch === "'" || isEscapeString) {
      const start = isEscapeString ? i + 2 : i + 1
      i = start
      let body = ''
      while (i < n) {
        if (isEscapeString && input[i] === '\\' && i + 1 < n) {
          body += input[i + 1]
          i += 2
          continue
        }
        if (input[i] === "'") {
          if (input[i + 1] === "'") {
            body += "'"
            i += 2
            continue
          }
          i += 1
          break
        }
        body += input[i]
        i += 1
      }
      if (EXEC_CODE_PREFIX.test(out)) {
        out += ` ; ${extractExecutableSql(body)} ; `
      } else {
        out += ' _str_ '
      }
      continue
    }

    // $tag$...$tag$ 美元定界字符串
    if (ch === '$') {
      const open = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i))
      if (open) {
        const delim = open[0]
        const start = i + delim.length
        const end = input.indexOf(delim, start)
        const body = end < 0 ? input.slice(start) : input.slice(start, end)
        i = end < 0 ? n : end + delim.length
        if (EXEC_CODE_PREFIX.test(out)) {
          out += ` ; ${extractExecutableSql(body)} ; `
        } else {
          out += ' _str_ '
        }
        continue
      }
    }

    out += ch
    i += 1
  }

  return out
}

/** 从统一 diff 提取改动后的 SQL 片段（保留上下文行与新增行，忽略删除行），按 hunk 用 `;` 隔离。 */
function patchPostImageSql(patch) {
  const chunks = []
  let current = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      if (current.length) chunks.push(current.join('\n'))
      current = []
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) continue
    if (line.startsWith('+') || line.startsWith(' ')) current.push(line.slice(1))
  }
  if (current.length) chunks.push(current.join('\n'))
  return chunks.join('\n;\n')
}

/** 检测一段 SQL 中的不可逆破坏性 DDL 操作名。 */
function detectDestructiveOps(rawSql) {
  const sql = extractExecutableSql(rawSql)
  const hits = new Set()

  if (/\bDROP\s+TABLE\b/i.test(sql)) hits.add('DROP TABLE')
  if (/\bDROP\s+COLUMN\b/i.test(sql)) hits.add('DROP COLUMN')
  if (/\bDROP\s+SCHEMA\b[^;]*\bCASCADE\b/i.test(sql)) hits.add('DROP SCHEMA CASCADE')
  if (/(?:^|;|\b(?:BEGIN|THEN|ELSE|LOOP)\b)\s*TRUNCATE\b/i.test(sql)) hits.add('TRUNCATE')

  for (const stmt of sql.split(';')) {
    if (!/\bALTER\s+TABLE\b/i.test(stmt)) continue
    if (
      /\bDROP\s+(?:IF\s+EXISTS\s+)?(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|EXPRESSION\b|IDENTITY\b|COLUMN\b|TABLE\b)[A-Za-z_]/i.test(
        stmt,
      )
    ) {
      hits.add('DROP COLUMN')
    }
  }

  return [...hits]
}

/** 提取迁移文件中的不可逆破坏性 DDL 操作名：优先解析完整文件 content，其次解析 patch（含上下文行），均缺失时 fail-closed 兜底。 */
export function destructiveMigrationOps(file) {
  if (typeof file.content === 'string') {
    return detectDestructiveOps(file.content)
  }
  if (typeof file.patch === 'string') {
    return detectDestructiveOps(patchPostImageSql(file.patch))
  }
  const tag = ANY_MIGRATION.exec(file.filename)?.[1]
  if (file.status !== 'removed' && tag) {
    if (DESTRUCTIVE_TAG.test(tag)) {
      return ['DROP/TRUNCATE（SQL 内容未获取，按文件名命中）']
    }
    return ['SQL 内容未获取（diff 被截断且未拉取完整文件，无法自动排除不可逆删除）']
  }
  return []
}

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
  const rollbackNotes = [section(body, '怎么回滚'), section(body, '迁移与回滚')]
    .filter(Boolean)
    .join('\n')
  const retentionStatus = evaluateRetentionNote(rollbackNotes)

  for (const f of files) {
    const m = f.status === 'added' && MIGRATION.exec(f.filename)
    if (m) {
      const rollback = `packages/db/drizzle/rollback/${m[1]}.down.sql`
      if (!present.has(rollback)) {
        warns.push(`新迁移 \`${m[1]}\` 没有回滚 SQL \`${rollback}\`；「怎么回滚」里写清不可回滚的原因或补上它。`)
      }
    }

    const anyM = f.status !== 'removed' && ANY_MIGRATION.exec(f.filename)
    if (!anyM) continue
    const ops = destructiveMigrationOps(f)
    if (!ops.length) continue
    const opList = ops.join(' / ')
    if (retentionStatus === 'blocked') {
      fails.push(
        `迁移 \`${anyM[1]}\` 包含不可逆删除（${opList}），且「怎么回滚」显示留存期/最早可发布时间尚未到期或核验未完成；未到日期且完成核验前不得合并或发布（AGENTS.md「部署与灾备」）。`,
      )
    } else if (retentionStatus === 'missing') {
      fails.push(
        `迁移 \`${anyM[1]}\` 包含不可逆删除（${opList}）：回滚 SQL 只能重建空结构，无法恢复原数据。请在「怎么回滚」写明关联 Issue/ADR 的留存期与最早可发布时间（已到期/无日期限制）、历史数据留存或回填零差异核验，以及可恢复备份确认（AGENTS.md「部署与灾备」）。`,
      )
    } else {
      warns.push(
        `迁移 \`${anyM[1]}\` 包含不可逆删除（${opList}），请评审核对关联 Issue/ADR 的留存期与最早可发布时间，确认生产历史数据已过期、已回填或有可验证恢复副本后再合并。`,
      )
    }
  }

  return { fails, warns, costFiles: cost }
}
