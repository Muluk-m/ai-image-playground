import { BrandAvatar } from '../../lib/privateHost'

/** 没上传过头像时用青芽；上传后的地址由资料店同步到顶栏、菜单和面板。 */
export function AccountAvatar({ src }: { src: string | null }) {
  if (!src) return <BrandAvatar />
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className="h-full w-full rounded-full object-cover"
      draggable={false}
    />
  )
}
