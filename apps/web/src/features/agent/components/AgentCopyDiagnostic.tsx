import { Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { copyTextToClipboard } from '../../../lib/clipboard'

export default function AgentCopyDiagnostic({ diagnostic }: { diagnostic: object }) {
  const { t } = useTranslation('agent')
  const [result, setResult] = useState<'copied' | 'copyFailed' | null>(null)
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-auto gap-1 px-2 py-1 text-xs"
      onClick={async () => {
        try {
          await copyTextToClipboard(JSON.stringify(diagnostic, null, 2))
          setResult('copied')
        } catch {
          setResult('copyFailed')
        }
      }}
    >
      <Copy className="h-3 w-3" aria-hidden="true" />
      <span aria-live="polite">{t(`error.${result ?? 'copyLog'}`)}</span>
    </Button>
  )
}
