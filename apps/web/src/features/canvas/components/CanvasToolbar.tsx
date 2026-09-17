import { useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import { duplicateSelection } from '../lib/canvasClipboard'
import type { CanvasDoc, Tool } from '../lib/canvasDoc'

const TOOLS: Array<{ tool: Tool; hotkey: string; icon: React.ReactNode }> = [
  {
    tool: 'select',
    hotkey: 'V',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 3l14 8-6.5 1.5L9 19 5 3z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    tool: 'hand',
    hotkey: 'H',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M8 12V6.5a1.5 1.5 0 013 0V11m0-4.5a1.5 1.5 0 013 0V11m0-3.5a1.5 1.5 0 013 0V13c0 4-2.5 7-6.5 7S6 17 5 14.5l-1.3-3.2a1.4 1.4 0 012.4-1.3L8 12z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    tool: 'pen',
    hotkey: 'D',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 20c.5-3 1-4.5 2.5-6L17 3.5a2.1 2.1 0 013 3L9.5 17c-1.5 1.5-3 2-5.5 3z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    tool: 'eraser',
    hotkey: 'E',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M8.5 19L4 14.5a2 2 0 010-2.8L12.7 3a2 2 0 012.8 0L20 7.5a2 2 0 010 2.8L11.3 19H20M8.5 19H11.3M8.5 19l-2-2M7 9.5l7.5 7.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    tool: 'arrow',
    hotkey: 'A',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 19L18 6m0 0h-7m7 0v7"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    tool: 'text',
    hotkey: 'T',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 6V4h14v2M12 4v16m-3 0h6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
]

function ToolButton({
  active,
  title,
  onClick,
  disabled,
  children,
}: {
  active?: boolean
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent'
      }`}
    >
      {children}
    </button>
  )
}

const PILL =
  'pointer-events-auto rounded-2xl border border-border bg-sidebar p-1.5 shadow-lg backdrop-blur'

/** 工具与缩放共用画布左侧工具栏，窄矮视口内可滚动。 */
export default function CanvasToolbar({ doc }: { doc: CanvasDoc }) {
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const { t } = useTranslation('canvas')
  const { tool, selection, camera, viewport } = doc

  const toolLabels: Record<Tool, string> = {
    select: t('toolbar.tool.select'),
    hand: t('toolbar.tool.hand'),
    pen: t('toolbar.tool.pen'),
    eraser: t('toolbar.tool.eraser'),
    arrow: t('toolbar.tool.arrow'),
    text: t('toolbar.tool.text'),
  }

  const zoomStep = (dir: 1 | -1) => {
    doc.zoomAt(viewport.width / 2, viewport.height / 2, camera.zoom * (dir === 1 ? 1.25 : 0.8))
  }

  const tools = TOOLS.map(({ tool: candidate, hotkey, icon }) => (
    <ToolButton
      key={candidate}
      active={tool === candidate}
      title={t('toolbar.toolTitle', { label: toolLabels[candidate], hotkey })}
      onClick={() => doc.setTool(candidate)}
    >
      {icon}
    </ToolButton>
  ))
  const history = (
    <>
      <ToolButton title={t('toolbar.undo')} disabled={!doc.canUndo} onClick={() => doc.undo()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M8 5L4 9l4 4M4 9h10a6 6 0 016 6v1"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </ToolButton>
      <ToolButton title={t('toolbar.redo')} disabled={!doc.canRedo} onClick={() => doc.redo()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M16 5l4 4-4 4M20 9H10a6 6 0 00-6 6v1"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </ToolButton>
    </>
  )
  const selectionActions = selection.size > 0 && (
    <>
      <ToolButton title={t('toolbar.duplicate')} onClick={() => duplicateSelection(doc)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M16 4H6a2 2 0 00-2 2v10"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      </ToolButton>
      <ToolButton
        title={t('toolbar.deleteSelected')}
        onClick={() => doc.deleteElements([...doc.selection])}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M5 7h14M9 7V5h6v2m-8 0l1 13h8l1-13"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </ToolButton>
    </>
  )
  const zoom = (
    <>
      <ToolButton title={t('toolbar.zoomOut')} onClick={() => zoomStep(-1)}>
        <span className="text-base leading-none">−</span>
      </ToolButton>
      <button
        type="button"
        title={t('toolbar.resetZoom')}
        onClick={() => doc.zoomAt(viewport.width / 2, viewport.height / 2, 1)}
        className={`rounded-xl text-xs text-foreground tabular-nums transition-colors hover:bg-muted h-9 w-9 px-0 text-[10px]`}
      >
        {Math.round(camera.zoom * 100)}%
      </button>
      <ToolButton title={t('toolbar.zoomIn')} onClick={() => zoomStep(1)}>
        <span className="text-base leading-none">＋</span>
      </ToolButton>
    </>
  )

  return (
    // Canvas coordinates are local to the visible workspace, independent of the sidebar.
    <div className="studio-toolbar" data-canvas-toolbar="side">
      <div
        className={`${PILL} studio-tools flex flex-col items-center gap-1`}
        role="group"
        aria-label={t('toolbar.groupAria')}
      >
        {tools}
        <div className="my-1 h-px w-6 shrink-0 bg-border" />
        {history}
        {selectionActions}
        <div className="my-1 h-px w-6 shrink-0 bg-border" />
        {zoom}
      </div>
    </div>
  )
}
