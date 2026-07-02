import { BaseBoxShapeUtil, HTMLContainer, type RecordProps, T, type TLShape } from 'tldraw'
import type { CanvasProfileSnapshot } from '../../../store'
import type { TaskParams } from '../../../types'
import { retryCanvasTask } from '../lib/submitFromCanvas'

/** 占位框的可视状态：运行中 / 失败 / 失效（不可恢复）。 */
export type CanvasTaskStatus = 'loading' | 'error' | 'stale'

export interface GenerationPlaceholderProps {
  w: number
  h: number
  status: CanvasTaskStatus
  /** 错误 / 失效态的说明文案；loading 态为空。 */
  message: string
}

// 把自定义 shape 注册进 tldraw 的全局 shape 联合（tldraw 5.1.1 官方方式）：
// 增强 TLGlobalShapePropsMap 后，TLShape 联合、editor.getShape/createShape/updateShape
// 泛型、以及 BaseBoxShapeUtil 约束都能识别本 shape，无需类型 cast。
declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    'generation-placeholder': GenerationPlaceholderProps
  }
}

export type GenerationPlaceholderShape = TLShape<'generation-placeholder'>

/**
 * 占位框 shape 的 meta：任务恢复所需的元数据（决策 2）。
 * 随 tldraw 持久化，是任务状态的**单一持久真相源**——恢复时扫描运行态占位框的 meta 即可，
 * 不另设独立任务表。只存轻量 id / 标识，**绝不**把输入图塞进来（决策 2 / 决策 6）。
 */
export interface CanvasTaskMeta {
  taskId: string
  clientRequestId: string
  /** BFF submit 成功后经 onQueueSubmitted 回填；有它才能 resume 续 poll。 */
  bffRequestId?: string
  /** 发起时的 profile 来源，决定重开后能否恢复（仅 builtin-edge 可恢复）。 */
  source: 'builtin-edge' | 'user-byok'
  /** 原始提示词，供失效 / 错误态「重试」与落历史复用。 */
  prompt: string
  /** 发起时的参数快照（已折叠 n=1），供重试 / 恢复 / 落历史保真复用。 */
  params?: TaskParams
  /** 发起时的 profile 身份快照，恢复完成落历史保真（缺失兜底当前 active profile）。 */
  profileView?: CanvasProfileSnapshot
}

/**
 * 生成占位框自定义 shape（决策 1）：发起生成时立即在目标位置放置，
 * loading → 成功被结果图替换（删除）/ 失败转 error / 不可恢复转 stale。
 * 做成真实 shape 而非 DOM 浮层，由 tldraw 天然处理坐标、缩放、层级与持久化。
 */
export class GenerationPlaceholderShapeUtil extends BaseBoxShapeUtil<GenerationPlaceholderShape> {
  static override type = 'generation-placeholder' as const
  static override props: RecordProps<GenerationPlaceholderShape> = {
    w: T.number,
    h: T.number,
    status: T.literalEnum('loading', 'error', 'stale'),
    message: T.string,
  }

  override getDefaultProps(): GenerationPlaceholderShape['props'] {
    return { w: 360, h: 360, status: 'loading', message: '' }
  }

  override canResize() {
    return false
  }

  override canEdit() {
    return false
  }

  override hideRotateHandle() {
    return true
  }

  override component(shape: GenerationPlaceholderShape) {
    const { w, h, status, message } = shape.props
    const isLoading = status === 'loading'
    const accent = status === 'error' ? '#ef4444' : status === 'stale' ? '#f59e0b' : '#3b82f6'

    return (
      <HTMLContainer
        style={{
          width: w,
          height: h,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 16,
          boxSizing: 'border-box',
          border: `2px dashed ${accent}`,
          borderRadius: 12,
          background: 'rgba(148, 163, 184, 0.12)',
          color: '#cbd5e1',
          textAlign: 'center',
          fontSize: 13,
          lineHeight: 1.4,
          // 容器保持指针穿透：否则悬停在占位框上时滚轮缩放 / 拖拽平移会被 HTML 层吞掉，
          // 画布操作失灵。仅「重试」按钮单独开启指针事件。
          pointerEvents: 'none',
        }}
      >
        {isLoading ? (
          <>
            <div
              style={{
                width: 28,
                height: 28,
                border: `3px solid ${accent}`,
                borderTopColor: 'transparent',
                borderRadius: '50%',
                animation: 'canvas-placeholder-spin 0.8s linear infinite',
              }}
            />
            <span>生成中…</span>
          </>
        ) : (
          <>
            <span style={{ color: accent, fontWeight: 600 }}>
              {status === 'error' ? '生成失败' : '任务失效'}
            </span>
            {message && (
              <span style={{ maxWidth: '100%', wordBreak: 'break-word' }}>{message}</span>
            )}
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => retryCanvasTask(this.editor, shape)}
              style={{
                marginTop: 4,
                padding: '4px 14px',
                fontSize: 13,
                fontWeight: 500,
                color: '#fff',
                background: accent,
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                pointerEvents: 'all',
              }}
            >
              重试
            </button>
          </>
        )}
      </HTMLContainer>
    )
  }

  override getIndicatorPath(shape: GenerationPlaceholderShape) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }
}
