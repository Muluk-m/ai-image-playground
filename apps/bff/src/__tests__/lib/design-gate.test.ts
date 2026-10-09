import { describe, expect, it } from 'bun:test'

import {
  countHits,
  findRegressions,
  scanSource,
  tightenBaseline,
} from '../../../../../scripts/check-design'

const rulesIn = (path: string, source: string) => scanSource(path, source).map((hit) => hit.rule)

describe('scanSource', () => {
  it('flags native controls outside components/ui but not inside', () => {
    const source = '<button onClick={go}>Go</button>\n<textarea />'
    expect(rulesIn('apps/web/src/features/x/Panel.tsx', source)).toEqual([
      'native-control',
      'native-control',
    ])
    expect(rulesIn('apps/web/src/components/ui/button.tsx', source)).toEqual([])
  })

  it('lets file and hidden inputs through', () => {
    const source =
      '<input type="file" hidden />\n<input type="hidden" name="a" />\n<input value={v} />'
    expect(scanSource('apps/web/src/A.tsx', source)).toEqual([{ rule: 'native-control', line: 3 }])
  })

  it('flags magic values and palette classes', () => {
    const source =
      '<div className="text-[13px] p-[6px] rounded-[10px] bg-[#fff] text-zinc-500 text-foreground/70 font-bold text-lg" />'
    expect(rulesIn('apps/web/src/A.tsx', source).sort()).toEqual(
      [
        'arbitrary-color',
        'arbitrary-font',
        'arbitrary-radius',
        'arbitrary-spacing',
        'font-weight',
        'offscale-font',
        'opacity-text',
        'palette-class',
      ].sort(),
    )
  })

  it('keeps design tokens and on-grid utilities clean', () => {
    const source =
      '<div className="text-body-sm px-3 py-2 rounded-md bg-card text-muted-foreground font-semibold focus-visible:ring-2" />'
    expect(rulesIn('apps/web/src/A.tsx', source)).toEqual([])
  })

  it('treats a lone glyph as an icon but not a dimension separator', () => {
    expect(rulesIn('apps/web/src/A.tsx', '<span>×</span>')).toEqual(['glyph-icon'])
    expect(rulesIn('apps/web/src/A.tsx', '<span>{w} × {h}</span>')).toEqual([])
  })

  it('allows inline svg only in icon modules', () => {
    expect(rulesIn('apps/web/src/components/Header.tsx', '<svg viewBox="0 0 1 1" />')).toEqual([
      'inline-svg',
    ])
    expect(rulesIn('apps/web/src/components/icons.tsx', '<svg viewBox="0 0 1 1" />')).toEqual([])
    expect(rulesIn('apps/web/src/components/chipIcons.tsx', '<svg viewBox="0 0 1 1" />')).toEqual(
      [],
    )
  })

  it('honours design-allow on the same or previous line', () => {
    const source = [
      '{/* design-allow native-control: 画布热区需要原生按钮 */}',
      '<button />',
      '<button /> // design-allow native-control: 同上',
      '<button />',
    ].join('\n')
    expect(scanSource('apps/web/src/A.tsx', source)).toEqual([{ rule: 'native-control', line: 4 }])
  })

  it('skips comment lines', () => {
    expect(rulesIn('apps/web/src/A.tsx', '// 以前用 <button> 和 text-[13px]')).toEqual([])
  })

  it('checks CSS colors and font sizes except in the token files', () => {
    const css = '.a { color: #fff; font-size: 13px; }'
    expect(rulesIn('apps/web/src/styles/studio.css', css).sort()).toEqual([
      'css-color',
      'css-font-size',
    ])
    expect(rulesIn('apps/web/src/styles/theme.css', '--x: #fff;')).toEqual([])
  })
})

describe('baseline ratchet', () => {
  const current = countHits({
    'a.tsx': [
      { rule: 'native-control', line: 1 },
      { rule: 'native-control', line: 2 },
    ],
    'b.tsx': [{ rule: 'inline-svg', line: 1 }],
  })

  it('reports files that exceed or are missing from the baseline', () => {
    expect(findRegressions(current, { 'a.tsx': { 'native-control': 1 } })).toEqual([
      { file: 'a.tsx', rule: 'native-control', allowed: 1, actual: 2 },
      { file: 'b.tsx', rule: 'inline-svg', allowed: 0, actual: 1 },
    ])
    expect(
      findRegressions(current, { 'a.tsx': { 'native-control': 3 }, 'b.tsx': { 'inline-svg': 1 } }),
    ).toEqual([])
  })

  it('only ever tightens the baseline', () => {
    const baseline = {
      'a.tsx': { 'native-control': 3 },
      'c.tsx': { 'palette-class': 2 },
    }
    expect(tightenBaseline(current, baseline)).toEqual({ 'a.tsx': { 'native-control': 2 } })
  })
})
