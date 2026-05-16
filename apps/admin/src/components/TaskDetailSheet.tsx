import { Sheet, SheetContent } from '@/components/ui/sheet'

interface TaskDetailSheetProps {
  taskId: string | undefined
  onOpenChange: (open: boolean) => void
}

// Section 10 落地完整 TaskDetailView + lightbox。
export function TaskDetailSheet({ taskId, onOpenChange }: TaskDetailSheetProps) {
  return (
    <Sheet open={!!taskId} onOpenChange={onOpenChange}>
      <SheetContent className="w-full max-w-3xl sm:max-w-3xl">
        <div className="p-4 text-sm text-muted-foreground">
          task detail: {taskId} (Section 10)
        </div>
      </SheetContent>
    </Sheet>
  )
}
