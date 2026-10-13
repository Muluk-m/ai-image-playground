import type { ReactElement } from 'react'
import { Hint } from '../assistant-ui/elements/tooltip-icon-button'
import MediaImage from '../MediaImage'

export function CreationReferencePreview({
  src,
  label,
  children,
}: {
  src: string
  label: string
  children: ReactElement
}) {
  return (
    <Hint
      className="creation-reference-preview"
      tooltip={
        <>
          <MediaImage src={src} alt={label} />
          <span>{label}</span>
        </>
      }
    >
      {children}
    </Hint>
  )
}
