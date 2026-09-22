#!/usr/bin/env bun
/**
 * 语料体检：找出「语料里有、代码里没人用」的死 key。
 *
 * 反方向（代码里用了、语料里没有）不需要这个脚本——`src/i18n/index.ts` 里的
 * `declare module 'i18next'` 把中文 catalog 的形状喂给了 t()，漏 key 在 `pnpm typecheck`
 * 就红。这里只补它覆盖不到的那一半。
 *
 * 判定「被用到」的方式是在源码里搜 key 的字面量。我们的动态 key 都是从**字面量联合类型**
 * 里挑出来的（例如 `type PanelErrorKey = 'errors:link.identity_taken' | ...`），所以字面量
 * 搜索能命中。真正靠模板拼出来的 key 写进 DYNAMIC_PREFIXES 白名单。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const WEB_SRC = join(import.meta.dir, '..', 'apps', 'web', 'src')
const CATALOG_DIR = join(WEB_SRC, 'i18n', 'locales', 'zh-CN')

/** 靠模板字符串拼出来的 key 前缀，字面量搜不到，按前缀整体放行。 */
const DYNAMIC_PREFIXES = [
  'common:locale.',
  'locale.',
  // features/video/lib/labels.ts：按 shared 的稳定 id（驳回码、派生模式、模型别名）拼 key。
  'video:reject.',
  'video:tagline.',
  'video:derive.',
  // features/canvas/components/InpaintPanel.tsx：分段控件按 'brush' | 'eraser' 拼 key。
  'canvas:inpaint.tool.',
]

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'generated') continue
      walk(full, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry) && !full.includes(`${join('i18n', 'locales')}`)) out.push(full)
  }
  return out
}

function leafKeys(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix]
  if (node === null || typeof node !== 'object') return []
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    leafKeys(value, prefix ? `${prefix}.${key}` : key),
  )
}

const sources = walk(WEB_SRC)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')

const dead: string[] = []
let checked = 0

for (const entry of readdirSync(CATALOG_DIR)) {
  if (!entry.endsWith('.json')) continue
  const namespace = entry.replace(/\.json$/, '')
  const catalog = JSON.parse(readFileSync(join(CATALOG_DIR, entry), 'utf8')) as unknown
  const keys = new Set(leafKeys(catalog).map((key) => key.replace(PLURAL_SUFFIX, '')))
  for (const key of keys) {
    checked += 1
    const qualified = `${namespace}:${key}`
    if (DYNAMIC_PREFIXES.some((prefix) => qualified.startsWith(prefix) || key.startsWith(prefix))) {
      continue
    }
    if (sources.includes(key) || sources.includes(qualified)) continue
    dead.push(qualified)
  }
}

console.log(`checked ${checked} keys across ${readdirSync(CATALOG_DIR).length - 1} namespaces`)

if (dead.length > 0) {
  console.error(`\n${dead.length} key(s) in the catalogs are never referenced in source:\n`)
  for (const key of dead.sort()) console.error(`  ${key}`)
  console.error(
    `\nDelete them, or add the prefix to DYNAMIC_PREFIXES in ${relative(process.cwd(), import.meta.path)} if they are built at runtime.`,
  )
  process.exit(1)
}

console.log('no dead keys')
