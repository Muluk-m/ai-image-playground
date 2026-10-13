import { Suggestions } from '../../../components/assistant-ui/elements/suggestions'
import { useTranslation } from '../../../i18n'
import { fillAgentComposer } from '../lib/composerFill'

/** 输入框上方的下一句。点一下只填进输入框，发不发由用户决定。 */
export default function AgentFollowUps({ lines }: { lines: readonly string[] }) {
  const { t } = useTranslation('agent')
  if (lines.length === 0) return null
  return (
    <Suggestions
      aria-label={t('suggestions.followUpsAria')}
      suggestions={lines}
      selectedSuggestion={null}
      className="mb-2 w-full max-w-full"
      onSuggestion={(line) => {
        fillAgentComposer({ text: line })
      }}
    />
  )
}
