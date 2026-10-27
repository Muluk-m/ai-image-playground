import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMarkdown, isRevert, normalize, ocrOutcomes, parseArgs, reviewRounds, summarize } from '../review-stats.mjs'

const pr = (number, title, reviews = [], threads = []) => ({ number, title, mergedAt: '2026-10-27T00:00:00Z', reviews, threads })

test('标题以 revert 开头才算 revert', () => {
  assert.equal(isRevert('revert: node canvas skeleton (#1166)'), true)
  assert.equal(isRevert('Revert "feat(web): rebuild"'), true)
  assert.equal(isRevert('fix: handle reverted payments'), false)
  assert.equal(isRevert('docs: reverting guide'), false)
})

test('评审轮数按 AI review 针对的不同提交数算，人工 review 不算', () => {
  const p = pr(1, 'feat', [
    { author: 'github-actions', commit: 'a' },
    { author: 'chatgpt-codex-connector[bot]', commit: 'a' },
    { author: 'github-actions[bot]', commit: 'b' },
    { author: 'Muluk-m', commit: 'c' },
  ])
  assert.equal(reviewRounds(p), 2)
  assert.equal(reviewRounds(pr(2, 'docs')), 0)
})

test('ocr 意见按已解决、已改动、未处理计数，只算 ocr 发起的讨论串', () => {
  const p = pr(1, 'feat', [], [
    { author: 'github-actions', isResolved: true, isOutdated: true },
    { author: 'github-actions[bot]', isResolved: false, isOutdated: true },
    { author: 'github-actions', isResolved: false, isOutdated: false },
    { author: 'chatgpt-codex-connector', isResolved: false, isOutdated: false },
  ])
  assert.deepEqual(ocrOutcomes(p), { resolved: 1, outdated: 1, open: 1 })
})

test('汇总合并数、revert、平均轮数和超过 3 轮的 PR', () => {
  const rounds = (n) => Array.from({ length: n }, (_, i) => ({ author: 'github-actions', commit: `c${i}` }))
  const stats = summarize([
    pr(10, 'feat: a', rounds(1), [{ author: 'github-actions', isResolved: true, isOutdated: false }]),
    pr(11, 'revert: a', rounds(4)),
    pr(12, 'docs: b'),
  ])
  assert.equal(stats.merged, 3)
  assert.deepEqual(stats.reverts, [{ number: 11, title: 'revert: a' }])
  assert.equal(stats.averageRounds, 1.67)
  assert.equal(stats.averageRoundsReviewed, 2.5)
  assert.deepEqual(stats.overCap, [11])
  assert.deepEqual(stats.ocr, { resolved: 1, outdated: 0, open: 0, total: 1 })
  assert.match(formatMarkdown(stats, { repo: 'o/r', since: '2026-10-20' }), /其中 revert：1\n {2}- #11 revert: a/)
  assert.equal(summarize([]).averageRounds, 0)
})

test('GraphQL 节点缺字段时也能压平', () => {
  const p = normalize({
    number: 5,
    title: 't',
    mergedAt: 'x',
    reviews: { nodes: [{ author: null, commit: { oid: 'a' } }] },
    reviewThreads: { nodes: [{ isResolved: false, isOutdated: false, comments: { nodes: [] } }] },
  })
  assert.deepEqual(p.reviews, [{ author: '', commit: 'a' }])
  assert.deepEqual(p.threads, [{ author: '', isResolved: false, isOutdated: false }])
})

test('参数校验', () => {
  assert.deepEqual(parseArgs(['--days', '14', '--json'], { GITHUB_REPOSITORY: 'o/r' }), { days: 14, repo: 'o/r', json: true })
  assert.throws(() => parseArgs([], {}), /--repo/)
  assert.throws(() => parseArgs(['--days', '0'], { GITHUB_REPOSITORY: 'o/r' }), /正整数/)
  assert.throws(() => parseArgs(['--bogus'], { GITHUB_REPOSITORY: 'o/r' }), /未知参数/)
})
