import { TaskDetailView } from '@/components/TaskDetailView'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'

interface TaskDetailSheetProps {
  taskId: string | undefined
  onOpenChange: (open: boolean) => void
}

export function TaskDetailSheet({ taskId, onOpenChange }: TaskDetailSheetProps) {
  return (
    <Sheet open={!!taskId} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>任务详情</SheetTitle>
        </SheetHeader>
        {taskId ? <TaskDetailView taskId={taskId} /> : null}
      </SheetContent>
    </Sheet>
  )
}
