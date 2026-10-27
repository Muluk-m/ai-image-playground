#!/usr/bin/env node
// 评审周报：最近 N 天合并的 PR、其中的 revert、平均评审轮数，以及 ocr 行内意见的去向。只读，不写任何东西。
//
//   GITHUB_TOKEN=… node scripts/review-stats.mjs [--days 7] [--repo owner/name] [--json]
//
// 通过 gh 调 GitHub GraphQL（gh 读 GH_TOKEN / GITHUB_TOKEN 或已登录的账号），只需要仓库的读权限。
// 口径：
// - revert：标题以 revert 开头（不分大小写）。
// - 评审轮数：AI 评审（ocr 的 github-actions[bot] 与 Codex 的 chatgpt-codex-connector[bot]）提交的 review
//   针对过几个不同的 head 提交；一个 PR 没有 AI review 记 0 轮。
// - 单个 PR 只取前 100 条 review 与讨论串；超出的 PR 在输出里单独列为「统计不全」。
// - ocr 意见去向：ocr 发起的行内讨论串，已解决 = resolved，代码已改到那一行 = outdated（多半已处理），
//   其余 = open（未处理或作者回复不改）。
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const OCR_LOGIN = 'github-actions'
export const CODEX_LOGIN = 'chatgpt-codex-connector'
const AI_REVIEWERS = new Set([OCR_LOGIN, CODEX_LOGIN])

/** GraphQL 返回的 login 可能带也可能不带 `[bot]` 后缀。 */
export function botLogin(login) {
  return (login ?? '').replace(/\[bot\]$/, '')
}

export function isRevert(title) {
  return /^revert\b/i.test((title ?? '').trim())
}

/** 一个 PR 的 AI 评审轮数：AI review 针对过的不同提交数。 */
export function reviewRounds(pr) {
  const commits = new Set()
  for (const review of pr.reviews ?? []) {
    if (AI_REVIEWERS.has(botLogin(review.author)) && review.commit) commits.add(review.commit)
  }
  return commits.size
}

/** ocr 发起的讨论串按 resolved / outdated / open 计数。 */
export function ocrOutcomes(pr) {
  const outcome = { resolved: 0, outdated: 0, open: 0 }
  for (const thread of pr.threads ?? []) {
    if (botLogin(thread.author) !== OCR_LOGIN) continue
    if (thread.isResolved) outcome.resolved += 1
    else if (thread.isOutdated) outcome.outdated += 1
    else outcome.open += 1
  }
  return outcome
}

/**
 * @param {Array<{number:number,title:string,mergedAt:string,reviews?:Array<{author:string,commit:string}>,threads?:Array<{author:string,isResolved:boolean,isOutdated:boolean}>}>} prs
 */
export function summarize(prs) {
  const rounds = prs.map(reviewRounds)
  const ocr = { resolved: 0, outdated: 0, open: 0 }
  for (const pr of prs) {
    const o = ocrOutcomes(pr)
    ocr.resolved += o.resolved
    ocr.outdated += o.outdated
    ocr.open += o.open
  }
  const reviewed = rounds.filter((n) => n > 0)
  const average = (list) =>
    list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100) / 100 : 0
  return {
    merged: prs.length,
    reverts: prs.filter((pr) => isRevert(pr.title)).map((pr) => ({ number: pr.number, title: pr.title })),
    averageRounds: average(rounds),
    averageRoundsReviewed: average(reviewed),
    overCap: prs.filter((_, i) => rounds[i] > 3).map((pr) => pr.number),
    ocr: { ...ocr, total: ocr.resolved + ocr.outdated + ocr.open },
    truncated: prs.filter((pr) => pr.truncated).map((pr) => pr.number),
  }
}

export function formatMarkdown(stats, { repo, since }) {
  const lines = [
    `## 评审周报：${repo}（${since} 起合并）`,
    '',
    `- 合并的 PR：${stats.merged}`,
    `- 其中 revert：${stats.reverts.length}${stats.reverts.map((r) => `\n  - #${r.number} ${r.title}`).join('')}`,
    `- 平均 AI 评审轮数：${stats.averageRounds}（只算有 AI 评审的 PR：${stats.averageRoundsReviewed}）`,
    `- 超过 3 轮的 PR：${stats.overCap.length ? stats.overCap.map((n) => `#${n}`).join('、') : '无'}`,
    `- ocr 行内意见 ${stats.ocr.total} 条：已解决 ${stats.ocr.resolved}，代码已改动 ${stats.ocr.outdated}，未处理 ${stats.ocr.open}`,
  ]
  if (stats.truncated.length) {
    lines.push(
      `- ⚠️ 统计不全：${stats.truncated.map((n) => `#${n}`).join('、')} 的 review 或讨论串超过 100 条，只算了前 100 条`,
    )
  }
  return `${lines.join('\n')}\n`
}

const QUERY = `query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title mergedAt
      reviews(first: 100) { pageInfo { hasNextPage } nodes { author { login } commit { oid } } }
      reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved isOutdated comments(first: 1) { nodes { author { login } } } } }
    } }
  }
}`

/** 把 GraphQL 的 PR 节点压成 summarize 要的形状。 */
export function normalize(node) {
  return {
    number: node.number,
    title: node.title,
    mergedAt: node.mergedAt,
    // 单个 PR 的 review 或讨论串超过 100 条时只取到第一页；标出来，不静默少算。
    truncated: Boolean(node.reviews?.pageInfo?.hasNextPage || node.reviewThreads?.pageInfo?.hasNextPage),
    reviews: (node.reviews?.nodes ?? []).map((r) => ({ author: r.author?.login ?? '', commit: r.commit?.oid ?? '' })),
    threads: (node.reviewThreads?.nodes ?? []).map((t) => ({
      author: t.comments?.nodes?.[0]?.author?.login ?? '',
      isResolved: Boolean(t.isResolved),
      isOutdated: Boolean(t.isOutdated),
    })),
  }
}

function fetchMergedPrs(repo, since) {
  const out = execFileSync(
    'gh',
    ['api', 'graphql', '--paginate', '-f', `query=${QUERY}`, '-f', `q=repo:${repo} is:pr is:merged merged:>=${since}`, '--jq', '.data.search.nodes[]'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return out
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => normalize(JSON.parse(line)))
}

export function parseArgs(argv, env = process.env) {
  const args = { days: 7, repo: env.GITHUB_REPOSITORY ?? '', json: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') args.days = Number(argv[++i])
    else if (argv[i] === '--repo') args.repo = argv[++i] ?? ''
    else if (argv[i] === '--json') args.json = true
    else throw new Error(`未知参数：${argv[i]}`)
  }
  if (!Number.isInteger(args.days) || args.days < 1) throw new Error('--days 要是正整数')
  if (!/^[\w.-]+\/[\w.-]+$/.test(args.repo)) throw new Error('用 --repo owner/name 或 GITHUB_REPOSITORY 指定仓库')
  return args
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const since = new Date(Date.now() - args.days * 86_400_000).toISOString().slice(0, 10)
    const stats = summarize(fetchMergedPrs(args.repo, since))
    if (stats.truncated.length) {
      process.stderr.write(`警告：${stats.truncated.length} 个 PR 的 review 或讨论串超过 100 条，统计不全\n`)
    }
    process.stdout.write(args.json ? `${JSON.stringify(stats, null, 2)}\n` : formatMarkdown(stats, { repo: args.repo, since }))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
