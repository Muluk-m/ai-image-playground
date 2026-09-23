import { useTranslation } from '../../i18n'
import { Checkbox } from '../Checkbox'
import { CloseIcon, CopyIcon } from '../icons'
import Overlay from '../Overlay'

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
  const { t: tCommon } = useTranslation('common')

  return (
    <Overlay onClose={onClose} tier="raised">
      <div className="relative bg-card/90 backdrop-blur-xl border border-white/50 border-border rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-sm w-full p-6 z-10 ring-1 ring-black/5 dark:ring-white/10 animate-confirm-in">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 shrink-0 rounded-full p-1.5 text-muted-foreground transition hover:bg-muted hover:text-muted-foreground hover:bg-accent"
          aria-label={tCommon('action.close')}
        >
          <CloseIcon className="h-5 w-5" />
        </button>

        <h3 className="mb-3 pr-8 flex items-start gap-2.5 text-base font-bold text-foreground leading-snug">
          <CopyIcon className="h-5 w-5 shrink-0 text-primary mt-0.5" />
          <span>{t('profile.copyImportUrlFor', { name: profileName })}</span>
        </h3>
        <div className="text-[13px] text-muted-foreground mb-5 leading-relaxed">
          {t('importUrl.question')}
        </div>

        {!options.includeApiKey && (
          <div className="mb-6 rounded-2xl bg-card/80 p-4 ring-1 ring-black/5 dark:ring-white/5">
            <div className="text-[13px] font-bold text-foreground mb-3.5">
              {t('importUrl.newApiVars')}
            </div>
            <div className="space-y-3">
              <Checkbox
                checked={options.useNewApiAddress}
                onChange={(checked) => onOptionsChange({ useNewApiAddress: checked })}
                label={
                  <>
                    {t('importUrl.use')}{' '}
                    <code className="mx-0.5 rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono text-foreground">
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
                    <code className="mx-0.5 rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono text-foreground">
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
                    <code className="mx-0.5 rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono text-foreground">
                      {'{model}'}
                    </code>
                  </>
                }
              />
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={() => onCopy(false)}
            className="flex-1 py-2 rounded-xl border border-border border-border text-sm text-muted-foreground hover:bg-card hover:bg-accent transition"
          >
            {t('importUrl.exclude')}
          </button>
          <button
            onClick={() => onCopy(true)}
            className="flex-1 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition shadow-sm shadow-blue-500/20"
          >
            {t('importUrl.include')}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
