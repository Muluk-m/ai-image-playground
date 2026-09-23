import DisplaySettingsFields from './DisplaySettingsFields'

interface DisplaySettingsMenuItemsProps {
  /** 两个头像菜单（公开树与私有 overlay）的行样式不同，由宿主菜单给。 */
  itemClassName: string
  iconClassName: string
}

/**
 * 头像菜单里的显示设置：只影响这台设备怎么显示，登录前就生效，不随账号同步。
 * 与设置面板「通用」页是同一个组件，两处永远长得一样。
 */
export default function DisplaySettingsMenuItems({
  itemClassName,
  iconClassName,
}: DisplaySettingsMenuItemsProps) {
  return <DisplaySettingsFields rowClassName={itemClassName} iconClassName={iconClassName} />
}
