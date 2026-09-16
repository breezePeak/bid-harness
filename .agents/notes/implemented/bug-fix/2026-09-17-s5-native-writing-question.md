# Agent Note: S5 初始写作要求由 Host 原生提问

Status: implemented

## Problem

S5 原先只向 Main Agent 投递一条要求模型调用 `ask_user_question` 的插件消息，并把消息写入 `writing-request.json`。插件消息进入 Session Log 不代表原生问题 provider 已建立 pending 请求，因此用户只能看到聊天文字，不能可靠地完成原生问答。

## Decision

S4 最终目录确认进入 S5 等待态后，Bid Host 在短项目操作中创建并保存带 `request_id`、`attempt_id`、owner Session、目录哈希和状态的业务记录，释放项目锁，再用当前主交互 Agent 调用 `ctx.userQuestions.ask()`。在线等待句柄仅保存在 Host 内存中，并以项目规范化路径去重；回答回调重新取得项目锁，校验请求身份、目录和阶段后保存真实 `selected/custom` 内容。

首次 Writing Plan 必须携带 Host 生成的 `writing_request_id`。Host 从业务记录加入原生自定义回答原文，不把它伪造成 `user_message_refs`；计划提交和业务记录消费在同一项目 mutation 中完成。完成态和 attention 态的 Writing Plan patch 保持原有入口，不重新触发初始问题。重置、停止和 Host dispose 会使在线等待失效，旧回答不能推进新一轮。

已知旧的 `prompt_event` marker 只在当前没有有效计划且处于 S5 等待态时被局部重建；有效 Writing Plan 不会因 marker 过时而被删除。

## Alternatives considered

**继续由模型调用 `ask_user_question`**——被放弃，因为模型工具调用依赖模型先产生正确指令，不能保证 Host 进入 S5 时原生组件已经出现。

**修改通用 user-questions provider 以识别 Bid 的问题 ID**——被放弃，因为业务询问身份、问题 ID 和 provider RPC ID 属于不同层次；Bid 可在现有服务契约上完成生命周期和持久化，不应把项目特例放入共享 provider。

**把原生回答伪造成 Session 的 `user/message`**——被放弃，因为这会破坏消息来源校验并让模型历史与真实聊天不一致；原生回答由 Host 作为结构化业务记录保存。

## Consequences

S5 原生问题不再占用项目操作锁，浏览器重连可复用仍存活的在线等待，Host 重启可根据未完成业务记录重新建立等待。没有 provider、回答无效或持久化失败时，记录保留可恢复状态，不会默认为“没有要求”或启动 Writer。初始问题的业务记录增加了一个独立的磁盘格式版本，后续字段变化需要同步更新解析和恢复测试。
