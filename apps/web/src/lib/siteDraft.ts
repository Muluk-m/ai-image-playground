/**
 * 官网首页输入框的草稿交接。官网和工作台同源，官网把写好的提示词存进 sessionStorage，
 * 登录后进入工作台时取出一次填进输入框；只填不发，也不覆盖输入框里已有的内容。
 */
const KEY = 'muvloom.siteDraft'
const MAX_LENGTH = 4000

export function saveSiteDraft(prompt: string): void {
  try {
    const value = prompt.trim().slice(0, MAX_LENGTH)
    if (value) sessionStorage.setItem(KEY, value)
    else sessionStorage.removeItem(KEY)
  } catch {
    // 隐私模式等场景下存储不可用，草稿丢了也不影响登录。
  }
}

export function takeSiteDraft(): string | null {
  try {
    const value = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return value?.trim() ? value.trim() : null
  } catch {
    return null
  }
}
