// 原生 CLI 的版本号只有一个来源：cli-go/internal/version/VERSION。本检查确认其余每一份
// 拷贝都和它一致，任意一处漂移就让 CI 失败（docs/agents/cli-release.md 写了发布要改哪些文件）。
//
// 发布 PR 是两个提交，中间存在一个合法的「源码比网页超前一个版本」状态：
//   1) 第一个提交把 VERSION 提到 V、CI 过、在 PR head 上打 cli-vV，发布流水线出包；
//   2) 第二个提交才把网页接入页和三份指南固定到 V 和 cli-vV 的提交。
// 所以网页固定版本 P 允许等于 V（已发布并固定），也允许等于「上一个已发布版本」而 cli-vV 还不存在。
// 其他组合都是漂移。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 版本单一来源，以及其余需要对齐的文件。 */
export const SOURCE_FILE = 'cli-go/internal/version/VERSION'
export const CLI_FILE = 'cli-go/internal/cli/app.go'
export const SKILL_FILE = 'cli-go/internal/skill/install.go'
export const WORKFLOW_FILE = '.github/workflows/cli-checks.yml'
export const RELEASE_DOC_FILE = 'docs/agents/cli-release.md'
export const PIN_FILE = 'apps/web/src/features/cli/connectAgents.ts'
export const MIN_VERSION_FILE = 'apps/bff/src/routes/cli.ts'
/** 三份面向宿主智能体的接入指南，安装命令里固定着网页版本与发布提交。 */
export const GUIDE_FILES = [
  'apps/web/public/cli/setup.md',
  'apps/web/public/cli/workbuddy.md',
  'apps/web/workbuddy-skill/workbuddy.md',
]

const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/
const ANY_VERSION = /\b[0-9]+\.[0-9]+\.[0-9]+\b/g
const RAW_INSTALL_SHA =
  /raw\.githubusercontent\.com\/Muluk-m\/ai-image-playground\/([0-9a-f]{40})\//g
/**
 * 指南里除了 CLI 版本，也会写宿主自己的版本（例如「本机 WorkBuddy 5.9.3 已实测」）。约定是：
 * 非 CLI 的版本号前面必须紧跟产品名，其余所有 X.Y.Z 都按 CLI 版本检查。新写一个第三方版本时
 * 把产品名加进这张表。
 */
const FOREIGN_VERSION =
  /(?:WorkBuddy|Claude Code|Codex|豆包工作|Python|Go|Node)\s*v?[0-9]+\.[0-9]+\.[0-9]+/g

/** 比较 X.Y.Z：负数表示 a 更旧。 */
export function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

function read(root, path) {
  return readFileSync(join(root, path), 'utf8')
}

function match(text, pattern) {
  return text.match(pattern)?.[1] ?? null
}

function unique(values) {
  return [...new Set(values)]
}

/**
 * 读出所有需要比对的事实。`git` 不可用或没有取到 tag 时 `tags` 为 null：这时跳过与 tag 相关的
 * 子检查（本地浅克隆没有 tag 很正常），其余检查照常。
 */
export function collect(root, { git = defaultGit } = {}) {
  const guides = GUIDE_FILES.map((path) => {
    const text = read(root, path)
    return {
      path,
      versions: unique(
        [...text.replace(FOREIGN_VERSION, ' ').matchAll(ANY_VERSION)].map((m) => m[0]),
      ),
      shas: unique([...text.matchAll(RAW_INSTALL_SHA)].map((m) => m[1])),
    }
  })
  const pin = read(root, PIN_FILE)
  return {
    source: read(root, SOURCE_FILE).trim(),
    cliWiring: read(root, CLI_FILE),
    skillWiring: read(root, SKILL_FILE),
    workflowTag: match(
      read(root, WORKFLOW_FILE),
      /^\s*default:\s*(cli-v[0-9]+\.[0-9]+\.[0-9]+)\s*$/m,
    ),
    docVersions: unique(
      [...read(root, RELEASE_DOC_FILE).matchAll(/--version\s+([0-9]+\.[0-9]+\.[0-9]+)\b/g)].map(
        (m) => m[1],
      ),
    ),
    pinVersion: match(pin, /^export const CLI_VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'$/m),
    pinRef: match(pin, /^export const CLI_RELEASE_REF = '([0-9a-f]{40})'$/m),
    minVersion: match(
      read(root, MIN_VERSION_FILE),
      /^export const CLI_MIN_VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'$/m,
    ),
    guides,
    tags: git(root),
  }
}

/**
 * 已发布版本 → 该 tag 指向的提交。附注 tag 取解引用后的提交（等同 `git rev-parse <tag>^{commit}`）。
 */
export function defaultGit(root) {
  let out
  try {
    out = execFileSync(
      'git',
      [
        '-C',
        root,
        'for-each-ref',
        '--format=%(refname:strip=2)%09%(objectname)%09%(*objectname)',
        'refs/tags/cli-v*',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    return null
  }
  const tags = new Map()
  for (const line of out.split('\n')) {
    const [name, object, dereferenced] = line.split('\t')
    const version = name?.slice('cli-v'.length)
    if (!version || !EXACT_VERSION.test(version)) continue
    tags.set(version, dereferenced || object)
  }
  // 一个 tag 都没有，说明这份检出没取 tag（而不是「从未发布过」）。
  return tags.size === 0 ? null : tags
}

/** 返回 { problems, notices }：problems 非空就该让检查失败。 */
export function inspect(facts) {
  const problems = []
  const notices = []
  const v = facts.source
  if (!v || !EXACT_VERSION.test(v)) {
    problems.push(`${SOURCE_FILE} 必须是精确的 X.Y.Z 版本，现在是 ${JSON.stringify(facts.source)}`)
    return { problems, notices }
  }

  // Go 侧不允许再出现第二份字面量：两处都必须引用单一来源。
  for (const [path, text, name] of [
    [CLI_FILE, facts.cliWiring, 'Version'],
    [SKILL_FILE, facts.skillWiring, 'BundleVersion'],
  ]) {
    if (!new RegExp(`${name}\\s*=\\s*version\\.Current\\b`).test(text)) {
      problems.push(`${path}: ${name} 必须写成 ${name} = version.Current，从 ${SOURCE_FILE} 取值`)
    }
    const literal = match(text, new RegExp(`${name}\\s*=\\s*"([0-9]+\\.[0-9]+\\.[0-9]+)"`))
    if (literal) {
      problems.push(`${path}: ${name} 又写回了字面量 ${literal}，删掉它并引用 version.Current`)
    }
  }

  if (facts.workflowTag !== `cli-v${v}`) {
    problems.push(`${WORKFLOW_FILE}: release-tag 默认值是 ${facts.workflowTag}，应为 cli-v${v}`)
  }
  for (const version of facts.docVersions) {
    if (version !== v) {
      problems.push(
        `${RELEASE_DOC_FILE}: 示例命令里的 --version ${version} 与 ${SOURCE_FILE}（${v}）不一致`,
      )
    }
  }

  const p = facts.pinVersion
  const ref = facts.pinRef
  if (!p || !ref) {
    problems.push(`${PIN_FILE}: 必须导出 CLI_VERSION（X.Y.Z）与 CLI_RELEASE_REF（40 位提交哈希）`)
    return { problems, notices }
  }

  // 三份指南里的版本与安装脚本提交，必须和网页固定值完全一致。指南不写别的版本号：
  // 出现其他 X.Y.Z 一律按漂移处理。
  for (const guide of facts.guides) {
    if (guide.versions.length === 0) {
      problems.push(`${guide.path}: 没有提到 CLI 版本，应与 ${PIN_FILE} 的 CLI_VERSION（${p}）一致`)
    }
    for (const version of guide.versions) {
      if (version !== p) {
        problems.push(
          `${guide.path}: 写着版本 ${version}，网页固定的是 ${p}` +
            '（若这是宿主自己的版本，前面补上产品名，并把产品名加进脚本的 FOREIGN_VERSION）',
        )
      }
    }
    for (const sha of guide.shas) {
      if (sha !== ref) {
        problems.push(`${guide.path}: 安装脚本提交 ${sha} 与 CLI_RELEASE_REF（${ref}）不一致`)
      }
    }
  }

  if (!facts.minVersion) {
    problems.push(`${MIN_VERSION_FILE}: 必须导出 CLI_MIN_VERSION（X.Y.Z）`)
  } else if (compareVersions(facts.minVersion, p) > 0) {
    // 服务端最低版本高于网页让用户装的版本，等于把照指南安装的人直接挡在门外。
    problems.push(
      `${MIN_VERSION_FILE}: CLI_MIN_VERSION=${facts.minVersion} 高于网页固定版本 ${p}；` +
        '先发布并固定新版 CLI，再提最低版本',
    )
  }

  const tags = facts.tags
  if (!tags) {
    notices.push('没有取到 cli-v* tag，跳过与 release tag 相关的子检查（CI 检出需要 fetch-tags）')
    if (compareVersions(p, v) > 0) {
      problems.push(`${PIN_FILE}: CLI_VERSION=${p} 高于 ${SOURCE_FILE}（${v}）`)
    }
    return { problems, notices }
  }

  const released = [...tags.keys()].sort(compareVersions)
  const latest = released[released.length - 1]
  if (p === v) {
    // 发布 PR 的第二个提交之后：tag 必须已存在，固定的提交必须正好是该 tag 的提交。
    if (!tags.has(v)) {
      problems.push(`${PIN_FILE}: 固定到 ${p}，但 cli-v${p} 这个 tag 不存在（该版本还没发布）`)
    } else if (tags.get(v) !== ref) {
      problems.push(`${PIN_FILE}: CLI_RELEASE_REF=${ref} 不是 cli-v${p} 的提交（${tags.get(v)}）`)
    }
  } else {
    // 发布 PR 的第一个提交之后：源码超前一个版本，网页仍固定在上一个已发布版本。
    if (compareVersions(p, v) > 0) {
      problems.push(`${PIN_FILE}: CLI_VERSION=${p} 高于 ${SOURCE_FILE}（${v}）`)
    } else if (tags.has(v)) {
      problems.push(
        `cli-v${v} 已发布，但网页还固定在 ${p}：补上发布 PR 的第二个提交（${PIN_FILE} 与三份指南）`,
      )
    } else if (p !== latest) {
      problems.push(
        `${PIN_FILE}: CLI_VERSION=${p} 不是最近一个已发布版本（${latest}）；` +
          `只有「源码已提到 ${v}、cli-v${v} 还没打」这一种超前状态是允许的`,
      )
    } else if (tags.get(p) !== ref) {
      problems.push(`${PIN_FILE}: CLI_RELEASE_REF=${ref} 不是 cli-v${p} 的提交（${tags.get(p)}）`)
    }
  }
  return { problems, notices }
}

export function main(root) {
  const facts = collect(root)
  const { problems, notices } = inspect(facts)
  const tags = facts.tags ? `${facts.tags.size} 个 cli-v* tag` : '未取到 tag'
  console.log(
    `CLI 版本来源 ${facts.source}；网页固定 ${facts.pinVersion ?? '?'} @ ${facts.pinRef?.slice(0, 12) ?? '?'}；` +
      `服务端最低 ${facts.minVersion ?? '?'}；${tags}`,
  )
  for (const notice of notices) console.log(`notice: ${notice}`)
  if (problems.length === 0) return 0
  for (const problem of problems) console.error(`error: ${problem}`)
  console.error(`CLI 版本不一致：${problems.length} 处。改动清单见 ${RELEASE_DOC_FILE}。`)
  return 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(dirname(dirname(fileURLToPath(import.meta.url)))))
}
