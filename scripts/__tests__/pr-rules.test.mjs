import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  destructiveMigrationOps,
  evaluatePr,
  hydrateMigrationContents,
  section,
  stripComments,
} from '../pr-rules.mjs'

const template = readFileSync(new URL('../../.github/pull_request_template.md', import.meta.url), 'utf8')
const file = (filename, extra = {}) => ({ filename, status: 'modified', additions: 1, deletions: 1, ...extra })
const shot = '![顶栏](https://github.com/user-attachments/assets/abc)'

/** 按模板填一份描述，覆盖其中几节。 */
const body = ({ top = '无用户可见影响', rollback, evidence, cost = '不涉及。' } = {}) => {
  let text = template.replace('## 做了什么、影响是什么\n', `## 做了什么、影响是什么\n\n${top}\n`)
  if (rollback) text = text.replace(/(## 怎么回滚\n)/, `$1\n${rollback}\n`)
  if (evidence) text = text.replace(/- \[ \] 本 PR 不涉及上述关键流程[^\n]*\n- \[ \] 已附测试账号[^\n]*\n/, `${evidence}\n`)
  return text.replace(/(## 成本与影响\n)/, `$1\n${cost}\n`)
}

test('an untouched template passes for a backend-only change', () => {
  assert.deepEqual(evaluatePr({ files: [file('apps/bff/src/routes/feedback.ts')], body: body() }), {
    fails: [],
    warns: [],
    costFiles: [],
  })
})

test('ui changes need a screenshot that says it came from the test environment', () => {
  const files = [file('apps/web/src/components/Header.tsx'), file('apps/web/src/__tests__/Header.test.tsx')]
  // 模板注释里本身写着 test.muvloom.online，不能算数。
  assert.match(evaluatePr({ files, body: body() }).fails.join(), /需要附测试环境 test.muvloom.online 的截图/)
  assert.match(evaluatePr({ files, body: body({ top: shot }) }).fails.join(), /没写明来自测试环境/)
  assert.deepEqual(evaluatePr({ files, body: body({ top: `test.muvloom.online 截图：\n${shot}` }) }).fails, [])
  // 官网与工作台同一份产物发到测试环境，同样要截图。
  assert.equal(evaluatePr({ files: [file('apps/website/src/pages/index.tsx')], body: body() }).fails.length, 1)
  // 正文里的文件名不是截图。
  const named = body({ top: '本地产物 out.png；已在 test.muvloom.online 自测' })
  assert.match(evaluatePr({ files, body: named }).fails.join(), /需要附测试环境/)
})

test('admin ui changes need a screenshot but not the test environment', () => {
  const files = [file('apps/admin/src/components/AppSidebar.tsx')]
  assert.match(evaluatePr({ files, body: body() }).fails.join(), /改了 Admin 界面/)
  assert.deepEqual(evaluatePr({ files, body: body({ top: `本地 Admin：\n${shot}` }) }).fails, [])
})

test('critical flows need checked evidence with media, or a reasoned waiver', () => {
  const files = [file('apps/bff/src/routes/submit.ts')]
  assert.match(evaluatePr({ files, body: body() }).fails.join(), /改到关键流程：生成（`apps\/bff\/src\/routes\/submit.ts`）/)
  assert.match(
    evaluatePr({ files: [file('apps/bff/src/bootstrap/task-lifecycle.ts')], body: body() }).fails.join(),
    /支付计费（`apps\/bff\/src\/bootstrap\/task-lifecycle.ts`）、生成（`apps\/bff\/src\/bootstrap\/task-lifecycle.ts`）/,
  )
  assert.match(
    evaluatePr({ files: [file('apps/bff/src/bootstrap/task-submission.ts')], body: body() }).fails.join(),
    /支付计费（`apps\/bff\/src\/bootstrap\/task-submission.ts`）、生成（`apps\/bff\/src\/bootstrap\/task-submission.ts`）/,
  )
  assert.match(
    evaluatePr({
      files: [file('apps/bff/src/lib/billing-ports.ts')],
      body: body(),
    }).fails.join(),
    /支付计费（`apps\/bff\/src\/lib\/billing-ports.ts`）/,
  )
  assert.match(
    evaluatePr({
      files: [file('apps/bff/src/modules/execution/task-lifecycle-bus.ts')],
      body: body(),
    }).fails.join(),
    /支付计费（`apps\/bff\/src\/modules\/execution\/task-lifecycle-bus.ts`）、生成（`apps\/bff\/src\/modules\/execution\/task-lifecycle-bus.ts`）/,
  )
  assert.match(
    evaluatePr({
      files: [file('apps/bff/src/bootstrap/task-execution.ts')],
      body: body(),
    }).fails.join(),
    /改到关键流程：生成（`apps\/bff\/src\/bootstrap\/task-execution.ts`）/,
  )
  assert.match(
    evaluatePr({
      files: [file('apps/bff/src/modules/execution/task-execution-hooks.ts')],
      body: body(),
    }).fails.join(),
    /改到关键流程：生成（`apps\/bff\/src\/modules\/execution\/task-execution-hooks.ts`）/,
  )
  assert.match(
    evaluatePr({
      files: [file('apps/bff/src/workers/agent-batch-loop.ts')],
      body: body(),
    }).fails.join(),
    /改到关键流程：生成（`apps\/bff\/src\/workers\/agent-batch-loop.ts`）/,
  )
  assert.match(
    evaluatePr({
      files: [file('apps/bff/src/modules/agent/orchestration/production/generation.ts')],
      body: body(),
    }).fails.join(),
    /改到关键流程：生成（`apps\/bff\/src\/modules\/agent\/orchestration\/production\/generation\.ts`）/,
  )
  assert.match(
    evaluatePr({
      files: [file('apps/bff/src/modules/agent/orchestration/batch/execution.ts')],
      body: body(),
    }).fails.join(),
    /改到关键流程：生成（`apps\/bff\/src\/modules\/agent\/orchestration\/batch\/execution\.ts`）/,
  )
  assert.match(
    evaluatePr({
      files: [file('apps/bff/src/modules/execution/task-outcome.ts')],
      body: body(),
    }).fails.join(),
    /改到关键流程：生成（`apps\/bff\/src\/modules\/execution\/task-outcome.ts`）/,
  )
  assert.match(
    evaluatePr({
      files: [file('apps/bff/src/modules/execution/submission-idempotency.ts')],
      body: body(),
    }).fails.join(),
    /支付计费（`apps\/bff\/src\/modules\/execution\/submission-idempotency.ts`）、生成（`apps\/bff\/src\/modules\/execution\/submission-idempotency.ts`）/,
  )
  assert.match(
    evaluatePr({
      files: [file('apps/bff/src/lib/user-login.ts')],
      body: body(),
    }).fails.join(),
    /改到关键流程：注册登录（`apps\/bff\/src\/lib\/user-login.ts`）/,
  )
  assert.match(
    evaluatePr({
      files: [file('apps/bff/src/modules/execution/task-queries.ts')],
      body: body(),
    }).fails.join(),
    /改到关键流程：生成（`apps\/bff\/src\/modules\/execution\/task-queries.ts`）/,
  )

  const checkedNoMedia = '- [ ] 本 PR 不涉及上述关键流程\n- [x] 已附测试账号在测试环境走通'
  assert.equal(evaluatePr({ files, body: body({ evidence: checkedNoMedia }) }).fails.length, 1)

  const proven = `- [ ] 本 PR 不涉及上述关键流程\n- [x] 已附测试账号在测试环境走通\n\n普通账号，test.muvloom.online，abc1234\n${shot}`
  assert.deepEqual(evaluatePr({ files, body: body({ evidence: proven }) }).fails, [])

  // 勾了、有图，但没写环境、账号类型、提交。
  const bare = `- [ ] 本 PR 不涉及上述关键流程\n- [x] 已附测试账号在测试环境（test.muvloom.online）走通\n\n${shot}`
  assert.match(evaluatePr({ files, body: body({ evidence: bare }) }).fails.join(), /没写明环境（test.muvloom.online）、账号类型、提交 SHA/)
  // 附件 URL 里的 UUID 不是提交 SHA。
  const upload = '![截图](https://github.com/user-attachments/assets/12345678-abcd-4321-abcd-123456789abc)'
  const noSha = `- [ ] 本 PR 不涉及上述关键流程\n- [x] 已附测试账号在测试环境走通\n\n普通账号，test.muvloom.online\n${upload}`
  assert.match(evaluatePr({ files, body: body({ evidence: noSha }) }).fails.join(), /没写明提交 SHA/)
  // 环境写成完整链接同样算数。
  const linked = `- [ ] 本 PR 不涉及上述关键流程\n- [x] 已附测试账号在测试环境走通\n\n普通账号，https://test.muvloom.online，提交 abc1234\n${upload}`
  assert.deepEqual(evaluatePr({ files, body: body({ evidence: linked }) }).fails, [])

  const bareWaiver = '- [x] 本 PR 不涉及上述关键流程\n- [ ] 已附测试账号在测试环境走通'
  assert.equal(evaluatePr({ files, body: body({ evidence: bareWaiver }) }).fails.length, 1)

  const waiver = `${bareWaiver}\n\n只合并重复的类型声明，运行时代码不变。`
  const result = evaluatePr({ files, body: body({ evidence: waiver }) })
  assert.deepEqual(result.fails, [])
  assert.match(result.warns.join(), /作者声明不涉及流程行为：「只合并重复的类型声明/)

  // 理由写在勾选行后面同样有效；套话不算理由。
  const sameLine = '- [x] 本 PR 不涉及上述关键流程：只把类型从 a.ts 挪到 b.ts，运行时不变\n- [ ] 已附测试账号在测试环境走通'
  assert.deepEqual(evaluatePr({ files, body: body({ evidence: sameLine }) }).fails, [])
  for (const filler of ['不涉及。', '无', 'N/A', '不涉及，见上'])
    assert.equal(evaluatePr({ files, body: body({ evidence: `${bareWaiver}\n\n${filler}` }) }).fails.length, 1, filler)
})

test('cost files need more than a bare 不涉及, and keep the cost label list', () => {
  const files = [file('apps/bff/src/lib/upstream.ts'), file('apps/bff/src/__tests__/lib/upstream.test.ts')]
  const bare = evaluatePr({ files, body: body() })
  assert.match(bare.fails.join(), /可能影响成本的文件（1 个/)
  assert.deepEqual(bare.costFiles, ['apps/bff/src/lib/upstream.ts'])
  assert.deepEqual(evaluatePr({ files, body: body({ cost: '不涉及：只改日志字段，不改请求。' }) }).fails, [])
  assert.match(evaluatePr({ files, body: null }).fails.join(), /成本与影响/)
  for (const filler of ['无', 'N/A', '-', '（不涉及）', '不涉及，见上', '暂无'])
    assert.equal(evaluatePr({ files, body: body({ cost: filler }) }).fails.length, 1, filler)
})

test('renamed files are matched by their old path too', () => {
  const files = [file('apps/bff/src/lib/moved.ts', { previous_filename: 'apps/bff/src/lib/upstream.ts' })]
  assert.deepEqual(evaluatePr({ files, body: body() }).costFiles, ['apps/bff/src/lib/upstream.ts'])
})

test('large PRs warn, without counting lockfiles and drizzle snapshots', () => {
  const big = [file('apps/bff/src/a.ts', { additions: 900, deletions: 200 })]
  assert.match(evaluatePr({ files: big, body: body() }).warns.join(), /改动 1100 行/)
  const generated = [
    file('apps/bff/src/a.ts', { additions: 500 }),
    file('pnpm-lock.yaml', { additions: 5000 }),
    file('packages/db/drizzle/meta/0101_snapshot.json', { additions: 3000 }),
    file('apps/web/src/components/ui/icon/glyphs.gen.ts', { additions: 4000 }),
    file('apps/web/public/inspiration-manifest.json', { additions: 2000 }),
  ]
  assert.deepEqual(evaluatePr({ files: generated, body: body() }).warns, [])
})

test('new migrations without a rollback file warn', () => {
  const added = file('packages/db/drizzle/0101_x.sql', { status: 'added', content: 'CREATE TABLE x (id text);' })
  assert.match(evaluatePr({ files: [added], body: body() }).warns.join(), /没有回滚 SQL/)
  const withRollback = [added, file('packages/db/drizzle/rollback/0101_x.down.sql', { status: 'added' })]
  assert.deepEqual(evaluatePr({ files: withRollback, body: body() }), { fails: [], warns: [], costFiles: [] })
  // 同一 PR 删掉或移走回滚文件，不算有回滚。
  const removed = [added, file('packages/db/drizzle/rollback/0101_x.down.sql', { status: 'removed' })]
  assert.match(evaluatePr({ files: removed, body: body() }).warns.join(), /没有回滚 SQL/)
  const moved = [
    added,
    file('packages/db/drizzle/rollback/old.down.sql', {
      status: 'renamed',
      previous_filename: 'packages/db/drizzle/rollback/0101_x.down.sql',
    }),
  ]
  assert.match(evaluatePr({ files: moved, body: body() }).warns.join(), /没有回滚 SQL/)
})

test('destructive migrations require retention/backup confirmation in rollback section', () => {
  const dropTable = file('packages/db/drizzle/0120_drop_old_logs.sql', {
    status: 'added',
    patch: '@@ -0,0 +1,2 @@\n+SET LOCAL lock_timeout = \'5s\';\n+DROP TABLE IF EXISTS "public"."old_logs";',
  })
  const rollbackFile = file('packages/db/drizzle/rollback/0120_drop_old_logs.down.sql', {
    status: 'added',
    patch: '@@ -0,0 +1 @@\n+CREATE TABLE "public"."old_logs" (id text primary key);',
  })

  // 未写留存/时间闸门确认 → 失败
  const bare = evaluatePr({ files: [dropTable, rollbackFile], body: body() })
  assert.match(bare.fails.join(), /不可逆删除（DROP TABLE）/)

  // 真实事故 #2033 风格（「重建空表」）、不可逆免责（「不可恢复」）、drizzle 快照与否定语境均不能绕过
  for (const weak of [
    '执行 0120_drop_old_logs.down.sql 恢复表结构即可。',
    '执行 0120_drop_old_logs.down.sql 重建表结构，见 #1937。',
    '已提供 0109_drop_server_logs.down.sql 重建空表与全部约束/索引。',
    '执行 down.sql 只能重建表结构，原历史数据不可恢复。',
    '回滚时需 revert 迁移、drizzle 快照与 _journal.json。',
    '尚未到保留期，暂未核对留存数据，也无备份副本。',
    '尚未核验已全量回填，未完成回填验收。',
    '历史数据未全量回填。',
    '没有可验证备份。',
    '计划完成全量回填后再执行。',
    '预计下周完成全量回填后再删表。',
    '准备做 PG 快照后再执行本次清理。',
  ]) {
    assert.match(
      evaluatePr({ files: [dropTable, rollbackFile], body: body({ rollback: weak }) }).fails.join(),
      /不可逆删除（DROP TABLE）/,
      weak,
    )
  }

  // 明确未到期/未满留存期/待核验的时间闸门是独立失败条件，不能被其他子句的「已备份/可恢复」覆盖
  for (const unmetGate of [
    '已核对 #1937，最早执行日期为 2026-11-27（尚未到期）；历史数据已备份。',
    '关联 #1937 的保留期尚未到期，生产历史数据已备份且验证可恢复。',
    '尚在 7 天留存期内，已提前完成 PG 冷备。',
    '最早可发布时间为 2026-11-28（待到期后发布），已备份。',
    '尚未到 2026-11-28，历史数据已备份。',
    '生产历史数据未全量回填，但已有备份。',
  ]) {
    assert.match(
      evaluatePr({ files: [dropTable, rollbackFile], body: body({ rollback: unmetGate }) }).fails.join(),
      /尚未到期或核验未完成/,
      unmetGate,
    )
  }

  // 字符串字面量里带 /*、E'don\'t'、美元定界字面量内带撇号，均不能吞掉后面的真实 DROP TABLE
  for (const tricky of [
    "+SELECT '/*';\n+DROP TABLE public.old_logs;\n+SELECT '*/';",
    "+SELECT E'don\\'t';\n+DROP TABLE public.old_logs;\n+SET LOCAL lock_timeout = '5s';",
    "+COMMENT ON TABLE public.tasks IS $$don't touch$$;\n+DROP TABLE public.old_logs;\n+SET LOCAL lock_timeout = '5s';",
  ]) {
    const f = file('packages/db/drizzle/0124_tricky.sql', { status: 'added', patch: tricky })
    assert.deepEqual(destructiveMigrationOps(f), ['DROP TABLE'], tricky)
  }

  // DO [LANGUAGE plpgsql] $$ ... EXECUTE 动态 SQL（含带括号表达式 EXECUTE ('...')）、省略 COLUMN 关键字的 ALTER TABLE DROP、DROP SCHEMA CASCADE 均应命中
  const dynamicDrop = file('packages/db/drizzle/0125_dynamic.sql', {
    status: 'added',
    patch: "+DO LANGUAGE plpgsql $$\n+BEGIN\n+  EXECUTE $sql$DROP TABLE IF EXISTS public.old_logs$sql$;\n+  EXECUTE format('ALTER TABLE public.tasks DROP COLUMN IF EXISTS %I', 'old_col');\n+END $$;",
  })
  assert.deepEqual(destructiveMigrationOps(dynamicDrop), ['DROP TABLE', 'DROP COLUMN'])

  const parenthesizedExecute = file('packages/db/drizzle/0125_exec_paren.sql', {
    status: 'added',
    patch: "+DO $$\n+BEGIN\n+  EXECUTE ('DROP TABLE IF EXISTS public.old_logs');\n+  EXECUTE (format('ALTER TABLE public.tasks DROP COLUMN %I', 'old_col'));\n+END $$;",
  })
  assert.deepEqual(destructiveMigrationOps(parenthesizedExecute), ['DROP TABLE', 'DROP COLUMN'])

  const omittedColumnKeyword = file('packages/db/drizzle/0126_omit_col.sql', {
    status: 'added',
    patch: '+ALTER TABLE public.tasks DROP IF EXISTS "legacy_col";',
  })
  assert.deepEqual(destructiveMigrationOps(omittedColumnKeyword), ['DROP COLUMN'])

  const dropSchemaCascade = file('packages/db/drizzle/0127_drop_schema.sql', {
    status: 'added',
    patch: '+DROP SCHEMA IF EXISTS legacy CASCADE;',
  })
  assert.deepEqual(destructiveMigrationOps(dropSchemaCascade), ['DROP SCHEMA CASCADE'])

  // 写清 Issue 时间闸门与留存核验（支持「怎么回滚」与「迁移与回滚」两种标题，即便同句逗号后带「重建空表/不可恢复」）→ 0 failure，保留人工复核 warning
  const confirmed = evaluatePr({
    files: [dropTable, rollbackFile],
    body: body({
      rollback: '已核对 #1937 留存期（2026-11-28 后已到期），历史数据无需保留，回滚 SQL 仅重建空表且原数据不可恢复。',
    }),
  })
  assert.deepEqual(confirmed.fails, [])
  assert.match(confirmed.warns.join(), /不可逆删除（DROP TABLE），请评审核对/)

  const pendingCheck = evaluatePr({
    files: [dropTable, rollbackFile],
    body: body({
      rollback: '待确认生产是否已完成全量回填，目前未备份。',
    }),
  })
  assert.equal(pendingCheck.fails.length, 1)

  const altHeading = evaluatePr({
    files: [dropTable, rollbackFile],
    body: '## 迁移与回滚\n\n生产已完成全量回填零差异验收，且已验证可恢复备份副本。',
  })
  assert.deepEqual(altHeading.fails, [])
  assert.match(altHeading.warns.join(), /不可逆删除（DROP TABLE），请评审核对/)

  // 计费目录的 DROP COLUMN / TRUNCATE 同样受检
  const billingDropCol = file('packages/db/drizzle-billing/0030_prune_col.sql', {
    status: 'added',
    patch: '@@ -0,0 +1 @@\n+ALTER TABLE private_billing.orders DROP COLUMN IF EXISTS legacy_note;',
  })
  assert.match(evaluatePr({ files: [billingDropCol], body: body() }).fails.join(), /DROP COLUMN/)

  const trunc = file('packages/db/drizzle/0121_clean.sql', {
    status: 'added',
    patch: '@@ -0,0 +1 @@\n+TRUNCATE TABLE public.temp_cache;',
  })
  assert.match(evaluatePr({ files: [trunc], body: body() }).fails.join(), /TRUNCATE/)

  // content 与 patch 均缺失时（超大 diff 被 GitHub 省略且未拉取完整文件）：按文件名命中且对中性文件名也 fail-closed
  const omittedPatch = file('packages/db/drizzle/0122_drop_legacy.sql', { status: 'added' })
  assert.match(evaluatePr({ files: [omittedPatch], body: body() }).fails.join(), /SQL 内容未获取，按文件名命中/)

  const omittedNeutral = file('packages/db/drizzle/0128_cleanup_legacy.sql', { status: 'added' })
  assert.match(evaluatePr({ files: [omittedNeutral], body: body() }).fails.join(), /无法自动排除不可逆删除/)

  // 补齐完整 content 后，中性文件名超大安全迁移应正常放行
  const hydratedSafe = file('packages/db/drizzle/0128_cleanup_legacy.sql', {
    status: 'added',
    content: 'CREATE INDEX IF NOT EXISTS idx_cleanup ON public.tasks (id);',
  })
  assert.deepEqual(destructiveMigrationOps(hydratedSafe), [])

  // 修改既有迁移：跨行 DROP TABLE（patch 仅改第二行表名）在 content 或含上下文 patch 下均可命中；位于既有块注释内不误报
  const modifiedSplitDropViaPatch = file('packages/db/drizzle/0129_edit_existing.sql', {
    status: 'modified',
    patch: '@@ -1,2 +1,2 @@\n DROP TABLE\n-  public.old_logs;\n+  public.server_logs;',
  })
  assert.deepEqual(destructiveMigrationOps(modifiedSplitDropViaPatch), ['DROP TABLE'])

  const modifiedSplitDropViaContent = file('packages/db/drizzle/0129_edit_existing.sql', {
    status: 'modified',
    patch: '@@ -2,1 +2,1 @@\n-  public.old_logs;\n+  public.server_logs;',
    content: 'DROP TABLE\n  public.server_logs;',
  })
  assert.deepEqual(destructiveMigrationOps(modifiedSplitDropViaContent), ['DROP TABLE'])

  const modifiedInsideBlockComment = file('packages/db/drizzle/0130_edit_comment.sql', {
    status: 'modified',
    patch: '@@ -10,1 +10,2 @@\n+DROP TABLE public.server_logs;',
    content: '/*\n历史说明：\n\n\n\n\n\n\n\nDROP TABLE public.server_logs;\n*/\nSELECT 1;',
  })
  assert.deepEqual(destructiveMigrationOps(modifiedInsideBlockComment), [])

  // 非破坏性 DROP、权限/触发器语境 TRUNCATE、双引号列名 "truncate"、注释及非代码美元定界字符串均不误报
  const safeMigration = file('packages/db/drizzle/0123_safe_cleanup.sql', {
    status: 'added',
    patch: [
      '@@ -0,0 +1,12 @@',
      '+-- 注意：本迁移不执行 DROP TABLE，也不 TRUNCATE',
      '+/* 历史注释：DROP COLUMN 留待下一波 */',
      '+DROP TRIGGER IF EXISTS trg_foo ON public.tasks;',
      '+DROP FUNCTION IF EXISTS public.fn_foo();',
      '+DROP INDEX IF EXISTS idx_foo;',
      '+ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_old_check;',
      '+ALTER TABLE public.tasks ALTER COLUMN device_id DROP EXPRESSION IF EXISTS;',
      '+ALTER TABLE public.tasks ALTER COLUMN request_payload DROP NOT NULL;',
      '+REVOKE TRUNCATE ON TABLE public.tasks FROM readonly_role;',
      '+GRANT\n+  TRUNCATE\n+ON TABLE public.tasks TO maint_role;',
      '+CREATE TRIGGER trg_guard\n+  BEFORE\n+  TRUNCATE ON public.tasks\n+  EXECUTE FUNCTION fn_guard();',
      '+ALTER TABLE public.tasks ADD COLUMN "truncate" boolean;',
      "+COMMENT ON TABLE public.tasks IS 'never DROP TABLE blindly';",
      '+COMMENT ON COLUMN public.tasks.id IS $$never DROP TABLE or TRUNCATE blindly$$;',
    ].join('\n'),
  })
  assert.deepEqual(destructiveMigrationOps(safeMigration), [])
  assert.deepEqual(
    evaluatePr({
      files: [safeMigration, file('packages/db/drizzle/rollback/0123_safe_cleanup.down.sql', { status: 'added' })],
      body: body(),
    }),
    { fails: [], warns: [], costFiles: [] },
  )
})

test('hydrateMigrationContents fetches full SQL only for active migration files', async () => {
  const calls = []
  const input = [
    file('packages/db/drizzle/0131_big.sql', { status: 'added', sha: 'sha-1' }),
    file('packages/db/drizzle-billing/0031_big.sql', { status: 'modified', sha: 'sha-2' }),
    file('packages/db/drizzle/0132_removed.sql', { status: 'removed', sha: 'sha-3' }),
    file('packages/db/drizzle/0133_failed.sql', { status: 'added', sha: 'sha-err' }),
    file('apps/bff/src/index.ts', { status: 'modified', sha: 'sha-4' }),
  ]
  const out = await hydrateMigrationContents(input, async (f) => {
    calls.push(f.filename)
    if (f.sha === 'sha-err') throw new Error('network error')
    return `/* ${f.sha} */\nDROP TABLE public.old_logs;`
  })
  assert.deepEqual(calls, [
    'packages/db/drizzle/0131_big.sql',
    'packages/db/drizzle-billing/0031_big.sql',
    'packages/db/drizzle/0133_failed.sql',
  ])
  assert.deepEqual(destructiveMigrationOps(out[0]), ['DROP TABLE'])
  assert.deepEqual(destructiveMigrationOps(out[1]), ['DROP TABLE'])
  assert.equal(out[2].content, undefined)
  assert.match(destructiveMigrationOps(out[3]).join(), /SQL 内容未获取/)
  assert.equal(out[4].content, undefined)
})

test('section reads a heading up to the next one, ignoring comments', () => {
  assert.equal(section('## A\n<!-- x -->\nfoo\n## B\nbar', 'A'), 'foo')
  assert.equal(section('## A\nfoo', 'C'), undefined)
  assert.equal(stripComments('a<!-- b'), 'a')
})
