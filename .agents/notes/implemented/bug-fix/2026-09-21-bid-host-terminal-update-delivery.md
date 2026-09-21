# Agent Note: Bid Host 终态摘要投递

Status: implemented

## Problem

Execution Agent 的预步过滤丢弃直属 Child 的 report 和 settled 消息，而 Interaction Agent 只有 model-invisible 的 `bid.run.notice`。Run 失败后用户立即追问时，Main Agent 可能既不知道 Child 的结算，也看不到 Host 已持久化的挂起原因。

## Decision

Execution Session 不过滤直属 Child 的 `subagent-report` 和 `subagent-settled`，S5 执行器也不另行安装同类过滤。Interaction Session 的过滤是 Session 级规则，不依赖活跃 operation；即使原始 progress 在 Run 释放后才被唤醒，也不会进入 Main Agent 模型请求。

`BidRunCoordinator` 先写入 `bid.run.suspended` 和 `bid.run.notice`，再调用 Host 终态观察器。Host 用 `agent.inject()` 将同一 Run 的 stage、status、cause、error code、脱敏 message 和最多三条 issues 作为 `@deepseek-ai/dsh-bid` instruction 写入 Interaction Agent 的持久 inbox。运行中 Agent 在下一个安全 step 边界取得它；空闲 Agent 不被唤醒，下次用户消息与摘要一起进入请求。当 Interaction Agent 已不在 live registry 时，Host 直接追加同样的 plugin `user/message`，使恢复后的下一个 Agent 仍可见。

attention_required、不可恢复的 workflow failed 与最终阶段 completed 复用同一摘要格式。普通进度只保留在 Host 阶段状态与 `bid_stage_inspect`，摘要不携带 Child transcript、staged snapshot、Artifact 正文或工具历史。

## Alternatives considered

**将所有 Child 消息转发给 Interaction Agent。** 这会复制 Execution 日志、放大上下文，并重新混合公开问答与私有协议。

**让 Main Agent 每次问答前轮询 Run 状态。** 轮询增加调用与竞态，且已有 Host 拥有的终态提交点可以直接投递一次摘要。

**只依赖 `bid_stage_inspect`。** inspect 仍是按需详查入口，但模型不知道刚发生失败时可能不会调用它，无法直接回答用户的追问。

## Consequences

Execution Agent 可以根据直属 Child 结果继续当前阶段，Main Agent 在下一次请求中可以解释最近终态，而原始 Child 消息不进入 Interaction 上下文。终态 instruction 与 UI notice 共用 Host 已脱敏的错误事实；需要更多阶段细节时，Main Agent 仍通过 `bid_stage_inspect` 读取有界快照。

本记录部分修正[Bid 全阶段 Main Agent 交互](../feature/2026-09-11-bid-all-stage-main-agent-steer.md)中“Execution 的 Child 通知不进入模型”的范围；Interaction/Execution 的 Session 所有权仍由[Bid 独立交互与执行通道](2026-09-14-bid-interaction-execution-lanes.md)拥有，Run 结算与 `bid.run.notice` 仍由[Bid Workflow 与 Run 使用统一生命周期](../architecture/2026-09-13-bid-workflow-run-lifecycle.md)拥有。
