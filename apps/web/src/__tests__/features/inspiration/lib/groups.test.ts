import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { groupOf, INSPIRATION_GROUPS } from '../../../../features/inspiration/lib/groups'
import { inspirationGroupLabel } from '../../../../features/inspiration/lib/labels'

interface ManifestItem {
  category: string
}

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../public/inspiration-manifest.json'), 'utf8'),
) as { items: ManifestItem[] }

const HAN = /[\u3400-\u9fff]/

describe('inspiration groups', () => {
  it('maps every published category and keeps the full count', () => {
    const counts = new Map<string, number>()
    for (const item of manifest.items) {
      const group = groupOf(item.category)
      counts.set(group, (counts.get(group) ?? 0) + 1)
    }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
    expect(total).toBe(manifest.items.length)
    expect(groupOf('YouTube 缩略图')).toBe('posters')
    expect(groupOf('人物与角色')).toBe('people')
    expect(groupOf('个人资料 / 头像')).toBe('people')
    expect(groupOf('UI 与界面')).toBe('brand')
    expect(groupOf('品牌与 Logo')).toBe('brand')
    expect(groupOf('图表与信息图')).toBe('infographic')
    expect(groupOf('信息图 / 教育视觉图')).toBe('infographic')
    expect(groupOf('精选')).toBe('other')
    expect(groupOf('文档与排版')).toBe('other')
    expect(groupOf('不存在的分类')).toBe('other')
    expect(counts.size).toBeGreaterThan(1)
  })

  it('translates group names without leaving Chinese in English', () => {
    for (const group of INSPIRATION_GROUPS) {
      expect(inspirationGroupLabel(group.id, 'zh-CN')).toBe(group.name)
      expect(inspirationGroupLabel(group.name, 'en'), group.id).not.toMatch(HAN)
    }
  })
})
