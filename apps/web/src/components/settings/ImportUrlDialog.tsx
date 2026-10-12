import { useTranslation } from '../../i18n'
import { Checkbox } from '../patterns/Checkbox'
import Dialog from '../patterns/Dialog'
import { Button } from '../ui/button'

const COPY_IMPORT_URL_OPTIONS_STORAGE_KEY = 'image-playground.copy-import-url-options'

export const DEFAULT_COPY_IMPORT_URL_OPTIONS = {
  includeApiKey: false,
  useNewApiAddress: false,
  useNewApiKey: true,
  useNewApiModel: false,
}

export type CopyImportUrlOptions = typeof DEFAULT_COPY_IMPORT_URL_OPTIONS

export function readCopyImportUrlOptions(): CopyImportUrlOptions {
  if (typeof window === 'undefined') return DEFAULT_COPY_IMPORT_URL_OPTIONS

  try {
    const saved = window.localStorage.getItem(COPY_IMPORT_URL_OPTIONS_STORAGE_KEY)
    if (!saved) return DEFAULT_COPY_IMPORT_URL_OPTIONS

    const parsed = JSON.parse(saved) as Partial<CopyImportUrlOptions> | null
    if (!parsed || typeof parsed !== 'object') return DEFAULT_COPY_IMPORT_URL_OPTIONS

    return {
      includeApiKey: false,
      useNewApiAddress: Boolean(parsed.useNewApiAddress),
      useNewApiKey: parsed.useNewApiKey === undefined ? true : Boolean(parsed.useNewApiKey),
      useNewApiModel: Boolean(parsed.useNewApiModel),
    }
  } catch {
    return DEFAULT_COPY_IMPORT_URL_OPTIONS
  }
}

export function saveCopyImportUrlOptions(options: CopyImportUrlOptions) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(
      COPY_IMPORT_URL_OPTIONS_STORAGE_KEY,
      JSON.stringify({
        useNewApiAddress: options.useNewApiAddress,
        useNewApiKey: options.useNewApiKey,
        useNewApiModel: options.useNewApiModel,
      }),
    )
  } catch {
    // localStorage 不可用时只保留当前会话状态。
  }
}

interface ImportUrlDialogProps {
  profileName: string
  options: CopyImportUrlOptions
  onOptionsChange: (patch: Partial<CopyImportUrlOptions>) => void
  onCopy: (includeApiKey: boolean) => void
  onClose: () => void
}

/** 复制导入 URL 前的选项框：只决定 URL 里带什么，复制动作由调用方执行。 */
export default function ImportUrlDialog({
  profileName,
  options,
  onOptionsChange,
  onCopy,
  onClose,
}: ImportUrlDialogProps) {
  const { t } = useTranslation('settings')

  return (
    <Dialog
      title={t('profile.copyImportUrlFor', { name: profileName })}
      onClose={onClose}
      tier="raised"
      className="max-w-sm"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => onCopy(false)}
          >
            {t('importUrl.exclude')}
          </Button>
          <Button type="button" size="sm" className="flex-1" onClick={() => onCopy(true)}>
            {t('importUrl.include')}
          </Button>
        </>
      }
    >
      <div className="text-body-sm text-muted-foreground leading-relaxed">
        {t('importUrl.question')}
      </div>

      {!options.includeApiKey && (
        <div className="mt-5 rounded-2xl bg-muted/40 p-4 ring-1 ring-hairline">
          <div className="mb-3.5 text-body-sm font-semibold text-foreground">
            {t('importUrl.newApiVars')}
          </div>
          <div className="space-y-3">
            <Checkbox
              checked={options.useNewApiAddress}
              onChange={(checked) => onOptionsChange({ useNewApiAddress: checked })}
              label={
                <>
                  {t('importUrl.use')}{' '}
                  <code className="mx-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                    {'{address}'}
                  </code>{' '}
                  {t('importUrl.addressSuffix')}
                </>
              }
            />
            <Checkbox
              checked={options.useNewApiKey}
              onChange={(checked) => onOptionsChange({ useNewApiKey: checked })}
              label={
                <>
                  {t('importUrl.use')}{' '}
                  <code className="mx-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                    {'{key}'}
                  </code>
                </>
              }
            />
            <Checkbox
              checked={options.useNewApiModel}
              onChange={(checked) => onOptionsChange({ useNewApiModel: checked })}
              label={
                <>
                  {t('importUrl.use')}{' '}
                  <code className="mx-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                    {'{model}'}
                  </code>
                </>
              }
            />
          </div>
        </div>
      )}
    </Dialog>
  )
}
