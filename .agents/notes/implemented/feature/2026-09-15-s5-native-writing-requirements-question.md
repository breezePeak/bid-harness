# Agent Note: S5 使用原生整体写作要求问答

Status: implemented

## Problem

S5 正文生成前需要收集一次整体写作要求，但原流程让 Main Agent 通过普通对话自行询问，不能复用 DSH Web 的结构化问答入口，也使“没有要求”和自定义要求缺少统一的答案边界。

## Decision

默认启动规则由[S4 确认后直接写作](2026-09-26-s5-start-after-outline-confirmation.md)取代：S4 确认后直接执行 S5，浏览器两种确认模式都不自动询问意见。下述问答与恢复约束仅适用于显式创建或已保存的写作请求。

显式写作请求在 `chapter_writing/waiting_user` 保存项目请求身份，由 Host 通过原生用户问答服务呈现固定问题、“没有，开始编写”选项与自由输入。已保存请求在刷新或换 Session 后沿同一身份恢复；正常 S4 确认不创建此请求。

原生问答答案由 Main Agent 写入既有 Writing Plan 的 `global_instructions`，首次计划允许没有传统 `user/message` 引用；Writing Plan 的页数验收、章节任务、SubAgent 调度和停止／恢复链路不变。

## Alternatives considered

**继续使用自定义聊天询问：** 保留了旧的手动／自动触发入口，但不再把普通聊天作为 S5 整体要求的收集 UI，因为它无法提供原生问答的结构化选项和自定义输入。

**由 Host 直接调用 `ctx.userQuestions.ask`:** 未采用，因为本次交互的调用者必须是 Main Agent，原生工具结果需要回到模型上下文，由模型按现有 Writing Plan 协议解释并分配要求。

## Consequences

显式请求使用 `ctx.userQuestions` 和 Web 原生问答呈现；无附加要求与自由文本沿既有计划保存和启动链路处理。首次原生答案允许没有传统用户消息引用；后续真实聊天要求保留消息引用。
