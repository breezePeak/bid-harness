# Agent Note: Bid 使用单一任务状态机

Status: implemented

## Problem

Bid 同时保存 Workflow gate、Run status、浏览器 runtime status 与重置后的 `waiting_start`，同一业务进度需要跨四套字段推导。组合状态允许出现没有 Run 的 running、带 Run 的 waiting_user、Workflow 与 runtime 阶段不一致等非法值；重置还通过独立 `stage_start` 决策协议才能继续执行。

## Decision

`BidTaskState` 是 Host、项目文件、Session 归约和浏览器 Projection 的唯一业务状态。其 `status` 只允许 `ready`、`running`、`waiting_user`、`suspended`、`failed` 与 `completed`；判别联合规定只有 `running` 和 `suspended` 携带 Run。Run 只保存执行身份、Work Descriptor、revision、进度和时间，挂起原因与错误属于 `suspended` 分支，业务失败属于 `failed` 分支。

`project-state.json` version 4 扁平保存任务状态及 revision、更新时间。读取器结构化接受 version 3 的 Workflow、Run、最近 Run 和兼容 runtime 字段并归一为 `BidTaskState`；正常写入只产生 version 4。Host 在项目锁内把没有 live operation 的 `running` 改为 `suspended(host_restart)`。

Session 使用 `bid.project.resumed` 同步完整任务状态，并用 `bid.task.changed` 提交显式业务结果。旧阶段事件、旧 v3 resumed payload 与 `stage_start` 决策值只服务历史日志回放，生产路径不再产生它们。`bid.run.completed` 本身不改变业务状态；Run 结束必须在同一次 checkpoint 中追加明确结果。

阶段重置先完成取消、静止等待、Artifact 清理与上下文替换。S2、S3、S4 在同一项目操作中提交 `ready` 后立即调用正常驱动路径；S1 与 S5 提交 `waiting_user`，其中 S5 不创建 Execution Agent。没有重置后的开始 Remote，也没有 `waiting_start` 用户问题。

`BidClientProjection` 直接返回 `task: BidTaskState`，权限与 composer capability 从该值生成。S6 DOCX 继续使用独立项目操作锁，不改变任务阶段或状态。

## Alternatives considered

**保留 Workflow 与 Run 两个状态对象并加强交叉校验。** 每个写入、回放和客户端入口仍需维护组合矩阵，无法在类型层排除非法组合。

**保留派生 runtime 作为客户端兼容层。** 首次发布前没有外部消费者；兼容层会继续成为可被误用的第二真相源。

**重置后保留显式开始问题。** S2–S4 的重置意图已经授权重新执行，多一次问题只增加持久决策、Remote 和恢复分支；S5 本身需要用户输入，因此直接回到 `waiting_user`。

## Consequences

状态合法性由类型和 Zod schema 同时约束，磁盘、Session、Host 与客户端不再互相推导平行状态。成功 Run 的调用方必须明确提交后继、等待用户、失败或完成结果；新增 dedicated work 也必须选择返回状态。代价是旧 v3 与旧事件的兼容逻辑集中保留在解析和回放边界，删除条件是历史日志与项目格式不再需要读取。

本记录部分替代[Bid Workflow 与 Run 使用统一生命周期](2026-09-13-bid-workflow-run-lifecycle.md)中的双状态结构，但保留其 Work Descriptor、Run fencing、Commit Scope、Activity Scope、恢复核对和 PublicationBatch 决策；部分替代[Workspace 项目状态](2026-09-03-bid-workspace-project.md)的 version 3 磁盘结构；替代[原生恢复问题](../bug-fix/2026-09-15-bid-native-recovery-questions.md)中的重置后 `waiting_start` 与 `stage_start` 分支，挂起 Run 的恢复问题仍有效。[阶段重置模型上下文](../bug-fix/2026-09-03-bid-stage-reset-model-context.md)继续拥有上下文替换规则。
