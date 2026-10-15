import { type AccountProfileView, DEFAULT_AVATAR_PATH } from '@image-playground/shared'

export interface ProfileRow {
  id: string
  username: string
  nickname: string | null
  bio: string | null
  avatar_key: string | null
  updated_at: number
}

/** 自定义头像走 API；默认芽标走前端静态路径。`v` 用资料更新时间，换头像后地址会变。 */
export function accountProfileView(user: ProfileRow): AccountProfileView {
  const custom = user.avatar_key !== null
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    bio: user.bio,
    avatar_url: custom
      ? `/api/avatars/${encodeURIComponent(user.id)}?v=${user.updated_at}`
      : DEFAULT_AVATAR_PATH,
    avatar_is_default: !custom,
  }
}
