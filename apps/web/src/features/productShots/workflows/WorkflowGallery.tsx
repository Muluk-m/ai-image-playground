import { CARD, OUTLINE_BUTTON } from '../../../components/panelStyles'
import { useStore } from '../../../store'
import { useProductShotsStore } from '../store'
import { downloadKit } from './render'
import { KitResult } from './WorkflowWorkspace'

export default function WorkflowGallery() {
  const draft = useProductShotsStore((s) => s.draft)
  const tasks = useStore((s) => s.tasks)
  const groups = draft.images.flatMap((image) => {
    const kits = image.versions.filter((v) => v.workflow?.spec.kind === 'kit')
    return [...new Set(kits.map((v) => v.workflow?.groupId))].map((groupId) => ({
      imageId: image.imageId,
      groupId,
      versions: kits.filter((v) => v.workflow?.groupId === groupId),
    }))
  })
  const jobId = draft.id
  if (!groups.length || !jobId) return null
  return (
    <section className={`${CARD} mt-4`}>
      <h2 className="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-100">成套图片</h2>
      {groups.map((group, index) => (
        <div key={group.groupId} className="mb-4 last:mb-0">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs text-gray-500">第 {index + 1} 套</h3>
            <button
              type="button"
              className={OUTLINE_BUTTON}
              onClick={() =>
                void downloadKit(
                  `${draft.name}-${index + 1}`,
                  group.versions.flatMap((version) => {
                    const task = tasks.find((t) => t.id === version.taskId)
                    return task?.status === 'done' && task.outputImages[0]
                      ? [{ version, imageId: task.outputImages[0] }]
                      : []
                  }),
                ).catch((e) => useStore.getState().showToast(String(e), 'error'))
              }
            >
              按各自尺寸打包下载
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.versions.map((version) => (
              <KitResult
                key={version.id}
                version={version}
                session={{ kind: 'kit', jobId, imageId: group.imageId }}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
