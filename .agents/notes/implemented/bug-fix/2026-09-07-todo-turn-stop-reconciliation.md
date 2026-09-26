# Agent Note: todo 轮次停止时校正活跃状态

Status: implemented

## Problem

`todo_write` 的 `in_progress` 是模型写入的自由文本清单声明，不是 Host 观测到的执行状态。模型完成任务或进入等待后若忘记更新清单，`turn/end` 仍保留含 `in_progress` 的最后快照。只在界面[隐藏已停止的计划](../simplification/2026-09-26-transient-conversation-plans.md)虽能消除错误动画，但会留下未校正的持久事实；[下一轮次清空计划](../feature/2026-07-28-todo-plan-clears-on-next-turn.md)仍拥有投影的轮次边界。

## Decision

`dsh-tool-todo` 在现有 `agent/turn-stopping` 扩展点检查当前轮次最近一次 `todo/write`。若其中仍有 `in_progress` 且本轮没有命中过 token 上限，插件通过 `agent.steer` 在同一轮次追加一条可回放的插件消息，要求模型重新提交完整清单：实际完成项写为 `completed`，不再运行的未完成项写为 `pending`，然后再结束。本轮未写清单时不读取旧轮次状态；token 上限截断保留原终止原因和清单，不为收尾多花一次已经不可靠的模型请求。

每个 agent 轮次最多追加一次提醒。模型遵从后，持久化 `todo/write` 仍是唯一清单事实；模型忽略后，轮次仍可结束，不会因停止钩子形成无界请求循环。

Web 计划条同时读取会话的权威 `running` 位。可见时，`in_progress` 仅在 Agent 运行时显示蓝色旋转图标与「进行中」计数；已停止的计划由[展示周期](../simplification/2026-09-26-transient-conversation-plans.md)隐藏，不删除条目、不伪造 `completed` 或 `pending`，也不改写持久日志。

## Alternatives considered

**在 `turn/end` 自动把所有 `in_progress` 改成 `completed`。** Host 不知道自由文本任务是否真正完成；目录产出、等待用户、失败和中断都可能结束轮次，统一完成会制造错误事实。

**只在结束时隐藏清单，不要求模型校正。** 展示层隐藏不能修复持久化的最后快照，下一次读取或其他消费者仍会得到错误声明；短暂展示由[临时执行计划](../simplification/2026-09-26-transient-conversation-plans.md)单独约束。

**持续 steering 直到模型改写。** 模型可以重复忽略提醒；无界停止钩子会消耗任意多次模型请求，并阻止用户重新取得控制权。

**只修改 Web 文案。** 静态「未收尾」能停止错误动画，却放弃了让模型在正常路径修复权威清单的机会；重新打开或其他消费者仍只能看到未校正的最后快照。

## Consequences

正常路径会多花至多一次模型校正请求，并把提醒作为 `user/message` 记录，因此请求输入和会话回放一致。异常、截断或不服从路径仍能有界结束，Web 空闲时隐藏旧计划。Host 仍不猜测任务完成语义：清单内容与三态状态由模型拥有，运行位决定执行期动画和计划条可见性。定向全循环测试固定校正、单轮最多一次、旧轮次不复用及 token 上限不延长；ACP 无密钥回放固定真实 agent-loop 中的提醒及后续清单改写。
