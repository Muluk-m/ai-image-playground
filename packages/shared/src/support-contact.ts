/**
 * 运营方对外的联系渠道。落地页「联系我们」、使用指南和法律文本都从这里取，不要另抄一份。
 * 改渠道只改这里。
 */
export const SUPPORT_CONTACT = {
  email: 'maqiqian0316@gmail.com',
  xHandle: 'Muluk656',
  /** 运营主体名称。运营方给出前保持 null，页面上不出现主体这一行。 */
  operatorEntity: null as string | null,
} as const

export const SUPPORT_X_URL = `https://x.com/${SUPPORT_CONTACT.xHandle}`
export const SUPPORT_MAILTO = `mailto:${SUPPORT_CONTACT.email}`
