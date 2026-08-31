# @deepseek-ai/dsh-client-ui-bid

[English](README.md) | 中文

标书会话浏览器 UI。插件把 `BidStagePanel` 贡献到会话声明的 `conversation.input.dock` 列表，并且只在 Host 解析出的 Session Preset 为 `bid` 且 `bid.runtime` Projection 可用时渲染。紧凑状态行复用 DSH Composer 的布局、状态标记、字体和按钮，只显示当前 `projection.runtime` 阶段与状态；执行进度继续由 DSH Transcript、Todo 和工具视图展示。客户端不折叠 Bid 事件、不推进阶段、不推导权限，也不保存本地阶段或状态。

`projection.allowedActions` 控制上传、重试和目录确认控件是否出现，Host 投影的文件限制配置选择器和规则文案。文件选择会把浏览器 `File` 对象保留在本地，直到用户明确上传整个批次。上传控件为生成的 `bid/uploadFiles` Remote 编码这些字节，重试控件只调用生成的 `bid/retryStage` Remote；两者都不调用 `session.prompt()`，只有刷新的 Host Projection 才会报告阶段成功或失败。目录确认回调仍不可用，因此对应控件保持禁用，不绕过 Host 准入。

需要用户确认时才显示“审核项”标签：S2 招标分析、S5 目录确认和 S7 整本审核都在此展示详情；没有待确认项时标签隐藏。主对话只保留当前阶段与确认按钮。S2 的评分原文、分值和来源只读，项目结论、评分目标和响应重点通过受控操作提交；S5 的目录编辑和确认操作也在审核项中完成。

面板把 `projection.composer.enabled` 及其稳定 reason code 映射到同一 Session 的 `ctx.conversation.blocks`。S7 处于 `book_review/waiting_user` 时，审核项自动切换到三栏审核工作台：左栏保留同一 Session 的 Transcript 和 Composer，中栏只读渲染章节 Markdown，右栏显示 Host 返回的审核摘要、问题和限制。工作台通过专用 Remote 读取审核报告与章节，并仅在用户明确确认后调用完成审核操作。非 Bid Preset 或 Projection 不可用时会清除 block 并隐藏面板，从而让非 Bid Session 保持原有 composer 与附件路径。发布的 `bid` Agent Preset 经 Host roster 发现并显示为“标书模式”；Preset seat 不包含 Bid 专用分支或 toggle。

## 模型体验

没有直接影响。本包不添加提示词内容，也不发送普通 Session prompt；文件持久化、工作流事件与所有模型可见的 Bid 输入均由 Host 拥有。

#### KV Cache 影响

无。渲染投影和选择本地文件不会改变模型请求前缀。

## 已知局限与延后工作

- **文件接入使用单次 JSON/base64 请求**——浏览器与 Host 内存会在配置限制内持有编码后的整个批次。
- **面板只显示业务状态**——它不重复 DSH 的任务列表和工具调用树。

文件接入为每个本地选择文件显示名称背景进度，并把 Host 返回的解析错误显示在对应名称下方。Host 的文件级失败不会清除同批次的成功文件；当前传输协议仍是一次 JSON/base64 批次请求。
