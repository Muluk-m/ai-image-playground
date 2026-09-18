import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'

/**
 * 公开测试不论 `private/` 在不在，都按公开树的行为跑。
 *
 * 带 overlay 的检出里，`loadPrivateBffOverlay()` 默认会加载真 overlay，它的结算钩子直接查私有计费表；
 * 公开测试库只跑公开迁移，这张表不存在，任何走到任务终态的用例都会失败。需要计费的用例在文件顶部
 * 装 `installRecordingTaskHooks()` 覆盖这里的默认值；要测真实加载的用例给 `loadPrivateBffOverlay`
 * 传显式入口，不受影响。
 */
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
