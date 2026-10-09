import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet'
import { useTranslation } from '../../i18n'
import ExportForm from './ExportForm'
import { useImageExportStore } from './store'

export default function ImageExportDialog() {
  const { t } = useTranslation(['toolbox', 'common'])
  const request = useImageExportStore((state) => state.request)
  const close = useImageExportStore((state) => state.close)
  return (
    <Sheet
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <SheetContent
        data-shadcn-modal
        overlayClassName="z-[1299] bg-black/40 backdrop-blur-sm"
        closeLabel={t('common:action.close')}
        className="z-[1300] flex w-full flex-col gap-0 p-0 sm:max-w-[400px]"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <SheetHeader className="border-b border-border px-5 py-4 text-left">
          <SheetTitle className="text-base">{t('export.title')}</SheetTitle>
          <SheetDescription className="sr-only">{t('export.description')}</SheetDescription>
        </SheetHeader>
        {request && (
          <ExportForm
            key={request.sources.map((one) => one.id).join(',')}
            sources={request.sources}
            name={request.name}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}
