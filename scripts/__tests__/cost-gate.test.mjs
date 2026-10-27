import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { costFiles, decide, parseBody } from '../cost-gate.mjs'

const templateUrl = new URL('../../.github/pull_request_template.md', import.meta.url)
const template = readFileSync(templateUrl, 'utf8')
const tick = (body, marker) =>
  body.replace(new RegExp(`^(\\s*- )\\[ \\](.*<!-- ${marker} -->)`, 'm'), '$1[x]$2')

test('模型、供应商、定价、额度和 overlay 的改动算成本相关', () => {
  const files = [
    'apps/bff/channels.json',
    'apps/bff/src/lib/agent/models.config.json',
    'apps/bff/src/lib/agent/model-preflight.ts',
    'apps/bff/src/lib/agent/provider-fetch.ts',
    'apps/bff/src/lib/agent/turn-rate-limit.ts',
    'apps/bff/src/lib/upstream/openai.ts',
    'apps/bff/src/lib/upstream.ts',
    'apps/bff/src/lib/token-pricing.ts',
    'apps/bff/src/lib/quota.ts',
    'apps/admin/server/routes/agent-models.ts',
    'apps/web/src/features/pricing/PricingPage.tsx',
    'apps/web/src/components/Credits.tsx',
    'private.lock',
  ]
  assert.deepEqual(costFiles(files), files)
})

test('文档、测试和无关代码不算', () => {
  assert.deepEqual(
    costFiles([
      'AGENTS.md',
      'docs/agents/release.md',
      'apps/bff/src/__tests__/lib/quota.test.ts',
      'apps/bff/src/lib/agent/turn.ts',
      'apps/web/src/components/Button.tsx',
      'apps/bff/src/lib/upstreamish.ts',
    ]),
    [],
  )
})

test('模板原样不算声明，也不算确认', () => {
  assert.deepEqual(parseBody(template), { declared: false, approved: false })
})

test('只勾确认框、不写确认来源，不算确认', () => {
  assert.equal(parseBody(tick(template, 'cost:approved')).approved, false)
})

test('勾上确认框并写明来源才算确认', () => {
  const body = tick(template, 'cost:approved').replace(
    /确认来源：\s*<!--/,
    '确认来源：Nain 在 Slack 2026-10-27 回复「可以」 <!--',
  )
  assert.equal(parseBody(body).approved, true)
})

test('作者自己勾「涉及成本」也要确认，即使路径清单没命中', () => {
  const result = decide(['apps/bff/src/lib/agent/turn.ts'], tick(template, 'cost:declared'))
  assert.deepEqual(result, { matched: [], sensitive: true, approved: false })
})

test('不涉及成本的 PR 不需要确认', () => {
  assert.equal(decide(['docs/agents/release.md'], template).sensitive, false)
})
