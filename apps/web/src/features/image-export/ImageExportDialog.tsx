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
  const { t } = useTranslation('toolbox')
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
        className="z-[1300] flex w-full flex-col gap-0 p-0 sm:max-w-[440px]"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <SheetHeader className="border-b border-border px-6 py-5 text-left">
          <SheetTitle>{t('export.title')}</SheetTitle>
          <SheetDescription>{t('export.description')}</SheetDescription>
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
