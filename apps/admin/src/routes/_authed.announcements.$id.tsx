import { createFileRoute } from '@tanstack/react-router'
import { AnnouncementEditor } from '@/features/announcements/AnnouncementEditor'

export const Route = createFileRoute('/_authed/announcements/$id')({
  component: AnnouncementEditorRoute,
})

function AnnouncementEditorRoute() {
  const { id } = Route.useParams()
  return <AnnouncementEditor id={id} />
}
