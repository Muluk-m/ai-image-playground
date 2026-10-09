#!/usr/bin/env bun
/**
 * 设计规范门禁：apps/web 的原生控件、任意值、调色板类、内联 svg 等违规，规则依据见
 * apps/web/DESIGN.md。
 *
 * 存量违规按「文件 × 规则」计数记在 scripts/design-baseline.json，只许降不许升：
 * 某个文件某条规则的命中数超过 baseline 就失败。确有理由的个例在同一行或上一行写
 * `design-allow <rule>: 理由` 豁免，不要靠抬 baseline 放行。
 *
 * 用法：bun run scripts/check-design.ts           # 检查
 *       bun run scripts/check-design.ts --update  # 按当前扫描把 baseline 往下收紧
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type DesignRule = {
  id: string
  fix: string
  pattern: RegExp
  extensions: readonly string[]
  appliesTo?: (path: string) => boolean
}

const outsideUi = (path: string) => !path.includes('/components/ui/')
const isIconModule = (path: string) => /\/(icons|\w+Icons)\.tsx$/.test(path)
const palette =
  'zinc|gray|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const colorUtilities =
  'text|bg|border|ring|fill|stroke|from|to|via|outline|divide|placeholder|shadow|decoration|accent|caret'
const code = ['ts', 'tsx'] as const

export const DESIGN_RULES: readonly DesignRule[] = [
  {
    id: 'native-control',
    fix: '用 components/ui 的 Button / Input / Textarea / Select 等组件，不写原生控件',
    pattern: /<(button|select|textarea|dialog)\b|<input\b(?![^>]*\btype=["'](file|hidden)["'])/g,
    extensions: ['tsx'],
    appliesTo: outsideUi,
  },
  {
    id: 'inline-svg',
    fix: '图标用 lucide-react；自定义图标收进 components/icons.tsx',
    pattern: /<svg\b/g,
    extensions: ['tsx'],
    appliesTo: (path) => outsideUi(path) && !isIconModule(path),
  },
  {
    id: 'glyph-icon',
    fix: '× → ↗ ✓ 这类字符不能当图标，换成 lucide 图标（X、ArrowRight、Check…）',
    pattern: />\s*[×→←↗↘＋✕✓✔▾▸◫≡]\s*<|['"`][×→←↗↘＋✕✓✔▾▸◫≡]['"`]/g,
    extensions: code,
  },
  {
    id: 'arbitrary-font',
    fix: '字号只用字阶 token：text-label-sm / xs / body-sm / sm / title / base / xl / headline / display',
    pattern: /\btext-\[\d+(\.\d+)?(px|rem|em)\]/g,
    extensions: code,
  },
  {
    id: 'offscale-font',
    fix: 'text-lg / 2xl / 3xl… 不在字阶里，换成最近的字阶 token（20→xl，28→headline，38→display）',
    pattern: /\btext-(lg|2xl|3xl|4xl|5xl|6xl|7xl)\b/g,
    extensions: code,
  },
  {
    id: 'font-weight',
    fix: '字重只用 font-normal / font-medium / font-semibold',
    pattern: /\bfont-(thin|extralight|light|bold|extrabold|black)\b/g,
    extensions: code,
  },
  {
    id: 'arbitrary-spacing',
    fix: '间距用 Tailwind 档位（布局层 4/8/12/16/24/32/48），不写 [Npx]',
    pattern:
      /\b-?(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y)-\[-?[\d.]+(px|rem)\]/g,
    extensions: code,
  },
  {
    id: 'arbitrary-radius',
    fix: '圆角用 rounded-sm / md / lg / full，不写 [Npx]',
    pattern: /\brounded(-[trblse]{1,2})?-\[[^\]]+\]/g,
    extensions: code,
  },
  {
    id: 'arbitrary-color',
    fix: '颜色走语义 token（bg-card、text-muted-foreground…），不写 [#hex] / [rgb()]',
    pattern: new RegExp(`\\b(${colorUtilities})-\\[(#|rgba?\\(|hsla?\\()[^\\]]*\\]`, 'g'),
    extensions: code,
  },
  {
    id: 'palette-class',
    fix: '状态与中性色走语义 token（success / warning / destructive / muted），不用 Tailwind 调色板',
    pattern: new RegExp(`\\b(${colorUtilities})-(${palette})-\\d{2,3}\\b`, 'g'),
    extensions: code,
  },
  {
    id: 'opacity-text',
    fix: '文字只有 foreground 与 muted-foreground 两档，不用 /70 这类透明度造第三档',
    pattern: /\btext-(foreground|muted-foreground|card-foreground|popover-foreground)\/\d+\b/g,
    extensions: code,
  },
  {
    id: 'focus-not-visible',
    fix: '焦点环用 focus-visible:，只有文本输入框允许 focus:',
    pattern: /(?<![-\w])focus:(ring|outline)/g,
    extensions: code,
    appliesTo: outsideUi,
  },
  {
    id: 'foreign-icon-lib',
    fix: '图标库只用 lucide-react',
    pattern:
      /from ['"](react-icons|@heroicons|@phosphor-icons|@tabler\/icons|@radix-ui\/react-icons)[^'"]*['"]/g,
    extensions: code,
  },
  {
    id: 'radix-outside-ui',
    fix: 'Radix 原语只在 components/ui 里封装一次，业务代码从 components/ui 引入',
    pattern: /from ['"]@radix-ui\/[^'"]+['"]/g,
    extensions: code,
    appliesTo: outsideUi,
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

/** 扫一个文件；`design-allow <rule>` 写在同一行，或写在紧邻上方的纯注释行时豁免该行。 */
export function scanSource(path: string, source: string): DesignHit[] {
  const extension = path.slice(path.lastIndexOf('.') + 1)
  const rules = DESIGN_RULES.filter(
    (rule) => rule.extensions.includes(extension) && (rule.appliesTo?.(path) ?? true),
  )
  const lines = source.split('\n')
  const hits: DesignHit[] = []
  lines.forEach((line, index) => {
    if (/^\s*(\/\/|\/?\*)/.test(line)) return
    const previous = lines[index - 1] ?? ''
    const allowance = /^\s*(\/\/|\{?\/\*)/.test(previous) ? `${previous}\n${line}` : line
    for (const rule of rules) {
      if (allowance.includes(`design-allow ${rule.id}`)) continue
      for (const _ of line.matchAll(rule.pattern)) hits.push({ rule: rule.id, line: index + 1 })
    }
  })
  return hits
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

function sortCounts(counts: DesignCounts): DesignCounts {
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((file) => [
        file,
        Object.fromEntries(
          Object.keys(counts[file]!)
            .sort()
            .map((rule) => [rule, counts[file]![rule]!]),
        ),
      ]),
  )
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
  const baselineExists = existsSync(baselinePath)
  const baseline: DesignCounts = baselineExists
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : {}

  if (process.argv.includes('--update')) {
    const next = baselineExists ? tightenBaseline(current, baseline) : sortCounts(current)
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`design baseline written: ${Object.keys(next).length} files`)
    process.exit(0)
  }

  const regressions = findRegressions(current, baseline)
  if (regressions.length > 0) {
    const fixes = new Map(DESIGN_RULES.map((rule) => [rule.id, rule.fix]))
    const lines = regressions.flatMap(({ file, rule, allowed, actual }) => {
      const at = hitsByFile[file]!.filter((hit) => hit.rule === rule).map((hit) => hit.line)
      return [
        `  ${file} [${rule}] ${actual} > baseline ${allowed}，行 ${at.join(', ')}`,
        `    → ${fixes.get(rule)}`,
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

  const tightened = tightenBaseline(current, baseline)
  if (JSON.stringify(tightened) !== JSON.stringify(sortCounts(baseline))) {
    console.log('设计违规比 baseline 少了，可运行 `pnpm design:baseline` 收紧。')
  }
}
