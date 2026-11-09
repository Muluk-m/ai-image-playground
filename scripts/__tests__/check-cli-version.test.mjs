import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CLI_FILE,
  collect,
  compareVersions,
  GUIDE_FILES,
  inspect,
  MIN_VERSION_FILE,
  main,
  PIN_FILE,
  RELEASE_DOC_FILE,
  SKILL_FILE,
  SOURCE_FILE,
  WORKFLOW_FILE,
} from '../check-cli-version.mjs'

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const FILES = [
  SOURCE_FILE,
  CLI_FILE,
  SKILL_FILE,
  WORKFLOW_FILE,
  RELEASE_DOC_FILE,
  PIN_FILE,
  MIN_VERSION_FILE,
  ...GUIDE_FILES,
]
const temporary = []

after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

/** 把真实仓库里需要比对的那几个文件复制进临时树，便于逐个篡改后看检查是否报错。 */
function fixture(edits = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aip-cli-version-'))
  temporary.push(root)
  for (const path of FILES) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    cpSync(join(repo, path), join(root, path))
  }
  for (const [path, edit] of Object.entries(edits)) {
    const file = join(root, path)
    writeFileSync(file, edit(readFileSync(file, 'utf8')))
  }
  return root
}

/** 临时树不是 git 仓库，所以显式喂一张 tag 表。 */
function factsFor(root, tags) {
  return collect(root, { git: () => tags })
}

const releasedTags = () =>
  new Map([
    ['0.2.3', 'c'.repeat(40)],
    ['0.2.4', '940f1faf1f4147d4b0add11efa5d3684aef0439c'],
  ])

function problemsFor(edits, tags = releasedTags()) {
  return inspect(factsFor(fixture(edits), tags)).problems
}

test('版本比较按数值而不是字典序', () => {
  assert.equal(compareVersions('0.2.4', '0.2.4'), 0)
  assert.ok(compareVersions('0.2.4', '0.10.0') < 0)
  assert.ok(compareVersions('0.2.10', '0.2.9') > 0)
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0)
})

test('当前仓库已对齐：真实树加真实 tag 没有问题', () => {
  const { problems } = inspect(collect(repo))
  assert.deepEqual(problems, [])
  assert.equal(main(repo), 0)
})

test('没取到 tag 时只跳过 tag 相关子检查', () => {
  const { problems, notices } = inspect(factsFor(fixture(), null))
  assert.deepEqual(problems, [])
  assert.equal(notices.length, 1)
  assert.match(notices[0], /fetch-tags/)
  // 其余检查仍然生效。
  const drifted = inspect(
    factsFor(fixture({ [WORKFLOW_FILE]: (t) => t.replace('cli-v0.2.4', 'cli-v0.2.3') }), null),
  )
  assert.equal(drifted.problems.length, 1)
})

test('来源文件必须是精确的 X.Y.Z', () => {
  for (const value of ['v0.2.4\n', '0.2\n', '', '0.2.4-rc1\n']) {
    const problems = problemsFor({ [SOURCE_FILE]: () => value })
    assert.equal(problems.length, 1, value)
    assert.match(problems[0], /必须是精确的 X\.Y\.Z/)
  }
})

test('Go 两处版本必须引用单一来源，不能写回字面量', () => {
  for (const [path, name] of [
    [CLI_FILE, 'Version'],
    [SKILL_FILE, 'BundleVersion'],
  ]) {
    const problems = problemsFor({
      [path]: (t) => t.replace(`${name} = version.Current`, `${name} = "0.2.4"`),
    })
    assert.equal(problems.length, 2, `${path} ${problems.join(' / ')}`)
    assert.match(problems[0], new RegExp(`${name} = version\\.Current`))
    assert.match(problems[1], /字面量 0\.2\.4/)
  }
})

test('cli-checks.yml 的默认 tag 必须跟来源一致', () => {
  const problems = problemsFor({ [WORKFLOW_FILE]: (t) => t.replace('cli-v0.2.4', 'cli-v0.2.3') })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /release-tag 默认值是 cli-v0\.2\.3，应为 cli-v0\.2\.4/)
})

test('发布手册里如果留了 --version 字面量，也要跟来源一致', () => {
  const problems = problemsFor({
    [RELEASE_DOC_FILE]: (t) =>
      `${t}\n    python install/build-dist.py --version 0.1.9 --output dist\n`,
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /--version 0\.1\.9/)
})

test('三份指南的版本与安装脚本提交必须等于网页固定值', () => {
  for (const guide of GUIDE_FILES) {
    const problems = problemsFor({ [guide]: (t) => t.replaceAll('0.2.4', '0.2.3') })
    assert.ok(problems.length >= 1, guide)
    for (const problem of problems)
      assert.match(problem, new RegExp(`^${guide}: 写着版本 0\\.2\\.3`))
  }
  const sha = problemsFor({
    [GUIDE_FILES[0]]: (t) =>
      t.replaceAll('940f1faf1f4147d4b0add11efa5d3684aef0439c', 'a'.repeat(40)),
  })
  assert.equal(sha.length, 1)
  assert.match(sha[0], /安装脚本提交 a{40} 与 CLI_RELEASE_REF/)
})

test('指南里宿主自己的版本不算 CLI 版本', () => {
  assert.deepEqual(
    problemsFor({ [GUIDE_FILES[1]]: (t) => t.replace('WorkBuddy 5.9.3', 'WorkBuddy 6.0.1') }),
    [],
  )
  // 去掉产品名就会被当成 CLI 版本检查。
  const problems = problemsFor({
    [GUIDE_FILES[1]]: (t) => t.replace('WorkBuddy 5.9.3', '客户端 5.9.3'),
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /写着版本 5\.9\.3/)
})

test('指南完全不提版本也要报', () => {
  const problems = problemsFor({ [GUIDE_FILES[2]]: (t) => t.replaceAll('0.2.4', '') })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /没有提到 CLI 版本/)
})

test('网页固定值缺失直接报错', () => {
  const problems = problemsFor({
    [PIN_FILE]: (t) => t.replace("export const CLI_VERSION = '0.2.4'", ''),
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /CLI_VERSION/)
})

test('服务端最低版本不能高于网页固定版本', () => {
  const problems = problemsFor({
    [MIN_VERSION_FILE]: (t) => t.replace("CLI_MIN_VERSION = '0.1.0'", "CLI_MIN_VERSION = '0.2.5'"),
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /CLI_MIN_VERSION=0\.2\.5 高于网页固定版本 0\.2\.4/)
  // 等于固定版本是允许的（该版本自己能用）。
  assert.deepEqual(
    problemsFor({
      [MIN_VERSION_FILE]: (t) =>
        t.replace("CLI_MIN_VERSION = '0.1.0'", "CLI_MIN_VERSION = '0.2.4'"),
    }),
    [],
  )
})

test('发布 PR 第一个提交后：源码超前一个版本且 tag 还没打，是允许的', () => {
  const tags = releasedTags()
  tags.delete('0.2.4')
  tags.set('0.2.3', 'c'.repeat(40))
  const bumped = {
    [SOURCE_FILE]: () => '0.2.5\n',
    [WORKFLOW_FILE]: (t) => t.replace('cli-v0.2.4', 'cli-v0.2.5'),
    [PIN_FILE]: (t) =>
      t
        .replace("CLI_VERSION = '0.2.4'", "CLI_VERSION = '0.2.3'")
        .replace('940f1faf1f4147d4b0add11efa5d3684aef0439c', 'c'.repeat(40)),
    ...Object.fromEntries(
      GUIDE_FILES.map((guide) => [
        guide,
        (t) =>
          t
            .replaceAll('0.2.4', '0.2.3')
            .replaceAll('940f1faf1f4147d4b0add11efa5d3684aef0439c', 'c'.repeat(40)),
      ]),
    ),
  }
  assert.deepEqual(problemsFor(bumped, tags), [])

  // 同一棵树，但 cli-v0.2.5 已经发布：第二个提交漏了。
  const released = new Map(tags).set('0.2.5', 'd'.repeat(40))
  const missed = problemsFor(bumped, released)
  assert.equal(missed.length, 1)
  assert.match(missed[0], /cli-v0\.2\.5 已发布，但网页还固定在 0\.2\.3/)
})

test('网页固定在更早的版本，不只是上一个已发布版本，也要报', () => {
  const tags = new Map([
    ['0.2.2', 'b'.repeat(40)],
    ['0.2.3', 'c'.repeat(40)],
  ])
  const problems = problemsFor(
    {
      [SOURCE_FILE]: () => '0.2.4\n',
      [PIN_FILE]: (t) =>
        t
          .replace("CLI_VERSION = '0.2.4'", "CLI_VERSION = '0.2.2'")
          .replace('940f1faf1f4147d4b0add11efa5d3684aef0439c', 'b'.repeat(40)),
      ...Object.fromEntries(
        GUIDE_FILES.map((guide) => [
          guide,
          (t) =>
            t
              .replaceAll('0.2.4', '0.2.2')
              .replaceAll('940f1faf1f4147d4b0add11efa5d3684aef0439c', 'b'.repeat(40)),
        ]),
      ),
    },
    tags,
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /不是最近一个已发布版本（0\.2\.3）/)
})

test('网页固定的版本比源码新，直接报', () => {
  const problems = problemsFor({
    [SOURCE_FILE]: () => '0.2.3\n',
    [WORKFLOW_FILE]: (t) => t.replace('cli-v0.2.4', 'cli-v0.2.3'),
  })
  assert.ok(problems.some((problem) => /CLI_VERSION=0\.2\.4 高于/.test(problem)))
})

test('网页固定到一个没有 tag 的版本（还没发布）要报', () => {
  const tags = new Map([['0.2.3', 'c'.repeat(40)]])
  const problems = problemsFor({}, tags)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /cli-v0\.2\.4 这个 tag 不存在/)
})

test('CLI_RELEASE_REF 必须正好是该 tag 的提交', () => {
  const tags = new Map(releasedTags()).set('0.2.4', 'e'.repeat(40))
  const problems = problemsFor({}, tags)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /不是 cli-v0\.2\.4 的提交/)
})

test('main 在漂移时返回非零', () => {
  const root = fixture({ [WORKFLOW_FILE]: (t) => t.replace('cli-v0.2.4', 'cli-v0.2.3') })
  assert.equal(main(root), 1)
})
