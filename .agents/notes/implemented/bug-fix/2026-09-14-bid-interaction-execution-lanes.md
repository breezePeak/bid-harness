# Agent Note: Bid 独立交互与执行通道

Status: implemented

## Problem

Bid S2–S5 的长任务和公开聊天共用一个 Agent 与 Session 时，Agent Loop 的单活动轮次约束会让聊天等待内部协议，或把用户消息插入私有 finish 工具链。项目锁又曾拒绝同项目其他 Session 的消息，导致运行中出现 busy、串话或无法连续问答；为聊天重试 busy 不能消除共享 Session 的所有权冲突。

## Decision

Bid Host 为每个 Long Run 保留一个顶层 Interaction Session，并创建一个 Host 持有的 Execution Session。Interaction Session 只处理公开消息和阶段 scoped 工具；Execution Session 复制模型选项、Workspace 与 Bid preset，使用内部 `subagent` origin 阻止通用 API、UI 和公开消息把它当成聊天目标，并在创建种子中写入一次性 `subagent/descriptor`，使持久化子会话目录能够折叠其身份。阶段模型步骤以及其 Child、Writer 和 Reviewer 都从 Execution Session 派生。

项目 operation 仍是唯一执行控制器和写入所有者。`BidRunSnapshot` 持久化 `interactionSessionId` 与 `executionSessionId`，控制事件写入 Interaction Session 并广播项目投影；Execution Session 只保存可恢复的模型执行日志。Host 在 Run 和后代 Activity 收敛后释放 Execution Agent，刷新后从项目文件与 Session Log 恢复身份，不把内存对象当作权威状态。

同项目任一顶层 Interaction Session 都可在 Run 期间发送多轮消息并调用 `bid_stage_inspect`。读取直接使用项目快照；公开回复的模型错误、停止原因和日志只属于该聊天 Agent，不改变 Run、Artifact 或调度器。普通消息不创建第二个 operation，不路由到 Execution Session，也不使用 `agent-busy` 重试。

S5 的明确修改继续通过现有 Writing Plan 与 durable command journal 进入唯一项目写入者。命令在 accepted 响应前持久化，调度器只在既有安全点应用计划版本；进度询问和解释不创建命令。并发顺序、重复和恢复语义由 command ID、计划版本及 journal 状态确定，不新增第二套指令队列。

任一同项目 Interaction Session 的原生 Stop 表示取消整个 Run。Host 先撤销提交权限，再中止 Execution Session 的 Run、关闭调度入口、等待 Child 与 Activity 收敛，最后持久化 `user_stop` 挂起状态；普通聊天失败不触发该路径。

## Alternatives considered

**继续在同一 Session 交错公开回合和私有协议。** Agent Loop 同一时刻只能运行一个轮次，工具卸载与 continuation 排队仍无法让公开回复和长执行真正并行，也让两类日志及取消原因共享所有权。

**收到 busy 后重试或轮询。** 重试只延后竞争，不能修复 Session 路由和取消归属，还会增加重复调用及不可预测延迟。

**为聊天创建第二个项目 operation。** 两个控制器会争夺项目锁、revision 与 Artifact 提交权；聊天只需要只读快照和受控命令入口。

**把用户消息直接投递给 Execution Session。** 这会重新引入私有工具串话，并允许聊天 Stop、模型错误或上下文增长干扰阶段协议。

**新增通用 RunInstruction 队列。** S5 已有带身份、版本、状态和恢复语义的 command journal；平行实现会产生两个命令真相源。其他阶段没有已授权的运行中写操作，不需要空泛扩展点。

## Verification

项目 Session 集成测试固定 Interaction/Execution 身份分离、S2/S3/S4/S5 运行中连续问答、同项目其他聊天读取、S5 command journal、Execution Child 收敛及任一聊天 Stop 挂起唯一 Run。Run coordinator 测试固定 suspend、complete、Activity 与 commit 的单次收敛语义。

## Consequences

运行中的聊天不再占用执行 Agent，公开回复失败也不会终止阶段；所有 Artifact 写入仍经过同一个 operation、Run coordinator 和 commit scope。每个活动 operation 额外持有一个内部 Session，其日志按现有 Session 存储恢复，并在运行收敛后释放 live Agent。内部 Execution Session 使用 `subagent` origin 作为现有路由隔离标记，目录中以「Bid 阶段执行」的一次性子代理身份呈现；监控和调试仍通过 Run 快照身份区分它与真正执行章节工作的后代 Child。
