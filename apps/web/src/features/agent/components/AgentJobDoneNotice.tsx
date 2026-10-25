import { useEffect } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { projectEntryName } from '../../canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../canvas/projectStore'
import {
  dismissAgentJobNotice,
  markAgentConversationSeen,
  useAgentJobActivity,
} from '../lib/jobActivity'
import { useAgentStore } from '../store'

/** 完成提示停留多久；用户没理它就自己收起，侧栏那个点还留着。 */
const NOTICE_MS = 12_000

/**
 * 对话外出完图时的全局提示（BUG-16）：右下角一张卡，「XX」N 张图 / N 个视频已生成 · 查看。
 * 查看直接回到那段对话。
 */
export default function AgentJobDoneNotice() {
  const { t } = useTranslation('agent')
  const notice = useAgentJobActivity((state) => state.notice)
  const project = useCanvasProjectStore((state) =>
    notice ? state.projects.find((one) => one.conversationId === notice.conversationId) : undefined,
  )
  const title = useAgentStore((state) =>
    notice ? state.conversations.find((one) => one.id === notice.conversationId)?.title : undefined,
  )

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(dismissAgentJobNotice, NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const name = project ? projectEntryName(project) : title?.trim() || t('job.done.untitled')
  // 出的是视频就说「个视频」，图和视频都有就都说，别把视频算成「张图」。
  const ready = notice
    ? notice.videos && notice.images
      ? t('job.done.mixed', {
          images: t('job.done.images', { count: notice.images }),
          videos: t('job.done.videos', { count: notice.videos }),
        })
      : notice.videos
        ? t('job.done.videos', { count: notice.videos })
        : t('job.done.images', { count: notice.images })
    : ''
  const body = notice
    ? !notice.images && !notice.videos
      ? // 一张都没出来：只说没完成几项，别说成「0 张图已生成」。
        t('job.done.bodyAllFailed', { name, count: notice.failed })
      : notice.failed
        ? t('job.done.bodyFailed', { name, ready, count: notice.failed })
        : t('job.done.body', { name, ready })
    : ''

  const view = async () => {
    if (!notice) return
    const { conversationId } = notice
    useStore.getState().setAppMode('canvas')
    try {
      await useAgentStore.getState().selectConversation(conversationId)
    } catch {
      // 加载出错：提示留着，用户可以再点一次。
      return
    }
    // 切换可能被拦下（别的对话这一轮还在跑、保存失败）：没切过去就把提示留着，用户还能再点。
    if (useAgentStore.getState().conversationId === conversationId)
      markAgentConversationSeen(conversationId)
  }

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[1390] flex max-w-[min(360px,calc(100vw-2rem))]">
      {/* live region 常驻，只换里面的内容，读屏才会播报。 */}
      <div role="status" aria-live="polite" className="w-full">
        {notice ? (
          <div
            data-agent-job-notice=""
            className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
              <Icon name={notice.images || notice.videos ? 'success' : 'error'} size="xs" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-body-sm font-medium">{t('job.done.title')}</p>
              <p className="mt-0.5 break-words text-body-sm text-muted-foreground">{body}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button type="button" size="sm" onClick={() => void view()}>
                {t('job.done.view')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('job.done.dismiss')}
                onClick={dismissAgentJobNotice}
              >
                <Icon name="close" size="xs" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
