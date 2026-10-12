import { type MouseEvent, useState, useSyncExternalStore } from 'react'
import { Hint } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import ContextMenu, { ContextMenuItem } from '../../../components/patterns/ContextMenu'
import { Button } from '../../../components/ui/button'
import { Icon, type IconName } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { duplicateSelection } from '../lib/canvasClipboard'
import type { CanvasDoc, Tool } from '../lib/canvasDoc'

const TOOLS: Array<{ tool: Tool; hotkey: string; icon: IconName }> = [
  { tool: 'select', hotkey: 'V', icon: 'select' },
  { tool: 'hand', hotkey: 'H', icon: 'pan' },
  { tool: 'pen', hotkey: 'D', icon: 'draw' },
  { tool: 'eraser', hotkey: 'E', icon: 'erase' },
  { tool: 'arrow', hotkey: 'A', icon: 'drawArrow' },
  { tool: 'text', hotkey: 'T', icon: 'text' },
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
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  children: React.ReactNode
}) {
  // 工具栏贴在画布左侧，提示朝右出，不压住按钮本身。
  return (
    <Hint tooltip={title} side="right">
      <Button
        type="button"
        variant={active ? 'default' : 'ghost'}
        size="icon"
        aria-label={title}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </Hint>
  )
}

const PILL =
  'pointer-events-auto rounded-2xl border border-border bg-sidebar p-1.5 shadow-lg backdrop-blur'

/** 工具与缩放共用画布左侧工具栏，窄矮视口内可滚动。 */
export default function CanvasToolbar({
  doc,
  onFitContent,
  onImportImages,
  onImportFolder,
}: {
  doc: CanvasDoc
  onFitContent: () => void
  onImportImages: () => void
  onImportFolder: () => void
}) {
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const { t } = useTranslation('canvas')
  const [importMenu, setImportMenu] = useState<{ x: number; y: number } | null>(null)
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
      <Icon name={icon} />
    </ToolButton>
  ))
  const history = (
    <>
      <ToolButton title={t('toolbar.undo')} disabled={!doc.canUndo} onClick={() => doc.undo()}>
        <Icon name="undo" />
      </ToolButton>
      <ToolButton title={t('toolbar.redo')} disabled={!doc.canRedo} onClick={() => doc.redo()}>
        <Icon name="redo" />
      </ToolButton>
    </>
  )
  const selectionActions = selection.size > 0 && (
    <>
      <ToolButton title={t('toolbar.duplicate')} onClick={() => duplicateSelection(doc)}>
        <Icon name="duplicate" />
      </ToolButton>
      <ToolButton title={t('toolbar.deleteSelected')} onClick={() => doc.deleteSelection()}>
        <Icon name="delete" />
      </ToolButton>
    </>
  )
  const zoom = (
    <>
      <div className="hidden md:block">
        <ToolButton
          title={t('toolbar.fitContent')}
          onClick={onFitContent}
          disabled={!doc.elements.length}
        >
          <Icon name="fit" />
        </ToolButton>
      </div>
      <ToolButton title={t('toolbar.zoomOut')} onClick={() => zoomStep(-1)}>
        <Icon name="zoomOut" />
      </ToolButton>
      <Hint tooltip={t('toolbar.resetZoom')} side="right">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('toolbar.resetZoom')}
          onClick={() => doc.zoomAt(viewport.width / 2, viewport.height / 2, 1)}
          className="px-0 text-label-sm tabular-nums"
        >
          {camera.zoom < 0.01 ? '<1%' : `${Math.round(camera.zoom * 100)}%`}
        </Button>
      </Hint>
      <ToolButton title={t('toolbar.zoomIn')} onClick={() => zoomStep(1)}>
        <Icon name="zoomIn" />
      </ToolButton>
    </>
  )

  return (
    // Canvas coordinates are local to the visible workspace, independent of the sidebar.
    <div className="studio-toolbar" data-canvas-toolbar="side">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="pointer-events-auto absolute left-[58px] top-0 z-10 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-sidebar px-3 py-2 text-xs font-medium text-foreground shadow-lg disabled:opacity-50 md:hidden"
        disabled={!doc.elements.length}
        onClick={onFitContent}
      >
        <Icon name="fit" />
        {t('toolbar.fitContent')}
      </Button>
      <div
        className={`${PILL} studio-tools flex flex-col items-center gap-1`}
        role="group"
        aria-label={t('toolbar.groupAria')}
      >
        {tools}
        <div className="my-1 h-px w-6 shrink-0 bg-border" />
        <ToolButton
          title={t('import.openMenu')}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect()
            setImportMenu({ x: bounds.right + 6, y: bounds.top })
          }}
        >
          <Icon name="attach" />
        </ToolButton>
        <div className="my-1 h-px w-6 shrink-0 bg-border" />
        {history}
        {selectionActions}
        <div className="my-1 h-px w-6 shrink-0 bg-border" />
        {zoom}
      </div>
      {importMenu && (
        <ContextMenu x={importMenu.x} y={importMenu.y} onClose={() => setImportMenu(null)}>
          <ContextMenuItem
            icon={<Icon name="images" />}
            label={t('import.images')}
            onClick={() => {
              setImportMenu(null)
              onImportImages()
            }}
          />
          <ContextMenuItem
            icon={<Icon name="folder" />}
            label={t('import.folder')}
            onClick={() => {
              setImportMenu(null)
              onImportFolder()
            }}
          />
        </ContextMenu>
      )}
    </div>
  )
}
