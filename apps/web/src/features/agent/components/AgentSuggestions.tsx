import { useTranslation } from '../../../i18n'
import { fillAgentComposer } from '../lib/composerFill'

const SUGGESTIONS = [
  { title: 'suggestions.productTitle', prompt: 'suggestions.productPrompt' },
  { title: 'suggestions.posterTitle', prompt: 'suggestions.posterPrompt' },
  { title: 'suggestions.characterTitle', prompt: 'suggestions.characterPrompt' },
] as const

/**
 * 空对话与项目欢迎页的起手示例：点一下把整句话填进输入框并聚焦，不直接发送。
 * 对话一开始，两处空状态都会让位，建议随之消失。
 */
export default function AgentSuggestions({ className = '' }: { className?: string }) {
  const { t } = useTranslation('agent')
  return (
    <ul aria-label={t('suggestions.aria')} className={`grid gap-2 ${className}`}>
      {SUGGESTIONS.map((suggestion) => {
        const prompt = t(suggestion.prompt)
        return (
          <li key={suggestion.title}>
            <button
              type="button"
              data-prompt={prompt}
              onClick={() => fillAgentComposer(prompt)}
              className="flex w-full flex-col gap-0.5 rounded-xl border border-border bg-background/60 px-3 py-2 text-left transition-colors hover:border-ring/60 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="text-xs font-medium text-foreground">{t(suggestion.title)}</span>
              <span className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                {prompt}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
