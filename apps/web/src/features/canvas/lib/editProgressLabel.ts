import type { PlaceholderView } from './editor'

/**
 * 转圈时说哪一句。占位框浮层与源图卡片上那层共用同一张表——两处分别写就会出现
 * 「卡片上说擦除中、占位框说生成中」这种同一件事两种说法。
 */
export function editProgressKey(
  placeholder: PlaceholderView,
): 'placeholder.generating' | 'inpaint.running' | 'erase.running' | 'outpaint.running' {
  if (!placeholder.meta.editSourceId) return 'placeholder.generating'
  switch (placeholder.meta.editKind) {
    case 'erase':
      return 'erase.running'
    case 'outpaint':
      return 'outpaint.running'
    default:
      return 'inpaint.running'
  }
}
