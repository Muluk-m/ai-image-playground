#!/usr/bin/env bun
/**
 * 设计规范门禁，规则、baseline 棘轮与 `design-allow` 豁免见 apps/web/DESIGN.md「门禁」。
 * 用法：bun run scripts/check-design.ts [--update]   # --update 只把 baseline 往下收紧
 *       bun run scripts/check-design.ts --adopt <rule> # 新增规则时登记它的存量
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

export type DesignRule = {
  id: string
  fix: string
  /** 按行匹配的正则；与 find 二选一 */
  pattern?: RegExp
  /** 在语法树上找命中，返回偏移量；正则描述不了结构（跨行、类型导入）时用 */
  find?: (file: ts.SourceFile) => number[]
  /** 默认 ts / tsx */
  extensions?: readonly string[]
  appliesTo?: (path: string) => boolean
  /** 按命中位置所在的 JSX 标签豁免个例（index 是命中在整个文件里的偏移） */
  exempt?: (source: string, index: number) => boolean
}

const outsideUi = (path: string) => !path.includes('/components/ui/')
// 品牌 Logo 是唯一允许手写 svg 的地方；icons.tsx 与 *Icons.tsx 是待迁走的旧图标模块。
const isLogoModule = (path: string) => /\/logos\.tsx$/.test(path)
const palette =
  'zinc|gray|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const colorUtilities =
  'text|bg|border|ring|fill|stroke|from|to|via|outline|divide|placeholder|shadow|decoration|accent|caret'

/** 从 `<` 开始的完整 JSX 开始标签（跳过 `{…}` 表达式里的 `>`），属性可以跨行。 */
function openingTagAt(source: string, start: number): string {
  let depth = 0
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (char === '>' && depth === 0) return source.slice(start, index + 1)
  }
  return source.slice(start)
}

/** 命中位置所在的 JSX 开始标签；不在任何开始标签里时返回 null。 */
function enclosingTag(source: string, index: number): { name: string; text: string } | null {
  for (let start = source.lastIndexOf('<', index); start >= 0; ) {
    const name = /^<([A-Za-z][\w.]*)/.exec(source.slice(start, start + 64))?.[1]
    if (name) {
      const text = openingTagAt(source, start)
      return start + text.length > index ? { name, text } : null
    }
    start = source.lastIndexOf('<', start - 1)
  }
  return null
}

const typeOf = (tag: string) => /(?<![\w-])type=["'](\w+)["']/.exec(tag)?.[1]
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'radio',
  'range',
  'submit',
])

// lucide-react 的 import / export 声明里只要带了运行时的值（不全是类型）就算。
function isRuntimeLucideImport(statement: ts.Statement): boolean {
  if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return false
  const specifier = statement.moduleSpecifier
  if (!specifier || !ts.isStringLiteral(specifier) || specifier.text !== 'lucide-react')
    return false
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return false
    const clause = statement.exportClause
    return !clause || !ts.isNamedExports(clause) || clause.elements.some((e) => !e.isTypeOnly)
  }
  const clause = statement.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  return !bindings || !ts.isNamedImports(bindings) || bindings.elements.some((e) => !e.isTypeOnly)
}

export const DESIGN_RULES: readonly DesignRule[] = [
  {
    id: 'native-control',
    fix: '用 components/ui 的 Button / Input / Textarea / Select 等组件，不写原生控件',
    pattern: /<(button|select|textarea|dialog|input)\b/g,
    extensions: ['tsx'],
    appliesTo: outsideUi,
    exempt: (source, index) => {
      const tag = openingTagAt(source, index)
      return tag.startsWith('<input') && ['file', 'hidden'].includes(typeOf(tag) ?? '')
    },
  },
  {
    id: 'inline-svg',
    fix: '图标用 components/ui/icon 的 <Icon name>；缺的图形先登记进它的 ICONS 对照表',
    pattern: /<svg\b/g,
    extensions: ['tsx'],
    appliesTo: (path) => outsideUi(path) && !isLogoModule(path),
  },
  {
    id: 'lucide-import',
    fix: '图标用 components/ui/icon 的 <Icon name>，不直接 import lucide-react（纯类型导入除外）',
    find: (file) => file.statements.filter(isRuntimeLucideImport).map((s) => s.getStart(file)),
    appliesTo: outsideUi,
  },
  {
    id: 'glyph-icon',
    fix: '× → ↗ ✓ 这类字符不能当图标，换成 <Icon>（close、arrowRight、check…）',
    pattern: />\s*[×→←↗↘＋✕✓✔▾▸◫≡]\s*<|['"`][×→←↗↘＋✕✓✔▾▸◫≡]['"`]/g,
  },
  {
    id: 'arbitrary-font',
    fix: '字号只用字阶 token：text-label-sm / xs / body-sm / sm / title / base / xl / headline / display',
    pattern: /\btext-\[\d+(\.\d+)?(px|rem|em)\]/g,
  },
  {
    id: 'offscale-font',
    fix: 'text-lg / 2xl / 3xl… 不在字阶里，换成最近的字阶 token（20→xl，28→headline，38→display）',
    pattern: /\btext-(lg|2xl|3xl|4xl|5xl|6xl|7xl)\b/g,
  },
  {
    id: 'font-weight',
    fix: '字重只用 font-normal / font-medium / font-semibold',
    pattern: /\bfont-(thin|extralight|light|bold|extrabold|black)\b/g,
  },
  {
    id: 'arbitrary-spacing',
    fix: '间距用 Tailwind 档位（布局层 4/8/12/16/24/32/48），不写 [Npx]',
    pattern:
      /\b-?(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y)-\[-?[\d.]+(px|rem)\]/g,
  },
  {
    id: 'arbitrary-radius',
    fix: '圆角用 rounded-sm / md / lg / full，不写 [Npx]',
    pattern: /\brounded(-[trblse]{1,2})?-\[[^\]]+\]/g,
  },
  {
    id: 'arbitrary-color',
    fix: '颜色走语义 token（bg-card、text-muted-foreground…），不写 [#hex] / [rgb()]',
    pattern: new RegExp(`\\b(${colorUtilities})-\\[(#|rgba?\\(|hsla?\\()[^\\]]*\\]`, 'g'),
  },
  {
    id: 'palette-class',
    fix: '状态与中性色走语义 token（success / warning / destructive / muted），不用 Tailwind 调色板',
    pattern: new RegExp(`\\b(${colorUtilities})-(${palette})-\\d{2,3}\\b`, 'g'),
  },
  {
    id: 'opacity-text',
    fix: '文字只有 foreground 与 muted-foreground 两档，不用 /70 这类透明度造第三档',
    pattern: /\btext-(foreground|muted-foreground|card-foreground|popover-foreground)\/\d+\b/g,
  },
  {
    id: 'focus-not-visible',
    fix: '焦点环用 focus-visible:，只有文本输入框允许 focus:',
    pattern: /(?<![-\w])focus:(ring|outline)/g,
    appliesTo: outsideUi,
    exempt: (source, index) => {
      const tag = enclosingTag(source, index)
      return (
        !!tag &&
        /^(input|textarea|Input|Textarea)$/.test(tag.name) &&
        !NON_TEXT_INPUT_TYPES.has(typeOf(tag.text) ?? 'text')
      )
    },
  },
  {
    id: 'css-color',
    fix: 'CSS 里用 hsl(var(--token)) 引用颜色，不写死色值',
    pattern: /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g,
    extensions: ['css'],
    appliesTo: (path) => !/\/(theme|fonts)\.css$/.test(path),
  },
  {
    id: 'css-font-size',
    fix: '字号用字阶 token（Tailwind 的 text-* 类），不在 CSS 里写死',
    pattern: /font-size:\s*[\d.]+(px|rem)/g,
    extensions: ['css'],
  },
]

export type DesignCounts = Record<string, Record<string, number>>
export type DesignHit = { rule: string; line: number }

// 用 TypeScript 语法树找注释（CSS 只有块注释），别自己猜 // 与 /* 是不是在字符串里。
function commentRanges(source: string, file: ts.SourceFile | undefined): Array<[number, number]> {
  if (!file) {
    return [...source.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => [m.index, m.index + m[0].length])
  }
  const ranges = new Map<number, number>()
  const visit = (node: ts.Node) => {
    // JSX 文本里的 // 是页面上的字，不是注释。
    if (node.kind === ts.SyntaxKind.JsxText) return
    for (const range of [
      ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(source, node.end) ?? []),
    ]) {
      ranges.set(range.pos, range.end)
    }
    for (const child of node.getChildren(file)) visit(child)
  }
  visit(file)
  return [...ranges]
}

// 扫一个文件：注释先抹成空白（保留换行与偏移）再匹配规则。
// 注释里写 design-allow <rule> 时豁免同一行；写在只有注释的上一行时豁免下一行。
export function scanSource(path: string, source: string): DesignHit[] {
  const extension = path.slice(path.lastIndexOf('.') + 1)
  const rules = DESIGN_RULES.filter(
    (rule) =>
      (rule.extensions ?? ['ts', 'tsx']).includes(extension) && (rule.appliesTo?.(path) ?? true),
  )
  const file = path.endsWith('.css')
    ? undefined
    : ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      )
  const code = source.split('')
  const lineStarts = [0, ...[...source.matchAll(/\n/g)].map((match) => match.index + 1)]
  const lineOf = (offset: number) => {
    let line = 0
    while (lineStarts[line + 1] !== undefined && lineStarts[line + 1]! <= offset) line += 1
    return line
  }
  const notes: string[] = []
  for (const [start, end] of commentRanges(source, file)) {
    const line = lineOf(end - 1)
    notes[line] = `${notes[line] ?? ''} ${source.slice(start, end)}`
    for (let index = start; index < end; index += 1) if (code[index] !== '\n') code[index] = ' '
  }
  const masked = code.join('')
  const lines = masked.split('\n')
  // 只有注释的上一行（含 JSX 的 {/* … */}）才豁免下一行。
  const allowed = (rule: string, index: number) => {
    const above = /^\s*(\{\s*\})?\s*$/.test(lines[index - 1] ?? 'x') ? (notes[index - 1] ?? '') : ''
    return new RegExp(`design-allow ${rule}\\b`).test(`${notes[index] ?? ''} ${above}`)
  }
  const hits: Array<DesignHit & { offset: number }> = []
  for (const rule of rules) {
    const offsets = rule.find
      ? file
        ? rule.find(file)
        : []
      : [...masked.matchAll(rule.pattern ?? /$^/g)].map((match) => match.index)
    for (const offset of offsets) {
      const index = lineOf(offset)
      if (allowed(rule.id, index) || rule.exempt?.(masked, offset)) continue
      hits.push({ rule: rule.id, line: index + 1, offset })
    }
  }
  return hits.sort((a, b) => a.offset - b.offset).map(({ rule, line }) => ({ rule, line }))
}

export function countHits(hitsByFile: Record<string, DesignHit[]>): DesignCounts {
  const counts: DesignCounts = {}
  for (const [file, hits] of Object.entries(hitsByFile)) {
    for (const { rule } of hits) {
      counts[file] ??= {}
      counts[file][rule] = (counts[file][rule] ?? 0) + 1
    }
  }
  return counts
}

export type Regression = { file: string; rule: string; allowed: number; actual: number }

export function findRegressions(current: DesignCounts, baseline: DesignCounts): Regression[] {
  const regressions: Regression[] = []
  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, actual] of Object.entries(rules)) {
      const allowed = baseline[file]?.[rule] ?? 0
      if (actual > allowed) regressions.push({ file, rule, allowed, actual })
    }
  }
  return regressions
}

/** 新加一条规则时把它的存量登记进 baseline；其他规则的计数原样保留。 */
export function adoptRule(
  current: DesignCounts,
  baseline: DesignCounts,
  rule: string,
): DesignCounts {
  if (!DESIGN_RULES.some((known) => known.id === rule)) throw new Error(`未知规则：${rule}`)
  if (Object.values(baseline).some((rules) => rule in rules)) {
    throw new Error(`baseline 里已经有 ${rule}，存量只能收紧，不能重新登记`)
  }
  const merged: DesignCounts = structuredClone(baseline)
  for (const [file, rules] of Object.entries(current)) {
    const count = rules[rule]
    if (!count) continue
    merged[file] ??= {}
    merged[file][rule] = count
  }
  // 借 tightenBaseline 排序：两边相同时它只做排序。
  return tightenBaseline(merged, merged)
}

/** baseline 只往下收：已修掉的条目删除，计数取两者较小值，从不新增。 */
export function tightenBaseline(current: DesignCounts, baseline: DesignCounts): DesignCounts {
  const next: DesignCounts = {}
  for (const file of Object.keys(baseline).sort()) {
    for (const rule of Object.keys(baseline[file]!).sort()) {
      const count = Math.min(baseline[file]![rule]!, current[file]?.[rule] ?? 0)
      if (count > 0) {
        next[file] ??= {}
        next[file][rule] = count
      }
    }
  }
  return next
}

const SCAN_ROOT = 'apps/web/src'
const IGNORED = /(^|\/)(__tests__|node_modules|dist)\/|\.test\.tsx?$|\.d\.ts$/

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dir, '..')
  const baselinePath = resolve(import.meta.dir, 'design-baseline.json')
  const hitsByFile: Record<string, DesignHit[]> = {}
  for await (const file of new Bun.Glob('**/*.{ts,tsx,css}').scan({
    cwd: resolve(repositoryRoot, SCAN_ROOT),
  })) {
    const path = `${SCAN_ROOT}/${file}`
    if (IGNORED.test(path)) continue
    const hits = scanSource(path, readFileSync(resolve(repositoryRoot, path), 'utf8'))
    if (hits.length > 0) hitsByFile[path] = hits
  }
  const current = countHits(hitsByFile)
  const update = process.argv.includes('--update')
  if (!existsSync(baselinePath) && !update) {
    console.error(
      '缺少 scripts/design-baseline.json；只有初始化时才运行 `pnpm design:baseline` 生成。',
    )
    process.exit(1)
  }
  // 首次生成时以当前扫描为 baseline；之后只收紧。
  const baseline: DesignCounts = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : current

  if (process.argv.includes('--adopt')) {
    const adopt = process.argv[process.argv.indexOf('--adopt') + 1] ?? ''
    if (update || adopt.startsWith('--')) {
      console.error('用法：bun run scripts/check-design.ts --adopt <rule>（不能与 --update 同用）')
      process.exit(1)
    }
    let next: DesignCounts
    try {
      next = adoptRule(current, baseline, adopt)
    } catch (error) {
      console.error((error as Error).message)
      process.exit(1)
    }
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`adopted existing ${adopt} hits into the design baseline`)
    process.exit(0)
  }

  if (update) {
    const next = tightenBaseline(current, baseline)
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`design baseline written: ${Object.keys(next).length} files`)
    process.exit(0)
  }

  const regressions = findRegressions(current, baseline)
  if (regressions.length > 0) {
    const lines = regressions.flatMap(({ file, rule, allowed, actual }) => {
      const at = hitsByFile[file]!.filter((hit) => hit.rule === rule).map((hit) => hit.line)
      return [
        `  ${file} [${rule}] ${actual} > baseline ${allowed}，行 ${at.join(', ')}`,
        `    → ${DESIGN_RULES.find((candidate) => candidate.id === rule)?.fix}`,
      ]
    })
    console.error(
      [
        '设计规范门禁未通过（规则见 apps/web/DESIGN.md）：',
        ...lines,
        '确属例外时在该行或上一行注释 `design-allow <rule>: 理由`，不要抬 baseline。',
      ].join('\n'),
    )
    process.exit(1)
  }

  if (findRegressions(baseline, current).length > 0) {
    console.log('设计违规比 baseline 少了，可运行 `pnpm design:baseline` 收紧。')
  }
}
