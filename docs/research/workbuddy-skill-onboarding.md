# WorkBuddy CLI + Skill 接入核对

核对时间：2026-11-06；实机 WorkBuddy 5.9.3。

## 官方支持的安装方式

- [技能使用说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)：「查找技能」针对技能市场；「上传技能」是手动导入路径，不能把这两点误解为只允许 UI 安装。
- [技能包结构](https://open.workbuddy.cn/docs/skill)：ZIP 内为技能目录，根文件 `SKILL.md`；补充资料放 `references/`。WorkBuddy 还定义了展示名、双语介绍、版本和作者字段。
- [权限说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes)：默认权限以工作空间为边界，写入敏感路径、文件替换与删除可能需要确认。前台执行不等于自动免于权限保护；完全访问会影响全部任务，不作为幕芽接入要求。

## 当前幕芽缺口

CLI 0.1.3 的 `skill install --host` 只接受 `claude-code`、`codex`。旧指南对 WorkBuddy 跳过技能安装，造成账号可用但 `/mu` 没有幕芽技能的体验。本机 `~/.workbuddy/skills` 也没有 `muvloom`，不能将 CLI ready 当作技能已安装。

## 本次方案

继续使用原生 CLI。Web 构建从现有 CLI Skill 源生成 WorkBuddy ZIP，补充其官方元数据和针对实际故障的接入说明；不维护第二份生图工作流，也不添加未经支持的 CLI host 参数。

[官方自定义技能案例](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Practice-Cases/Practice-Eight) 明确支持在对话中创建技能，执行后在已安装中查看。当前客户端也已从用户级 `~/.workbuddy/skills/` 发现其他技能；对话安装本地包还须本次实机验证。

WorkBuddy 页面使用专用提示词和指南，由 WorkBuddy 在对话中下载并安装技能到用户技能目录；下载按钮和上传步骤仅保留在「我自己来」方式。完成条件为技能可见且启用、CLI ready、capabilities 成功。认证在可交互前台执行，发码后交回用户操作；写入失败先处理必要权限，状态已 ready 时保留连接。Agent 不手工操作凭据、不修改全局保护。

依据实际日志，本机后台认证曾在最终凭据 rename 时被拒绝；后续前台确认后 CLI 0.1.3 已 ready。早先有服务端签发记录的三次失败不能归因为「无人确认导致过期」。

## 2026-11-07 实机发现

用户从 WorkBuddy 对话发起安装；执行记录确认下载、检查和安装完成，安装目录的 10 个文件与测试站 ZIP 逐字节一致。但新任务输入 `/muv` 仍无匹配，不能将文件落盘或新开对话当作技能加载成功。

只读检查客户端技能列表缓存，已有 `muvloom`，来源 `userSettings`，`disable` 和 `disableModelInvocation` 均为 false。daemon 扫描日志的用户技能数从 3 增到 4；因此包缺失和被禁用不是本次已观察到的原因。客户端有跨会话的技能列表与版本缓存，下一步验证完整重开客户端后的发现结果，尚未据此宣称根因或恢复已验证。

本次仅安装技能，WorkBuddy 却额外执行账号状态检查并触发凭据目录询问。已拒绝该多余步骤；指南现在显式区分仅技能请求与完整账号接入，状态检查失败也不得推断原账号未登录。
