import type { ComponentType } from 'react'
import type { PrivateWebOverlay } from '../../lib/privateOverlay'
import {
  getSubmissionGuard,
  onSubmissionAccepted,
  onSubmissionError,
  onSubmissionSettled,
  useSubmissionGuard,
} from './billing-store'
import feishuLogoUrl from './feishu-logo.png'
import { HeaderActions, HeaderCreditAction } from './HeaderActions'
// 副作用导入：overlay 一被加载就把自己的语料注册进 i18next，不依赖各组件的导入顺序。
import './i18n'

// Official Feishu website og:image, https://www.feishu.cn/en:
// https://p1-hera.feishucdn.com/tos-cn-i-jbbdkfciu3/84a9f036fe2b44f99b899fff4beeb963~tplv-jbbdkfciu3-image:100:100.image
const FeishuMark: ComponentType = () => (
  <img src={feishuLogoUrl} alt="" aria-hidden="true" width={20} height={20} />
)
export const privateWebOverlay: PrivateWebOverlay = {
  HeaderCreditAction,
  HeaderAccountActions: HeaderActions,
  replacesAuthActions: true,
  supportsReferrals: true,
  oauthProviderMarks: { feishu: FeishuMark },
  useSubmissionGuard,
  getSubmissionGuard,
  onSubmissionAccepted,
  onSubmissionError,
  onSubmissionSettled,
}

export default privateWebOverlay
