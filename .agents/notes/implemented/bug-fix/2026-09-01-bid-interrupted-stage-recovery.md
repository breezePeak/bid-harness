# Agent Note: Bid 中断恢复与当前阶段重置

Status: implemented

## Problem

Bid 阶段开始时会持久化 `bid.stage.started`，但 Host 进程在 Executor 或 Validator 结束前停止时无法写入完成或失败事件。Session 恢复后只能归约出 `running`；新进程中没有对应的执行操作，Projection 却仍禁用操作区并要求用户等待，因此项目无法继续。

## Decision

Host 把“项目状态存在 running 或 cancelling Run，但新进程没有对应 operation”视为中断执行。`agent/session-start` 在运行任何 Executor 前保留 Workflow 业务进度并持久化 `host_restart` 挂起；恢复结果是项目状态与 Session 事件中的事实，而不是浏览器推测。Main Agent 只能携带精确 Run ID 和项目 revision 请求恢复，具体机制由[统一 Run 生命周期](../architecture/2026-09-13-bid-workflow-run-lifecycle.md)拥有。

同一 Orchestrator 上的并发 `drive()` 仍共享已安装的 operation，不会把真正在执行的 Run 标记为中断。恢复不接管内存 Promise 或调度状态；各阶段 Executor 按持久检查点核对并复用已完成工作。

Bid Preset 在 Agent 作用域注册 `/bid-reset-s2` 至 `/bid-reset-s5`。目标可以是当前或更早阶段，不能是未来阶段、S1 或 S6。Host 用可取消的独占操作记录串行化同一 Workspace 的项目写操作；重置先占用该记录，无论当前进程是否仍保留执行操作，都会取消并等待主 Agent、Subagent 和并发 Worker 全部静止，再按阶段所有权删除 Artifact、追加 `bid.stage.reset` 并停在持久化的 `waiting_start`。短暂且不可抢占的文件事务先自然结算。第二个并发重置会被拒绝，用户发起的取消不写入 `bid.stage.failed`。

用户点击“开始本阶段”或执行 `/bid-start` 后，`bid/startStage` 才从 `waiting_start` 进入原有阶段执行路径。重复开始、未重置阶段和 S1 均被拒绝；重启后的 Projection 仍保留该开始门，因此重置操作本身不触发模型调用。

composer block 只禁止普通消息和依赖消息上下文的输入控件。前置加号执行人类命令，不经过 textarea，因此在 Bid 失败 block 下仍可打开；没有会话、会话已移除、父 Agent 离线或输入栏 inert 时仍禁用。命令生命周期和重置事件写入 Session，但命令文本不进入模型历史。

## Alternatives considered

**保持 `running`，由用户发送普通消息直接续跑。** 上一个进程的 Promise、Agent 等待和 Child Session 调度状态无法在新进程中继续；普通消息只能促使 Main Agent 检查并发起精确恢复。

**恢复时自动重跑当前阶段。** 不采用，因为进程停止可能留下部分 Artifact 和已发起的外部工作；先持久化挂起再由 Main Agent 判断用户意图，不会把中断误报为新的成功执行。

**只在浏览器把长时间 `running` 显示为可恢复。** 不采用，因为多个 Client 会产生不同的超时判断，项目状态与 Session 日志仍然保留错误的运行状态。

**用一个带阶段参数的全局重置命令。** 不采用，因为它会在非 Bid Session 中暴露无效能力，并允许用户输入与当前状态无关的阶段名。作用域内的固定命令让菜单直接展示 S2–S5，Host 校验目标不得晚于当前阶段。

**让重置请求等待用户确认后再返回。** 不采用，因为一次请求不能跨越用户检查和刷新，持久化的 `waiting_start` 才能让所有客户端观察同一开始门。

**只由浏览器延迟重置后的执行。** 不采用，因为命令和其他客户端仍能绕过前端状态，Host 也无法阻止新的模型调用。

## Consequences

Host 重启后，中断的 Bid Run 会稳定进入 `host_restart` 挂起；页面保持 Composer 可用，由 Main Agent 检查状态并按精确身份请求恢复，也可从 `+` 命令菜单把 S2–S5 重置到当前或更早阶段。运行中的阶段能在全部 Agent 工作停止后安全回退，不会与正在写入的 Worker 并发删除文件。重置成功与阶段执行是两个可观察操作，用户确认前不会发生新的模型调用；Projection 只开放 `start_stage` 并禁用 Composer。项目状态文件负责跨 Session 进度，当前 Session 的日志负责执行记录和 Projection；恢复同步与锁归属见[Workspace 项目记录](../architecture/2026-09-03-bid-workspace-project.md)。
