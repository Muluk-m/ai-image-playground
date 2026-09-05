# CONTEXT.md

项目领域与架构词汇表。架构讨论使用的术语（module / interface / depth / seam / adapter / leverage / locality）定义见 `/codebase-design` skill。

## Overlay（浮层）

所有模态浮层共享的深化模块（`apps/web/src/components/Overlay.tsx`）。接口 = 包装组件 `<Overlay onClose tier>{children}</Overlay>`，实现拥有五条纪律：

- **portal 到 `document.body`** — 浮层永远不受祖先 `transform` / `filter` / `backdrop-filter` 包含块影响（2026-08-04 SizePickerModal 事故的根因）
- **scroll-lock** — 组合 `usePreventBackgroundScroll`，内容 ref 自动作为滚动边界
- **ESC 栈** — 组合 `useCloseOnEscape`，一次只关最顶层
- **backdrop 关闭** — 内置 pointerdown-guard（pointerdown 与 click 都必须命中表面本身，才关闭，防划词误关）；暗化层 `pointer-events-none`，否则它盖在表面之上、命中的永远是它，点击永不关闭。需要自定义表面交互（如 Lightbox 的缩放感知点击）的调用方用 `backdrop="none"`，在自己的内容根上挂 handler
- **z 层三档** — `modal`（z-50 基底模态）/ `raised`（z-100 嵌套子弹窗、需压过其它模态的）/ `alert`（z-110 最顶层：ConfirmDialog，以及需要压过 raised 的嵌套浮层）

纪律：模态类浮层一律经 Overlay 渲染内容，不得自己写 `fixed inset-0` + portal。定位型浮层（Tooltip、Select 下拉、拖拽预览）不属于 Overlay，另是一类。

## 槽位（slot）

提示词里 `{名称}` 形状的占位符（名称不含空白与花括号），在输入框里渲染成可点开的 chip。
一个槽位可以填多个值，提交时按各槽位值的笛卡尔积展开成多条已替换的提示词，每条再走现有的
数量分发规则。槽位值是 composer 状态，随「重启保留输入」持久化，不进任务记录。
_Avoid_: 变量、占位符、模板参数

## 引用（mention）

提示词里指向某张参考图的胶囊。**只有一种引用原语**：存的永远是按参考图序号的哨兵标记，
发送时转成 `[image N]`，重排走 remap、被删掉的降级为「@已移除图片」。选中素材不是第二种语法——
先把素材图按 `imageId` 去重地附加为参考图（已在条里则复用原序号），再插入同一个按序号的引用。
胶囊的显示标签由该图片是否属于某个素材决定（多名同图取最近使用）；**可见文本的长度就是
contentEditable 的光标坐标系**，标签与可见文本不一致光标会整体错位。
_Avoid_: @提及、图片变量、素材引用

## 部署与能力（deployment & capability）

一套代码支撑多种部署，差异用能力表达，不用版本枚举表达。

**能力（capability）**：
`scope:name` 形状的布尔门禁原语，deny by default，由服务端求值。**唯一允许出现在调用点的门禁判据。**
_Avoid_: feature flag、开关、feature、权限

**配额（quota）**：
数值上限。与能力分属两个命名空间——能力回答「有没有这件事」，配额回答「上限是多少」。
_Avoid_: limit、限额开关

**部署形态（deployment shape）**：
一组能力取值的实际组合。是**观察结果，不是配置项**——没有任何地方存储或判断「这是哪种形态」。
_Avoid_: 版本、edition、环境、SKU、双版本

**预设（preset）**：
展开成一组能力默认值的便利名字，仅在配置解析时存在，**展开后即消失**。不得被任何调用点判断。
_Avoid_: EDITION、版本枚举、mode

**私有树（private tree）**：
存在性本身即开关的目录或包。「不在」是默认状态，「在」是例外。
_Avoid_: ee 目录、企业版代码、付费模块

## 身份（identity）

三种身份互不隶属，不要合并。**设备不属于用户**——认证关闭的部署里只有设备、没有用户。

**用户（user）**：
有账号的使用者。只在 `accounts:login` 开启的部署里存在。
_Avoid_: 账号、customer、会员

**自助注册（self-registration）**：
用户自行创建登录账号的能力，由 `accounts:self-register` 单独控制；必须依赖
`accounts:login`，默认关闭。注册后的开户、赠送积分与审计在同一事务内完成。

**设备（device）**：
匿名使用者的浏览器标识，是匿名配额的归属对象。与用户是两套平行身份，不存在从属关系。
_Avoid_: 客户端、访客账号

**运营者（operator）**：
部署与运维这套系统的人，后台的唯一使用者。目前是单一口令，不是用户体系里的一个角色。
_Avoid_: 管理员、admin 用户、超级用户


## 积分与套餐（credits & subscriptions）

经营部署的计费模型只存在于私有树，公开树只提供能力门禁、提交事务 hook 与 UI
插槽。以下术语是私有模块与调用接缝共用的契约：

**积分账户（credit account）**：
每个用户唯一，包含两个余额桶。`subscription`（套餐积分）按月发放并到期清零；
`recharge`（充值积分）长期有效。消费时套餐桶优先，不允许出现负余额。

**积分流水（credit ledger）**：
余额变化的追加式事实记录。预扣、结算、退回、发放、充值和到期清零都必须写流水；
余额是当前状态，流水是解释余额的依据。运营写操作只能经 BFF，Admin 不直接写库。

**任务占用（task hold）**：
提交事务内按 `task_id` 唯一创建的积分预扣。任务首次调用上游后结算；调用前失败或取消则
按原桶退回。重试只更新真实上游调用次数，不重复预扣。

**模型单价（model price）**：
模型每生成一张图片所需的积分数。一次提交的价格是 `单价 × n`；缺少有效价格时拒绝提交。

**套餐（subscription plan）**：
定义每月积分和 1 / 3 / 12 个月价格。生效订阅记录起止时间与下一次月度发放时间；月度发放
由读路径惰性核对和后台维护扫描共同保证幂等。

## 素材库（library）

**素材（asset）**：
给一张已存图片起的名字，记录 `{ id, name, imageId, createdAt, lastUsedAt }`，存在主 IndexedDB 的
`assets` 表里，跟随 scope 隔离与匿名库领养。图片本体与缩略图仍归 image store，同一个 `imageId`
可以有多条素材记录，删素材不动图片。
_Avoid_: 图库、收藏夹、素材图

**模板（template）**：
一段可复用的提示词连同它引用的素材与参数快照，记录 `{ id, name, prompt, assetIds, params,
createdAt, lastUsedAt }`，存在主 IndexedDB 的 `templates` 表里。`prompt` 存带哨兵标记的形式，
`assetIds` 按引用序号排列（那一位不是素材就记 null）。套用先补齐缺席的素材图，再按新顺序
remap 引用——素材已删的位降级为「已移除」，套用仍然成功。
_Avoid_: 预设、快捷短语、prompt 片段

## 复刻套图（remix）

**套（set）**：
一组竞品来源图加一组标好角度的产品素材，连同平台 / 文案语言 / 差异化档位与产品描述（名称、外形特征、
主色、禁止色），作为一个整体产出的一组图。来源是竞品链接或上传的竞品图，复刻它们的创意。记录
`{ id, name, source, productAssets, settings, shots, createdAt, updatedAt }` 存在主 IndexedDB 的
`remix_sets` 表里，跟随 scope 隔离与匿名库领养。
_Avoid_: 批次、任务组、套图任务

**镜头（shot）**：
套里的一张图，由一张来源图派生：一份可编辑的画面简报、由简报派生的提示词、一张产品底图，以及
生成后回写的任务 id。一图一镜，底图按机位选同角度的素材。尺寸图、参数表这类只占位不生图。
镜头不存状态，状态一律从任务记录派生。
_Avoid_: 分镜、图位、slot

## 换背景（bgswap）

**换背景任务（bgswap job）**：
一组用户自己的现成商品图，连同一句偏好与每张要出几版，作为一个整体跑完。产品像素不动，只重绘
背景，品类与环境由 AI 自己判断，没有风格库可选。记录 `{ id, name, images, preference,
versionsPerImage, createdAt, updatedAt }` 存在主 IndexedDB 的 `bgswap_jobs` 表里，跟随 scope
隔离与匿名库领养；每张图记 `{ imageId, sourceUrl?, versions, chosenVersionId? }`，一张原图的多次
产出都留着，用户选一版定稿。
_Avoid_: 批量换背景套、背景风格、镜头

## 测试

- `apps/web` 有 jsdom 环境（按文件 `@vitest-environment jsdom` 启用），组件级冒烟测试的入口；Overlay 是首个有 DOM 锚点的模块。

## 参数策略（paramCompatibility）

「这个 profile 下哪些参数可用 / 合法」的唯一权威模块（`apps/web/src/lib/paramCompatibility.ts`）：

- **`getParamCapabilities(profile, outputFormat)`** — 能力查询。UI chip 显隐（ParamControls / InputBar）与归一化共用同一判定，禁止在组件里重新推导（codexCli 或 channel 未声明 quality capability→无 quality、gemini/非 png→无透明输出、png→无压缩、responses→无审核）
- **`normalizeParamsForSettings(params, settings)`** — 归一化，幂等。在分发层（`callImageApi` / `resumeQueueImageApi`）**强制执行**：任何提交路径（工作台 / canvas / 恢复 / 重试）到达 adapter 前必过，调用方不需要自觉
- store 提交路径与 InputBar effect 里的归一化调用是另一层职责（任务记录保真 + UI 回写），不是第二套约定
