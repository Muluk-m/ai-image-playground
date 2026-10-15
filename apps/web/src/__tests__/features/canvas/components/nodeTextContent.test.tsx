// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import NodeTextContent from '../../../../features/canvas/components/NodeTextContent'

it('renders rich blocks consistently without interpreting user HTML', () => {
  const markup = renderToStaticMarkup(
    createElement(NodeTextContent, {
      data: {
        text: '第一幕\n对白\n第二镜\n',
        fontSize: 16,
        fill: '#fff',
        richText: [
          { insert: '第一幕' },
          { insert: '\n', attributes: { header: 1 } },
          { insert: '<img src=x onerror=alert(1)>', attributes: { bold: true } },
          { insert: '\n', attributes: { list: 'ordered' } },
          { insert: '第二镜' },
          { insert: '\n', attributes: { list: 'ordered' } },
          { insert: { divider: true } },
          { insert: '\n' },
        ],
      },
    }),
  )
  expect(markup).toContain('<h1>第一幕</h1>')
  expect(markup).toContain('start="2"')
  expect(markup).toContain('<hr/>')
  expect(markup).not.toContain('<img')
  expect(markup).toContain('&lt;img')
})
