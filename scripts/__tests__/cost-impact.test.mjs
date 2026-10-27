import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { costFiles } from '../cost-impact.mjs'

test('模型、供应商、定价、额度、扣费入口和 overlay 的改动算成本相关', () => {
  const files = [
    'apps/bff/channels.json',
    'apps/bff/src/lib/agent/models.config.json',
    'apps/bff/src/lib/agent/model-preflight.ts',
    'apps/bff/src/lib/agent/provider-fetch.ts',
    'apps/bff/src/lib/agent/turn-rate-limit.ts',
    'apps/bff/src/lib/agent/chat-task.ts',
    'apps/bff/src/lib/agent/auto-submit.ts',
    'apps/bff/src/lib/agent/batch-analysis-preparation.ts',
    'apps/bff/src/lib/agent/batch-execution.ts',
    'apps/bff/src/lib/upstream/openai.ts',
    'apps/bff/src/lib/upstream.ts',
    'apps/bff/src/lib/token-pricing.ts',
    'apps/bff/src/lib/taskSubmission.ts',
    'apps/bff/src/db/task-transitions.ts',
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
      'apps/bff/src/__tests__/lib/agent/batch-execution.test.ts',
      'apps/bff/src/lib/agent/turn.ts',
      'apps/web/src/components/Button.tsx',
      'apps/bff/src/lib/upstreamish.ts',
    ]),
    [],
  )
})

test('成本文件改名到清单外，按旧路径照样命中', () => {
  // 工作流把 pulls/N/files 的 filename 和 previous_filename 都喂进来。
  const files = ['apps/bff/src/lib/pricing-v2.ts', 'apps/bff/src/lib/token-pricing.ts']
  assert.deepEqual(costFiles(files), ['apps/bff/src/lib/token-pricing.ts'])
})

test('按工作流的方式（相对路径）运行时读取标准输入并写出 sensitive', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'cost-impact-')), 'output')
  const run = (input) =>
    execFileSync('node', ['scripts/cost-impact.mjs'], {
      input,
      env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '' },
    })
  run('apps/bff/src/lib/quota.ts\nREADME.md\n')
  run('README.md\n')
  assert.equal(readFileSync(out, 'utf8'), 'sensitive=true\nsensitive=false\n')
})
