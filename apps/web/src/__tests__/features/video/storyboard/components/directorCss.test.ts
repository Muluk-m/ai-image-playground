import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const css = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../features/video/storyboard/components/director.css',
  ),
  'utf8',
)

/** `:where()` 的内容不计入 specificity，所以判断一条规则的分量时先把它整段剔掉。 */
function stripWhere(selector: string): string {
  let out = ''
  let index = 0
  while (index < selector.length) {
    if (!selector.startsWith(':where(', index)) {
      out += selector[index]
      index += 1
      continue
    }
    let depth = 0
    index += ':where'.length
    while (index < selector.length) {
      if (selector[index] === '(') depth += 1
      else if (selector[index] === ')') {
        depth -= 1
        if (depth === 0) {
          index += 1
          break
        }
      }
      index += 1
    }
  }
  return out
}

/** 选择器文本里的规则，`{` 之前的部分；@media 的条件不是选择器，跟着 `@` 一起跳过。 */
function selectors(): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...source.matchAll(/(^|[{}])\s*([^{}@]+?)\s*\{/gm)]
    .map((match) => match[2] ?? '')
    .flatMap((group) => group.split(','))
    .map((selector) => selector.trim())
    .filter(Boolean)
}

function countClasses(selector: string): number {
  return (selector.match(/\.[a-zA-Z_-][\w-]*/g) ?? []).length
}

function matchesBareElement(selector: string): boolean {
  return /(^|[\s>+~])[a-z][a-z0-9]*(?![\w-])/.test(selector.replace(/\[[^\]]*\]/g, ''))
}

// 导演台里渲染的是共用组件（Checkbox、参考图删除按钮、FIELD textarea），它们靠 utility
// 排版。只要一条规则既匹配元素、又带着 class，它就至少是 (0,1,1)，压得过 `.h-5`、`.flex`
// 这些 (0,1,0) 的 utility，把组件压散——2026-09 导演台那次就是这么坏的。所以凡是拿元素
// 选择器说话的规则，class 那一位必须让出去：容器写进 `:where()`，(0,0,1) 依然压得过
// preflight，而任何一个 utility 都能覆盖它。
it('keeps every element-matching rule from outranking a single utility class', () => {
  const offenders = selectors().filter((selector) => {
    const weighted = stripWhere(selector)
    return matchesBareElement(weighted) && countClasses(weighted) > 0
  })

  expect(offenders).toEqual([])
})

it('still lowers the element reset instead of dropping it', () => {
  expect(css).toMatch(/:where\(\.video-director\)\s+button\s*\{/)
  expect(css).toMatch(/:where\(\.video-director\)\s+:is\(input, textarea, select\)/)
})
