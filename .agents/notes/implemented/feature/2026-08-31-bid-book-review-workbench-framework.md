# Agent Note: 技术标整本审核工作台框架

Status: implemented

## Problem

S6 已生成确认目录和章节正文，但在 DOCX 导出前缺少可浏览整本技术标、承载审核结果并要求用户明确继续的阶段。

## Decision

`book_review` 使用程序执行器生成 `review/report.json`。报告记录 S6 章节路径和正文 SHA-256，固定标记为 `framework_only` 与 `not_evaluated`，并保留 `DETAILED_REVIEW_NOT_IMPLEMENTED` 限制项。

`StagePolicy.userGate` 表达用户确认时机。S5 使用 `before_execution`，S7 在报告通过 Validator 后使用 `after_validation`。S7 完成请求重新校验报告和正文哈希，成功后才记录完成事件并驱动 `docx_export`。

审核工作台注册为 `conversation.view`。左栏组合确认目录和当前 Session 的 `ChatView`、`InputBar`；嵌入组件复用会话插件已有的消息渲染、流式输出、工具节点、草稿和停止行为。工作台激活时，Composer block 标记其已嵌入，ConversationRoot 不再渲染底部副本。

`ConversationController.selectView()` 通过当前 Session 的视图状态切换已注册视图。ui-bid 在投影进入 `book_review` 时调用该通用接口，自动打开审核工作台，而 ui-conversation 不依赖 Bid Stage。

正文 Remote 仅接受 `section_id`，由 Host 在确认目录和章节 manifest 中解析正文路径，并拒绝链接路径。浏览器不会收到 Session 工作区绝对路径。

## Alternatives considered

**让 Agent 生成空问题列表。** 未实现审核规则时调用模型会制造已经审核的错误印象，确定性报告更准确。

**在 ui-bid 复制聊天组件。** 复制会丢失队列、流式、工具节点、附件和输入状态，因此工作台嵌入通用会话组件。

**把工作台放入 input dock。** input dock 适合阶段提示和小型操作，不能提供独立滚动的三栏阅读工作区。

## Consequences

问题列表为空不表示审核通过，S7 不修改章节正文，也不执行详细审核、自动修复、联网验证或 DOCX 导出。后续审核 Agent 可以保留报告 Schema、Host Remote 和用户确认流程，只替换程序执行器并填充问题项。
