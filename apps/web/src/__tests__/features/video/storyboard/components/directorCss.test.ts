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

// `.video-director button` 的 specificity 是 (0,1,1)，压得过 `.h-5`、`.flex` 这类 (0,1,0) 的
// utility。导演台里渲染的是共用组件（Checkbox、参考图删除按钮、FIELD textarea），它们靠
// utility 排版，被这套 reset 一压就散架。基础 reset 必须写成 `:where(.video-director) el`，
// 把 class 的那一位让出去：(0,0,1) 仍然压得过 preflight，但让 utility 赢。
it('keeps the element reset from outranking a single utility class', () => {
  const bareElementReset = /\.video-director\s+[a-z][a-z0-9]*\s*[,{]/g
  expect(css.match(bareElementReset)).toBeNull()
})

it('still lowers the element reset instead of dropping it', () => {
  expect(css).toMatch(/:where\(\.video-director\)\s+button\s*\{/)
  expect(css).toMatch(/:where\(\.video-director\)\s+:is\(input, textarea, select\)/)
})
