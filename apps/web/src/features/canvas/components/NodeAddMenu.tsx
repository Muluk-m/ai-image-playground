import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../../../components/ui/button'
import { Icon, type IconName } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'

/** 双击画布空白处弹出的添加菜单。只列现在放得进去的类型。 */
export default function NodeAddMenu({
  x,
  y,
  onText,
  onImage,
  onVideo,
  actions,
  onUpload,
  onAssets,
  onClose,
}: {
  x: number
  y: number
  onText: () => void
  onImage: () => void
  onVideo?: () => void
  actions?: { icon: IconName; label: string; onClick: () => void }[]
  onUpload: () => void
  onAssets?: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const rect = menu.current?.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - (rect?.width ?? 248) - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - (rect?.height ?? 280) - 8)),
    })
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [x, y])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus()
      }
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null
      if (target && menu.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [onClose])
  return createPortal(
    <div
      ref={menu}
      className="studio-node-menu"
      style={position}
      role="menu"
      aria-label={t('nodes.addTitle')}
    >
      {actions?.map((action) => (
        <MenuItem key={action.label} {...action} />
      ))}
      <p className="studio-node-menu-title text-xs">{t('nodes.addTitle')}</p>
      <MenuItem icon="text" label={t('nodes.addText')} onClick={onText} />
      <MenuItem icon="image" label={t('nodes.addImage')} onClick={onImage} />
      {onVideo && <MenuItem icon="video" label={t('nodes.addVideo')} onClick={onVideo} />}
      <p className="studio-node-menu-section text-xs">{t('nodes.addResources')}</p>
      {onAssets && <MenuItem icon="folder" label={t('nodes.assets')} onClick={onAssets} />}
      <MenuItem icon="upload" label={t('nodes.addUpload')} onClick={onUpload} />
    </div>,
    document.body,
  )
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: IconName
  label: string
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="studio-node-menu-item h-auto w-full justify-start font-normal"
      role="menuitem"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      <span className="studio-node-menu-icon">
        <Icon name={icon} />
      </span>
      {label}
    </Button>
  )
}
