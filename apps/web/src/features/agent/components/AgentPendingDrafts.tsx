import { useState } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { CARD_NOTE } from '../agentStyles'
import { agentToolFailureText } from '../lib/toolFailure'
import { useAgentStore } from '../store'

/**
 * 一批草稿卡堆在面板里时的「全部确认」。
 *
 * 一张草稿卡上的确认键只管自己那一张（`AgentPromptDraft`），模型一轮拟出好几张时逐张点
 * 很累。这条横幅只在有两张以上待确认时出现——只有一张时它和卡上的键说同一件事，白占一行。
 *
 * 逐张走的还是同一个确认接口：提示词、幂等、计费全部不变，唯一省掉的是重复点击。
 */
export default function AgentPendingDrafts() {
  const { t } = useTranslation('agent')
  const pending = useAgentStore(
    (state) =>
      state.messages.filter((one) => one.kind === 'tool' && one.status === 'awaiting_confirmation')
        .length,
  )
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  if (pending < 2) return null

  const confirmAll = () => {
    if (submitting) return
    setSubmitting(true)
    setFailure(null)
    void useAgentStore
      .getState()
      .confirmAllPrompts()
      .then((result) => {
        // 停在半路：说清楚成交了几张，再给那一个出路对应的说法。
        if (result.failure && !result.failure.ok) {
          setFailure(
            (result.failure.reason === 'refused'
              ? agentToolFailureText(result.failure.code)
              : null) ?? t('confirm.allFailed', { count: result.confirmed }),
          )
        }
        setSubmitting(false)
      })
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
      <span className={CARD_NOTE}>{t('confirm.allPending', { count: pending })}</span>
      <Button type="button" size="sm" disabled={submitting} onClick={confirmAll}>
        {submitting ? t('confirm.allSubmitting') : t('confirm.allSubmit', { count: pending })}
      </Button>
      {failure && (
        <p role="alert" className={`w-full ${CARD_NOTE}`}>
          {failure}
        </p>
      )}
    </div>
  )
}
