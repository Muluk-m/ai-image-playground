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

## 测试

- `apps/web` 有 jsdom 环境（按文件 `@vitest-environment jsdom` 启用），组件级冒烟测试的入口；Overlay 是首个有 DOM 锚点的模块。

## 参数策略（paramCompatibility）

「这个 profile 下哪些参数可用 / 合法」的唯一权威模块（`apps/web/src/lib/paramCompatibility.ts`）：

- **`getParamCapabilities(profile, outputFormat)`** — 能力查询。UI chip 显隐（ParamControls / InputBar）与归一化共用同一判定，禁止在组件里重新推导（codexCli 或 channel 未声明 quality capability→无 quality、gemini/非 png→无透明输出、png→无压缩、responses→无审核）
- **`normalizeParamsForSettings(params, settings)`** — 归一化，幂等。在分发层（`callImageApi` / `resumeQueueImageApi`）**强制执行**：任何提交路径（工作台 / canvas / 恢复 / 重试）到达 adapter 前必过，调用方不需要自觉
- store 提交路径与 InputBar effect 里的归一化调用是另一层职责（任务记录保真 + UI 回写），不是第二套约定
