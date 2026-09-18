import { useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import {
  agentToolFailureAction,
  agentToolFailureActionLabel,
  agentToolFailureText,
  runAgentToolFailureAction,
} from '../../agent/lib/toolFailure'
import { useAgentStore } from '../../agent/store'
import { type CanvasEditor, STATUS_ACCENT } from '../lib/editor'
import { retryCanvasTask } from '../lib/submitFromCanvas'

/**
 * 占位框内容浮层：虚线边框由画布上的占位框元素本体绘制（Konva Rect），
 * spinner / 错误文案 / 重试按钮走 DOM 浮层——容器保持指针穿透
 * （悬停时滚轮缩放 / 拖拽平移不被吞掉），仅重试按钮开启指针事件。
 * 位置随相机 scroll / zoom 实时换算，内容用 scale(zoom) 与页面坐标系同步缩放。
 */
export default function PlaceholderOverlay({ editor }: { editor: CanvasEditor }) {
  // 失败占位的文案与出路按错误码取 errors / agent 的译文，切语言时要跟着重渲染。
  const { t } = useTranslation(['canvas', 'common', 'errors', 'agent'])
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  // 「让助手重新处理」替用户往会话里说一句话，只能说回占位所属的那个会话。
  const openConversationId = useAgentStore((state) => state.conversationId)
  const { camera } = editor.doc
  const placeholders = editor.getPlaceholders()

  if (placeholders.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {placeholders.map((p) => {
        const accent = STATUS_ACCENT[p.status]
        const isLoading = p.status === 'loading'
        // 智能体的失败占位带错误码时只认码（ADR 0006）；旧占位框没有码，照旧显示存下的那句话。
        const agentCode = p.meta.agent ? p.meta.agentErrorCode : undefined
        const note = agentToolFailureText(agentCode) ?? p.message
        const action = agentToolFailureAction(agentCode)
        // 失败占位留得比会话久（切会话、刷新后还在）：不是当前打开的那个会话就不给这个出路，
        // 否则这句话会落进一个毫不相干的会话。
        const agentAction =
          action === 'reprocess' &&
          (!p.meta.agentConversationId || p.meta.agentConversationId !== openConversationId)
            ? null
            : action
        return (
          <div
            key={p.id}
            className="absolute"
            style={{
              left: (p.x - camera.x) * camera.zoom,
              top: (p.y - camera.y) * camera.zoom,
              width: p.w,
              height: p.h,
              transform: `scale(${camera.zoom})`,
              transformOrigin: 'top left',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                padding: 16,
                boxSizing: 'border-box',
                color: 'hsl(var(--foreground))',
                textAlign: 'center',
                fontSize: 13,
                lineHeight: 1.4,
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
                  <span>{t('placeholder.generating')}</span>
                </>
              ) : (
                <>
                  <span style={{ color: accent, fontWeight: 600 }}>
                    {p.status === 'error' ? t('placeholder.failed') : t('placeholder.stale')}
                  </span>
                  {note && (
                    <span style={{ maxWidth: '100%', wordBreak: 'break-word' }}>{note}</span>
                  )}
                  {agentCode && agentAction && (
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() =>
                        runAgentToolFailureAction(agentAction, {
                          code: agentCode,
                          title: p.meta.prompt,
                          send: (text) => void useAgentStore.getState().send(text),
                        })
                      }
                      style={{
                        marginTop: 4,
                        padding: '4px 14px',
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'var(--studio-neutral-0)',
                        background: accent,
                        border: 'none',
                        borderRadius: 8,
                        cursor: 'pointer',
                        pointerEvents: 'all',
                      }}
                    >
                      {agentToolFailureActionLabel(agentAction)}
                    </button>
                  )}
                  {/* 智能体占的位没有可重发的画布任务：它的出路按错误码给，不在这里原样重发。 */}
                  {!p.meta.agent && (
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => retryCanvasTask(editor, p)}
                      style={{
                        marginTop: 4,
                        padding: '4px 14px',
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'var(--studio-neutral-0)',
                        background: accent,
                        border: 'none',
                        borderRadius: 8,
                        cursor: 'pointer',
                        pointerEvents: 'all',
                      }}
                    >
                      {t('common:action.retry')}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
