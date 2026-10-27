#!/usr/bin/env node
// 成本影响提示：PR 改到模型调用、模型/供应商切换、定价、额度或计费相关文件时，给 PR 打
// cost-impact 标签并在检查摘要里列出命中的文件，提醒作者在描述的「成本与影响」里写清楚。
// 只提示、不拦合并。规则见 AGENTS.md「成本与影响说明」，由 .github/workflows/cost-impact.yml 在每个 PR 上跑。
//
//   gh api --paginate repos/<repo>/pulls/<n>/files --jq '.[] | .filename, (.previous_filename // empty)' \
//     | node scripts/cost-impact.mjs
//
// 标准输入是改动文件列表（一行一个）。设置了 GITHUB_OUTPUT 时写出 sensitive=true|false。
// 路径清单不是完整定义：清单外的成本改动同样要在描述里写明。
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 改到这些文件即视为可能影响成本。测试目录不算：只改测试不会改变线上花费。 */
export const COST_PATHS = [
  // 渠道、模型目录与运营配置样例
  /^apps\/bff\/channels\.json$/,
  /^apps\/bff\/operator-config\.example\.json$/,
  /^apps\/bff\/\.env\.example$/,
  /^apps\/bff\/src\/lib\/agent\/(models|masked-edit)\.config\.json$/,
  // 智能体的模型选择、供应商请求、上下文压缩与出站预算/限额
  /^apps\/bff\/src\/lib\/agent\/(model[^/]*|provider-[^/]*|video-models|outbound-budget|compaction[^/]*)\.ts$/,
  /^apps\/bff\/src\/lib\/agent\/[^/]*(limit|budget)[^/]*\.ts$/,
  // 智能体的预扣、结算、授权与批量执行（调用次数与扣费入口）
  /^apps\/bff\/src\/lib\/agent\/(chat-task|background-jobs|auto-submit|turn-preparation|turn-authorization|stage-authorizations)\.ts$/,
  // 批量分析与批量生成：模型解析、配额与任务派发
  /^apps\/bff\/src\/lib\/agent\/batch-[^/]*\.ts$/,
  // 任务提交、状态流转与计费 hook 接缝
  /^apps\/bff\/src\/lib\/(taskSubmission|private-overlay|private-host)\.ts$/,
  /^apps\/bff\/src\/db\/task-transitions\.ts$/,
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = readFileSync(0, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const matched = [...new Set(costFiles(files))]
  for (const file of matched) console.log(`成本相关文件：${file}`)
  console.log(`sensitive=${matched.length > 0}`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `sensitive=${matched.length > 0}\n`)
  }
  if (process.env.GITHUB_STEP_SUMMARY && matched.length > 0) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## 可能影响成本\n\n请在 PR 描述「成本与影响」里写明改了什么、对成本的影响。\n\n${matched.map((f) => `- \`${f}\``).join('\n')}\n`,
    )
  }
}
