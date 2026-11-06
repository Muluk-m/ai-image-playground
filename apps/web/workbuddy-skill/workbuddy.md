# WorkBuddy 安装与授权

幕芽、muya、muvloom 是同一个服务。技能名是 `muvloom`，展示名是「幕芽 Muvloom」。

## 确认技能已安装

在 WorkBuddy「专家·技能·连接器 → 技能 → 已安装」中确认「幕芽 Muvloom」已启用；也可在输入框输入 `/mu` 检查候选技能。账号授权成功不代表技能安装成功。

还未安装时，从幕芽插件接入页面下载 `muvloom-workbuddy.zip`，通过「添加技能 → 上传技能」导入。自建技能包不能假装已在技能市场上架。需要用户完成导入时，给出包的位置与这一步操作，然后结束当前回合等待确认。

CLI 安装和服务地址选择按接入页面的安装指南执行。CLI 0.1.3 的 `skill install --host` 只支持 Claude Code 和 Codex；WorkBuddy 使用上传导入流程。

## 连接账号

所有认证命令使用 WorkBuddy 的前台、可交互执行方式；Bash 的 `run_in_background` 保持关闭，让需要的权限确认可以显示给用户。前台执行仍可能受权限保护，不保证免于确认。

1. 先运行 `muvloom auth status`。`state: ready` 时直接验证 `muvloom capabilities`，保留已有连接。
2. 未登录时，前台运行 `muvloom auth login --no-wait`，打开返回的 `verification_uri_complete`，告诉用户在页面完成授权。**立即结束这一回合等待用户确认**，让用户有操作窗口。
3. 用户确认后，先再次运行 `muvloom auth status`。已经 `ready` 就完成；否则前台运行 `muvloom auth login --timeout 15` 收尾，再检查状态。
4. `AUTH_PENDING` 只表示仍在等待。保留原流程，提示用户完成页面确认后再继续；不要循环等待或反复申请新码。

## 本地写入或清理受限

出现 `operation not permitted`、`permission denied` 或保存凭据失败时，保留并说明真实错误，暂停登录收尾。由用户按 WorkBuddy 的权限提示决定是否允许 CLI 对幕芽配置目录进行必要操作，确认权限后先查 `auth status` 再继续。

凭据由 CLI 管理。不要手动读取、复制、覆盖或删除凭据文件，不把 token 写入 Skill、提示词或聊天，也不修改全局权限或安全规则来绕过拦截。

`AUTH_REQUIRED` 提示码无效或已使用时，先检查现有连接；它不等于码过期。只有 CLI 明确返回 `AUTH_EXPIRED` 才按过期处理。确认本地权限问题已经解决、状态仍未登录后，再向用户说明需要重新授权一次。

## 安装完成条件

同时确认技能可见且启用、`auth status` 为 `ready`、`capabilities` 成功，才报告接入完成。安装验收不生成图片。完成后回到用户原来的图片任务；仅安装请求则停止。
