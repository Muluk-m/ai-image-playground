import { Suggestions } from '../../../components/assistant-ui/elements/suggestions'
import { useTranslation } from '../../../i18n'
import { fillAgentComposer } from '../lib/composerFill'

const SUGGESTIONS = [
  { title: 'suggestions.productTitle', prompt: 'suggestions.productPrompt', icon: 'shopping-bag' },
  { title: 'suggestions.posterTitle', prompt: 'suggestions.posterPrompt', icon: 'layout-template' },
  {
    title: 'suggestions.characterTitle',
    prompt: 'suggestions.characterPrompt',
    icon: 'person-standing',
  },
] as const

/**
 * 空对话与项目欢迎页的起手示例：点一下把整句话填进输入框并聚焦，不直接发送。
 * 对话一开始，两处空状态都会让位，建议随之消失。
 */
export default function AgentSuggestions({ className = '' }: { className?: string }) {
  const { t } = useTranslation('agent')
  return (
    <Suggestions
      aria-label={t('suggestions.aria')}
      className={className}
      variant="list"
      suggestions={SUGGESTIONS.map((suggestion) => t(suggestion.title))}
      descriptions={Object.fromEntries(
        SUGGESTIONS.map((suggestion) => [t(suggestion.title), t(suggestion.prompt)]),
      )}
      selectedSuggestion={null}
      onSuggestion={(title) => {
        const selected = SUGGESTIONS.find((suggestion) => t(suggestion.title) === title)
        if (selected) fillAgentComposer(t(selected.prompt))
      }}
    />
  )
}
