#!/usr/bin/env node
// 成本门禁：PR 改到模型调用、模型/供应商切换、定价、额度或计费相关文件，或者作者在 PR 描述里
// 勾了「涉及成本」，就要求描述里同时勾上「Nain 已明确确认」并写明确认来源。规则见 AGENTS.md
// 「成本硬规则」，由 .github/workflows/cost-gate.yml 在每个 PR 上跑。
//
//   gh api --paginate repos/<repo>/pulls/<n>/files --jq '.[].filename' \
//     | PR_BODY="$body" node scripts/cost-gate.mjs
//
// 标准输入是改动文件列表（一行一个），PR_BODY 是 PR 描述。设置了 GITHUB_OUTPUT 时写出
// sensitive=true|false 和 approved=true|false；本脚本只判定，不改 PR、不失败，由 workflow 决定。
// 路径清单是兜底的网，不是完整定义：清单外的成本改动靠作者自己勾「涉及成本」。
import { appendFileSync, readFileSync } from 'node:fs'

/** 改到这些文件即视为成本相关。测试目录不算：只改测试不会改变线上花费。 */
export const COST_PATHS = [
  // 渠道、模型目录与运营配置样例
  /^apps\/bff\/channels\.json$/,
  /^apps\/bff\/operator-config\.example\.json$/,
  /^apps\/bff\/\.env\.example$/,
  /^apps\/bff\/src\/lib\/agent\/(models|masked-edit)\.config\.json$/,
  // 智能体的模型选择、供应商请求、上下文压缩与出站预算/限额
  /^apps\/bff\/src\/lib\/agent\/(model[^/]*|provider-[^/]*|video-models|outbound-budget|compaction[^/]*)\.ts$/,
  /^apps\/bff\/src\/lib\/agent\/[^/]*(limit|budget)[^/]*\.ts$/,
  // 上游供应商调用
  /^apps\/bff\/src\/lib\/upstream(\.ts$|\/)/,
  /^apps\/bff\/src\/lib\/(chatCompletion|channels|model-availability|token-pricing|quota|account-concurrency|rate-limit|operator-config)\.ts$/,
  /^apps\/bff\/src\/routes\/(channels|internal-models|internal-agent-models)\.ts$/,
  // 后台的模型与智能体模型设置
  /^apps\/admin\/server\/routes\/(models|agent-models)\.ts$/,
  // 前端的定价、积分与渠道
  /^apps\/web\/src\/features\/pricing\//,
  /^apps\/web\/src\/components\/(Credits|SubmissionBillingAction)\.tsx$/,
  /^apps\/web\/src\/lib\/channels\//,
  /^packages\/shared\/src\/channel-discovery\.ts$/,
  // 私有 overlay（收费、计费、套餐都在里面）
  /^private\.lock$/,
]

export function costFiles(files) {
  return files.filter(
    (file) => !file.split('/').includes('__tests__') && COST_PATHS.some((re) => re.test(file)),
  )
}

const checked = (body, marker) =>
  body
    .split(/\r?\n/)
    .find((line) => line.includes(`<!-- ${marker} -->`) && /^\s*[-*]\s*\[[xX]\]/.test(line))

/** 读 PR 模板里带隐藏标记的两个复选框。确认框必须勾上，且「确认来源：」后面有内容。 */
export function parseBody(body = '') {
  const declared = Boolean(checked(body, 'cost:declared'))
  const approvedLine = checked(body, 'cost:approved')
  const source = approvedLine?.match(/确认来源[:：]\s*(.*?)\s*<!--/)?.[1] ?? ''
  return { declared, approved: Boolean(approvedLine) && source.length > 0 }
}

export function decide(files, body) {
  const matched = costFiles(files)
  const { declared, approved } = parseBody(body)
  return { matched, sensitive: matched.length > 0 || declared, approved }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = readFileSync(0, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const result = decide(files, process.env.PR_BODY ?? '')
  for (const file of result.matched) console.log(`成本相关文件：${file}`)
  console.log(`sensitive=${result.sensitive} approved=${result.approved}`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `sensitive=${result.sensitive}\napproved=${result.approved}\n`,
    )
  }
}
