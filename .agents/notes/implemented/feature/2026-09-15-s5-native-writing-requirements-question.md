# Agent Note: S5 使用原生整体写作要求问答

Status: implemented

## Problem

S5 正文生成前需要收集一次整体写作要求，但原流程让 Main Agent 通过普通对话自行询问，不能复用 DSH Web 的结构化问答入口，也使“没有要求”和自定义要求缺少统一的答案边界。

## Decision

S5 `chapter_writing/waiting_user` 保留现有手动／自动分流和项目请求标记；手动入口唤醒 Main Agent 后，阶段提示要求它调用原生 `ask_user_question`，使用固定问题和“没有，开始编写”选项，同时允许自由输入。阶段工具作用域仅在检测到该原生工具时放行它，其他阶段的工具限制与守卫保持不变。

原生问答答案由 Main Agent 写入既有 Writing Plan 的 `global_instructions`，首次计划允许没有传统 `user/message` 引用；Writing Plan 的页数验收、章节任务、SubAgent 调度和停止／恢复链路不变。

## Alternatives considered

**继续使用自定义聊天询问：** 保留了旧的手动／自动触发入口，但不再把普通聊天作为 S5 整体要求的收集 UI，因为它无法提供原生问答的结构化选项和自定义输入。

**由 Host 直接调用 `ctx.userQuestions.ask`:** 未采用，因为本次交互的调用者必须是 Main Agent，原生工具结果需要回到模型上下文，由模型按现有 Writing Plan 协议解释并分配要求。

## Consequences

S5 手动入口现在使用现有 `ask_user_question`、`ctx.userQuestions` 和 Web 问答呈现；“没有，开始编写”与自由文本都沿原有计划提交和启动链路处理。没有传统用户消息引用的首次原生答案不再被无条件拒绝；需要保留原始用户消息时，仍使用现有引用机制。
