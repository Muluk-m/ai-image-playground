import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { evaluatePr, section, stripComments } from '../pr-rules.mjs'

const template = readFileSync(new URL('../../.github/pull_request_template.md', import.meta.url), 'utf8')
const file = (filename, extra = {}) => ({ filename, status: 'modified', additions: 1, deletions: 1, ...extra })
const shot = '![顶栏](https://github.com/user-attachments/assets/abc)'

/** 按模板填一份描述，覆盖其中几节。 */
const body = ({ top = '无用户可见影响', evidence, cost = '不涉及。' } = {}) => {
  let text = template.replace('## 做了什么、影响是什么\n', `## 做了什么、影响是什么\n\n${top}\n`)
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
  const added = file('packages/db/drizzle/0101_x.sql', { status: 'added' })
  assert.match(evaluatePr({ files: [added], body: body() }).warns.join(), /没有回滚 SQL/)
  const withRollback = [added, file('packages/db/drizzle/rollback/0101_x.down.sql', { status: 'added' })]
  assert.deepEqual(evaluatePr({ files: withRollback, body: body() }).warns, [])
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

test('section reads a heading up to the next one, ignoring comments', () => {
  assert.equal(section('## A\n<!-- x -->\nfoo\n## B\nbar', 'A'), 'foo')
  assert.equal(section('## A\nfoo', 'C'), undefined)
  assert.equal(stripComments('a<!-- b'), 'a')
})
