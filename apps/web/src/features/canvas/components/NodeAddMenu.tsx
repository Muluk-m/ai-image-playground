import { useEffect, useRef } from 'react'
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
  onUpload,
  onClose,
}: {
  x: number
  y: number
  onText: () => void
  onImage: () => void
  onUpload: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
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
  const left = Math.max(8, Math.min(x, window.innerWidth - 248))
  const top = Math.max(8, Math.min(y, window.innerHeight - 228))
  return createPortal(
    <div
      ref={menu}
      className="studio-node-menu"
      style={{ left, top }}
      role="menu"
      aria-label={t('nodes.addTitle')}
    >
      <p className="studio-node-menu-title text-xs">{t('nodes.addTitle')}</p>
      <MenuItem icon="text" label={t('nodes.addText')} onClick={onText} />
      <MenuItem icon="image" label={t('nodes.addImage')} onClick={onImage} />
      <p className="studio-node-menu-section text-xs">{t('nodes.addResources')}</p>
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
