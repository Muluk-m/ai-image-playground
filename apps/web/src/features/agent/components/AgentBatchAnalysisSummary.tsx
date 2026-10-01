import type {
  AgentBatchPage,
  AgentBatchAnalysisSummary as AnalysisSummary,
} from '@image-playground/shared'
import { useTranslation } from '../../../i18n'
import { AgentBatchAnalysisEvidence } from './AgentBatchItemResult'

export default function AgentBatchAnalysisSummary({
  summary,
  items,
  sourceVersion,
}: {
  summary: AnalysisSummary
  items: AgentBatchPage['items']
  sourceVersion?: number
}) {
  const { t } = useTranslation('agent')
  const title =
    sourceVersion === undefined
      ? t('batch.summaryTitle')
      : t('batch.sourceAnalysisTitle', { version: sourceVersion })
  const inputs = items.flatMap((item) => item.inputs)
  const name = (imageId: string) =>
    inputs.find((input) => input.imageId === imageId)?.name ??
    t('batch.inputImage', { index: summary.requiredImageIds.indexOf(imageId) + 1 })
  return (
    <section
      aria-label={title}
      className="grid gap-2 rounded-lg border border-border bg-background p-2 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{title}</span>
        <span>
          {summary.complete ? t('batch.analysisComplete') : t('batch.analysisIncomplete')}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <span>
          {t('batch.summaryCoverage', {
            reviewed: summary.successfulImageIds.length,
            total: summary.requiredImageIds.length,
          })}
        </span>
        <span>
          {summary.inspectionComplete
            ? t('batch.inspectionComplete')
            : t('batch.inspectionIncomplete')}
        </span>
      </div>
      {summary.missingImageIds.map((imageId) => (
        <span key={imageId} className="text-warning">
          {t('batch.analysisMissing', { name: name(imageId) })}
        </span>
      ))}
      {summary.jointComparisons.map((comparison, index) => (
        <div key={comparison.itemKey} className="flex flex-wrap gap-2 rounded-md bg-muted p-2">
          <span>{t('batch.jointComparison', { index: index + 1 })}</span>
          <span>
            {comparison.complete
              ? t('batch.itemStatus.completed')
              : comparison.status === 'completed'
                ? t('batch.analysisIncomplete')
                : comparison.status === 'failed'
                  ? t('batch.comparisonFailed')
                  : t(
                      `batch.itemStatus.${comparison.status === 'in_progress' ? 'in_flight' : comparison.status}`,
                    )}
          </span>
          <span className="text-muted-foreground">
            {comparison.requiredImageIds.map(name).join(' · ')}
          </span>
        </div>
      ))}
      {summary.findings.length > 0 && (
        <details>
          <summary className="cursor-pointer py-1 focus-visible:outline-ring">
            {t('batch.summaryFindings', { count: summary.findings.length })}
          </summary>
          <ul className="max-h-64 space-y-3 overflow-y-auto overscroll-contain pt-2">
            {summary.findings.map((finding) => (
              <li
                key={`${finding.taskId}:${finding.attempt}:${finding.imageId}`}
                className="grid gap-1"
              >
                <div className="flex flex-wrap justify-between gap-2 text-muted-foreground">
                  <span>{name(finding.imageId)}</span>
                  <span>{t('batch.attempt', { number: finding.attempt })}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">{finding.text}</p>
                <AgentBatchAnalysisEvidence evidence={finding.evidence} inputs={inputs} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
