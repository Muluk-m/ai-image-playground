import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { FeedbackInboxPage } from '@/features/feedback/FeedbackInboxPage'
import { type FeedbackSearch, parseFeedbackSearch } from '@/lib/feedback'

export const Route = createFileRoute('/_authed/feedback')({
  validateSearch: parseFeedbackSearch,
  beforeLoad: ({ context }) => {
    if (!context.adminSession.accounts_login) throw notFound()
  },
  component: FeedbackRoute,
})

function FeedbackRoute() {
  const search = Route.useSearch()
  const navigate = useNavigate()

  function onSearchChange(next: Partial<FeedbackSearch>) {
    void navigate({
      to: '/feedback',
      search: { ...search, ...next },
      replace: true,
    })
  }

  return <FeedbackInboxPage search={search} onSearchChange={onSearchChange} />
}
