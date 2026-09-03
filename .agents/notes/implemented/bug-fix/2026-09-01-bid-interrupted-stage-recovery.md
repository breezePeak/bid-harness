# Agent Note: Bid 中断恢复与当前阶段重置

Status: implemented

## Problem

Bid 阶段开始时会持久化 `bid.stage.started`，但 Host 进程在 Executor 或 Validator 结束前停止时无法写入完成或失败事件。Session 恢复后只能归约出 `running`；新进程中没有对应的执行操作，Projection 却仍禁用操作区并要求用户等待，因此项目无法继续。

## Decision

`BidOrchestrator.drive()` 把“新 Orchestrator 实例没有进程内 operation，但 Session 日志归约为 `running`”视为上一个 Host 进程的中断执行。它在运行任何 Executor 前追加当前阶段的 `bid.stage.failed`，并保持既有失败恢复语义：S1 允许重新上传，其他阶段允许通过 `bid/retryStage` 完整重跑。`agent/session-start` 会调用该 `drive()` 并刷新 Session，所以恢复结果是持久事实，而不是浏览器推测。

同一 Orchestrator 上的并发 `drive()` 仍共享已安装的 operation，不会把真正在执行的阶段标记为中断。恢复处理不接管部分 Artifact；后续重试仍由各阶段 Executor 按其完整执行入口处理旧的尝试输出。

Bid Preset 在 Agent 作用域注册 `/bid-reset-s2` 至 `/bid-reset-s5`。目标可以是当前或更早阶段，不能是未来阶段、S1 或 S6。Host 用可取消的独占操作记录串行化同一 Workspace 的项目写操作；自动阶段运行时，重置先占用该记录，取消主 Agent 和共享 `AbortSignal` 下的 Subagent、并发 Worker，等待原操作与 Agent 全部静止，再按阶段所有权删除 Artifact、追加 `bid.stage.reset` 并通过正常 `drive()` 完整重跑。短暂且不可抢占的文件事务先自然结算。第二个并发重置会被拒绝，用户发起的取消不写入 `bid.stage.failed`。

composer block 只禁止普通消息和依赖消息上下文的输入控件。前置加号执行人类命令，不经过 textarea，因此在 Bid 失败 block 下仍可打开；没有会话、会话已移除、父 Agent 离线或输入栏 inert 时仍禁用。命令生命周期和重置事件写入 Session，但命令文本不进入模型历史。

## Alternatives considered

**保持 `running`，由用户发送普通消息恢复。** Bid Host 会拒绝通用 Prompt，而且上一个进程的 Promise、Agent 等待和 Child Session 调度状态无法在新进程中继续。

**恢复时自动重跑当前阶段。** 不采用，因为进程停止可能留下部分 Artifact 和已发起的外部工作；先持久化明确失败再由用户重试，不会把中断误报为新的成功执行。

**只在浏览器把长时间 `running` 显示为可重试。** 不采用，因为多个 Client 会产生不同的超时判断，Session 日志仍然保留错误的运行状态。

**用一个带阶段参数的全局重置命令。** 不采用，因为它会在非 Bid Session 中暴露无效能力，并允许用户输入与当前状态无关的阶段名。作用域内的固定命令让菜单直接展示 S2–S5，Host 校验目标不得晚于当前阶段。

## Consequences

Host 重启后，中断的 Bid 阶段会稳定进入 `failed`；页面可重新上传、使用通用重试，或从 `+` 命令菜单把 S2–S5 重置到当前或更早阶段。运行中的阶段也能在全部 Agent 工作停止后安全回退，不会与正在写入的 Worker 并发删除文件。该选择不从阶段中间续跑，因此重置会重复目标阶段的必要计算，并保留各 Executor 的清理责任。项目状态文件负责跨 Session 进度，当前 Session 的日志负责执行记录和 Projection；恢复同步与锁归属见[Workspace 项目记录](../architecture/2026-09-03-bid-workspace-project.md)。
