# Agent Note: Bid 恢复决策使用 DSH 原生用户提问

Status: implemented

## Problem

阶段挂起、自动重试耗尽和阶段重置后的下一步选择同时存在于阶段状态与聊天交互中。阶段卡按钮和普通聊天恢复文本不能稳定承载问题身份，也无法在 Host 重启后恢复一个未回答的选择；重复恢复入口还可能让已完成任务再次启动。

## Decision

Bid Host 复用 `ctx.userQuestions.ask()` 和现有 `QuestionComposer`，为支持阶段重跑的挂起 Run 提供继续、当前阶段重跑和停止三个合法选项；S1 只能继续或停止，为重置后的 `waiting_start` 提供当前阶段重跑和停止两个合法选项。阶段状态卡只显示状态、原因和进度，不注册恢复或开始按钮；挂起态也不再向 Main Agent 注册 `bid_resume_current_run`，普通消息不会被解释为恢复答案。

每个决策以 `session + stage + runId + decisionType` 组成稳定 `decisionKey`。Host 在提问前追加 `bid.run.decision.required`，保存完整原生问题；明确选项映射成功后追加 `bid.run.decision.received`，随后分别调用既有 `resumeCurrentRun`、挂起 Run 的 `resetStage` 加 `startStage`，或统一的 `agent.cancel({ kind: 'user' })`。自动重试仍由现有执行器预算处理，只有重试耗尽形成挂起 Run 后才进入决策边界。

Host 重启或 Session 恢复时从最后一个未被 `bid.run.decision.received` 配对的请求事件重建问题，并再次调用 DSH 原生提供方；原生 Host transport 继续负责刷新、重连和请求回答期间的 pending question。进程内的 single-flight 表只防止同一决策重复请求，不作为持久真相源。

## Alternatives considered

**保留阶段卡恢复按钮：** 未采用，因为它绕过 DSH 原生提问、无法与其他 Host 问题共享 pending 生命周期，也会让浏览器本地按钮成为第二个决策协议。

**让 Main Agent 根据普通消息调用恢复工具：** 未采用，因为普通聊天不能证明用户选择了哪一个合法操作，且模型回合无法提供 Host 重启后的待回答问题恢复。

**Host 重启后自动继续：** 未采用，因为恢复可能消耗模型额度或违背用户明确停止；Host 只从持久请求恢复问题，继续执行仍需要明确的原生选项结果。

## Consequences

未回答的问题由 Session Log 与 DSH Host transport 共同恢复，浏览器刷新、WebSocket/SSE 重连和 Host 进程重启都不会丢失决策身份；同一 Run 不会产生重复问题，回答后也不会因刷新再次出现。恢复继续沿用 Run checkpoint、Work Descriptor、Project revision 和现有 Child 收敛顺序；阶段重跑仍只清理选定阶段及后续产物。由于取消原生提问不等于选择，取消后保留未完成决策记录，下一次恢复边界可再次物化该问题。
