import { useEffect, useState } from 'react'
import { compactModelName, ModelLogo } from '../../../components/ModelIdentity'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { modelLabel } from '../../../lib/channels/publicChannels'
import { suggestedInspirations } from '../../inspiration/lib/suggestedInspirations'
import { useInspirationStore } from '../../inspiration/store'
import { fillAgentComposer } from '../lib/composerFill'
import './agentSuggestions.css'

export default function AgentSuggestions({ className = '' }: { className?: string }) {
  const { t } = useTranslation('agent')
  const items = useInspirationStore((state) => state.items)
  const loadRemote = useInspirationStore((state) => state.loadRemote)
  const [suggestions, setSuggestions] = useState(() => suggestedInspirations(items))
  useEffect(() => {
    setSuggestions(suggestedInspirations(items))
  }, [items])
  useEffect(() => {
    void loadRemote()
  }, [loadRemote])
  if (!suggestions.length) return null
  return (
    <section
      className={`agent-inspiration-suggestions ${className}`}
      aria-label={t('suggestions.aria')}
    >
      <div className="agent-inspiration-heading">
        <span>{t('suggestions.inspirationTitle')}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setSuggestions(suggestedInspirations(items))}
        >
          <Icon name="refresh" />
          {t('suggestions.shuffle')}
        </Button>
      </div>
      <div className="agent-inspiration-cards">
        {suggestions.map((item) => (
          <article key={item.id} className="agent-inspiration-card">
            <div className="agent-inspiration-cover">
              <img src={item.thumbnailUrl} alt={item.title} loading="lazy" />
              <div className="agent-inspiration-caption">
                <div>
                  <span className="inline-flex items-center gap-1">
                    <ModelLogo model={item.recommendedModel} />
                    {compactModelName(item.recommendedModel, modelLabel(item.recommendedModel))}
                  </span>
                  <h4>{item.title}</h4>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() =>
                    fillAgentComposer({ text: item.prompt, replace: true, clearReferences: true })
                  }
                >
                  {t('suggestions.try')}
                </Button>
              </div>
            </div>
            <p className="agent-inspiration-description">
              {item.description || item.category || item.title}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}
