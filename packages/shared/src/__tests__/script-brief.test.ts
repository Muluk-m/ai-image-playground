import { expect, it } from 'bun:test'
import {
  appendScriptEpisode,
  renderScriptDocument,
  SCRIPT_BRIEFS,
  scriptBriefById,
} from '../script-brief'

it('fills a popular brief into a script with an outline, cast and first episode', () => {
  const brief = scriptBriefById('sprout-window')
  expect(brief?.genre).toBe('都市现实')
  const script = renderScriptDocument(brief!)
  expect(script).toContain('## 大纲')
  expect(script).toContain('## 人物表')
  expect(script).toContain('## 第 1 集')
  expect(script).toContain('林夏')
  expect(script).toContain('第一片新叶')
})

it('keeps an explicit automatic choice and refuses a duplicate episode', () => {
  const brief = { ...SCRIPT_BRIEFS[0]!, style: '  ', outline: '' }
  const script = renderScriptDocument(brief)
  expect(script).toContain('画风：自动')
  expect(script).toContain('## 大纲\n自动')
  expect(appendScriptEpisode(script, 2, '第二天，叶子又多了一片。')).toContain('## 第 2 集')
  const twice = appendScriptEpisode(script, 2, '第二天，叶子又多了一片。')!
  expect(appendScriptEpisode(twice, 2, '再写一次')).toBeNull()
  expect(appendScriptEpisode(script, 3, '   ')).toBeNull()
})
