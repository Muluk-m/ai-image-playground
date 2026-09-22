import { type CSSProperties, useEffect, useState, useSyncExternalStore } from 'react'
import Credits from '../../../components/Credits'
import { useTranslation } from '../../../i18n'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import {
  useAgentJobProgressText,
  useAgentToolProgress,
} from '../../agent/components/AgentJobProgress'
import { AgentRetryWithdraw } from '../../agent/components/AgentToolCard'
import { toolMessageForPlaceholder } from '../../agent/lib/jobProgress'
import {
  agentLiveRetry,
  agentRerunBlock,
  agentRetryAvailable,
  agentRetryOrigin,
  agentRetryPricing,
} from '../../agent/lib/retry'
import {
  agentToolFailureAction,
  agentToolFailureActionLabel,
  agentToolFailureText,
  runAgentToolFailureAction,
} from '../../agent/lib/toolFailure'
import { useAgentStore } from '../../agent/store'
import type { AgentToolMessage } from '../../agent/types'
import { type CanvasEditor, type PlaceholderView, STATUS_ACCENT } from '../lib/editor'
import { editProgressText } from '../lib/editProgressLabel'
import { retryCanvasTask } from '../lib/submitFromCanvas'

function actionStyle(accent: string): CSSProperties {
  return {
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
  }
}

/**
 * 智能体失败占位上的单张重试：按原失败卡起跑时的参数重出这一张，按钮写明预估积分。
 * 积分只在收费形态有计价目录时才写；没有就只写「重试」。
 */
function AgentRetryButton({
  origin,
  placeholderId,
  generationId,
  accent,
}: {
  origin: AgentToolMessage
  placeholderId: string
  generationId?: string
  accent: string
}) {
  const { t } = useTranslation('agent')
  const guard = usePrivateSubmissionGuard(agentRetryPricing(origin))
  const [pending, setPending] = useState(false)
  return (
    <button
      type="button"
      disabled={pending}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={async () => {
        setPending(true)
        try {
          // 一直按住到占位真正换成生成中（云端要等文档拉回来），免得同一个占位再提交一次。
          await useAgentStore.getState().retry(origin.id, placeholderId, generationId)
        } finally {
          setPending(false)
        }
      }}
      style={{
        ...actionStyle(accent),
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        ...(pending ? { opacity: 0.6, cursor: 'default' } : {}),
      }}
    >
      {t('toolFailure.retry')}
      {guard.estimatedCredits !== undefined && (
        <>
          <span aria-hidden="true">·</span>
          <Credits credits={guard.estimatedCredits} />
        </>
      )}
    </button>
  )
}

/**
 * 智能体占的位在转圈时说的那句：与对话里那张结果卡同一份进度（阶段与已用时间）。
 * 找不到对应的卡（切走了会话、旧占位）就照旧只说「生成中」。
 */
function AgentPlaceholderLabel({ placeholder }: { placeholder: PlaceholderView }) {
  const { t } = useTranslation('canvas')
  const message = useAgentStore((state) =>
    toolMessageForPlaceholder(state.messages, {
      ...(placeholder.meta.agentMessageId ? { messageId: placeholder.meta.agentMessageId } : {}),
      ...(placeholder.meta.cloudGeneration ? { taskId: placeholder.meta.cloudGeneration.id } : {}),
    }),
  )
  const text = useAgentJobProgressText(useAgentToolProgress(message))
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {text ?? t('placeholder.generating')}
    </span>
  )
}

/** 每秒走一针，让占位框上的已用时间会动——静止的秒数与卡死一个样。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

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
  // 重试按原失败卡的快照重出，所以只认当前打开的那个会话里的卡。
  const messages = useAgentStore((state) => state.messages)
  const retryRefusals = useAgentStore((state) => state.retryRefusals)
  const { camera } = editor.doc
  const placeholders = editor.getPlaceholders()
  const now = useNow(placeholders.some((one) => one.status === 'loading'))

  if (placeholders.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {placeholders.map((p) => {
        const accent = STATUS_ACCENT[p.status]
        const isLoading = p.status === 'loading'
        // 智能体的失败占位带错误码时只认码（ADR 0006）；旧占位框没有码，照旧显示存下的那句话。
        // 重试被拒后盖在云端失败占位上的那一层（本机不能改写云端文档），只对被拒时那次生成作数。
        const refusal = retryRefusals[p.id]
        const refused =
          refusal && refusal.generationId === p.meta.cloudGeneration?.id ? refusal.code : undefined
        const agentCode = p.meta.agent ? (refused ?? p.meta.agentErrorCode) : undefined
        const note = agentToolFailureText(agentCode) ?? p.message
        // 失败占位留得比会话久（切会话、刷新后还在）：不是当前打开的那个会话就不给这个出路，
        // 否则这句话会落进一个毫不相干的会话。
        const ownConversation =
          Boolean(p.meta.agentConversationId) && p.meta.agentConversationId === openConversationId
        // 上游出错、超时、没出图才有重试；原卡没有快照、是局部或连锁改图、模型已下线时都没有。
        const origin =
          p.meta.agent && ownConversation && p.status === 'error'
            ? agentRetryOrigin(messages, p.meta)
            : null
        // 这个占位上的重试还在重试队列里排着：它保持失败，标着排队中，可以撤回。
        const live = origin ? agentLiveRetry(messages, p.id) : null
        const queuedRetry = live?.status === 'queued' ? live : null
        const retryOrigin = !queuedRetry && agentRetryAvailable(agentCode, origin) ? origin : null
        // 认得出这次生成、却重出不了（局部或连锁改图、模型已下线）：那几个码本该由重试收场，
        // 没有重试就一个出路都没有了，改走「让助手重新处理」，并在那句话里讲清重出不了什么。
        const block = origin ? agentRerunBlock(origin) : null
        const action = agentToolFailureAction(agentCode, block)
        const agentAction = action === 'reprocess' && !ownConversation ? null : action
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
                  {p.meta.agent ? (
                    <AgentPlaceholderLabel placeholder={p} />
                  ) : (
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {editProgressText(p, now)}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span style={{ color: accent, fontWeight: 600 }}>
                    {p.status === 'error' ? t('placeholder.failed') : t('placeholder.stale')}
                  </span>
                  {note && (
                    <span style={{ maxWidth: '100%', wordBreak: 'break-word' }}>{note}</span>
                  )}
                  {queuedRetry && (
                    <>
                      <span style={{ fontWeight: 600 }}>{t('agent:retry.queued')}</span>
                      <AgentRetryWithdraw
                        message={queuedRetry}
                        className="pointer-events-auto rounded-lg border border-border bg-background px-3.5 py-1 text-[13px] font-medium"
                      />
                    </>
                  )}
                  {retryOrigin && (
                    <AgentRetryButton
                      origin={retryOrigin}
                      placeholderId={p.id}
                      {...(p.meta.cloudGeneration
                        ? { generationId: p.meta.cloudGeneration.id }
                        : {})}
                      accent={accent}
                    />
                  )}
                  {agentCode && agentAction && (
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() =>
                        runAgentToolFailureAction(agentAction, {
                          code: agentCode,
                          // 云端项目里服务端预留的占位不带提示词，用通用的任务名指认。
                          title: p.meta.prompt || t('agent:creations.taskTitle'),
                          block,
                          send: (text) => void useAgentStore.getState().send(text),
                        })
                      }
                      style={actionStyle(accent)}
                    >
                      {agentToolFailureActionLabel(agentAction, agentCode)}
                    </button>
                  )}
                  {/* 智能体占的位没有可重发的画布任务：它的出路按错误码给，不在这里原样重发。 */}
                  {!p.meta.agent && (
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => retryCanvasTask(editor, p)}
                      style={actionStyle(accent)}
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
