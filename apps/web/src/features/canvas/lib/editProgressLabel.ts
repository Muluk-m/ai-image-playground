import { i18next } from '../../../i18n'
import type { PlaceholderView } from './editor'

/**
 * 转圈时说哪一句。占位框浮层与其它进度表达共用同一张表——两处分别写就会出现
 * 「这里说擦除中、那里说生成中」这种同一件事两种说法。
 */
function actionKey(
  placeholder: PlaceholderView,
):
  | 'placeholder.generating'
  | 'inpaint.running'
  | 'erase.running'
  | 'outpaint.running'
  | 'cutout.running'
  | 'imageEdit.running' {
  if (!placeholder.meta.editSourceId) return 'placeholder.generating'
  switch (placeholder.meta.editKind) {
    case 'erase':
      return 'erase.running'
    case 'outpaint':
      return 'outpaint.running'
    case 'cutout':
      return 'cutout.running'
    case 'edit':
      return 'imageEdit.running'
    default:
      return 'inpaint.running'
  }
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * 「局部重绘中… · 排队中 1:23」。
 *
 * 只写动作名的话，一条跑几分钟的任务在界面上与卡死没有区别——用户唯一能做的判断是
 * 「等」还是「重来」，而那需要阶段和已用时间。阶段来自 BFF 的队列状态（meta.queuePhase），
 * 起点是占位框自己的 createdAt，两者都随画布持久化，刷新后接着说。
 */
export function editProgressText(placeholder: PlaceholderView, now: number): string {
  const action = i18next.t(actionKey(placeholder), { ns: 'canvas' })
  const phase = placeholder.meta.queuePhase
  const since = placeholder.meta.createdAt
  const elapsed = since ? clock(Math.max(0, now - since)) : ''
  const detail = [phase ? i18next.t(`job.phase.${phase}`, { ns: 'agent' }) : '', elapsed]
    .filter(Boolean)
    .join(' ')
  return detail ? `${action} · ${detail}` : action
}
