# Agent Note: Bid Workflow 与 Run 使用统一生命周期

Status: implemented

## Problem

一个扁平阶段状态同时表达业务进度和进程执行，会把停止、Provider 故障、后端重启和业务校验失败压成同一个 failed。阶段级停止工具与重试 RPC 又绕开聊天原生取消，使 UI、Main Agent、Host 和各执行器分别拥有一部分停止与恢复规则；迟到的模型或 Child 结果仍可能在停止后提交正式 Artifact。

## Decision

Bid 控制状态分为持久 Workflow 与一次性 Run。Workflow 只保存业务阶段、确认门和不可恢复失败；Run 保存 UUID、stage、epoch、基线项目 revision、运行状态、停止原因和安全错误摘要。`project-state.json` version 2 与 Session 事件使用同一控制模型，扁平 runtime 仅作为浏览器视图。

Host 的 `BidRunCoordinator` 是自动执行的唯一授权者。它先将 `bid.run.started` checkpoint 到 `project-state.json`，再暴露强制 `BidRunContext`；`baseProjectRevision` 是创建前 CAS 基线，`controlRevision` 是 running 状态已持久化后的提交版本。`BidCommitScope` 在每次原子写入前取得短租约，退休后拒绝新租约，并让已获租约的最小提交收敛。S1 解析写入 Run staging，S3 Main Agent 只能写 Run scratch，Host 校验后才发布正式 Artifact。

停止顺序固定为关闭新任务准入、退休提交作用域、记录 cancelling、清理 Run 自己排入的 Main Agent inbox 消息、中止 Run 和 Main Agent、等待 Child、Main Agent idle 与提交租约收敛，最后持久化 suspended；重复停止共享同一个收敛 Promise，最先到达的停止原因生效。自动阶段的正式 Artifact 和关键 manifest 都经 Commit Scope 发布，旧 Run 完成不能覆盖挂起或后继状态。

每个 suspended Run 同时产生以 Run ID 派生的 `bid.run.notice`，Host restart 将孤儿 running Run 转为 suspended 时也生成同类通知。浏览器将这一单事件投影为 model-invisible 的聊天时间线行；用户停止使用中性样式，自动中断使用错误样式，稳定 notice ID 防止同一 Run 重复显示，状态面板只保留“已挂起”。

`Agent.cancel()` 在修改 inbox 或传播 abort 前同步发出带类型原因的 `agent/cancel-requested`。Bid Host 仅响应当前项目 operation 所属 Main Agent 的 user cause，因此聊天原生 Stop 同时停止公开回复与当前 Run；其他 Session、普通消息和暂停调度不会触发挂起。独立的 `stop_stage`、`retry_stage`、`bid_stop_stage` 及对应 Remote 不属于公开控制面。

挂起后的 Composer 保持可用。Main Agent 先用阶段检查读取有界状态，再根据完整聊天语义决定是否调用 `bid_resume_current_run`；工具必须携带 suspended Run ID 与 expected project revision。Host 持锁重读项目并执行 CAS，身份或 revision 改变就拒绝。Host 启动发现 running 或 cancelling 只写 `host_restart` 挂起，不自动恢复。

恢复是执行器级 reconciliation，不是内存续跑。S2 持久化逐条分析记录与 review phase，中断的 reviewing 回到 `review_required`；S3 复用已完整校验的正式 Artifact；S4 复用任务日志，只对明确的子任务物化、恢复和结果通道故障做内部有界重试；S5 复用计划、章节日志、正文哈希与 Reviewer 身份。429、Provider 文本和 retry-after 不由 S4 猜测，统一在 Run 边界暴露为可恢复挂起。

## Alternatives considered

**保留阶段级 Stop 与 Retry API。** 两套入口会继续产生不同的取消顺序、UI 权限和恢复结果，也无法让通用 Agent 生命周期的停止按钮成为唯一用户心智模型。

**停止时直接把 Workflow 标为 failed。** 用户停止和基础设施故障都不改变已确认业务进度；把它们写成业务失败会丢失精确尝试身份并迫使恢复依赖模糊阶段名。

**只依赖 AbortSignal 阻止迟到写入。** 结果可以在 signal 检查之后、原子替换之前变旧；Commit Scope 必须在同一个写入入口取得租约，并在 abort 传播前退休。

**自动恢复所有挂起 Run。** 恢复可能继续消耗模型额度或违背用户明确停止；Main Agent 需要结合用户当前意图作决定，Host 只执行带精确身份的请求。

## Consequences

Workflow 业务进度不会因用户停止、Host 重启或可恢复执行错误回退，UI 也不再把挂起渲染成业务失败。恢复能够复用 S2、S4、S5 的持久工作，并拒绝旧身份、旧 revision 和取消后的正式提交；代价是每个生产 Executor 都必须接受 `BidRunContext`，关键写入必须经过 fence。

Run 的内存执行栈、Promise 和调度门不会跨 Host 重启恢复；只有持久检查点可复用。Parser 即使在 Stop 后短暂完成，也只能留下 Run staging，不能发布正式结果。自动阶段的 DOCX renderer 在 Commit Scope 发布前只保留内存中的渲染字节。Provider 是否可重试不在阶段实现里按错误文本猜测，未来若需要自动退避，应由拥有 Provider 协议和预算的统一层提供。

本记录改变了[Workspace 项目状态](2026-09-03-bid-workspace-project.md)的磁盘格式与中断恢复方式，并取代[全阶段 Main Agent 实时交错](../feature/2026-09-11-bid-all-stage-main-agent-steer.md)中的独立阶段停止工具和重试动作；两份记录的 Workspace 所有权、项目锁与实时消息交错决定仍然有效。
